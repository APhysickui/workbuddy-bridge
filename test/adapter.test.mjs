import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkBuddyAdapter, parseCliResult } from '../src/adapters.mjs';
import { normalizeAnthropic } from '../src/anthropic.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const input = { model: 'auto', messages: [{ role: 'user', content: 'hello; $(not-a-command)' }] };
async function adapterFor(t, mode, timeoutMs = 3000) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'workbuddy-bridge-test-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  return new WorkBuddyAdapter({ runtimeDir, timeoutMs }, { command: process.execPath, prefixArgs: [fixture, mode] });
}

test('CLI adapter handles startup noise, split UTF-8 and usage without executing input', async t => {
  const result = await (await adapterFor(t, 'ok')).complete(input);
  assert.equal(result.text, '你好🙂 hello; $(not-a-command)');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
});

test('CLI authentication errors do not disclose raw stdout/stderr', async t => {
  await assert.rejects((await adapterFor(t, 'fail')).complete(input), error => {
    assert.equal(error.code, 'upstream_auth_required');
    assert.ok(!error.message.includes('DO_NOT_EXPOSE'));
    return true;
  });
});

test('error result on exit zero is rejected', async t => {
  await assert.rejects((await adapterFor(t, 'error-result')).complete(input), { code: 'upstream_quota' });
});

test('timeout terminates the upstream process', async t => {
  await assert.rejects((await adapterFor(t, 'hang', 200)).complete(input), { code: 'upstream_timeout', status: 504 });
});

test('client cancellation terminates the upstream process', async t => {
  const adapter = await adapterFor(t, 'hang');
  const controller = new AbortController();
  const task = adapter.complete({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(task, { code: 'cancelled' });
});

test('CLI output is bounded', async t => {
  await assert.rejects((await adapterFor(t, 'large')).complete(input), { code: 'upstream_output_limit' });
});

test('unrecognized CLI output is not treated as a completion', () => {
  assert.throws(() => parseCliResult(''), { code: 'upstream_empty_output' });
  assert.throws(() => parseCliResult('login screen'), { code: 'upstream_invalid_output' });
  assert.throws(() => parseCliResult('{"type":"result","result":""}'), { code: 'upstream_empty_result' });
});

test('cache tokens count toward OpenAI input and retain separate Anthropic categories', () => {
  const result = parseCliResult(JSON.stringify({ type: 'result', subtype: 'success', result: 'hi', usage: {
    input_tokens: 0, output_tokens: 43, cache_creation_input_tokens: 25300, cache_read_input_tokens: 10
  } }));
  assert.deepEqual(result.usage, { prompt_tokens: 25310, completion_tokens: 43, total_tokens: 25353,
    prompt_tokens_details: { cached_tokens: 10 } });
  assert.deepEqual(result.anthropicUsage, { input_tokens: 0, output_tokens: 43,
    cache_creation_input_tokens: 25300, cache_read_input_tokens: 10 });
  const invalid = parseCliResult(JSON.stringify({ type: 'result', subtype: 'success', result: 'hi', usage: {
    input_tokens: 0, output_tokens: 43, cache_creation_input_tokens: -1
  } }));
  assert.equal(invalid.usage, null);
});

test('an unexpected CLI model is stopped rather than accepted as DeepSeek', async t => {
  await assert.rejects((await adapterFor(t, 'wrong-model')).complete({ ...input, model: 'deepseek-v4-flash' }), { code: 'upstream_model_mismatch' });
});

test('missing upstream model identity is rejected for an explicit model', async t => {
  await assert.rejects((await adapterFor(t, 'no-model')).complete({ ...input, model: 'deepseek-v4-flash' }), { code: 'upstream_model_unverified' });
});

test('Anthropic client tools pass through the CLI adapter and return validated tool_use', async t => {
  const adapter = await adapterFor(t, 'anthropic');
  const request = normalizeAnthropic({ model: 'deepseek-v4-flash', max_tokens: 4096,
    messages: [{ role: 'user', content: 'Read hello.txt' }], tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }] },
  new Map([['deepseek-v4-flash', 'deepseek-v4-flash']]));
  const result = await adapter.completeAnthropic(request);
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.content[0].name, 'Read');
  assert.deepEqual(result.content[0].input, { file_path: 'hello.txt' });
});

test('CLI public thinking arrives before completion and snapshots do not duplicate it', async t => {
  const adapter = await adapterFor(t, 'thinking-answer');
  const input = normalizeAnthropic({ model: 'test', max_tokens: 1024,
    messages: [{ role: 'user', content: 'Check and reply.' }] }, new Map([['test', 'test']]));
  let finished = false;
  const events = [];
  const result = await adapter.completeAnthropic({ ...input, onThinking: event => {
    assert.equal(finished, false);
    events.push(event);
  } }).then(result => { finished = true; return result; });
  assert.deepEqual(events.map(event => event.type), ['start', 'delta', 'signature', 'stop']);
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: '先核对🙂再回答。', signature: 'fixture-signature' },
    { type: 'text', text: 'THINKING_REPLY_OK' }
  ]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_METADATA'));
});

