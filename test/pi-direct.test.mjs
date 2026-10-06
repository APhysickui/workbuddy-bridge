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
