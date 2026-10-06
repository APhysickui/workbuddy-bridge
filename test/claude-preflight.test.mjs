import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.mjs';
import { BridgeError } from '../src/errors.mjs';
import { checkClaudeUpstream, verifyClaudeCheck } from '../src/claude-preflight.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy',
  BRIDGE_MODELS: 'deepseek-v4-flash=deepseek-v4-flash', BRIDGE_CLAUDE_MODEL: 'deepseek-v4-flash' });

test('preflight demands a real backend and an exact text-only completion', async () => {
  let calls = 0;
  const adapter = { completeAnthropic: async input => {
    calls++;
    assert.equal(input.model, 'deepseek-v4-flash');
    assert.deepEqual(input.tools, []);
    return { content: [{ type: 'text', text: 'WORKBUDDY_UPSTREAM_OK' }], stopReason: 'end_turn', usage: null };
  } };
  await assert.rejects(checkClaudeUpstream({ ...config, backend: 'mock' }, adapter), /mock replies/);
  assert.equal(calls, 0);
  assert.equal((await checkClaudeUpstream(config, adapter)).content[0].text, 'WORKBUDDY_UPSTREAM_OK');
  for (const result of [
    { content: [{ type: 'text', text: 'ordinary reply' }], stopReason: 'end_turn' },
    { content: [{ type: 'text', text: 'WORKBUDDY_UPSTREAM_OK' }], stopReason: 'tool_use' },
    { content: [{ type: 'text', text: 'WORKBUDDY_UPSTREAM_OK' }, { type: 'tool_use' }], stopReason: 'end_turn' }
  ]) {
    await assert.rejects(checkClaudeUpstream(config, { completeAnthropic: async () => result }), { code: 'upstream_preflight_failed' });
  }
});

test('preflight propagates authentication failure without retrying or accepting another provider', async () => {
  let calls = 0;
  await assert.rejects(checkClaudeUpstream(config, { completeAnthropic: async () => {
    calls++;
    throw new BridgeError(502, 'upstream_auth_required', 'CLI authentication unavailable.');
  } }), { code: 'upstream_auth_required' });
  assert.equal(calls, 1);
});

test('Claude check verifies the exact reply, not just a successful process exit', () => {
  assert.equal(verifyClaudeCheck(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: 'CLAUDE_WORKBUDDY_OK' })).claude_text_verified, true);
  for (const stdout of ['', 'CLAUDE_WORKBUDDY_OK', JSON.stringify({ type: 'result', subtype: 'success', result: 'hi' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'CLAUDE_WORKBUDDY_OK' })]) {
    assert.throws(() => verifyClaudeCheck(stdout), { code: 'claude_check_failed' });
  }
});
