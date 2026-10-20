import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeResponses, responseObject, responseEvents } from '../src/responses.mjs';
import { createHandler } from '../src/server.mjs';
import { createLocalFetch } from '../src/local-fetch.mjs';
import { readConfig } from '../src/config.mjs';
import { WorkBuddyAdapter } from '../src/adapters.mjs';
import { BridgeError } from '../src/errors.mjs';
import { call } from './helpers.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'responses-test-key-0123456789abcdef', BRIDGE_MODELS: 'test=test' });
const read = { type: 'function', name: 'read', description: 'Read UTF-8 text', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const patch = { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/s' } };
const body = { model: 'test', store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Read the file.' }] }], tools: [read] };
const normalize = request => normalizeResponses(request, config.models);
const frames = text => text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));

test('Responses developer instructions, Codex advisory fields and public reasoning normalize to the shared tool adapter', () => {
  const input = normalize({ ...body, instructions: 'Follow permissions.', max_output_tokens: 1024, stream: true,
    reasoning: { effort: 'high', summary: 'auto' }, text: { verbosity: 'low' }, include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'session-cache', input: [{ role: 'developer', content: 'Client instructions.' }, ...body.input] });
  assert.equal(input.effort, 'high'); assert.equal(input.maxTokens, 1024);
  assert.equal(input.system, 'Follow permissions.\n\nClient instructions.');
  assert.equal(input.responseTools.get(input.tools[0].name).name, 'read');
  assert.ok(input.advisoryFields.includes('prompt_cache_key'));
});

test('function and custom tool history retain IDs, text and namespaces without exposing opaque reasoning', () => {
  const input = normalize({ ...body, tools: [{ type: 'namespace', name: 'functions', tools: [read, patch] }], input: [
    ...body.input, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Public thought.' }], encrypted_content: 'OPAQUE_DO_NOT_READ' },
    { type: 'function_call', call_id: 'call_read', name: 'read', namespace: 'functions', arguments: '{"path":"draft.txt"}' },
    { type: 'function_call_output', call_id: 'call_read', output: [{ type: 'input_text', text: 'Actual file result.' }] },
    { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', namespace: 'functions', input: '*** Begin Patch\n*** End Patch' },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Patch applied.' }
  ] });
  assert.ok(!JSON.stringify(input).includes('OPAQUE_DO_NOT_READ'));
  assert.equal(input.history[1].content[0].thinking, 'Public thought.');
  assert.equal(input.history.at(-1).content[0].tool_use_id, 'call_patch');
  assert.deepEqual(input.history[3].content[0].input, { input: '*** Begin Patch\n*** End Patch' });
  assert.deepEqual([...input.responseTools.values()].map(tool => tool.namespace), ['functions', 'functions']);
});

test('tool aliases remain stable across reordered definitions and distinguish namespaces', () => {
  const first = normalize({ ...body, tools: [read, { type: 'namespace', name: 'functions', tools: [read] }] });
  const second = normalize({ ...body, tools: [{ type: 'namespace', name: 'functions', tools: [read] }, read] });
  assert.equal(first.tools[0].name, second.tools[1].name);
  assert.notEqual(first.tools[0].name, first.tools[1].name);
});

test('forced choices and serial restrictions translate to the shared validator', () => {
  const input = normalize({ ...body, parallel_tool_calls: false, tool_choice: { type: 'function', name: 'read' } });
  assert.deepEqual(input.toolChoice, { type: 'tool', name: input.tools[0].name, disable_parallel_tool_use: true });
  assert.equal(normalize({ ...body, tool_choice: 'required' }).toolChoice.type, 'any');
  assert.equal(normalize({ ...body, tool_choice: 'none' }).toolChoice.type, 'none');
});

test('unsupported, malformed, unpaired or multimodal requests fail before contacting upstream', async () => {
  const invalids = [
    { ...body, store: true }, { ...body, previous_response_id: 'resp_old' }, { ...body, background: true },
    { ...body, tools: [{ type: 'web_search' }] }, { ...body, tools: [read, read] },
    { ...body, text: { format: { type: 'json_schema' } } }, { ...body, parallel_tool_calls: 'false' },
    { ...body, tool_choice: { type: 'function', name: 'missing' } },
    { ...body, input: [{ type: 'item_reference', id: 'msg_old' }] },
    { ...body, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }] },
    { ...body, input: [...body.input, { type: 'function_call_output', call_id: 'missing', output: 'fake' }] },
    { ...body, input: [...body.input, { type: 'function_call', call_id: 'a', name: 'read', arguments: '[]' }] },
    { ...body, input: [...body.input, { type: 'custom_tool_call', call_id: 'a', name: 'apply_patch', input: 'patch' },
      { type: 'function_call_output', call_id: 'a', output: 'wrong type' }] },
    { ...body, input: [...body.input, { type: 'reasoning', summary: [], content: {} }] }
  ];
  let calls = 0;
  const handler = createHandler(config, { completeAnthropic() { calls++; throw new Error('must not call'); } });
  for (const request of invalids) {
    const res = await call(handler, config, '/v1/responses', request);
    assert.equal(res.status, 400, JSON.stringify(request));
  }
  assert.equal(calls, 0);
});

