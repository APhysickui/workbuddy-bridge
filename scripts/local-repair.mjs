import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.mjs';
import { installKimi } from '../src/kimi-install.mjs';
import { ensureBridge, runClient } from '../src/launcher.mjs';
import { stopKnownBridge } from '../src/bridge-service.mjs';
import { verifyPiCheck, PI_PROVIDER_ID } from '../src/pi-config.mjs';
import { kimiPromptArgs, verifyKimiCheck, KIMI_CHECK_REPLY } from '../src/kimi-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
const execute = promisify(execFile);
let temporary;
let report;
const reportPath = join(project, '.runtime/local-repair-result.json');
async function record(stage, checks = {}) {
  report.stage = stage;
  report.updated_at = new Date().toISOString();
  Object.assign(report.checks, checks);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
try {
  const config = readConfig();
  if (config.backend !== 'workbuddy') throw new Error('修复命令需要 BRIDGE_BACKEND=workbuddy。');
  const planOnly = process.argv.includes('--plan');
  const onlyKimiTools = process.argv.includes('--kimi-tools-only');
  if (planOnly && onlyKimiTools) throw new Error('--plan 与 --kimi-tools-only 不能同时使用。');
  const kimiDir = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
  if (!planOnly) {
    await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
    let previous;
    if (onlyKimiTools) {
      previous = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => null);
      if (!previous || !['kimi_configuration', 'bridge_started', 'pi_text', 'pi_tools', 'kimi_text'].every(key => previous.checks?.[key] === true)) {
        throw new Error('尚无已通过的前三项验收，请先运行 npm run local:repair。');
      }
    }
    report = { status: 'running', started_at: new Date().toISOString(), checks: previous ? { ...previous.checks } : {} };
    delete report.checks.kimi_tools;
    if (previous) report.previous_started_at = previous.started_at;
    await record(onlyKimiTools ? 'kimi_tools' : 'kimi_configuration');
  }
  const installed = await installKimi(kimiDir, config, project, process.execPath, { apply: !planOnly && !onlyKimiTools,
    validate: path => execute('kimi', ['doctor', 'config', path], { timeout: 10000 }) });
  if (!onlyKimiTools) console.log(JSON.stringify({ kimi_configuration: installed }, null, 2));
  if (planOnly) {
    console.log('仅检查，未修改配置或调用模型。执行 npm run local:repair 会备份并更新普通 Kimi 配置、重启桥接、验证 pi 与 Kimi 的真实回复和文件读取；会消耗积分。');
  } else {
    if (!onlyKimiTools) {
      console.log('Kimi 配置已备份并更新。重启本项目桥接，使客户端读取最新代码。');
      await record('bridge_restart', { kimi_configuration: true });
      await stopKnownBridge(config);
    } else console.log('保留已通过的三项真实验收，重试 Kimi 文件读取。');
    await ensureBridge(project);
    await record(onlyKimiTools ? 'kimi_tools' : 'pi_text', { bridge_started: true });
    temporary = await mkdtemp(join(config.runtimeDir, 'repair-check-'));
    const marker = 'WORKBUDDY_REPAIR_' + randomUUID();
    const file = join(temporary, 'check.txt');
    await writeFile(file, marker, { mode: 0o600 });
    const options = { cwd: temporary, capture: true, allowFailure: true, timeout: config.timeoutMs * 3 };
    const pi = ['--provider', PI_PROVIDER_ID, '--model', config.claudeModel, '-e', join(project, '.pi/extensions/workbuddy.js'),
      '--print', '--mode', 'json', '--no-session', '--tools', 'read', '--no-mcp', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--offline'];
    if (!onlyKimiTools) {
      console.log('验证 pi 普通回复（保留 read 工具），会调用真实模型。');
      console.log(JSON.stringify(verifyPiCheck(await runClient('pi', [...pi, 'Reply with PI_WORKBUDDY_OK only.'], options))));
      await record('pi_tools', { pi_text: true });
      console.log('验证 pi 实际读取临时随机文件。');
      console.log(JSON.stringify(verifyPiCheck(await runClient('pi', [...pi, `Read ${file} with the read tool and reply with its exact contents only.`], options), marker, true)));
      await record('kimi_text', { pi_tools: true });
    }
    const kimiModel = `${installed.provider}/${installed.model}`;
    const kimiOptions = { ...options, env: { ...process.env, KIMI_CODE_HOME: kimiDir,
      NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' } };
    if (!onlyKimiTools) {
      console.log('验证普通 Kimi 配置下的真实回复。');
      console.log(JSON.stringify(verifyKimiCheck(await runClient('kimi', kimiPromptArgs(kimiModel, `Reply with ${KIMI_CHECK_REPLY} only.`), kimiOptions))));
      await record('kimi_tools', { kimi_text: true });
    }
    console.log('验证 Kimi 实际读取临时随机文件。');
    console.log(JSON.stringify(verifyKimiCheck(await runClient('kimi', kimiPromptArgs(kimiModel,
      `Use the file-reading tool to read ${file} and reply with its exact contents only. Do not guess.`), kimiOptions), marker, true)));
    report.status = 'success';
    await record('complete', { kimi_tools: true });
    console.log('LOCAL_REPAIR_OK：pi / Kimi 的真实文字和文件读取均通过。退出旧客户端后，直接重新运行 pi 或 kimi。');
  }
} catch (error) {
  if (report) { report.status = 'failed'; report.error_code = error.code ?? 'verification_failed'; await record(report.stage).catch(() => {}); }
  console.error(['EPERM', 'EACCES'].includes(error.code) ? '当前执行环境不能写入全局配置或连接本地端口；请在普通终端运行 npm run local:repair。'
    : error.message.startsWith('Command failed:') ? 'Kimi 配置验证失败，原配置未替换。' : error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
