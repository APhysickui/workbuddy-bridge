import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { directPiProvider } from '../src/pi-direct.mjs';
import { WorkBuddyAdapter } from '../src/adapters.mjs';
import { PI_PROVIDER_ID } from '../src/pi-config.mjs';

const sdkRoot = join(homedir(), '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist');
async function piClient(t) {
  try { await access(join(sdkRoot, 'api/anthropic-messages.js')); } catch { t.skip('pi is not installed'); return; }
  const api = await import(pathToFileURL(join(sdkRoot, 'api/anthropic-messages.js')));
  const { normalizeContext } = await import(pathToFileURL(join(sdkRoot, 'utils/transcript.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(sdkRoot, 'utils/event-stream.js')));
  const { isRetryableAssistantError } = await import(pathToFileURL(join(sdkRoot, 'utils/retry.js')));
  return { api, normalizeContext, createAssistantMessageEventStream, isRetryableAssistantError };
}
function configFor(runtimeDir) {
  return { ...readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy',
    BRIDGE_MODELS: 'deepseek-v4.1-flash=deepseek-v4.1-flash', BRIDGE_CLAUDE_MODEL: 'deepseek-v4.1-flash' }), runtimeDir };
}
const context = () => ({ systemPrompt: 'Use tools.', tools: [{ name: 'read', description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  messages: [{ role: 'user', content: 'Read hello.txt', timestamp: Date.now() }] });
const modelFor = provider => ({ ...provider.models[0], api: provider.api, provider: PI_PROVIDER_ID, baseUrl: provider.baseUrl });

test('pi direct provider uses the installed SDK and real CLI fixture for tools without a socket or daemon', async t => {
  const client = await piClient(t);
  if (!client) return;
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-pi-direct-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const config = configFor(runtimeDir);
  const adapter = new WorkBuddyAdapter(config, { prefixArgs: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), 'pi-roundtrip'] });
  const provider = directPiProvider(config, adapter, client.api, client.createAssistantMessageEventStream);
  const model = modelFor(provider);
  const transcript = context();
  const first = await provider.streamSimple(model, client.normalizeContext(transcript)).result();
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  assert.equal(first.content[0].type, 'toolCall');
  assert.deepEqual(first.content[0].arguments, { path: 'hello.txt' });
  assert.equal(first.usage.input, 0);
  assert.equal(first.usage.cacheWrite, 20);
  assert.equal(first.usage.cacheRead, 10);
  transcript.messages.push(first, { role: 'toolResult', toolCallId: first.content[0].id, toolName: 'read',
    content: [{ type: 'text', text: 'FILE_MARKER' }], isError: false, timestamp: Date.now() });
  const last = await provider.streamSimple(model, client.normalizeContext(transcript)).result();
  assert.equal(last.stopReason, 'stop', last.errorMessage);
  assert.equal(last.content[0].text, 'PI_WORKBUDDY_OK');
});

test('pi direct provider returns CLI failures without network retries or a fallback provider', async t => {
  const client = await piClient(t);
  if (!client) return;
  let calls = 0;
  const provider = directPiProvider(configFor(tmpdir()), { completeAnthropic() { calls++; throw new Error('private upstream output'); } }, client.api, client.createAssistantMessageEventStream);
  const result = await provider.streamSimple(modelFor(provider), client.normalizeContext(context()), { maxRetries: 3 }).result();
  assert.equal(result.stopReason, 'error');
  assert.equal(calls, 1);
  assert.ok(result.errorMessage.includes('Internal bridge error'));
  assert.ok(!result.errorMessage.includes('private upstream output'));
  assert.equal(client.isRetryableAssistantError(result), false);
});

test('pi SDK continues a multi-step task through announcements, two client tools and a final answer', async t => {
  const client = await piClient(t);
  if (!client) return;
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-pi-agent-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const config = configFor(runtimeDir);
  const adapter = new WorkBuddyAdapter(config, { prefixArgs: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), 'agent-snapshot'] });
  let invocations = 0;
  const invoke = adapter.invoke.bind(adapter);
  adapter.invoke = input => { invocations++; return invoke(input); };
  const provider = directPiProvider(config, adapter, client.api, client.createAssistantMessageEventStream);
  const transcript = context();
  transcript.messages[0].content = 'Read the index, then the draft it names. Report the result.';
  const paths = [];
  for (let step = 0; step < 3; step++) {
    const answer = await provider.streamSimple(modelFor(provider), client.normalizeContext(transcript)).result();
    assert.notEqual(answer.stopReason, 'error', answer.errorMessage);
    assert.equal(answer.content.filter(block => block.type === 'thinking').length, 2);
    assert.equal(answer.usage.input, 6);
    assert.equal(answer.usage.output, 10);
    transcript.messages.push(answer);
    if (step === 2) {
      assert.equal(answer.stopReason, 'stop');
      assert.equal(answer.content.find(block => block.type === 'text').text, 'Checked both files: RANDOM_DRAFT_MARKER');
    } else {
      assert.equal(answer.stopReason, 'toolUse');
      const call = answer.content.find(block => block.type === 'toolCall');
      paths.push(call.arguments.path);
      transcript.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: step === 0 ? 'draft.txt' : 'RANDOM_DRAFT_MARKER' }], isError: false, timestamp: Date.now() });
    }
  }
  assert.deepEqual(paths, ['index.txt', 'draft.txt']);
  assert.equal(invocations, 6, 'one bounded correction per client step');
});

