import { directClaudeSettings } from '../src/claude-config.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { readOriginalProvider } from '../src/passthrough.mjs';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
try {
  const config = readConfig();
  await readOriginalProvider(config);
  const additions = directClaudeSettings(config, project, process.execPath);
  const path = join(project, '.claude/settings.local.json');
  const old = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; });
  const settings = JSON.parse(old);
  const startup = (settings.hooks?.SessionStart ?? []).filter(entry =>
    !entry.hooks?.some(hook => hook.command?.includes('scripts/ensure-bridge.mjs')));
  const next = { ...settings, env: { ...settings.env, ...additions.env },
    hooks: { ...settings.hooks, SessionStart: [...startup, ...additions.hooks.SessionStart] } };
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(join(config.runtimeDir, 'before-direct-settings.json'), old, { mode: 0o600, flag: 'wx' })
    .catch(error => { if (error.code !== 'EEXIST') throw error; });
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  console.log(`已启用项目 Claude 模型发现：${config.models.size} 个（workbuddy）入口；原模型菜单保留。`);
  console.log('在本目录运行 claude，然后 /model 选择 WorkBuddy。实际联机检查：npm run integration:check。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
