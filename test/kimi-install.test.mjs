import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../src/config.mjs';
import { planKimiInstallation, installKimi } from '../src/kimi-install.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy' });
const legacy = `# user settings
default_model = "workbuddy/kimi-k3-1"
telemetry = false

[providers.other]
type = "openai"
base_url = "https://other.example/v1"
api_key = "original-test-secret"

[models."other/assistant"]
provider = "other"
model = "assistant"
max_context_size = 64000

[thinking]
enabled = true

[secondary_model]
default_model = "other/assistant"

[providers.workbuddy]
type = "openai"
base_url = "http://127.0.0.1:8799/v1"
api_key = "old-test-key"

[models."workbuddy/kimi-k3-1"]
provider = "workbuddy"
model = "kimi-k3-1"
max_context_size = 64000
max_output_size = 8192
capabilities = ["thinking", "always_thinking", "tool_use"]

[[hooks]]
event = "Stop"
command = "echo custom-hook"
`;
const plan = raw => planKimiInstallation(raw, config, '/project with spaces', '/usr/bin/node');

test('ordinary Kimi migration fixes the stale endpoint, protocol, thinking and secondary model', () => {
  const result = plan(legacy);
  assert.deepEqual(result.summary.removed_providers, ['workbuddy']);
  assert.equal(result.summary.provider, 'workbuddy');
  assert.equal(result.summary.models, config.models.size);
  assert.ok(!result.text.includes('8799') && !result.text.includes('old-test-key') && !result.text.includes('always_thinking'));
  assert.ok(result.text.includes('type = "anthropic"\nbase_url = "http://127.0.0.1:18765"'));
  assert.ok(result.text.includes('[thinking]\nenabled = true'));
  assert.ok(result.text.includes('[secondary_model]\ndefault_model = "workbuddy/kimi-k3-1"'));
  assert.ok(result.text.includes('max_context_size = 300000'));
  assert.ok(result.text.includes('event = "SessionStart"'));
  assert.ok(result.text.includes("'/project with spaces/scripts/kimi-startup.mjs'"));
  assert.ok(!JSON.stringify(result.summary).includes(config.apiKey));
});

test('Kimi migration preserves other providers and hooks and repeated installation is identical', () => {
  const first = plan(legacy);
  assert.ok(first.text.includes('[providers.other]\ntype = "openai"\nbase_url = "https://other.example/v1"\napi_key = "original-test-secret"'));
  assert.ok(first.text.includes('event = "Stop"\ncommand = "echo custom-hook"'));
  assert.equal(plan(first.text).text, first.text);
});

test('Kimi migration keeps an unrelated default and refuses provider name collisions', () => {
  const original = legacy.replace('default_model = "workbuddy/kimi-k3-1"', 'default_model = "other/assistant"');
  const result = plan(original);
  assert.equal(result.summary.default, 'other/assistant');
  assert.ok(result.text.includes('[thinking]\nenabled = true'));
  assert.ok(result.text.includes('[secondary_model]\ndefault_model = "other/assistant"'));
  const collision = original.replace('[providers.workbuddy]', '[providers.workbuddy-bridge]').replace('http://127.0.0.1:8799/v1', 'https://unrelated.example/v1');
  assert.throws(() => plan(collision), /指向其他服务/);
});

test('Kimi migration ignores example headers, keys and hook markers in multiline strings', () => {
  const example = `description = '''
[providers.workbuddy]
base_url = "http://127.0.0.1:8799/v1"
default_model = "workbuddy/kimi-k3-1"
# >>> workbuddy-bridge kimi startup
# <<< workbuddy-bridge kimi startup
'''
`;
  const result = plan(example + legacy);
  assert.ok(result.text.includes(example));
  assert.equal(result.summary.default, 'workbuddy/kimi-k3-1');
  assert.equal(plan(result.text).text, result.text);
  assert.ok(plan('default_model = "other/assistant"').text.includes('default_model = "other/assistant"\n\n'));
});

async function profileFor(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wb-kimi-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'config.toml'), legacy, { mode: 0o600 });
  return directory;
}

test('Kimi apply validates before replacement, backs up exact bytes and does not repeat writes', async t => {
  const directory = await profileFor(t);
  const original = join(directory, 'config.toml');
  const dry = await installKimi(directory, config, '/project', '/usr/bin/node');
  assert.equal(dry.applied, false);
  assert.equal(await readFile(original, 'utf8'), legacy);
  let validations = 0;
  const result = await installKimi(directory, config, '/project', '/usr/bin/node', { apply: true, async validate(path) {
    validations++;
    assert.equal(await readFile(original, 'utf8'), legacy);
    assert.ok((await readFile(path, 'utf8')).includes(config.apiKey));
  } });
  assert.equal(validations, 1);
  assert.equal(await readFile(result.backup, 'utf8'), legacy);
  assert.equal((await stat(original)).mode & 0o777, 0o600);
  assert.equal((await installKimi(directory, config, '/project', '/usr/bin/node', { apply: true })).backup, null);
});

test('Kimi validation failure or another writer leaves the original untouched', async t => {
  const directory = await profileFor(t);
  await assert.rejects(installKimi(directory, config, '/project', '/usr/bin/node', { apply: true, async validate() { throw new Error('invalid config'); } }), /invalid config/);
  assert.equal(await readFile(join(directory, 'config.toml'), 'utf8'), legacy);
  await mkdir(join(directory, 'config.toml.workbuddy-lock'));
  await assert.rejects(installKimi(directory, config, '/project', '/usr/bin/node', { apply: true }), /正在被写入/);
  await access(join(directory, 'config.toml.workbuddy-lock'));
});

test('installed Kimi accepts the migrated ordinary profile and its bridge startup hook', { timeout: 10000 }, async t => {
  const cli = join(homedir(), '.kimi-code/bin/kimi');
  try { await access(cli); } catch { t.skip('Kimi Code is not installed'); return; }
  const directory = await profileFor(t);
  const content = plan(legacy).text;
  await writeFile(join(directory, 'config.toml'), content, { mode: 0o600 });
  const result = await promisify(execFile)(cli, ['doctor'], { env: { ...process.env, KIMI_CODE_HOME: directory }, timeout: 5000 });
  assert.ok(result.stdout.includes('All checked config files are valid.'));
  assert.ok(!(result.stdout + result.stderr).includes('Unknown top-level key'));
});
