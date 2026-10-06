import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, access } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { inspectPiUnification, applyPiUnification } from '../src/pi-unify.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
try {
  const config = readConfig({ ...process.env, ...parseEnv(await readFile(join(project, '.env'), 'utf8')) });
  const index = args.indexOf('--agent-dir');
  if (index >= 0 && !args[index + 1]) throw new Error('--agent-dir 需要目录参数。');
  const agentDir = resolve(index >= 0 ? args[index + 1] : process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'));
  const extension = join(project, '.pi/extensions/workbuddy.js');
  await access(extension);
  const summary = args.includes('--apply')
    ? await applyPiUnification(agentDir, extension, config)
    : { ...(await inspectPiUnification(agentDir, extension, config)).summary, applied: false };
  console.log(JSON.stringify({ agent_dir: agentDir, ...summary }, null, 2));
  console.log(summary.applied ? 'pi 全局入口已统一。重新运行 pi，在 /model 选择 DeepSeek V4.1 Flash（workbuddy）[workbuddy-cli]。'
    : '以上为扫描方案，未写入全局文件。执行 npm run pi:unify -- --apply 应用。');
} catch (error) {
  console.error(['EPERM', 'EACCES'].includes(error.code)
    ? '当前执行环境不能写入 pi 全局配置；请在普通 macOS 终端执行 npm run pi:unify -- --apply。'
    : error.message);
  process.exitCode = 1;
}
