import { BridgeError } from './errors.mjs';
import { normalizeAnthropic } from './anthropic.mjs';

const expected = 'WORKBUDDY_UPSTREAM_OK';

export function verifyClaudeCheck(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch {}
  if (result?.type !== 'result' || result.is_error || result.subtype !== 'success' ||
      typeof result.result !== 'string' || result.result.trim() !== 'CLAUDE_WORKBUDDY_OK') {
    throw new BridgeError(502, 'claude_check_failed', 'Claude Code did not return CLAUDE_WORKBUDDY_OK. End-to-end connectivity is not verified.');
  }
  return { claude_text_verified: true, expected_reply: 'CLAUDE_WORKBUDDY_OK' };
}

export async function checkClaudeUpstream(config, adapter) {
  if (config.backend !== 'workbuddy') {
    throw new Error('Live preflight requires the WorkBuddy backend; mock replies are not proof of connectivity.');
  }
  const input = normalizeAnthropic({
    model: config.claudeModel,
    max_tokens: 128,
    messages: [{ role: 'user', content: `Reply with ${expected} only.` }],
    tools: []
  }, config.models);
  const result = await adapter.completeAnthropic(input);
  const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('');
  if (result.stopReason !== 'end_turn' || result.content?.some(block => block.type !== 'text') || text?.trim() !== expected) {
    throw new BridgeError(502, 'upstream_preflight_failed', 'WorkBuddy did not return the expected text-only preflight reply. Claude integration was not started.');
  }
  return result;
}
