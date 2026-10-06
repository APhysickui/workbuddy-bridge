import { mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PI_PROVIDER_ID } from './pi-config.mjs';

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function ownedLegacyProvider(id, provider) {
  if (!['workbuddy', PI_PROVIDER_ID].includes(id)) return false;
  try {
    const url = new URL(provider.baseUrl);
    return ['http:', 'https:'].includes(url.protocol) &&
      (url.hostname === 'workbuddy-cli.local' ||
       (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['8799', '18765'].includes(url.port)));
  } catch { return false; }
}

export function planPiUnification(models, settings, extension, config, agentDir) {
  if (!object(models) || !object(settings) || (models.providers !== undefined && !object(models.providers))) throw new Error('pi 配置必须为 JSON 对象。');
  if (settings.extensions !== undefined && !Array.isArray(settings.extensions)) throw new Error('pi settings.extensions 不是数组，未修改配置。');
  const providers = { ...models.providers };
  const removed = [];
  for (const [id, provider] of Object.entries(providers)) {
    if (!ownedLegacyProvider(id, provider)) continue;
    removed.push({ provider: id, baseUrl: provider.baseUrl, models: provider.models?.map(model => model.id) ?? [] });
    delete providers[id];
  }
  const nextModels = removed.length ? { ...models, providers } : structuredClone(models);
  const matchesExtension = value => typeof value === 'string' && !value.startsWith('builtin:') &&
    resolve(agentDir, value.replace(/^[+-]/, '')) === extension;
  const nextSettings = { ...settings, extensions: [...(settings.extensions ?? []).filter(value => !matchesExtension(value)), extension] };
  if (removed.some(item => item.provider === settings.defaultProvider) ||
      (settings.defaultProvider === PI_PROVIDER_ID && !config.models.has(settings.defaultModel))) {
    nextSettings.defaultProvider = PI_PROVIDER_ID;
    nextSettings.defaultModel = config.claudeModel;
  }
  return { models: nextModels, settings: nextSettings,
    summary: { removed, preserved_providers: Object.keys(providers), provider: PI_PROVIDER_ID,
      model: config.claudeModel, name: config.claudeModelName, transport: 'direct_official_cli_no_local_port', extension,
      default_preserved: nextSettings.defaultProvider === settings.defaultProvider && nextSettings.defaultModel === settings.defaultModel,
      changes: { models: JSON.stringify(models) !== JSON.stringify(nextModels), settings: JSON.stringify(settings) !== JSON.stringify(nextSettings) } } };
}

async function readDocument(path, fallback) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { raw: null, value: fallback }; }
  try { return { raw, value: JSON.parse(raw) }; }
  catch { throw new Error(`pi 配置不是有效 JSON：${path}。未修改配置。`); }
}

export async function inspectPiUnification(agentDir, extension, config) {
  const models = await readDocument(join(agentDir, 'models.json'), {});
  const settings = await readDocument(join(agentDir, 'settings.json'), {});
  return { ...planPiUnification(models.value, settings.value, extension, config, agentDir), originals: { models, settings } };
}

async function atomicWrite(path, data) {
  // Follow an existing symlink so integrations managing that file keep their link.
  const target = await realpath(path).catch(error => { if (error.code === 'ENOENT') return path; throw error; });
  const temp = target + '.workbuddy-' + randomUUID();
  try { await writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await rename(temp, target); }
  finally { await rm(temp, { force: true }); }
}

export async function applyPiUnification(agentDir, extension, config) {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const locks = [];
  const written = [];
  let plan;
  try {
    for (const name of ['models.json', 'settings.json']) {
      const lock = join(agentDir, name + '.lock');
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('pi 配置正在被写入。退出 pi 后重新运行统一命令。'); throw error; }
      locks.push(lock);
    }
    // Read after locking; a stale review never overwrites more recent user changes.
    plan = await inspectPiUnification(agentDir, extension, config);
    if (!Object.values(plan.summary.changes).some(Boolean)) return { ...plan.summary, applied: true, backup: null };
    const backup = join(agentDir, 'workbuddy-bridge-backups', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const name of ['models', 'settings']) {
      if (plan.originals[name].raw !== null) await writeFile(join(backup, name + '.json'), plan.originals[name].raw, { mode: 0o600 });
    }
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({ extension,
      originally_missing: ['models', 'settings'].filter(name => plan.originals[name].raw === null) }, null, 2), { mode: 0o600 });
    for (const name of ['models', 'settings']) {
      if (!plan.summary.changes[name]) continue;
      await atomicWrite(join(agentDir, name + '.json'), JSON.stringify(plan[name], null, 2) + '\n');
      written.push(name);
    }
    return { ...plan.summary, applied: true, backup };
  } catch (error) {
    for (const name of written.reverse()) {
      const raw = plan.originals[name].raw;
      if (raw === null) await rm(join(agentDir, name + '.json'), { force: true });
      else await atomicWrite(join(agentDir, name + '.json'), raw);
    }
    throw error;
  } finally {
    for (const lock of locks) await rm(lock, { recursive: true, force: true });
  }
}
