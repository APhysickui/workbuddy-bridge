import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliThinking } from '../src/cli-thinking.mjs';
import { WorkBuddyAdapter, parseCliResult } from '../src/adapters.mjs';
import { createHandler } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { call } from './helpers.mjs';

const thought = (thinking, signature = '') => ({ type: 'thinking', thinking, signature });
const event = value => ({ type: 'stream_event', event: value });
const start = id => event({ type: 'message_start', message: { id } });
const block = (index, text = '') => event({ type: 'content_block_start', index, content_block: thought(text) });
const delta = (index, text) => event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } });
const stop = index => event({ type: 'content_block_stop', index });
const snapshot = (id, blocks, uuid) => ({ type: 'assistant', uuid, message: { id, content: blocks } });
const terminal = { type: 'result', subtype: 'success', result: 'Done.' };

function check(records, expected) {
  const events = [];
  const parser = new CliThinking(value => events.push(value));
  for (const value of [...records, terminal]) parser.read(value);
  assert.deepEqual(parser.blocks(), expected);
  assert.deepEqual(parseCliResult([...records, terminal].map(JSON.stringify).join('\n')).thinking, expected);
  const streamed = [];
  const closed = new Set();
  for (const value of events) {
    assert.ok(!closed.has(value.index), 'no updates after a block is closed');
    if (value.type === 'start') {
      assert.equal(value.index, streamed.length, 'public indexes are dense and ordered');
      streamed.push(thought(value.thinking, value.signature));
    } else if (value.type === 'delta') streamed[value.index].thinking += value.thinking;
    else if (value.type === 'signature') streamed[value.index].signature += value.signature;
    else if (value.type === 'stop') closed.add(value.index);
  }
  assert.equal(closed.size, expected.length);
  assert.deepEqual(streamed, expected, 'stream and final result must contain exactly the same thinking');
  return events;
}

test('snapshot and live generations keep their order, even when their text is identical', () => {
  for (const ids of [['a', 'b', 'c'], [undefined, undefined, undefined]]) {
    check([snapshot(ids[0], [thought('Same.')]), start(ids[1]), block(0, 'Same.'), stop(0),
      snapshot(ids[1], [thought('Same.')]), start(ids[2]), snapshot(ids[2], [thought('Same.')])],
    [thought('Same.'), thought('Same.'), thought('Same.')]);
  }
});

test('empty thinking blocks consume no public index or snapshot slot', () => {
  check([start('a'), block(0), stop(0), block(1), delta(1, 'Visible.'), stop(1),
    snapshot('a', [thought('Visible.')])], [thought('Visible.')]);
});

test('a final snapshot supplies a missing public suffix and signature without replay', () => {
  check([start('a'), block(0, 'Check'), stop(0), snapshot('a', [thought('Checking.', 'actual-signature')])],
    [thought('Checking.', 'actual-signature')]);
});

test('multiple blocks in a generation merge by position and repeated snapshot identity', () => {
  check([start('a'), block(1, 'Same.'), stop(1), block(3, 'Same.'), stop(3),
    snapshot('a', [thought('Same.'), thought('Same.')], 'snapshot-a'),
    snapshot('a', [thought('Same.'), thought('Same.')], 'snapshot-a')], [thought('Same.'), thought('Same.')]);
  check([start('a'), block(0, 'First.'), stop(0), snapshot('a', [thought('First.')], 'reasoning-1'),
    block(2, 'Second.'), stop(2), snapshot('a', [thought('Second.')], 'reasoning-2')], [thought('First.'), thought('Second.')]);
});

test('late identical snapshots match their generation without erasing later thoughts', () => {
  check([start('a'), block(0, 'First.'), stop(0), start('b'), block(0, 'Second.'), stop(0),
    snapshot('a', [thought('First.')]), snapshot('b', [thought('Second.')])], [thought('First.'), thought('Second.')]);
});

test('conflicting snapshots cannot silently replace public thinking that was already streamed', () => {
  const records = [start('a'), block(0, 'Original.'), stop(0), snapshot('a', [thought('Replacement.')]), terminal];
  assert.throws(() => parseCliResult(records.map(JSON.stringify).join('\n')), { code: 'upstream_invalid_thinking' });
});

test('mixed CLI thinking produces unique SSE indexes before final text and client tools', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-thinking-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const config = { ...readConfig({ BRIDGE_API_KEY: 'thinking-test-key-0123456789abcdef',
    BRIDGE_BACKEND: 'workbuddy', BRIDGE_MODELS: 'test=test', BRIDGE_TOOL_TRANSPORT: 'prompt' }), runtimeDir };
  const adapter = new WorkBuddyAdapter(config, { prefixArgs: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url)), 'thinking-mixed'] });
  const response = await call(createHandler(config, adapter), config, '/v1/messages', {
    model: 'test', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Read the file.' }],
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
  });
  const events = response.body.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
  assert.deepEqual(events.filter(value => value.type === 'content_block_start').map(value => [value.index, value.content_block.type]),
    [[0, 'thinking'], [1, 'thinking'], [2, 'thinking'], [3, 'text'], [4, 'tool_use']]);
  assert.deepEqual(events.filter(value => value.type === 'content_block_stop').map(value => value.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(events.filter(value => value.delta?.type === 'thinking_delta').map(value => value.delta.thinking), ['Earlier.', 'Live.', 'Later.']);
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).type, 'message_stop');
});
