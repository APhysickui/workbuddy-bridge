import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../src/config.mjs';
import { workbuddyCatalog, catalogContextWindow } from '../src/model-catalog.mjs';
import { createHandler } from '../src/server.mjs';
import { handlerFetch } from './helpers.mjs';
import { kimiProfile, kimiEnvironment, checkKimiUpstream, verifyKimiCheck, KIMI_CHECK_REPLY } from '../src/kimi-config.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy' });

test('Kimi profile uses Anthropic tools, catalog budgets and a WorkBuddy secondary model', () => {
  const profile = kimiProfile(config, 'kimi-k3-1');
  assert.ok(profile.includes('type = "anthropic"'));
  assert.ok(profile.includes('base_url = "http://127.0.0.1:18765"'));
  assert.ok(profile.includes('[secondary_model]\ndefault_model = "workbuddy-bridge/kimi-k3-1"'));
  assert.ok(!profile.includes(config.apiKey));
  assert.ok(!profile.includes('always_thinking') && !profile.includes('image_in'));
  assert.throws(() => kimiProfile(config, 'unknown'), /未知/);
  for (const model of workbuddyCatalog.models) {
    const section = profile.split(`[models."workbuddy-bridge/${model.id}"]\n`)[1].split('\n\n')[0];
    assert.ok(section.includes(`max_context_size = ${catalogContextWindow(model)}`));
    assert.ok(section.includes(`max_output_size = ${model.maxOutputTokens}`));
    assert.ok(section.includes('capabilities = ["tool_use"]'));
  }
});

test('Kimi isolated environment removes conflicting Anthropic overrides and always excludes loopback from proxies', () => {
  const env = kimiEnvironment(config, '/tmp/kimi-profile', { ANTHROPIC_AUTH_TOKEN: 'unrelated-secret',
    ANTHROPIC_BASE_URL: 'https://unrelated.example', CLAUDE_MODEL: 'unrelated', HTTP_PROXY: 'http://proxy.example', NO_PROXY: 'example.com' });
  assert.equal(env.KIMI_CODE_HOME, '/tmp/kimi-profile');
  assert.equal(env.WORKBUDDY_BRIDGE_API_KEY, config.apiKey);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_MODEL, undefined);
  assert.equal(env.HTTP_PROXY, 'http://proxy.example');
  assert.equal(env.NO_PROXY, env.no_proxy);
  for (const host of ['localhost', '127.0.0.1', '::1', 'example.com']) assert.ok(env.NO_PROXY.split(',').includes(host));
});

test('Kimi preflight verifies an authenticated Anthropic reply and rejects network, model and reply failures without fallback', async () => {
  let calls = 0;
  const handler = createHandler(config, { async completeAnthropic(input) {
    calls++;
    assert.equal(input.model, 'kimi-k3-1');
    assert.equal(input.history.at(-1).content[0].text, `Reply with ${KIMI_CHECK_REPLY} only.`);
    return { content: [{ type: 'text', text: KIMI_CHECK_REPLY }], stopReason: 'end_turn', usage: null };
  } });
  await checkKimiUpstream(config, 'kimi-k3-1', handlerFetch(handler));
  assert.equal(calls, 1);
  await assert.rejects(checkKimiUpstream(config, 'kimi-k3-1', async () => { throw new Error('ECONNREFUSED'); }), /无法连接/);
  const good = { model: 'kimi-k3-1', stop_reason: 'end_turn', content: [{ type: 'text', text: KIMI_CHECK_REPLY }] };
  for (const body of [{ ...good, model: 'other' }, { ...good, content: [{ type: 'text', text: 'hi' }] },
    { ...good, stop_reason: 'tool_use' }]) {
    await assert.rejects(checkKimiUpstream(config, 'kimi-k3-1', async () => Response.json(body)), /准确回复/);
  }
  await assert.rejects(checkKimiUpstream(config, 'kimi-k3-1', async () => Response.json({ error: { message: 'Login required' } }, { status: 502 })), /HTTP 502.*Login required/);
});

test('Kimi checks require final assistant text and actual file tool output, not a successful exit', () => {
  const good = JSON.stringify({ role: 'assistant', content: KIMI_CHECK_REPLY });
  assert.equal(verifyKimiCheck(good).kimi_text_verified, true);
  assert.throws(() => verifyKimiCheck(''), /准确/);
  assert.throws(() => verifyKimiCheck(good + '\n' + JSON.stringify({ role: 'meta', type: 'turn.step.retrying' })), /错误/);
  assert.throws(() => verifyKimiCheck(good, KIMI_CHECK_REPLY, true), /工具结果/);
  const tool = JSON.stringify({ role: 'tool', tool_call_id: 'file-read', content: KIMI_CHECK_REPLY });
  assert.equal(verifyKimiCheck(tool + '\n' + good, KIMI_CHECK_REPLY, true).kimi_tools_verified, true);
});

test('installed Kimi validates and reads the isolated profile without changing global settings', { timeout: 15000 }, async t => {
  const cli = join(homedir(), '.kimi-code/bin/kimi');
  try { await access(cli); } catch { t.skip('Kimi Code is not installed'); return; }
  const profile = await mkdtemp(join(tmpdir(), 'wb-kimi-config-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(join(profile, 'config.toml'), kimiProfile(config, 'kimi-k3-1'), { mode: 0o600 });
  const env = kimiEnvironment(config, profile);
  const execute = promisify(execFile);
  const doctor = await execute(cli, ['doctor'], { env, timeout: 5000 });
  assert.ok(doctor.stdout.includes('All checked config files are valid.'));
  assert.ok(!(doctor.stdout + doctor.stderr).includes('Unknown top-level key'));
  const list = await execute(cli, ['provider', 'list', '--json'], { env, timeout: 5000 });
  const parsed = JSON.parse(list.stdout);
  assert.ok(JSON.stringify(parsed).includes('workbuddy-bridge/kimi-k3-1'));
  assert.ok(!JSON.stringify(parsed).includes('8799'));
});
