import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyPiCheck, PI_PROVIDER_ID } from '../src/pi-config.mjs';
import { applyPiUnification } from '../src/pi-unify.mjs';
import { DEFAULT_MODEL_ALIASES, workbuddyCatalog } from '../src/model-catalog.mjs';

test('installed pi CLI lists the catalog, selects several models, runs its read tool and shows one CLI startup failure', { timeout: 30000 }, async t => {
  const pi = join(homedir(), '.npm-global/bin/pi');
  try { await access(pi); } catch { t.skip('pi is not installed'); return; }
  const project = await mkdtemp(join(tmpdir(), 'wb-pi-cli-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const original = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(join(project, '.pi/extensions'), { recursive: true });
  await cp(join(original, 'src'), join(project, 'src'), { recursive: true });
  await cp(join(original, '.pi/extensions/workbuddy.js'), join(project, '.pi/extensions/workbuddy.js'));
  const cli = resolve(original, 'test/fixtures/pi-cli.mjs');
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  await writeFile(join(project, '.env'), `BRIDGE_API_KEY=test-local-key-0123456789abcdef\nBRIDGE_BACKEND=workbuddy\nBRIDGE_MODELS=${DEFAULT_MODEL_ALIASES}\nBRIDGE_CLAUDE_MODEL=deepseek-v4.1-flash\nCODEBUDDY_BIN=${cli}\n`, { mode: 0o600 });
  const common = ['--offline', '--approve', '--no-extensions', '-e', join(project, '.pi/extensions/workbuddy.js'),
    '--provider', PI_PROVIDER_ID, '--model', 'deepseek-v4.1-flash', '--print', '--mode', 'json',
    '--no-session', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files'];
  const options = { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: join(project, '.agent') }, timeout: 10000, maxBuffer: 4 * 1024 * 1024 };
  const execute = promisify(execFile);
  const run = (...args) => {
    const result = execute(...args);
    result.child.stdin.end(); // pi print mode waits for stdin EOF before sending a prompt.
    return result;
  };
  const text = await run(pi, [...common, '--no-tools', 'Reply with PI_WORKBUDDY_OK only.'], options);
  assert.equal(verifyPiCheck(text.stdout).pi_text_verified, true);
  const list = await run(pi, ['--offline', '--approve', '--no-extensions', '-e', join(project, '.pi/extensions/workbuddy.js'),
    '--list-models', 'workbuddy-cli'], options);
  for (const model of workbuddyCatalog.models) assert.ok(list.stdout.includes(model.id), `Missing ${model.id} in pi's actual menu`);
  for (const id of ['glm-5.3-flash', 'kimi-k3-1', 'minimax-m3']) {
    const args = [...common];
    args[args.indexOf('--model') + 1] = id;
    const selected = await run(pi, [...args, '--no-tools', 'Reply with PI_WORKBUDDY_OK only.'], options);
    assert.equal(verifyPiCheck(selected.stdout).pi_text_verified, true);
    const final = selected.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } })
      .filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1).message;
    assert.equal(final.model, id);
    assert.equal(final.provider, PI_PROVIDER_ID);
  }
  const marker = 'PI_CLI_FILE_' + randomUUID();
  const file = join(project, 'hello.txt');
  await writeFile(file, marker);
  const tools = await run(pi, [...common, '--tools', 'read', `Use read to read ${file} and reply with its exact contents only.`], options);
  assert.equal(verifyPiCheck(tools.stdout, marker, true).pi_tools_verified, true);
  const countBefore = (await readFile(join(project, '.runtime/fixture-invocations.txt'), 'utf8')).trim().split('\n').length;
  let failureOutput;
  try { failureOutput = (await run(pi, [...common, '--no-tools', 'SIMULATE_EMPTY_CLI'], options)).stdout; }
  catch (error) { failureOutput = error.stdout; }
  // pi JSON mode can exit zero for an assistant error; validate the message itself.
  assert.throws(() => verifyPiCheck(failureOutput), /CLI exited without output/);
  assert.ok(!failureOutput.includes('Connection error'));
  assert.ok(!failureOutput.includes('Retry failed'));
  const countAfter = (await readFile(join(project, '.runtime/fixture-invocations.txt'), 'utf8')).trim().split('\n').length;
  assert.equal(countAfter - countBefore, 1);

  // Unify a synthetic global configuration, then run plain pi from another directory.
  // No explicit -e, provider, model or background service is used for this last request.
  const agentDir = options.env.PI_CODING_AGENT_DIR;
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    workbuddy: { api: 'openai-completions', apiKey: 'old-test-key', baseUrl: 'http://127.0.0.1:8799/v1',
      models: [{ id: 'deepseek-v4-flash', name: 'old WorkBuddy' }] }
  } }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'workbuddy', defaultModel: 'deepseek-v4-flash' }));
  await applyPiUnification(agentDir, join(project, '.pi/extensions/workbuddy.js'), {
    claudeModel: 'deepseek-v4.1-flash', models: new Map([['deepseek-v4.1-flash', 'deepseek-v4.1-flash']])
  });
  const elsewhere = await mkdtemp(join(tmpdir(), 'wb-pi-elsewhere-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const plain = await run(pi, ['--offline', '--approve', '--print', '--mode', 'json', '--no-session', '--no-tools',
    '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', 'Reply with PI_WORKBUDDY_OK only.'], { ...options, cwd: elsewhere });
  assert.equal(verifyPiCheck(plain.stdout).pi_text_verified, true);
  assert.ok(plain.stdout.includes('workbuddy-cli'));
});
