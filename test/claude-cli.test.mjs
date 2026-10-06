import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readConfig } from '../src/config.mjs';
import { bridgeModelList } from '../src/claude-models.mjs';
import { directClaudeSettings } from '../src/claude-config.mjs';

test('installed Claude includes the discovered WorkBuddy lineup with original pinned tiers still selectable', { timeout: 15000 }, async t => {
  const cli = join(homedir(), '.npm-global/bin/claude');
  try { await access(cli); } catch { t.skip('Claude Code is not installed'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'wb-claude-menu-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef',
    BRIDGE_CLAUDE_MODEL: 'deepseek-v4.1-flash', BRIDGE_CLAUDE_MODEL_NAME: 'DeepSeek V4.1 Flash（workbuddy）',
    BRIDGE_CLAUDE_PASSTHROUGH: '1' });
  const settings = directClaudeSettings(config, directory, process.execPath);
  const models = bridgeModelList(config, true);
  // Seed the real discovery cache from our endpoint's response shape. This tests
  // the native menu consumer without sockets or an account/model request.
  await mkdir(join(directory, 'cache'), { recursive: true });
  await writeFile(join(directory, 'cache/gateway-models.json'), JSON.stringify({
    baseUrl: settings.env.ANTHROPIC_BASE_URL, fetchedAt: Date.now(), models
  }), { mode: 0o600 });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_')));
  const child = spawn(cli, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...clean, ...settings.env, CLAUDE_CONFIG_DIR: directory,
      CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: '100', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Original Sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5[1M]', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Original Opus' }
  });
  const exited = once(child, 'close');
  let lines = '';
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude menu initialization timed out')), 10000);
      child.stdout.setEncoding('utf8');
      child.stderr.resume(); // Raw client diagnostics are not part of the test output.
      child.stdout.on('data', chunk => {
        lines += chunk;
        let boundary;
        while ((boundary = lines.indexOf('\n')) >= 0) {
          const line = lines.slice(0, boundary); lines = lines.slice(boundary + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type !== 'control_response' || event.response?.request_id !== 'wb-model-menu') continue;
          clearTimeout(timer);
          resolve(event.response);
        }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', () => { clearTimeout(timer); reject(new Error('Claude ended before its model menu response')); });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'wb-model-menu', request: { subtype: 'initialize' } }) + '\n');
    });
    assert.equal(response.subtype, 'success');
    const menu = response.response.models;
    const workbuddy = menu.filter(row => row.value.startsWith('claude-workbuddy-'));
    assert.equal(workbuddy.length, 19); // The single custom option and discovery are deduplicated.
    for (const model of models) {
      const row = workbuddy.find(row => row.value === model.id);
      assert.equal(row?.displayName, model.display_name, `Missing or mislabeled ${model.id}`);
    }
    assert.equal(menu.find(row => row.value === 'sonnet')?.resolvedModel, 'claude-sonnet-5');
    assert.equal(menu.find(row => row.value === 'opus')?.resolvedModel, 'claude-opus-5-5[1M]');
  } finally {
    child.stdin.end();
    child.kill();
    await exited;
  }
});
