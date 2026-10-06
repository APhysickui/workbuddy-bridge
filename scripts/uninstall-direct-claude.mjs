import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { directClaudeSettings } from '../src/claude-config.mjs';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
try {
  const backup = JSON.parse(await readFile(join(project, '.runtime/before-direct-settings.json'), 'utf8'));
  const path = join(project, '.claude/settings.local.json');
  const settings = JSON.parse(await readFile(path, 'utf8'));
  const ours = directClaudeSettings(readConfig(), project, process.execPath);
  for (const [key, value] of Object.entries(ours.env)) {
    if (settings.env?.[key] !== value) continue;
    if (Object.hasOwn(backup.env ?? {}, key)) settings.env[key] = backup.env[key];
    else delete settings.env[key];
  }
  const command = ours.hooks.SessionStart[0].hooks[0].command;
  if (settings.hooks?.SessionStart) {
    settings.hooks.SessionStart = settings.hooks.SessionStart.map(entry => ({ ...entry,
      hooks: entry.hooks.filter(hook => hook.command !== command) })).filter(entry => entry.hooks.length);
    settings.hooks.SessionStart.push(...(backup.hooks?.SessionStart ?? []).filter(entry =>
      entry.hooks?.some(hook => hook.command?.includes('scripts/ensure-bridge.mjs'))));
    if (!settings.hooks.SessionStart.length) delete settings.hooks.SessionStart;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  if (settings.env && !Object.keys(settings.env).length) delete settings.env;
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  console.log('已移除项目 WorkBuddy 接入配置，并保留其他设置。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
