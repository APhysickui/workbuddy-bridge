import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../src/config.mjs';
import { setupKimiProfile, installKimiHerdr } from '../src/kimi-setup.mjs';

const execute = promisify(execFile);
const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy' });

async function temporaryProfile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-kimi-herdr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('standalone Kimi profile setup needs no Herdr and writes no API key', async t => {
  const profile = await temporaryProfile(t);
  const result = await setupKimiProfile(config, 'kimi-k3-1', profile, {
    env: {}, execute() { assert.fail('Herdr should be optional outside its workspace'); }
  });
  assert.deepEqual(result, { enabled: false, reason: 'not_requested' });
  const content = await readFile(join(profile, 'config.toml'), 'utf8');
  assert.ok(content.includes('workbuddy-bridge/kimi-k3-1'));
  assert.ok(!content.includes(config.apiKey));
  assert.equal((await stat(join(profile, 'config.toml'))).mode & 0o777, 0o600);
});

test('Herdr installation sees the regenerated config and the correct profile and pane', async t => {
  const profile = await temporaryProfile(t);
  await writeFile(join(profile, 'config.toml'), 'stale config');
  let calls = 0;
  const result = await setupKimiProfile(config, 'kimi-k3-1', profile, {
    env: { HERDR_ENV: '1', HERDR_BIN_PATH: '/fake/herdr', HERDR_PANE_ID: 'test:p1', HERDR_SOCKET_PATH: '/test/socket',
      KIMI_CODE_HOME: '/wrong/profile', ANTHROPIC_AUTH_TOKEN: 'unrelated' },
    async execute(bin, args, options) {
      calls++;
      assert.equal(bin, '/fake/herdr');
      assert.deepEqual(args, ['integration', 'install', 'kimi']);
      assert.equal(options.env.KIMI_CODE_HOME, profile);
      assert.equal(options.env.HERDR_PANE_ID, 'test:p1');
      assert.equal(options.env.HERDR_SOCKET_PATH, '/test/socket');
      assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.ok((await readFile(join(profile, 'config.toml'), 'utf8')).includes('default_model = "workbuddy-bridge/kimi-k3-1"'));
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { enabled: true });
});

test('an existing Herdr profile restores hooks even when launched outside Herdr', async t => {
  const profile = await temporaryProfile(t);
  await mkdir(join(profile, 'hooks'));
  await writeFile(join(profile, 'hooks/herdr-agent-state.sh'), '# managed hook');
  let calls = 0;
  const result = await setupKimiProfile(config, 'deepseek-v4.1-flash', profile, {
    env: {}, async execute() { calls++; }
  });
  assert.equal(calls, 1);
  assert.equal(result.enabled, true);
});

test('explicit Herdr setup works outside Herdr and missing or failing Herdr is optional', async t => {
  const profile = await temporaryProfile(t);
  assert.equal((await installKimiHerdr(profile, { env: {}, force: true, async execute() {} })).enabled, true);
  for (const [code, reason] of [['ENOENT', 'herdr_not_found'], ['ETIMEDOUT', 'install_failed'], [1, 'install_failed']]) {
    const result = await setupKimiProfile(config, 'kimi-k3-1', profile, {
      env: { HERDR_ENV: '1' }, async execute() { throw Object.assign(new Error('private diagnostic'), { code }); }
    });
    assert.deepEqual(result, { enabled: false, reason });
    assert.ok((await readFile(join(profile, 'config.toml'), 'utf8')).includes('[models."workbuddy-bridge/kimi-k3-1"]'));
  }
});

function runHook(hook, action, env, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile('bash', [hook, action], { env, timeout: 5000 }, error => error ? reject(error) : resolve());
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

test('installed Herdr restores Kimi hooks idempotently and reports real hook events without prompts', { timeout: 25000 }, async t => {
  const herdr = process.env.HERDR_BIN_PATH || join(homedir(), '.local/bin/herdr');
  const kimi = join(homedir(), '.kimi-code/bin/kimi');
  try { await access(herdr); await access(kimi); } catch { t.skip('Herdr and Kimi Code are not both installed'); return; }
  const profile = await temporaryProfile(t);
  const env = { ...process.env, HERDR_BIN_PATH: herdr, HERDR_ENV: '0', KIMI_CODE_HOME: profile };
  assert.equal((await setupKimiProfile(config, 'kimi-k3-1', profile, { env, force: true })).enabled, true);
  const hook = join(profile, 'hooks/herdr-agent-state.sh');
  const initial = await readFile(join(profile, 'config.toml'), 'utf8');
  const hooks = content => content.split('[[hooks]]').slice(1).map(block => block.trim());
  assert.ok(hooks(initial).length > 0);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'Interrupt']) {
    assert.ok(hooks(initial).some(block => block.includes(`event = "${event}"`)));
  }
  assert.equal((await setupKimiProfile(config, 'deepseek-v4.1-flash', profile, { env })).enabled, true);
  const regenerated = await readFile(join(profile, 'config.toml'), 'utf8');
  assert.deepEqual(hooks(regenerated), hooks(initial));
  assert.ok(regenerated.includes('default_model = "workbuddy-bridge/deepseek-v4.1-flash"'));
  assert.ok(regenerated.includes('max_context_size = 300000'));
  const doctor = await execute(kimi, ['doctor'], { env, timeout: 5000 });
  assert.ok(doctor.stdout.includes('All checked config files are valid.'));
  assert.ok(!(doctor.stdout + doctor.stderr).includes('Unknown top-level key'));

  // Execute the official hook with a recording socket, never a live Herdr pane.
  const python = (await execute('python3', ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
  const spy = join(profile, 'socket-spy.py');
  await writeFile(spy, `import json, os, socket, sys
class RecordingSocket:
    def __init__(self, *args): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, path):
        assert path == os.environ['WB_TEST_SOCKET_PATH']
    def sendall(self, data):
        with open(os.environ['WB_TEST_REPORT_FILE'], 'w') as f:
            f.write(data.decode())
    def recv(self, size): return b'{}'
socket.socket = RecordingSocket
code = sys.argv[2]
sys.argv = ['-c', *sys.argv[3:]]
exec(compile(code, '<official-herdr-hook>', 'exec'))
`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await mkdir(join(profile, 'bin'));
  await writeFile(join(profile, 'bin/python3'), `#!/bin/sh\nexec ${quote(python)} ${quote(spy)} "$@"\n`, { mode: 0o700 });
  const report = join(profile, 'report.json');
  const socket = join(profile, 'fake.sock');
  const hookEnv = { ...env, PATH: join(profile, 'bin') + ':' + env.PATH, HERDR_ENV: '1', HERDR_PANE_ID: 'test:p1',
    HERDR_SOCKET_PATH: socket, WB_TEST_SOCKET_PATH: socket, WB_TEST_REPORT_FILE: report };
  for (const action of ['session', 'working', 'blocked', 'idle']) {
    await rm(report, { force: true });
    await runHook(hook, action, hookEnv, { session_id: 'test-session', prompt: 'private-prompt', tool_input: 'private-tool-input' });
    const raw = await readFile(report, 'utf8');
    const payload = JSON.parse(raw);
    assert.equal(payload.method, action === 'session' ? 'pane.report_agent_session' : 'pane.report_agent');
    assert.equal(payload.params.pane_id, 'test:p1');
    assert.equal(payload.params.agent, 'kimi');
    assert.equal(payload.params.agent_session_id, 'test-session');
    if (action !== 'session') assert.equal(payload.params.state, action);
    assert.ok(!raw.includes('private-prompt') && !raw.includes('private-tool-input'));
  }
  await rm(report, { force: true });
  await runHook(hook, 'working', { ...hookEnv, HERDR_ENV: '0' }, { session_id: 'test-session' });
  await assert.rejects(access(report), { code: 'ENOENT' });
});
