import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { piProvider, verifyPiCheck, registerPiProvider, PI_PROVIDER_ID } from '../src/pi-config.mjs';
import { createHandler } from '../src/server.mjs';
import { handlerFetch } from './helpers.mjs';
import { catalogModel, workbuddyCatalog } from '../src/model-catalog.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy',
  BRIDGE_MODELS: 'deepseek-v4.1-flash=deepseek-v4.1-flash', BRIDGE_CLAUDE_MODEL: 'deepseek-v4.1-flash',
  BRIDGE_CLAUDE_MODEL_NAME: 'DeepSeek V4.1 Flash（workbuddy）' });

test('pi adds a separate provider without replacing the old workbuddy configuration or environment auth', async () => {
  const providers = new Map([['workbuddy', { baseUrl: 'http://127.0.0.1:8799/v1' }]]);
  const before = process.env.ANTHROPIC_AUTH_TOKEN;
  registerPiProvider({ registerProvider(name, provider) { providers.set(name, provider); } }, piProvider(config));
  assert.equal(PI_PROVIDER_ID, 'workbuddy-cli');
  assert.equal(providers.get('workbuddy').baseUrl, 'http://127.0.0.1:8799/v1');
  assert.equal(providers.get(PI_PROVIDER_ID).api, 'anthropic-messages');
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, before);
  assert.equal(piProvider(config).models[0].name, 'DeepSeek V4.1 Flash（workbuddy）');
});

test('the default model menu uses official CLI context defaults and model-specific output budgets', () => {
  const all = readConfig({ BRIDGE_API_KEY: config.apiKey });
  const models = new Map(piProvider(all).models.map(model => [model.id, model]));
  assert.equal(models.size, 19);
  for (const model of models.values()) {
    assert.ok(model.name.endsWith('（workbuddy）'));
    assert.deepEqual(model.input, ['text']);
    assert.equal(model.reasoning, true); // Render public CLI thinking when available.
    assert.equal(model.compat.allowEmptySignature, true);
  }
  assert.equal(models.get('deepseek-v4.1-flash').contextWindow, 300000);
  assert.equal(catalogModel('deepseek-v4.1-flash').maxInputTokens, 1000000);
  assert.equal(models.get('deepseek-v4.1-flash').maxTokens, 128000);
  assert.equal(models.get('glm-5.3-flash').maxTokens, 131072);
  assert.equal(models.get('glm-5.1').contextWindow, 200000);
  assert.equal(models.get('minimax-m3').contextWindow, 300000);
  assert.equal(models.get('kimi-k3-1').maxTokens, 32000);
  assert.equal(models.get('hy3').contextWindow, 192000);
  assert.notEqual(models.get('hy3').name, models.get('hy3-x').name);
  assert.ok(!models.has('default-1.2')); // A legacy catalog entry is not in the current CLI menu.
  assert.ok(!models.has('codewise-completions'));
});

test('public aliases take limits and names from their actual upstream target', () => {
  const aliases = readConfig({ BRIDGE_API_KEY: config.apiKey,
    BRIDGE_MODELS: 'wb-kimi=kimi-k3-1,glm-5.1=minimax-m3,custom=custom-model',
    BRIDGE_CLAUDE_MODEL: 'wb-kimi', BRIDGE_CLAUDE_MODEL_NAME: 'My Kimi' });
  const [kimi, minimax, unknown] = piProvider(aliases).models;
  assert.equal(kimi.name, 'My Kimi（workbuddy）');
  assert.equal(kimi.contextWindow, 300000);
  assert.equal(kimi.maxTokens, 32000);
  assert.equal(minimax.name, 'MiniMax-M3（workbuddy）');
  assert.equal(minimax.maxTokens, 64000);
  assert.equal(unknown.contextWindow, 64000);
  assert.equal(unknown.maxTokens, 4096);
});

test('the HTTP model list and pi report the same catalog limits and display names', async () => {
  const all = readConfig({ BRIDGE_API_KEY: config.apiKey });
  const fetcher = handlerFetch(createHandler(all, {}));
  const response = await fetcher('http://local/v1/models', { headers: { 'x-api-key': all.apiKey } });
  assert.equal(response.status, 200);
  const list = (await response.json()).data;
  const pi = piProvider(all).models;
  assert.equal(list.length, workbuddyCatalog.models.length);
  for (const [i, model] of list.entries()) {
    assert.equal(model.id, pi[i].id);
    assert.equal(model.display_name, pi[i].name);
    assert.equal(model.context_window, pi[i].contextWindow);
    assert.equal(model.max_output_tokens, pi[i].maxTokens);
  }
});

test('pi check validates final assistant output and does not trust exit zero or failed tools', () => {
  const event = { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PI_WORKBUDDY_OK' }] } };
  assert.equal(verifyPiCheck(JSON.stringify(event)).pi_text_verified, true);
  for (const stdout of ['', 'PI_WORKBUDDY_OK', JSON.stringify({ ...event, message: { ...event.message, stopReason: 'error' } })]) {
    assert.throws(() => verifyPiCheck(stdout));
  }
  assert.throws(() => verifyPiCheck(JSON.stringify(event), 'PI_WORKBUDDY_OK', true));
  assert.equal(verifyPiCheck(JSON.stringify({ type: 'tool_execution_end', isError: false }) + '\n' + JSON.stringify(event), 'PI_WORKBUDDY_OK', true).pi_tools_verified, true);
});

test('installed pi Anthropic client reads bridge SSE and completes a tool-result round trip', async t => {
  const root = join(homedir(), '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist');
  try { await access(join(root, 'api/anthropic-messages.js')); } catch { t.skip('pi client is not installed'); return; }
  const { stream } = await import(pathToFileURL(join(root, 'api/anthropic-messages.js')));
  const { normalizeContext } = await import(pathToFileURL(join(root, 'utils/transcript.js')));
  let calls = 0;
  const handler = createHandler(config, { completeAnthropic: async input => {
    calls++;
    assert.equal(input.model, 'deepseek-v4.1-flash');
    assert.equal(input.tools[0].name, 'read');
    if (calls === 1) return { content: [{ type: 'tool_use', id: 'tool_test', name: 'read', input: { path: 'hello.txt' } }], stopReason: 'tool_use', usage: null };
    assert.ok(JSON.stringify(input.history).includes('FILE_MARKER'));
    return { content: [{ type: 'text', text: 'PI_WORKBUDDY_OK' }], stopReason: 'end_turn', usage: null };
  } });
  const provider = piProvider(config);
  const model = { ...provider.models[0], provider: 'workbuddy', api: provider.api, baseUrl: provider.baseUrl };
  const context = { systemPrompt: 'Use tools.', tools: [{ name: 'read', description: 'Read a text file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    messages: [{ role: 'user', content: 'Read hello.txt', timestamp: Date.now() }] };
  const options = { apiKey: config.apiKey, fetch: handlerFetch(handler), maxTokens: 1024 };
  const first = await stream(model, normalizeContext(context), options).result();
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  assert.equal(first.content[0].type, 'toolCall');
  assert.deepEqual(first.content[0].arguments, { path: 'hello.txt' });
  context.messages.push(first, { role: 'toolResult', toolCallId: 'tool_test', toolName: 'read',
    content: [{ type: 'text', text: 'FILE_MARKER' }], isError: false, timestamp: Date.now() });
  const final = await stream(model, normalizeContext(context), options).result();
  assert.equal(final.stopReason, 'stop', final.errorMessage);
  assert.equal(final.content[0].text, 'PI_WORKBUDDY_OK');
  assert.equal(calls, 2);
});