test('nonpartial CLI assistant thinking is retained without fabricating a signature', () => {
  const lines = [
    { type: 'assistant', parent_tool_use_id: 'child-tool', message: { content: [{ type: 'thinking', thinking: 'CHILD_REASONING' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Public explanation.' },
      { type: 'redacted_thinking', data: 'OPAQUE_PAYLOAD' }, { type: 'text', text: 'hi' }] } },
    { type: 'result', subtype: 'success', result: 'hi' }
  ].map(value => JSON.stringify(value)).join('\n');
  assert.deepEqual(parseCliResult(lines).thinking, [{ type: 'thinking', thinking: 'Public explanation.', signature: '' }]);
});

test('explicit supported Anthropic effort reaches the official CLI argument', async t => {
  const adapter = await adapterFor(t, 'thinking-effort');
  const request = normalizeAnthropic({ model: 'test', max_tokens: 1024, output_config: { effort: 'high' },
    messages: [{ role: 'user', content: 'Check and reply.' }] }, new Map([['test', 'test']]));
  assert.equal((await adapter.completeAnthropic(request)).stopReason, 'end_turn');
});

function agentInput() {
  return normalizeAnthropic({ model: 'test', max_tokens: 1024, messages: [{ role: 'user', content: 'Inspect the files and report the result.' }],
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }, new Map([['test', 'test']]));
}

test('reasoning-only CLI generations can recover without running client tools upstream', async t => {
  const result = await (await adapterFor(t, 'agent-reasoning-only')).completeAnthropic(agentInput());
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.content.filter(block => block.type === 'thinking').map(block => block.thinking),
    ['Read the full draft text.', 'Return the client read request.']);
  assert.equal(result.content.at(-1).name, 'read');
});

test('an unfinished announcement is corrected into a validated client action with all usage counted', async t => {
  const adapter = await adapterFor(t, 'agent-continue');
  const events = [];
  const result = await adapter.completeAnthropic({ ...agentInput(), onThinking: event => events.push(event) });
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.content.at(-1).input, { path: 'index.txt' });
  assert.deepEqual(events.filter(event => event.type === 'start').map(event => event.index), [0, 1]);
  assert.equal(result.content.filter(block => block.type === 'thinking').length, 2);
  assert.deepEqual(result.usage, { prompt_tokens: 6, completion_tokens: 10, total_tokens: 16 });
  assert.deepEqual(result.anthropicUsage, { input_tokens: 6, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test('snapshot thinking precedes live correction thinking without lost or duplicated blocks', async t => {
  const adapter = await adapterFor(t, 'agent-snapshot');
  const events = [];
  const result = await adapter.completeAnthropic({ ...agentInput(), onThinking: event => events.push(event) });
  assert.deepEqual(events.map(event => [event.type, event.index]), [['start', 0], ['stop', 0], ['start', 1], ['stop', 1]]);
  assert.deepEqual(result.content.filter(block => block.type === 'thinking').map(block => block.thinking),
    ['The next file is needed.', 'Request the actual client tool now.']);
});

test('repeated promises stop after one correction and never fabricate a client tool', async t => {
  const events = [];
  await assert.rejects((await adapterFor(t, 'agent-stuck')).completeAnthropic({ ...agentInput(), onThinking: event => events.push(event) }), { code: 'upstream_incomplete_turn' });
  assert.equal(events.filter(event => event.type === 'start').length, 2);
});

test('upstream recovery exhaustion reports the actual safe failure category', async t => {
  await assert.rejects((await adapterFor(t, 'agent-limit')).completeAnthropic(agentInput()), error => {
    assert.equal(error.code, 'upstream_turn_limit');
    assert.ok(!error.message.includes('PRIVATE_METADATA'));
    return true;
  });
});

test('correction shares the original deadline and remains cancellable', async t => {
  const timed = await adapterFor(t, 'agent-timeout', 500);
  const invoke = timed.invoke.bind(timed);
  const budgets = [];
  timed.invoke = input => { budgets.push(input.timeoutMs); return invoke(input); };
  await assert.rejects(timed.completeAnthropic(agentInput()), { code: 'upstream_timeout' });
  assert.equal(budgets.length, 2);
  assert.ok(budgets[1] < budgets[0] - 120, 'a fresh timeout was allocated for the correction');
  const adapter = await adapterFor(t, 'agent-timeout');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(adapter.completeAnthropic({ ...agentInput(), signal: controller.signal }), { code: 'cancelled' });
});

test('agent checker requires both real client file reads and the exact random final marker', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-agent-check-test-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/agent-check.mjs', import.meta.url));
  const options = { cwd: runtimeDir, timeout: 10000, env: { ...process.env,
    BRIDGE_API_KEY: 'fixture-only-local-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy', CODEBUDDY_BIN: fixture,
    BRIDGE_MODELS: 'test=test', BRIDGE_CLAUDE_MODEL: 'test', WB_FAKE_CLI_MODE: 'agent-check' } };
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--model', 'test'], options);
  assert.match(stdout, /AGENT_CHECK_OK/);
  const steps = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  assert.deepEqual(steps.map(step => [step.stop_reason, step.tool_calls]), [['tool_use', 1], ['tool_use', 1], ['end_turn', 0]]);
  await assert.rejects(promisify(execFile)(process.execPath, [script, '--model', 'test'],
    { ...options, env: { ...options.env, WB_FAKE_CLI_MODE: 'agent-check-premature' } }), error => {
    assert.match(error.stderr, /ended before both reads/);
    assert.ok(!error.stdout.includes('AGENT_CHECK_OK'));
    return true;
  });
});
