import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPiUnification, applyPiUnification } from '../src/pi-unify.mjs';

const config = { claudeModel: 'deepseek-v4.1-flash', claudeModelName: 'DeepSeek V4.1 Flash（workbuddy）', models: new Map([['deepseek-v4.1-flash', 'deepseek-v4.1-flash']]) };
const models = { customRoot: 'preserved', providers: {
  packy: { apiKey: 'existing-secret', baseUrl: 'https://original.example/v1', models: [{ id: 'deepseek-v4-flash' }] },
  workbuddy: { apiKey: 'old-local-secret', baseUrl: 'http://127.0.0.1:8799/v1', models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }
} };
const settings = { defaultProvider: 'qoder-cn', defaultModel: 'DeepSeek-Flash', packages: ['npm:qoder'], theme: 'dark',
  extensions: ['/extensions/other.js'] };
const extension = '/project/.pi/extensions/workbuddy.js';

test('global unification removes the known dead bridge and preserves other provider credentials, models, defaults and packages', () => {
  const plan = planPiUnification(models, settings, extension, config, '/agent');
  assert.equal(plan.models.providers.workbuddy, undefined);
  assert.deepEqual(plan.models.providers.packy, models.providers.packy);
  assert.equal(plan.models.customRoot, 'preserved');
  assert.equal(plan.settings.defaultProvider, 'qoder-cn');
  assert.equal(plan.settings.defaultModel, 'DeepSeek-Flash');
  assert.deepEqual(plan.settings.packages, settings.packages);
  assert.deepEqual(plan.settings.extensions, [...settings.extensions, extension]);
  assert.equal(plan.summary.default_preserved, true);
  assert.ok(!JSON.stringify(plan.summary).includes('existing-secret'));
  assert.ok(!JSON.stringify(plan.summary).includes('old-local-secret'));
});

test('an old WorkBuddy default migrates to V4.1; unrelated remote providers are never removed by name alone', () => {
  const plan = planPiUnification(models, { ...settings, defaultProvider: 'workbuddy', defaultModel: 'deepseek-v4-flash' }, extension, config, '/agent');
  assert.equal(plan.settings.defaultProvider, 'workbuddy-cli');
  assert.equal(plan.settings.defaultModel, 'deepseek-v4.1-flash');
  const remote = { providers: { workbuddy: { ...models.providers.workbuddy, baseUrl: 'https://my-provider.example/v1' } } };
  assert.deepEqual(planPiUnification(remote, settings, extension, config, '/agent').models, remote);
});

test('global application backs up exact original bytes, preserves new changes and is idempotent', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'wb-unify-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const rawModels = JSON.stringify(models) + '\n';
  const latest = { ...settings, freshUserSetting: 'keep-me' };
  const rawSettings = JSON.stringify(latest, null, 3);
  await writeFile(join(agentDir, 'models.json'), rawModels);
  await writeFile(join(agentDir, 'settings.json'), rawSettings);
  const result = await applyPiUnification(agentDir, extension, config);
  assert.equal(await readFile(join(result.backup, 'models.json'), 'utf8'), rawModels);
  assert.equal(await readFile(join(result.backup, 'settings.json'), 'utf8'), rawSettings);
  assert.equal(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).freshUserSetting, 'keep-me');
  const second = await applyPiUnification(agentDir, extension, config);
  assert.equal(second.backup, null);
  assert.deepEqual(second.changes, { models: false, settings: false });
  assert.ok(!(await readdir(agentDir)).some(name => name.endsWith('.lock')));
});

test('a pi settings lock leaves both files untouched and never removes someone else’s lock', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'wb-unify-lock-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const rawModels = JSON.stringify(models);
  await writeFile(join(agentDir, 'models.json'), rawModels);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(settings));
  await mkdir(join(agentDir, 'settings.json.lock'));
  await assert.rejects(applyPiUnification(agentDir, extension, config), /正在被写入/);
  assert.equal(await readFile(join(agentDir, 'models.json'), 'utf8'), rawModels);
  assert.ok((await readdir(agentDir)).includes('settings.json.lock'));
  assert.ok(!(await readdir(agentDir)).includes('models.json.lock'));
});
