import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHandler } from '../src/server.mjs';
import { MockAdapter } from '../src/adapters.mjs';
import { readConfig } from '../src/config.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_MODELS: 'wb-auto=auto,wb-glm-5.1=glm-5.1' });
class Capture extends EventEmitter {
  chunks = [];
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  setHeader(name, value) { this.headers ??= {}; this.headers[name] = value; }
  write(value) { this.chunks.push(value); return true; }
  end(value) { if (value) this.chunks.push(value); this.writableEnded = true; this.emit('close'); }
  get body() { return this.chunks.join(''); }
}

function request(path, body, options = {}) {
  const data = options.raw ?? (body === undefined ? '' : JSON.stringify(body));
  const req = Readable.from([Buffer.from(data)]);
  req.url = path;
  req.method = options.method ?? (body === undefined ? 'GET' : 'POST');
  req.headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...options.headers };
  return req;
}
async function call(handler, path, body, options) {
  const res = new Capture();
  await handler(request(path, body, options), res);
  return res;
}
const chat = { model: 'wb-auto', messages: [{ role: 'user', content: '你好🙂' }] };
const events = res => res.body.split('\n\n').filter(Boolean).map(frame => {
  const data = frame.split('\n').find(line => line.startsWith('data: ')).slice(6);
  return data === '[DONE]' ? data : JSON.parse(data);
});

test('health describes demo and does not claim upstream or credit verification', async () => {
  const handler = createHandler(config, new MockAdapter());
  const res = await call(handler, '/health', undefined, { headers: { authorization: '' } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).backend, 'mock');
  assert.equal(JSON.parse(res.body).credit_sharing_verified, false);
});

test('model and completion endpoints require the local key', async () => {
  const handler = createHandler(config, new MockAdapter());
  for (const path of ['/v1/models', '/v1/chat/completions', '/v1/responses']) {
    const res = await call(handler, path, chat, { headers: { authorization: 'Bearer wrong-key' } });
    assert.equal(res.status, 401);
  }
});

test('models list and text completion preserve the public alias', async () => {
  const handler = createHandler(config, new MockAdapter());
  assert.equal(JSON.parse((await call(handler, '/v1/models')).body).data[0].id, 'wb-auto');
  const res = await call(handler, '/v1/chat/completions', chat);
  const body = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(body.model, 'wb-auto');
  assert.equal(body.object, 'chat.completion');
  assert.ok(body.choices[0].message.content.includes('本地演示'));
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage, undefined);
});

test('Chat Completions SSE reconstructs Unicode text and ends with DONE', async () => {
  const handler = createHandler(config, new MockAdapter());
  const res = await call(handler, '/v1/chat/completions', { ...chat, stream: true, stream_options: { include_usage: true } });
  const parsed = events(res);
  assert.ok(res.headers['content-type'].startsWith('text/event-stream'));
  assert.equal(parsed.at(-1), '[DONE]');
  assert.equal(parsed.at(-2).usage, null);
  assert.equal(parsed.at(-2).choices.length, 0);
  const text = parsed.filter(event => typeof event !== 'string').map(event => event.choices[0]?.delta?.content ?? '').join('');
  assert.equal(text, '[本地演示，未调用 WorkBuddy]\n收到：你好🙂');
});

test('Responses JSON and SSE expose one completed text message', async () => {
  const handler = createHandler(config, new MockAdapter());
  const input = { model: 'wb-auto', input: '你好🙂', store: false, instructions: 'Be brief.' };
  const body = JSON.parse((await call(handler, '/v1/responses', input)).body);
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].content[0].type, 'output_text');
  const parsed = events(await call(handler, '/v1/responses', { ...input, stream: true }));
  assert.equal(parsed[0].type, 'response.created');
  assert.equal(parsed.at(-1).type, 'response.completed');
  const text = parsed.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join('');
  assert.equal(text, parsed.at(-1).response.output[0].content[0].text);
  assert.deepEqual(parsed.map(event => event.sequence_number), parsed.map((_, index) => index));
});

test('unsupported tool, multimodal, sampling and state requests fail before the upstream is called', async () => {
  let count = 0;
  const handler = createHandler(config, { complete() { count++; throw new Error('must not be called'); } });
  const bad = [
    { ...chat, tools: [] }, { ...chat, temperature: 0.1 }, { ...chat, max_tokens: 20 },
    { ...chat, n: 2 }, { ...chat, model: 'unknown' },
    { ...chat, messages: [{ role: 'tool', content: 'result' }] },
    { ...chat, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }
  ];
  for (const body of bad) assert.equal((await call(handler, '/v1/chat/completions', body)).status, 400);
  assert.equal((await call(handler, '/v1/responses', { model: 'wb-auto', input: 'hi', previous_response_id: 'resp_previous' })).status, 400);
  assert.equal(count, 0);
});

test('invalid JSON, wrong media type and oversized body are rejected', async () => {
  const handler = createHandler(config, new MockAdapter());
  assert.equal((await call(handler, '/v1/chat/completions', chat, { raw: '{' })).status, 400);
  assert.equal((await call(handler, '/v1/chat/completions', chat, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(handler, '/v1/chat/completions', chat, { raw: 'x'.repeat(config.maxBodyBytes + 1) })).status, 413);
});

test('one active request blocks a second and the slot is released afterward', async () => {
  let release;
  const handler = createHandler(config, { complete: () => new Promise(resolve => { release = resolve; }) });
  const first = call(handler, '/v1/chat/completions', chat);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await call(handler, '/v1/chat/completions', chat)).status, 429);
  release({ text: 'ok', usage: null });
  assert.equal((await first).status, 200);
  const next = call(handler, '/v1/chat/completions', chat);
  await new Promise(resolve => setImmediate(resolve));
  release({ text: 'again', usage: null });
  assert.equal((await next).status, 200);
});

test('disconnect cancels upstream work and releases its slot', async () => {
  let signal;
  const handler = createHandler(config, { complete: input => new Promise((resolve, reject) => {
    signal = input.signal;
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  const res = new Capture();
  const task = handler(request('/v1/chat/completions', chat), res);
  while (!signal) await new Promise(resolve => setImmediate(resolve));
  res.emit('close');
  await task;
  assert.equal(signal.aborted, true);
  assert.equal(JSON.parse((await call(handler, '/health')).body).busy, false);
});

test('internal errors return generic messages', async () => {
  const handler = createHandler(config, { complete() { throw new Error('PRIVATE_TOKEN'); } });
  const res = await call(handler, '/v1/chat/completions', chat);
  assert.equal(res.status, 500);
  assert.ok(!res.body.includes('PRIVATE_TOKEN'));
});

test('background service status is authenticated and reports configured routing', async () => {
  const handler = createHandler(config, new MockAdapter());
  assert.equal((await call(handler, '/_bridge/status', undefined, { headers: { authorization: '' } })).status, 401);
  const res = await call(handler, '/_bridge/status');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).models, { 'wb-auto': 'auto', 'wb-glm-5.1': 'glm-5.1' });
  assert.ok(!res.body.includes(config.apiKey));
});
