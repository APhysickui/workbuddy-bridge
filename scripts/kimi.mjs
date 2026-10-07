import { mkdir, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { ensureBridge, runClient } from '../src/launcher.mjs';
import { kimiAlias, kimiProfile, kimiEnvironment, checkKimiUpstream, verifyKimiCheck, KIMI_CHECK_REPLY } from '../src/kimi-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv.slice(2);
let temporary;
try {
  const config = readConfig();
  config.runtimeDir = join(project, '.runtime');
  if (config.backend !== 'workbuddy') throw new Error('Kimi 启动器需要 BRIDGE_BACKEND=workbuddy；先确认官方 CodeBuddy 能正常回复。');
  let cwd = project;
  let model = config.models.has('kimi-k3-1') ? 'kimi-k3-1' : config.claudeModel;
  const check = input.includes('--check');
  const forwarded = [];
  for (let i = 0; i < input.length; i++) {
    if (['--cwd', '--model', '-m'].includes(input[i])) {
      const option = input[i];
      const value = input[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} 需要参数。`);
      if (option === '--cwd') cwd = resolve(value);
      else model = value.replace(/^workbuddy-bridge\//, '');
    } else if (input[i] !== '--check') forwarded.push(input[i]);
  }
  const profileDir = join(config.runtimeDir, 'kimi-profile');
  const profile = kimiProfile(config, model);
  if (check && forwarded.length) throw new Error('kimi:check 不接收额外的 Kimi 会话参数。');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const path = join(profileDir, 'config.toml');
  await writeFile(path, profile, { mode: 0o600 });
  await chmod(path, 0o600);
  const env = kimiEnvironment(config, profileDir);
  await ensureBridge(project);
  console.log(`检查 WorkBuddy → ${model} 的真实短回复（可能消耗积分）；成功后才启动 Kimi。`);
  await checkKimiUpstream(config, model);
  console.log(`预检通过。Kimi 使用本项目 profile，model=${model}；默认开启新会话。`);
  if (!check) {
    await runClient('kimi', ['--model', kimiAlias(model), ...forwarded], { cwd, env });
  } else {
    temporary = await mkdtemp(join(config.runtimeDir, 'kimi-check-'));
    const options = { cwd: temporary, env, capture: true, timeout: config.timeoutMs * 3 };
    const common = ['--model', kimiAlias(model), '--output-format', 'stream-json'];
    const text = await runClient('kimi', [...common, '--prompt', `Reply with ${KIMI_CHECK_REPLY} only.`], options);
    console.log(JSON.stringify(verifyKimiCheck(text)));
    const marker = 'KIMI_WORKBUDDY_FILE_' + randomUUID();
    const file = join(temporary, 'check.txt');
    await writeFile(file, marker, { mode: 0o600 });
    const tools = await runClient('kimi', [...common, '--yolo', '--prompt',
      `Use the file-reading tool to read ${file} and reply with its exact contents only. Do not guess the contents.`], options);
    console.log(JSON.stringify(verifyKimiCheck(tools, marker, true)));
    console.log('Kimi 的真实文字回复及文件读取往返均通过。');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
