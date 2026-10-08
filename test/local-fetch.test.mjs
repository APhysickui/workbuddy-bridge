import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalFetch } from '../src/local-fetch.mjs';
import { createHandler } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { BridgeError } from '../src/errors.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_MODELS: 'test=test' });
const body = { model: 'test', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Check and reply.' }] };
const init = signal => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey }, body: JSON.stringify(body), signal });

test('local fetch releases thinking before the completion promise and keeps final usage', { timeout: 5000 }, async () => {
  let release;
  let completed = false;
  const thinking = { type: 'thinking', thinking: 'Checking facts.', signature: '' };
  const handler = createHandler(config, { completeAnthropic: async input => {
    input.onThinking({ type: 'start', index: 0, thinking: thinking.thinking, signature: '' });
    input.onThinking({ type: 'stop', index: 0 });
    await new Promise(resolve => { release = resolve; });
    completed = true;
    return { content: [thinking, { type: 'text', text: 'Verified answer.' }], stopReason: 'end_turn',
      usage: { prompt_tokens: 30, completion_tokens: 5 },
      anthropicUsage: { input_tokens: 0, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 10 } };
  } });
  const response = await createLocalFetch(handler)('http://workbuddy-cli.local/v1/messages', init());
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(completed, false);
  assert.match(Buffer.from(first.value).toString(), /message_start/);
  release();
  let text = Buffer.from(first.value).toString();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += Buffer.from(chunk.value).toString(); }
  assert.equal((text.match(/"type":"thinking_delta"/g) ?? []).length, 1);
  assert.match(text, /Verified answer/);
  assert.match(text, /"cache_creation_input_tokens":20/);
  assert.match(text, /"cache_read_input_tokens":10/);
  assert.match(text, /event: message_stop/);
});

test('errors after a public thought produce an explicit failure, never message_stop', async () => {
  const handler = createHandler(config, { completeAnthropic: async input => {
    input.onThinking({ type: 'start', index: 0, thinking: 'Checking.' });
    throw new BridgeError(502, 'upstream_quota', 'The upstream CLI reported insufficient quota.');
  } });
  const response = await createLocalFetch(handler)('http://workbuddy-cli.local/v1/messages', init());
  const text = await response.text();
  assert.match(text, /event: error/);
  assert.match(text, /insufficient quota/);
  assert.ok(!text.includes('event: message_stop'));
});

test('cancelling a local response body cancels upstream work and releases the request slot', { timeout: 5000 }, async () => {
  let signal;
  let settled;
  const finished = new Promise(resolve => { settled = resolve; });
  const handler = createHandler(config, { completeAnthropic: async input => {
    signal = input.signal;
    input.onThinking({ type: 'start', index: 0, thinking: 'Checking.' });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    settled();
    throw new BridgeError(499, 'cancelled', 'Request cancelled');
  } });
  const local = createLocalFetch(handler);
  const response = await local('http://workbuddy-cli.local/v1/messages', init());
  await response.body.cancel();
  await finished;
  assert.equal(signal.aborted, true);
  const health = await local('http://workbuddy-cli.local/health');
  assert.equal((await health.json()).busy, false);
});

test('local streaming drains backpressure and retains all bytes', { timeout: 5000 }, async () => {
  const text = '大🙂'.repeat(50000);
  const local = createLocalFetch(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    if (!response.write(text)) await new Promise(resolve => response.once('drain', resolve));
    response.end('done');
  });
  assert.equal(await (await local('http://workbuddy-cli.local/test')).text(), text + 'done');
});
