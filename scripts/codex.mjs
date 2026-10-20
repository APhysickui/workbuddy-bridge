import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.mjs';
import { ensureBridge, runClient } from '../src/launcher.mjs';
import { codexArguments, codexEnvironment, codexCatalogFile, codexModelCatalog, selectedCodexModel, verifyCodexCheck } from '../src/codex-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let temporary;
try {
  // Read the project's .env even when the user's agent workspace is elsewhere.
  const config = readConfig();
  config.runtimeDir = join(project, '.runtime');
  if (config.backend !== 'workbuddy') throw new Error('Codex 接入需要 BRIDGE_BACKEND=workbuddy；演示回复不能证明真实连接。');
  let model, cwd = project, check = false;
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { forwarded.push(...args.slice(i + 1)); break; }
    if (args[i] === '--check') check = true;
    else if (['--model', '-m', '--cwd'].includes(args[i])) {
      const option = args[i], value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} 需要参数。`);
      if (option === '--cwd') cwd = resolve(value); else model = value;
    } else forwarded.push(args[i]);
  }
  model = selectedCodexModel(config, model);
  if (check && forwarded.length) throw new Error('codex:check 不接收额外 Codex 参数。');
  const catalog = codexCatalogFile(config);
  await mkdir(dirname(catalog), { recursive: true, mode: 0o700 });
  await writeFile(catalog, JSON.stringify(codexModelCatalog(config)) + '\n', { mode: 0o600 });
  await ensureBridge(project);
  const env = codexEnvironment(config);
  console.log(`WorkBuddy → Codex: model=${model}, Responses + client tools；使用本次启动参数，保留全局配置。`);
  if (!check) {
    const invocation = codexArguments(config, catalog, model, forwarded);
    await runClient('codex', invocation, { cwd, env });
  } else {
    console.log('验证 Codex 的真实回复和临时文件读取，会调用模型并可能消耗积分。');
    temporary = await mkdtemp(join(tmpdir(), 'workbuddy-codex-check-'));
    const checkHome = join(temporary, 'codex-home');
    await mkdir(checkHome, { recursive: true, mode: 0o700 });
    const options = { cwd: temporary, env: { ...env, CODEX_HOME: checkHome }, capture: true, allowFailure: true, timeout: config.timeoutMs * 4 };
    const common = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json'];
    const text = await runClient('codex', codexArguments(config, catalog, model,
      [...common, 'Reply with CODEX_WORKBUDDY_OK only.']), options);
    console.log(JSON.stringify(verifyCodexCheck(text, 'CODEX_WORKBUDDY_OK')));
    const marker = 'CODEX_WORKBUDDY_FILE_' + randomBytes(16).toString('hex');
    const file = join(temporary, 'check.txt'); await writeFile(file, marker, { mode: 0o600 });
    const tools = await runClient('codex', codexArguments(config, catalog, model,
      [...common, `Read ${file} using a client shell tool and reply with the exact file contents only. Do not guess the contents.`]), options);
    console.log(JSON.stringify(verifyCodexCheck(tools, marker, true)));
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
