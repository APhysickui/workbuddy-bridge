import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, cp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { catalogContextWindow, catalogContextLengths, catalogMaximumContextWindow, workbuddyCatalog } from '../src/model-catalog.mjs';
import { unwrapProductConfig, findWorkBuddyCatalog, importCatalog, planCatalogEnv } from '../src/catalog-refresh.mjs';
import { readConfig } from '../src/config.mjs';
import { piProvider } from '../src/pi-config.mjs';
import { kimiProfile } from '../src/kimi-config.mjs';
import { codexModelCatalog } from '../src/codex-config.mjs';
import { bridgeModelList } from '../src/claude-models.mjs';
const model = id => ({ id, name: id, maxInputTokens: 1000000, maxOutputTokens: 32000,
  contextWindow: { defaultLength: 300000, supportedLengths: [300000, 600000, 1000000] } });
const previous = { defaultModel: 'keep', models: [model('keep'), model('retired')] };
const product = { authentication: { secret: 'DO_NOT_EXPORT' }, endpoint: 'https://private.invalid',
  agents: [{ name: 'cli', models: ['keep', 'new'], modelTags: ['craft'] }],
  models: [model('keep'), { ...model('new'), isDefault: true }, { ...model('hidden'), tags: ['craft'], private: 'DO_NOT_EXPORT' }] };