test('SSE retains function arguments, custom raw input, namespaces and ordered unique item IDs', () => {
  const input = normalize({ ...body, tools: [{ type: 'namespace', name: 'functions', tools: [read, patch] }] });
  const result = { content: [ { type: 'thinking', thinking: 'Inspect first.' }, { type: 'text', text: 'Reading.' },
    { type: 'tool_use', id: 'call_read', name: input.tools[0].name, input: { path: '测试🙂.txt' } },
    { type: 'tool_use', id: 'call_patch', name: input.tools[1].name, input: { input: '*** Begin Patch\n*** End Patch' } } ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
  const full = responseObject('resp_test', 'test', result, 100, input);
  assert.equal(full.output[2].name, 'read'); assert.equal(full.output[2].namespace, 'functions');
  assert.equal(full.output[3].type, 'custom_tool_call'); assert.equal(full.output[3].input, result.content[3].input.input);
  const events = [...responseEvents('resp_test', 'test', result, 100, input)].map(event => event.data);
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  assert.deepEqual(events.filter(event => event.type === 'response.output_item.added').map(event => event.output_index), [0, 1, 2, 3]);
  assert.equal(new Set(full.output.map(item => item.id)).size, 4);
  assert.equal(events.filter(event => event.type === 'response.function_call_arguments.delta').map(event => event.delta).join(''), '{"path":"测试🙂.txt"}');
  assert.equal(events.filter(event => event.type === 'response.custom_tool_call_input.delta').map(event => event.delta).join(''), result.content[3].input.input);
  assert.deepEqual(events.at(-1).response, full);
});

test('Responses reasoning arrives before completion and final events do not replay it', async () => {
  let release, completed = false;
  const input = { ...body, stream: true };
  const handler = createHandler(config, { completeAnthropic: async request => {
    request.onThinking({ type: 'start', index: 0, thinking: 'Public.' });
    request.onThinking({ type: 'delta', index: 0, thinking: ' Done.' });
    request.onThinking({ type: 'stop', index: 0 });
    await new Promise(resolve => { release = resolve; }); completed = true;
    return { content: [{ type: 'thinking', thinking: 'Public. Done.', signature: '' }, { type: 'text', text: 'Answer.' }], stopReason: 'end_turn' };
  } });
  const response = await createLocalFetch(handler)('http://workbuddy-cli.local/v1/responses', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(input) });
  const reader = response.body.getReader(); const first = await reader.read(); assert.equal(completed, false);
  release(); let text = Buffer.from(first.value).toString();
  for (;;) { const part = await reader.read(); if (part.done) break; text += Buffer.from(part.value).toString(); }
  const events = frames(text);
  assert.equal(events.filter(event => event.type === 'response.output_item.added' && event.item.type === 'reasoning').length, 1);
  assert.equal(events.filter(event => event.type === 'response.reasoning_summary_text.delta').map(event => event.delta).join(''), 'Public. Done.');
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  assert.equal(events.at(-1).type, 'response.completed');
});

test('upstream failure after reasoning produces response.failed without answer or completed', async () => {
  const handler = createHandler(config, { completeAnthropic: async request => {
    request.onThinking({ type: 'start', index: 0, thinking: 'Checking.' });
    throw new BridgeError(502, 'upstream_quota', 'The upstream CLI reported insufficient quota.');
  } });
  const response = await call(handler, config, '/v1/responses', { ...body, stream: true });
  const events = frames(response.body);
  assert.equal(events.at(-1).type, 'response.failed');
  assert.equal(events.at(-1).response.error.code, 'upstream_quota');
  assert.ok(!events.some(event => event.type === 'response.completed'));
});

test('Responses native handoff completes two real client reads and a final random marker without continuation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-responses-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = join(directory, 'index.txt'), draft = join(directory, 'draft.txt');
  const marker = 'RESPONSES_VERIFIED_' + Date.now();
  await writeFile(index, draft); await writeFile(draft, marker);
  const upstreamConfig = { ...config, backend: 'workbuddy', runtimeDir: directory, timeoutMs: 5000 };
  const adapter = new WorkBuddyAdapter(upstreamConfig, { prefixArgs: [fileURLToPath(new URL('./fixtures/native-cli.mjs', import.meta.url)), 'agent'] });
  const handler = createHandler(upstreamConfig, adapter);
  const input = [{ role: 'user', content: `Read ${index}. It names another file. Read it and return its marker.` }];
  const observed = [];
  for (let step = 0; step < 3; step++) {
    const response = await call(handler, config, '/v1/responses', { ...body, input, stream: true });
    const events = frames(response.body); const full = events.at(-1).response;
    assert.equal(events.at(-1).type, 'response.completed', response.body);
    const calls = full.output.filter(item => item.type === 'function_call');
    if (step < 2) {
      assert.equal(calls.length, 1); const call = calls[0]; assert.equal(call.name, 'read');
      const path = JSON.parse(call.arguments).path; assert.equal(path, step === 0 ? index : draft);
      observed.push(path); input.push(...full.output, { type: 'function_call_output', call_id: call.call_id, output: await readFile(path, 'utf8') });
    } else {
      assert.equal(calls.length, 0);
      assert.equal(full.output.find(item => item.type === 'message').content[0].text, marker);
      assert.equal(full.output.find(item => item.type === 'message').phase, 'final_answer');
    }
  }
  assert.deepEqual(observed, [index, draft]);
});

