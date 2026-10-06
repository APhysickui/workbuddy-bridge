import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingBridge, bridgeIdentity, stopKnownBridge } from '../src/bridge-service.mjs';

const config = { port: 18765, apiKey: 'test-local-key', claudeModel: 'deepseek-v4-flash', models: new Map([['deepseek-v4-flash', 'deepseek-v4-flash']]) };
test('startup recognizes only an authenticated bridge with the correct backend and model', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18765/_bridge/status');
    assert.equal(options.headers.authorization, 'Bearer test-local-key');
    return { ok: true, json: async () => bridgeIdentity({ ...config, backend: 'workbuddy' }) };
  };
  assert.equal(await matchingBridge(config, fetcher), true);
  await assert.rejects(matchingBridge(config, async () => ({ ok: false })), /密钥或服务接口不匹配/);
  for (const status of [
    { bridge: 'workbuddy-bridge', backend: 'mock', models: { 'deepseek-v4-flash': 'deepseek-v4-flash' } },
    { bridge: 'workbuddy-bridge', backend: 'workbuddy', models: { 'deepseek-v4-flash': 'another-model' } },
    { ...bridgeIdentity({ ...config, backend: 'workbuddy' }), protocol: 1 },
    { ...bridgeIdentity({ ...config, backend: 'workbuddy' }), cli_path: '/old/codebuddy' },
    { ...bridgeIdentity({ ...config, backend: 'workbuddy' }), claude_passthrough: true }
  ]) await assert.rejects(matchingBridge(config, async () => ({ ok: true, json: async () => status })), /后端或模型不匹配/);
});

test('missing service may be started, while a sandbox restriction stops startup', async () => {
  assert.equal(await matchingBridge(config, async () => { throw Object.assign(new Error(), { cause: { code: 'ECONNREFUSED' } }); }), false);
  await assert.rejects(matchingBridge(config, async () => { throw Object.assign(new Error(), { cause: { code: 'EPERM' } }); }), /不允许连接本地端口/);
});

test('an authenticated older bridge can be stopped after its protocol or model table changes', async () => {
  const calls = [];
  const stopped = await stopKnownBridge(config, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.authorization, `Bearer ${config.apiKey}`);
    if (calls.length === 1) return { ok: true, json: async () => ({ bridge: 'workbuddy-bridge', protocol: 2, models: { old: 'old' } }) };
    assert.equal(options.method, 'POST');
    return { ok: true };
  });
  assert.equal(stopped, true);
  assert.equal(calls[1], `http://127.0.0.1:${config.port}/_bridge/shutdown`);
});

test('a wrong key or an unrelated service is never shut down', async () => {
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ bridge: 'another-service' }) }]) {
    let calls = 0;
    await assert.rejects(stopKnownBridge(config, async () => { calls++; return response; }));
    assert.equal(calls, 1);
  }
});
