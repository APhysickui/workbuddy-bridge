import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