test('native MCP exposes custom patch text as a client call without applying it on the bridge', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-responses-custom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstreamConfig = { ...config, backend: 'workbuddy', runtimeDir: directory, timeoutMs: 5000 };
  const adapter = new WorkBuddyAdapter(upstreamConfig, { prefixArgs: [fileURLToPath(new URL('./fixtures/native-cli.mjs', import.meta.url)), 'custom'] });
  const request = { ...body, tools: [{ type: 'namespace', name: 'functions', tools: [patch] }],
    tool_choice: { type: 'custom', name: 'apply_patch', namespace: 'functions' }, stream: true };
  const response = await call(createHandler(upstreamConfig, adapter), config, '/v1/responses', request);
  const full = frames(response.body).at(-1).response;
  const tool = full.output.find(item => item.type === 'custom_tool_call');
  assert.equal(tool.name, 'apply_patch'); assert.equal(tool.namespace, 'functions');
  assert.match(tool.input, /\*\*\* Begin Patch/);
  await assert.rejects(readFile(join(directory, 'proof.txt')), { code: 'ENOENT' });
  const continued = normalize({ ...request, tool_choice: 'auto', input: [...body.input, ...full.output,
    { type: 'custom_tool_call_output', call_id: tool.call_id, output: 'Patch applied by client.' }] });
  assert.equal(continued.history.at(-1).content[0].content, 'Patch applied by client.');
});

test('Responses cancellation aborts upstream and releases the bridge slot', async () => {
  let signal;
  const handler = createHandler(config, { completeAnthropic: async input => {
    signal = input.signal;
    input.onThinking({ type: 'start', index: 0, thinking: 'Reading.' });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new BridgeError(499, 'cancelled', 'Request cancelled');
  } });
  const local = createLocalFetch(handler);
  const response = await local('http://workbuddy-cli.local/v1/responses', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey }, body: JSON.stringify({ ...body, stream: true }) });
  await response.body.cancel();
  assert.equal(signal.aborted, true);
  assert.equal((await (await local('http://workbuddy-cli.local/health')).json()).busy, false);
});
