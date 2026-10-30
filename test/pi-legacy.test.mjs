import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPiLegacyCompatibility } from '../src/pi-legacy.mjs';
const config = { models: new Map([['deepseek-v4.1-flash', 'deepseek-v4.1-flash'], ['kimi-k3-1', 'kimi-k3-1']]) };
async function setup(t, providers) {
  const directory = await mkdtemp(join(tmpdir(), 'wb-pi-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json'), raw = JSON.stringify({ providers });
  await writeFile(file, raw);
  const registered = new Map(), handlers = new Map(), changes = [], notifications = [];
  const target = { provider: 'workbuddy-cli', id: 'deepseek-v4.1-flash' };
  const api = { registerProvider(id, provider) { registered.set(id, provider); }, on(event, handler) { handlers.set(event, handler); },
    async setModel(model) { changes.push(model); return true; } };
  registerPiLegacyCompatibility(api, config, current => ({ models: [...current.models].map(([id]) => ({ id, name: id })), current }), directory);
  const ctx = model => ({ model, modelRegistry: { find(provider, id) { return { provider, id }; } }, ui: { notify(message) { notifications.push(message); } } });
  return { file, raw, registered, handlers, changes, notifications, ctx, target };
}

test('owned dead provider is redirected in memory and its old Flash selection migrates explicitly', async t => {
  const f = await setup(t, { workbuddy: { baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'private-test-key' } });
  assert.equal(f.registered.get('workbuddy').current.models.get('deepseek-v4-flash'), 'deepseek-v4.1-flash');
  await f.handlers.get('session_start')({}, f.ctx({ provider: 'workbuddy', id: 'deepseek-v4-flash' }));
  assert.deepEqual(f.changes, [f.target]); assert.match(f.notifications[0], /deepseek-v4.1-flash/);
  assert.equal(await readFile(f.file, 'utf8'), f.raw);
  assert.ok(!f.notifications.join('').includes('private-test-key'));
});
test('same-name remote provider is never intercepted', async t => {
  const f = await setup(t, { workbuddy: { baseUrl: 'https://user-provider.example/v1' } });
  assert.equal(f.registered.size, 0); assert.equal(f.handlers.size, 0);
});
test('other providers and already-current selections retain their chosen models', async t => {
  const f = await setup(t, { workbuddy: { baseUrl: 'http://localhost:8799/v1' } });
  for (const model of [{ provider: 'cc-switch-deep-seek', id: 'deepseek-v4-flash' }, f.target]) {
    await f.handlers.get('session_start')({}, f.ctx(model));
  }
  assert.equal(f.changes.length, 0);
  await f.handlers.get('model_select')({}, f.ctx({ provider: 'workbuddy', id: 'kimi-k3-1' }));
  assert.deepEqual(f.changes, [{ provider: 'workbuddy-cli', id: 'kimi-k3-1' }]);
});
test('an explicitly configured old ID is kept instead of silently changing its upstream model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-pi-id-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { workbuddy: { baseUrl: 'http://127.0.0.1:8799/v1' } } }));
  let current;
  registerPiLegacyCompatibility({ registerProvider(_id, provider) { current = provider; }, on() {} },
    { models: new Map([['deepseek-v4-flash', 'explicit-upstream-id']]) }, c => ({
      models: [...c.models].map(([id]) => ({ id, name: id })), upstreams: c.models }), directory);
  assert.equal(current.upstreams.get('deepseek-v4-flash'), 'explicit-upstream-id');
});
