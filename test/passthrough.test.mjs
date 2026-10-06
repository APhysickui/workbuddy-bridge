import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardAnthropic, passthroughHeaders, passthroughUrl, readOriginalProvider } from '../src/passthrough.mjs';
import { createHandler } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { Capture, call } from './helpers.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy',
  BRIDGE_MODELS: 'deepseek-v4.1-flash=deepseek-v4.1-flash', BRIDGE_CLAUDE_PASSTHROUGH: '1' });
const provider = { baseUrl: 'https://original.example', headers: { authorization: 'Bearer original-provider-secret' } };

test('original provider uses the existing credential and rejects local loops or competing auth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-provider-'));
  const file = join(dir, 'settings.json');
  try {
    await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: provider.baseUrl, ANTHROPIC_AUTH_TOKEN: 'old-token' } }));
    assert.deepEqual(await readOriginalProvider(config, {}, file), { baseUrl: provider.baseUrl, headers: { authorization: 'Bearer old-token' } });
    await assert.rejects(readOriginalProvider(config, { ANTHROPIC_API_KEY: 'other-key' }, file), /一种独立/);
    for (const base of [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, 'file:///private/tmp/a']) {
      await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'old-key' } }));
      await assert.rejects(readOriginalProvider(config, {}, file), /URL 无效/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local credentials never reach the original provider, and native beta headers survive', () => {
  const headers = passthroughHeaders(provider, { 'x-api-key': config.apiKey, authorization: `Bearer ${config.apiKey}`,
    'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31', host: 'localhost' });
  assert.equal(headers.authorization, provider.headers.authorization);
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers.host, undefined);
  assert.equal(headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(passthroughUrl({ baseUrl: 'https://old.example/v1' }, '/v1/messages'), 'https://old.example/v1/messages');
});

test('original Claude models bypass WorkBuddy validation and preserve raw JSON even while WorkBuddy is busy', async () => {
  let release;
  let forwarded = 0;
  const raw = '{ "model": "claude-opus-5-5[1M]", "thinking": {"type":"adaptive"}, "tools":[{"type":"web_search_20250305","name":"web_search"}], "messages":[] }';
  const handler = createHandler({ ...config, originalProvider: provider }, {
    completeAnthropic: () => new Promise(resolve => { release = resolve; })
  }, async input => {
    forwarded++;
    assert.equal(input.rawBody.toString(), raw);
    assert.equal(input.provider, provider);
    input.response.writeHead(418, { 'content-type': 'application/json' });
    input.response.end('{"original":true}');
  });
  const first = call(handler, config, '/v1/messages', { model: 'deepseek-v4.1-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
    const res = await call(handler, config, path, {}, { raw });
    assert.equal(res.status, 418);
    assert.equal(res.body, '{"original":true}');
  }
  const denied = await call(handler, config, '/v1/messages', {}, { raw, headers: { 'x-api-key': 'wrong' } });
  assert.equal(denied.status, 401);
  assert.equal(forwarded, 2);
  release({ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: null });
  await first;
});

test('WorkBuddy failures never fall back to a paid Claude provider', async () => {
  let forwarded = 0;
  const handler = createHandler({ ...config, originalProvider: provider }, {
    completeAnthropic() { throw new Error('failed'); }
  }, async () => { forwarded++; });
  const response = await call(handler, config, '/v1/messages', { model: 'deepseek-v4.1-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.status, 500);
  assert.equal(forwarded, 0);
});

test('curl transport preserves fragmented SSE, upstream errors and request bytes without credentials in argv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-forward-test-'));
  const rawBody = Buffer.from('{ "model":"claude-sonnet-5", "stream":true }');
  try {
    for (const status of [200, 429]) {
      const response = new Capture();
      let inspected;
      const spawn = (command, args) => {
        assert.equal(command, 'curl');
        assert.equal(args.includes('--location'), false);
        assert.equal(args.join(' ').includes('original-provider-secret'), false);
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
        let directives = '';
        child.stdin.on('data', chunk => { directives += chunk; });
        child.stdin.on('finish', () => {
          inspected = (async () => {
            const match = /data-binary = "@([^"]+)"/.exec(directives);
            assert.deepEqual(await readFile(match[1]), rawBody);
            assert.ok(directives.includes('authorization: Bearer original-provider-secret'));
            assert.ok(!directives.includes(config.apiKey));
            child.stdout.write('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 ' + status + ' ');
            child.stdout.write('Response\r\nContent-Type: text/event-stream\r\nRequest-Id: req_original\r\nSet-Cookie: secret\r\n\r');
            child.stdout.write('\nevent: message_start\ndata: {"text":"你好"}\n\n');
            // Confirm streaming before the subprocess has completed.
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(response.status, status);
            assert.ok(response.body.includes('你好'));
            assert.equal(response.writableEnded, false);
            child.stdout.end('event: message_stop\ndata: {}\n\n');
            setImmediate(() => child.emit('close', 0));
          })();
          inspected.catch(error => { child.stdout.destroy(error); child.emit('close', 1); });
        });
        return child;
      };
      await forwardAnthropic({ config: { ...config, runtimeDir: dir }, provider, path: '/v1/messages', rawBody,
        headers: { 'x-api-key': config.apiKey }, response, signal: new AbortController().signal }, spawn);
      await inspected;
      assert.equal(response.headers['request-id'], 'req_original');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.body, 'event: message_start\ndata: {"text":"你好"}\n\nevent: message_stop\ndata: {}\n\n');
      assert.deepEqual(await readdir(dir), []);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
