import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.mjs';
import { createHandler } from '../src/server.mjs';
import { claudeModelId, claudeRouteModels } from '../src/claude-models.mjs';
import { directClaudeSettings } from '../src/claude-config.mjs';
import { handlerFetch } from './helpers.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef',
  BRIDGE_CLAUDE_MODEL: 'deepseek-v4.1-flash', BRIDGE_CLAUDE_PASSTHROUGH: '1' });

test('Claude discovery lists all WorkBuddy models with recognized aliases and the requested labels', async () => {
  const fetcher = handlerFetch(createHandler(config, {}));
  const headers = { authorization: `Bearer ${config.apiKey}`, 'anthropic-version': '2023-06-01' };
  const response = await fetcher('http://local/v1/models?limit=1000', { headers });
  const list = (await response.json()).data;
  assert.equal(list.length, 19);
  assert.ok(list.every(model => /(claude|anthropic)/i.test(model.id) && model.display_name.endsWith('（workbuddy）')));
  assert.equal(new Set(list.map(model => model.id)).size, 19);
  assert.ok(list.some(model => model.id === 'claude-workbuddy-kimi-k3-1' && model.display_name === 'Kimi-K3（workbuddy）'));
  assert.equal(response.headers.get('vary'), 'anthropic-version');
  const openai = await fetcher('http://local/v1/models', { headers: { authorization: headers.authorization } });
  assert.ok((await openai.json()).data.some(model => model.id === 'kimi-k3-1'));
  const denied = await fetcher('http://local/v1/models', { headers: { ...headers, authorization: 'Bearer wrong-key' } });
  assert.equal(denied.status, 401);
});

test('all discovered Claude aliases route to their actual official models and return the public alias', async () => {
  let received;
  let forwarded = 0;
  const fetcher = handlerFetch(createHandler({ ...config, originalProvider: {} }, {
    completeAnthropic: async input => {
      received = input;
      return { content: [{ type: 'text', text: 'fixture reply' }], stopReason: 'end_turn', usage: null };
    }
  }, () => { forwarded++; throw new Error('must not forward a WorkBuddy alias'); }));
  for (const [id, upstreamId] of config.models) {
    const model = claudeModelId(id);
    const response = await fetcher('http://local/v1/messages', { method: 'POST',
      headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(response.status, 200);
    assert.equal(received.model, upstreamId);
    assert.equal((await response.json()).model, model);
  }
  assert.equal(forwarded, 0);
  const count = await fetcher('http://local/v1/messages/count_tokens', { method: 'POST',
    headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: claudeModelId('glm-5.3'), messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(count.status, 200);
  assert.equal(forwarded, 0);
});

test('Claude enables discovery without an allowlist, default override, tier remapping or caching change', () => {
  const settings = directClaudeSettings(config, '/project', '/node');
  assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'claude-workbuddy-deepseek-v4.1-flash');
  assert.equal(settings.model, undefined);
  assert.equal(settings.availableModels, undefined);
  assert.equal(settings.modelPicker, undefined);
  assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
  assert.ok(!Object.keys(settings.env).some(key => key.startsWith('ANTHROPIC_DEFAULT_') || key.startsWith('DISABLE_PROMPT_CACHING')));
});

test('a conflicting explicit alias never silently replaces another configured route', () => {
  assert.throws(() => claudeRouteModels({ models: new Map([
    ['glm-5.3', 'glm-5.3'], ['claude-workbuddy-glm-5.3', 'minimax-m3']
  ]) }), /Conflicting/);
});