test('pi displays an ordinary CLI answer with its usual coding tools enabled', async t => {
  const client = await piClient(t);
  if (!client) return;
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-pi-plain-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const config = configFor(runtimeDir);
  const adapter = new WorkBuddyAdapter(config, { prefixArgs: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), 'plain-reply'] });
  const provider = directPiProvider(config, adapter, client.api, client.createAssistantMessageEventStream);
  const transcript = context();
  transcript.messages[0].content = '你是谁';
  const result = await provider.streamSimple(modelFor(provider), client.normalizeContext(transcript)).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.deepEqual(result.content, [{ type: 'text', text: '我是 DeepSeek，可以帮你回答问题。' }]);
});

test('cancelling pi direct streaming cancels the CLI operation', async t => {
  const client = await piClient(t);
  if (!client) return;
  let inputSignal;
  const provider = directPiProvider(configFor(tmpdir()), { completeAnthropic: input => new Promise((resolve, reject) => {
    inputSignal = input.signal;
    input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) }, client.api, client.createAssistantMessageEventStream);
  const controller = new AbortController();
  const stream = provider.streamSimple(modelFor(provider), client.normalizeContext(context()), { signal: controller.signal });
  while (!inputSignal) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await stream.result()).stopReason, 'aborted');
  assert.equal(inputSignal.aborted, true);
});

test('pi SDK displays live thinking before the validated tool call and preserves the next turn', { timeout: 10000 }, async t => {
  const client = await piClient(t);
  if (!client) return;
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-pi-thinking-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const config = configFor(runtimeDir);
  const adapter = new WorkBuddyAdapter(config, { prefixArgs: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), 'thinking-tool'] });
  let cliFinished = false;
  const observed = { completeAnthropic: async input => {
    assert.equal(input.effort, 'high');
    try { return await adapter.completeAnthropic(input); } finally { cliFinished = true; }
  } };
  const provider = directPiProvider(config, observed, client.api, client.createAssistantMessageEventStream);
  const model = modelFor(provider);
  const transcript = context();
  const stream = provider.streamSimple(model, client.normalizeContext(transcript), { reasoning: 'high' });
  let finished = false;
  const final = stream.result().then(result => { finished = true; return result; });
  const events = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === 'thinking_delta') {
      assert.equal(cliFinished, false, 'thinking was buffered until CLI completion');
      assert.equal(finished, false, 'thinking was buffered until the final answer');
    }
  }
  assert.equal(events.filter(event => event.type === 'thinking_start').length, 1);
  assert.equal(events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join(''), '先核对🙂再回答。');
  const first = await final;
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  assert.equal(first.content[0].type, 'thinking');
  assert.equal(first.content[0].thinkingSignature, 'fixture-signature');
  const tool = first.content.find(block => block.type === 'toolCall');
  assert.deepEqual(tool.arguments, { path: 'hello.txt' });
  assert.equal(first.usage.cacheWrite, 20);
  assert.equal(first.usage.cacheRead, 10);
  transcript.messages.push(first, { role: 'toolResult', toolCallId: tool.id, toolName: 'read',
    content: [{ type: 'text', text: 'FILE_MARKER' }], isError: false, timestamp: Date.now() });
  const last = await provider.streamSimple(model, client.normalizeContext(transcript), { reasoning: 'high' }).result();
  assert.equal(last.stopReason, 'stop', last.errorMessage);
  assert.equal(last.content.filter(block => block.type === 'text').map(block => block.text).join(''), 'THINKING_REPLY_OK');
  assert.ok(!JSON.stringify(last).includes('PRIVATE_METADATA'));
});

test('a CLI failure after live thinking remains an error with safe diagnostics', { timeout: 10000 }, async t => {
  const client = await piClient(t);
  if (!client) return;
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-pi-thinking-failure-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const adapter = new WorkBuddyAdapter(configFor(runtimeDir), { prefixArgs: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), 'thinking-fail'] });
  const provider = directPiProvider(configFor(runtimeDir), adapter, client.api, client.createAssistantMessageEventStream);
  const result = await provider.streamSimple(modelFor(provider), client.normalizeContext(context())).result();
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /insufficient quota/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_METADATA'));
  assert.equal(client.isRetryableAssistantError(result), false);
});

test('cancellation while pi displays thinking aborts the live CLI stream', { timeout: 10000 }, async t => {
  const client = await piClient(t);
  if (!client) return;
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-pi-thinking-cancel-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const adapter = new WorkBuddyAdapter(configFor(runtimeDir), { prefixArgs: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), 'thinking-hang'] });
  const provider = directPiProvider(configFor(runtimeDir), adapter, client.api, client.createAssistantMessageEventStream);
  const controller = new AbortController();
  const stream = provider.streamSimple(modelFor(provider), client.normalizeContext(context()), { signal: controller.signal });
  let sawThinking = false;
  for await (const event of stream) {
    if (event.type === 'thinking_delta') { sawThinking = true; controller.abort(); }
  }
  assert.equal(sawThinking, true);
  assert.equal((await stream.result()).stopReason, 'aborted');
});
