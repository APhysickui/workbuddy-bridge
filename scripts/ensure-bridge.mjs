import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.mjs';
import { matchingBridge } from '../src/bridge-service.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
try {
  const config = readConfig();
  if (!config.claudeModel || !config.models.has(config.claudeModel)) throw new Error('未配置 BRIDGE_CLAUDE_MODEL。');
  if (await matchingBridge(config)) process.exit(0);
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  const log = await open(join(config.runtimeDir, 'bridge.log'), 'a', 0o600);
  let launchFailed = false;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_')));
  const child = spawn(process.execPath, [`--env-file=${join(project, '.env')}`, join(project, 'src/main.mjs')], {
    cwd: project, env: { ...env, BRIDGE_BACKEND: 'workbuddy' },
    detached: true, stdio: ['ignore', log.fd, log.fd], shell: false
  });
  child.on('error', () => { launchFailed = true; });
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(250);
    if (await matchingBridge(config)) {
      console.log(JSON.stringify({ systemMessage: `WorkBuddy 桥接已自动启动 · ${config.claudeModelName ?? config.claudeModel}` }));
      process.exit(0);
    }
    if (launchFailed) break;
  }
  throw new Error('WorkBuddy 桥接未能启动，请检查 .runtime/bridge.log。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
