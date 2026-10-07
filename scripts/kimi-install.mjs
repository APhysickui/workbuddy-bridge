import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../src/config.mjs';
import { installKimi } from '../src/kimi-install.mjs';

const execute = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const config = readConfig();
  if (config.backend !== 'workbuddy') throw new Error('普通 Kimi 接入需要 BRIDGE_BACKEND=workbuddy，未改配置。');
  const apply = process.argv.includes('--apply');
  const directory = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
  const result = await installKimi(directory, config, project, process.execPath, { apply,
    validate: path => execute('kimi', ['doctor', 'config', path], { timeout: 10000 }) });
  console.log(JSON.stringify(result, null, 2));
  console.log(apply ? '已配置普通 kimi；退出旧会话后重新启动。服务将在会话开始时自动检查并启动。'
    : '以上为检查结果，未改配置。退出 Kimi 后运行 npm run kimi:install -- --apply。');
} catch (error) {
  const restricted = ['EPERM', 'EACCES'].includes(error.code);
  console.error(restricted ? '当前环境不能修改全局 Kimi 配置；请在普通终端运行 npm run kimi:install -- --apply。' :
    error.message.startsWith('Command failed:') ? 'Kimi 配置验证未通过，原配置未修改。' : error.message);
  process.exitCode = 1;
}
