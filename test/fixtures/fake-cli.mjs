import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mode = process.argv[2];
const args = process.argv.slice(3);
const flag = name => args[args.indexOf(name) + 1];
assert.equal(flag('--tools'), '');
assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
assert.equal(flag('--setting-sources'), 'none');
assert.ok(args.includes('--no-session-persistence'));
assert.ok(!args.includes('--dangerously-skip-permissions'));
assert.equal(flag('--max-turns'), '1');
assert.equal(flag('--output-format'), 'stream-json');
assert.ok(args.includes('--include-partial-messages'));
assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const messages = JSON.parse(input);
assert.equal(messages.at(-1).role, 'user');
if (mode !== 'no-model') console.log(JSON.stringify({ type: 'system', subtype: 'init', model: mode === 'wrong-model' ? 'claude-opus' : flag('--model') }));
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  console.error('Unauthorized login required, private_key=DO_NOT_EXPOSE');
  process.exitCode = 1;
} else if (mode === 'error-result') {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['quota exhausted private_key=DO_NOT_EXPOSE'] }));
} else if (mode === 'large') {
  process.stdout.write('x'.repeat(3 * 1024 * 1024));
} else if (mode.startsWith('thinking-')) {
  if (mode === 'thinking-effort') assert.equal(flag('--effort'), 'high');
  const event = event => console.log(JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: null }));
  event({ type: 'message_start', message: { role: 'assistant' } });
  event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先核对🙂' } });
  const secretMeta = { reasoning_detail: 'PRIVATE_METADATA_DO_NOT_EXPOSE', _meta: { api_key: 'PRIVATE_METADATA_DO_NOT_EXPOSE' } };
  event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再回答。' }, ...secretMeta });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } });
  event({ type: 'content_block_stop', index: 0 });
  console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '先核对🙂再回答。', signature: 'fixture-signature' },
    { type: 'redacted_thinking', data: 'PRIVATE_METADATA_DO_NOT_EXPOSE' }
  ] } }));
  if (mode === 'thinking-hang') setInterval(() => {}, 1000);
  else setTimeout(() => {
    if (mode === 'thinking-fail') {
      console.log(JSON.stringify({ type: 'result', is_error: true, errors: ['quota exhausted PRIVATE_METADATA_DO_NOT_EXPOSE'] }));
      return;
    }
    const afterTool = messages.at(-1).content.some?.(block => block.type === 'tool_result');
    const result = mode === 'thinking-tool' && !afterTool
      ? { text: '', tool_calls: [{ name: 'read', input: { path: 'hello.txt' } }] }
      : { text: 'THINKING_REPLY_OK', tool_calls: [] };
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result),
      usage: { input_tokens: 0, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 10 } }));
  }, 200);
} else if (mode === 'pi-roundtrip') {
  const result = messages.at(-1).content.some(block => block.type === 'tool_result')
    ? { text: 'PI_WORKBUDDY_OK', tool_calls: [] }
    : { text: '', tool_calls: [{ name: 'read', input: { path: 'hello.txt' } }] };
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result),
    usage: { input_tokens: 0, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 10 } }));
} else if (mode === 'anthropic') {
  const prompt = await readFile(flag('--system-prompt-file'), 'utf8');
  assert.ok(prompt.includes('Available client tools:'));
  assert.ok(prompt.includes('"name":"Read"'));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: '{"text":"","tool_calls":[{"name":"Read","input":{"file_path":"hello.txt"}}]}' }));
} else if (mode === 'plain-reply') {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: '我是 DeepSeek，可以帮你回答问题。', usage: { input_tokens: 3, output_tokens: 5 } }));
} else {
  console.log('harmless CLI startup line');
  const value = JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: `你好🙂 ${messages.at(-1).content}`, usage: { input_tokens: 3, output_tokens: 5 } });
  // Deliberately split UTF-8 across stdout writes.
  const bytes = Buffer.from(value + '\n');
  const split = bytes.indexOf(Buffer.from('你')) + 1;
  process.stdout.write(bytes.subarray(0, split));
  setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
}
