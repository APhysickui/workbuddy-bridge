import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.mjs';
import { stopKnownBridge, readBridgeStatus } from '../src/bridge-service.mjs';
import { ensureBridge } from '../src/launcher.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
try {
  const config = readConfig();
  if (await stopKnownBridge(config)) {
    let stopped = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(100);
      if (!await readBridgeStatus(config)) { stopped = true; break; }
    }
    if (!stopped) throw new Error('旧桥接服务尚未退出，未启动第二个实例。');
  }
  await ensureBridge(project);
  console.log('桥接已加载最新模型目录。现在运行 claude，再 /model 选择（workbuddy）模型。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