const timestamp = '2026-11-01T00:00:00.000Z';
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'wb-catalog-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('context budget follows the CLI option-selection rules, never input plus output', () => {
  const m = model('test');
  assert.equal(catalogContextWindow(m), 300000); assert.equal(catalogMaximumContextWindow(m), 1000000);
  const malformed = { ...m, contextWindow: { defaultLength: 400000, supportedLengths: [600000, 300000, 300000, -1, 2000000] } };
  assert.deepEqual(catalogContextLengths(malformed), [300000, 600000]);
  assert.equal(catalogContextWindow(malformed), 300000);
  assert.equal(catalogContextWindow({ ...m, contextWindow: { defaultLength: 300000, supportedLengths: [300000] } }), 1000000);
  assert.equal(catalogContextWindow({ ...m, contextWindow: undefined }), 1000000);
});
test('import selects only explicit CLI IDs, omits secrets and retains the project default', () => {
  const result = importCatalog(product, previous, timestamp);
  assert.deepEqual(result.catalog.models.map(model => model.id), ['keep', 'new']);
  assert.deepEqual(result.changes.added, ['new']); assert.deepEqual(result.changes.removed, ['retired']);
  assert.equal(result.catalog.defaultModel, 'keep'); assert.equal(result.catalog.officialDefaultModel, 'new');
  assert.ok(!JSON.stringify(result.catalog).includes('DO_NOT_EXPORT')); assert.ok(!JSON.stringify(result.catalog).includes('private.invalid'));
  assert.deepEqual(unwrapProductConfig({ 'product-config-snapshot': { savedAt: 1, data: JSON.stringify(product) } }), product);
  assert.deepEqual(importCatalog(product, result.catalog, timestamp).catalog, result.catalog);
});
test('invalid limits, IDs and context options cannot be published', () => {
  for (const mutated of [
    { ...product, agents: [{ name: 'cli', models: ['missing'] }] },
    { ...product, agents: [{ name: 'cli', models: ['keep', 'keep'] }] },
    { ...product, models: [{ ...model('keep'), maxOutputTokens: 2000000 }, model('new')] },
    { ...product, models: [{ ...model('keep'), contextWindow: { defaultLength: 999999, supportedLengths: [300000, 1000000] } }, model('new')] }
  ]) assert.throws(() => importCatalog(mutated, previous, timestamp));
});
test('model env migration preserves auth, line endings, custom aliases and pinned retired defaults', () => {
  const next = importCatalog(product, previous, timestamp).catalog;
  const raw = '# comment\r\nBRIDGE_API_KEY=keep-this-secret\r\nexport BRIDGE_MODELS = "keep=keep,retired=retired"\r\nBRIDGE_CLAUDE_MODEL=keep\r\n';
  const planned = planCatalogEnv(raw, previous, next);
  assert.equal(planned.mode, 'migrated_to_catalog');
  assert.equal(planned.text, raw.replace('"keep=keep,retired=retired"', 'catalog'));
  for (const custom of ['BRIDGE_MODELS=alias=keep\n', 'BRIDGE_MODELS=keep=keep,retired=retired\nBRIDGE_CODEX_MODEL=retired\n']) {
    assert.equal(planCatalogEnv(custom, previous, next).text, custom);
    assert.equal(planCatalogEnv(custom, previous, next).mode, 'explicit_list_preserved');
  }
});
test('cache discovery handles account and scoped formats and skips corrupt newer files', async t => {
  const root = await directory(t); await mkdir(join(root, 'cache'));
  await writeFile(join(root, 'cache', 'acc-product-config-old.json'), JSON.stringify({ 'product-config-snapshot': { data: product } }));
  await utimes(join(root, 'cache', 'acc-product-config-old.json'), 1, 1);
  const scoped = join(root, 'storage', 'user-test', 'scoped', 'session'); await mkdir(scoped, { recursive: true });
  const fresh = join(scoped, 'wb-product-config.json'); await writeFile(fresh, JSON.stringify(product)); await utimes(fresh, 2, 2);
  await writeFile(join(root, 'cache', 'acc-product-config-broken.json'), '{');
  assert.equal((await findWorkBuddyCatalog(root)).path, fresh);
});
test('catalog mode and all client budgets expose defaults, with separate catalog ceilings', () => {
  const config = readConfig({ BRIDGE_API_KEY: 'catalog-test-key-0123456789abcdef', BRIDGE_MODELS: 'catalog' });
  assert.equal(config.models.size, workbuddyCatalog.models.length);
  const pi = piProvider(config).models, codex = codexModelCatalog(config).models, api = bridgeModelList(config);
  const kimi = kimiProfile(config, 'kimi-k3.1-pro');
  for (const id of ['minimax-m3.1-flash', 'kimi-k3.1-pro', 'step-5-preview', 'mimo-v2.6-pro']) {
    assert.equal(pi.find(m => m.id === id).contextWindow, 300000);
    assert.equal(codex.find(m => m.slug === id).context_window, 300000);
    assert.equal(api.find(m => m.id === id).max_input_tokens, 300000);
    assert.equal(api.find(m => m.id === id).catalog_max_input_tokens, 1000000);
    assert.ok(kimi.includes(`[models."workbuddy-bridge/${id}"]`));
  }
  assert.equal(pi.find(m => m.id === 'space-bunny').contextWindow, 1000000);
});
test('refresh command backs up exact private env and imports idempotently without credentials', async t => {
  const root = await directory(t), origin = fileURLToPath(new URL('..', import.meta.url));
  await cp(join(origin, 'src'), join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'scripts')); await cp(join(origin, 'scripts/refresh-models.mjs'), join(root, 'scripts/refresh-models.mjs'));
  await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/models.md'), 'old docs');
  await writeFile(join(root, 'src/workbuddy-models.json'), JSON.stringify(previous));
  await writeFile(join(root, '.env.example'), 'BRIDGE_MODELS=keep=keep,retired=retired\n');
  const env = 'BRIDGE_API_KEY=PRIVATE_KEEP_ME\nBRIDGE_MODELS=keep=keep,retired=retired\nBRIDGE_CLAUDE_MODEL=keep\n';
  await writeFile(join(root, '.env'), env, { mode: 0o600 });
  const source = join(root, 'source.json'); await writeFile(source, JSON.stringify(product));
  const run = () => promisify(execFile)(process.execPath, [join(root, 'scripts/refresh-models.mjs'), '--source', source, '--apply'], { cwd: root });
  const first = (await run()).stdout; const result = JSON.parse(first.slice(first.indexOf('{'), first.lastIndexOf('}') + 1));
  assert.equal(await readFile(join(result.backup, '.env'), 'utf8'), env);
  assert.equal((await stat(join(result.backup, '.env'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), env.replace('keep=keep,retired=retired', 'catalog'));
  assert.ok(!first.includes('PRIVATE_KEEP_ME'));
  assert.ok(!(await readFile(join(root, 'src/workbuddy-models.json'), 'utf8')).includes('DO_NOT_EXPORT'));
  const second = (await run()).stdout; const repeated = JSON.parse(second.slice(second.indexOf('{'), second.lastIndexOf('}') + 1));
  assert.deepEqual(repeated.changed_files, []);
});
