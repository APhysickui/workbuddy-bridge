import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { createHandler } from '../src/server.mjs';
import { WorkBuddyAdapter } from '../src/adapters.mjs';
import { runClient } from '../src/launcher.mjs';
import { codexArguments, codexEnvironment, codexModelCatalog, selectedCodexModel, verifyCodexCheck } from '../src/codex-config.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'codex-test-local-key-0123456789abcdef', BRIDGE_CLAUDE_MODEL: 'deepseek-v4.1-flash' });
async function installedCodex(t) {
  try { await promisify(execFile)('codex', ['--version'], { timeout: 5000 }); return 'codex'; }
  catch (error) {
    if (process.env.WORKBUDDY_CODEX_REQUIRED === '1') throw error;
    t.skip('Codex CLI is not installed'); return null;
  }
}
test('Codex uses a session provider with Responses HTTP, local auth and native client permissions', () => {
  const args = codexArguments(config, '/tmp/catalog.json', 'kimi-k3-1', ['exec', '--sandbox', 'read-only', '--json', 'hi']);
  const settings = Object.fromEntries(args.flatMap((value, index) => value === '-c' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
  assert.equal(JSON.parse(settings.model_provider), 'workbuddy');
  assert.equal(JSON.parse(settings.model), 'kimi-k3-1');
  assert.equal(JSON.parse(settings['model_providers.workbuddy.wire_api']), 'responses');
  assert.equal(JSON.parse(settings['model_providers.workbuddy.base_url']), 'http://127.0.0.1:18765/v1');
  assert.equal(JSON.parse(settings['model_providers.workbuddy.env_key']), 'WORKBUDDY_BRIDGE_API_KEY');
  assert.equal(JSON.parse(settings['model_providers.workbuddy.requires_openai_auth']), false);
  assert.equal(JSON.parse(settings['model_providers.workbuddy.supports_websockets']), false);
  assert.ok(!args.join(' ').includes(config.apiKey));
  assert.ok(!args.some(arg => /dangerously/.test(arg)));
  assert.deepEqual(args.slice(-5), ['exec', '--sandbox', 'read-only', '--json', 'hi']);
});
test('Codex environment retains other providers and excludes localhost from proxies', () => {
  const env = codexEnvironment(config, { OPENAI_API_KEY: 'original-provider', CODEX_HOME: '/original-home', NO_PROXY: 'example.com' });
  assert.equal(env.OPENAI_API_KEY, 'original-provider'); assert.equal(env.CODEX_HOME, '/original-home');
  assert.equal(env.WORKBUDDY_BRIDGE_API_KEY, config.apiKey);
  assert.equal(env.NO_PROXY, env.no_proxy);
  assert.ok(env.NO_PROXY.split(',').includes('127.0.0.1'));
});
test('WorkBuddy model catalog advertises text and client shell tools without first-party code mode', () => {
  const catalog = codexModelCatalog(config);
  assert.equal(catalog.models.length, config.models.size);
  for (const model of catalog.models) {
    assert.match(model.display_name, /（workbuddy）$/);
    assert.deepEqual(model.input_modalities, ['text']);
    assert.equal(model.shell_type, 'unified_exec');
    assert.equal(model.apply_patch_tool_type, 'freeform');
    assert.equal(model.use_responses_lite, false); assert.equal(model.tool_mode, null);
    assert.equal(model.node_repl_disabled, true);
    assert.ok(model.context_window <= model.max_context_window);
  }
  assert.equal(selectedCodexModel(config), 'deepseek-v4.1-flash');
  assert.equal(selectedCodexModel(config, 'kimi-k3-1'), 'kimi-k3-1');
  assert.throws(() => selectedCodexModel(config, 'unknown'), /未知/);
});
test('Codex verification requires a completed turn, exact reply and real successful command output', () => {
  const expected = 'CODEX_WORKBUDDY_OK';
  const final = { type: 'item.completed', item: { type: 'agent_message', text: expected } };
  const completed = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } };
  const lines = items => items.map(item => JSON.stringify(item)).join('\n');
  assert.equal(verifyCodexCheck(lines([final, completed]), expected).codex_text_verified, true);
  assert.throws(() => verifyCodexCheck(lines([final]), expected));
  assert.throws(() => verifyCodexCheck(lines([{ type: 'error', message: 'failed' }, final, completed]), expected));
  assert.throws(() => verifyCodexCheck(lines([final, completed]), expected, true), /实际文件/);
  const tool = { type: 'item.completed', item: { type: 'command_execution', aggregated_output: expected, exit_code: 0 } };
  assert.equal(verifyCodexCheck(lines([tool, final, completed]), expected, true).codex_tools_verified, true);
  assert.throws(() => verifyCodexCheck(lines([{ ...tool, item: { ...tool.item, exit_code: 1 } }, final, completed]), expected, true));
});
test('installed Codex loads the generated provider catalog without global config or account requests', { timeout: 15000 }, async t => {
  const cli = await installedCodex(t); if (!cli) return;
  const directory = await mkdtemp(join(tmpdir(), 'wb-codex-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = join(directory, 'models.json');
  await writeFile(catalog, JSON.stringify(codexModelCatalog(config)), { mode: 0o600 });
  const { stdout } = await promisify(execFile)(cli, codexArguments(config, catalog, selectedCodexModel(config), ['debug', 'models']), {
    cwd: directory, env: { ...codexEnvironment(config), CODEX_HOME: directory }, timeout: 10000, maxBuffer: 2 * 1024 * 1024
  });
  const models = JSON.parse(stdout).models;
  assert.deepEqual(models.map(model => model.slug).sort(), [...config.models.keys()].sort());
  assert.ok(models.every(model => model.display_name.endsWith('（workbuddy）')));
});

test('installed Codex completes two real client MCP reads through Responses with synthetic upstream', { timeout: 45000 }, async t => {
  const cli = await installedCodex(t); if (!cli) return;
  const directory = await mkdtemp(join(tmpdir(), 'wb-codex-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const current = { ...config, backend: 'workbuddy', runtimeDir: directory, models: new Map([['test', 'test']]), timeoutMs: 10000 };
  const adapter = new WorkBuddyAdapter(current, { prefixArgs: [fileURLToPath(new URL('./fixtures/native-cli.mjs', import.meta.url)), 'codex-mcp'] });
  const handler = createHandler(current, adapter);
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    response.on('finish', () => {
      if (response.statusCode < 400) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {}
      // Fixture-only diagnostic: field names and item types, never prompts,
      // tool arguments, authentication or real account traffic.
      t.diagnostic(JSON.stringify({ http_status: response.statusCode, fields: Object.keys(parsed ?? {}),
        tool_types: parsed?.tools?.map(tool => tool.type), input_types: parsed?.input?.map(item => item.type ?? item.role), include: parsed?.include }));
    });
    return handler(request, response);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (process.env.WORKBUDDY_CODEX_REQUIRED !== '1' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Execution sandbox prevents loopback listener required by installed Codex'); return; }
    throw error;
  }
  t.after(() => { server.close(); server.closeAllConnections(); });
  current.port = server.address().port;
  const catalog = join(directory, 'models.json');
  await writeFile(catalog, JSON.stringify(codexModelCatalog(current)), { mode: 0o600 });
  const index = join(directory, 'index.txt'), draft = join(directory, 'draft.txt');
  const marker = 'CODEX_TEST_' + randomBytes(16).toString('hex');
  await writeFile(index, draft); await writeFile(draft, marker);
  const reader = fileURLToPath(new URL('./fixtures/codex-read-mcp.mjs', import.meta.url));
  const stdout = await runClient(cli, codexArguments(current, catalog, 'test', [
    '-c', `mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.fixture.args=${JSON.stringify([reader, index, draft])}`,
    'exec', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--json', `Read ${index}. It names a second file. Read that file too, then reply only with the marker from it.`]),
  { cwd: directory, env: { ...codexEnvironment(current), CODEX_HOME: directory }, capture: true, allowFailure: true, timeout: 35000 });
  try { assert.equal(verifyCodexCheck(stdout, marker).codex_text_verified, true); }
  catch (error) {
    const messages = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter(event => event.type === 'error' || event.type === 'turn.failed')
      .map(event => event.message ?? event.error?.message ?? 'Codex turn failed');
    t.diagnostic(JSON.stringify({ fixture_client_errors: messages }));
    const commands = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter(event => event.item?.type === 'command_execution').map(event => ({ status: event.item.status,
        exit_code: event.item.exit_code, output: event.item.aggregated_output?.slice(0, 500) }));
    t.diagnostic(JSON.stringify({ fixture_command_results: commands }));
    try { t.diagnostic(await readFile(join(directory, 'codex-fixture-trace.json'), 'utf8')); } catch {}
    throw error;
  }
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  assert.equal(events.filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.status === 'completed').length, 2);
  const reads = (await readFile(join(directory, 'client-reads.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).path);
  assert.deepEqual(reads, [index, draft]);
});
