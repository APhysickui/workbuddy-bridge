import { readFile, writeFile, mkdir, stat, rename, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { workbuddyCatalog } from '../src/model-catalog.mjs';
import { findWorkBuddyCatalog, unwrapProductConfig, importCatalog, planCatalogEnv, renderModelDocs } from '../src/catalog-refresh.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function atomicWrite(path, text, mode) {
  const temp = path + '.refresh-' + randomUUID();
  try { await writeFile(temp, text, { flag: 'wx', mode }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
try {
  const args = process.argv.slice(2); let source, directory, apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (['--source', '--workbuddy-dir'].includes(args[i])) {
      const key = args[i], value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${key} 需要路径参数。`);
      if (key === '--source') source = resolve(value); else directory = resolve(value);
    } else throw new Error('Usage: npm run models:refresh -- [--source <official.json> | --workbuddy-dir <dir>] [--apply]');
  }
  let input;
  if (source) {
    const product = unwrapProductConfig(JSON.parse(await readFile(source, 'utf8')));
    if (!product) throw new Error('指定文件不包含官方模型/agent 配置。');
    input = { product, savedAt: (await stat(source)).mtime.toISOString() };
  } else input = await findWorkBuddyCatalog(directory);
  const { catalog, changes } = importCatalog(input.product, workbuddyCatalog, input.savedAt);
  const originals = new Map(), updates = new Map();
  async function add(name, text) { originals.set(name, await readFile(join(project, name), 'utf8')); updates.set(name, text); }
  await add('src/workbuddy-models.json', JSON.stringify(catalog, null, 2) + '\n');
  await add('docs/models.md', renderModelDocs(catalog));
  const example = await readFile(join(project, '.env.example'), 'utf8');
  const selected = catalog.models.find(model => model.id === catalog.defaultModel);
  const label = selected.displayName ?? selected.name;
  await add('.env.example', example.replace(/^BRIDGE_MODELS=.*$/m, 'BRIDGE_MODELS=catalog')
    .replace(/^BRIDGE_CLAUDE_MODEL=.*$/m, `BRIDGE_CLAUDE_MODEL=${catalog.defaultModel}`)
    .replace(/^BRIDGE_CLAUDE_MODEL_NAME=.*$/m, `BRIDGE_CLAUDE_MODEL_NAME=${label.endsWith('（workbuddy）') ? label : label + '（workbuddy）'}`));
  let envMode = 'missing_uses_catalog';
  try {
    const raw = await readFile(join(project, '.env'), 'utf8');
    const planned = planCatalogEnv(raw, workbuddyCatalog, catalog); envMode = planned.mode;
    if (planned.text !== raw) { originals.set('.env', raw); updates.set('.env', planned.text); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [name, text] of updates) if (text === originals.get(name)) updates.delete(name);
  const summary = { snapshot: catalog.snapshotSavedAt, models: catalog.models.length, ...changes,
    default_model: catalog.defaultModel, official_default_model: catalog.officialDefaultModel, env_mode: envMode,
    changed_files: [...updates.keys()], applied: false };
  if (apply && updates.size) {
    const backup = join(project, '.runtime', 'model-refresh-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const name of updates.keys()) {
      const path = join(backup, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, originals.get(name), { mode: 0o600 });
    }
    const written = [];
    try {
      for (const [name, text] of updates) {
        if (await readFile(join(project, name), 'utf8') !== originals.get(name)) throw new Error(`文件 ${name} 在刷新过程中发生变化，未覆盖新内容，请重试。`);
        const mode = name === '.env' ? 0o600 : (await stat(join(project, name))).mode & 0o777;
        await atomicWrite(join(project, name), text, mode); written.push(name);
      }
    } catch (error) {
      for (const name of written.reverse()) {
        if (await readFile(join(project, name), 'utf8') === updates.get(name)) await atomicWrite(join(project, name), originals.get(name), name === '.env' ? 0o600 : 0o644);
      }
      throw error;
    }
    summary.backup = backup;
  }
  summary.applied = apply;
  console.log(JSON.stringify(summary, null, 2));
  console.log(apply ? '模型目录已更新。pi /reload；HTTP 客户端先 npm run bridge:restart，再重开 Kimi / Codex / Claude。'
    : '以上为预览，未修改文件。使用 --apply 应用并备份。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
