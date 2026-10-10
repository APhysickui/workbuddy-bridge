import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mode = process.env.WB_FAKE_CLI_MODE ?? process.argv[2];
const args = process.argv.slice(process.env.WB_FAKE_CLI_MODE ? 2 : 3);
const flag = name => args[args.indexOf(name) + 1];
assert.equal(flag('--tools'), '');
assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
assert.equal(flag('--setting-sources'), 'none');
assert.ok(args.includes('--no-session-persistence'));
assert.ok(!args.includes('--dangerously-skip-permissions'));
assert.equal(flag('--max-turns'), '3');
assert.equal(flag('--permission-mode'), 'dontAsk');
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
} else if (mode.startsWith('agent-')) {
  const last = messages.at(-1).content;
  const correction = JSON.stringify(last).includes('Transport correction:');
  const results = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
  const event = event => console.log(JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: null }));
  const thinking = text => {
    event({ type: 'message_start', message: { role: 'assistant' } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: text, signature: '' } });
    event({ type: 'content_block_stop', index: 0 });
  };
  const output = result => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: typeof result === 'string' ? result : JSON.stringify(result), usage: { input_tokens: 3, output_tokens: 5 } }));
  if (mode === 'agent-check-premature') {
    output({ text: 'I checked everything.', tool_calls: [] });
  } else if (mode === 'agent-check') {
    const firstPath = messages[0].content[0].text.match(/^Read (.+)\. It names/)[1];
    if (!results.length) output({ text: '', tool_calls: [{ name: 'read', input: { path: firstPath } }] });
    else if (results.length === 1) output({ text: '', tool_calls: [{ name: 'read', input: { path: results[0].content } }] });
    else output({ text: results[1].content, tool_calls: [] });
  } else if (mode === 'agent-limit') {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true,
      errors: ['Max turns (3) exceeded PRIVATE_METADATA_DO_NOT_EXPOSE'] }));
  } else if (mode === 'agent-reasoning-only') {
    thinking('Read the full draft text.');
    // Mirrors the official CLI needing a second internal generation after a
    // reasoning-only response. No file tool is executed by this subprocess.
    if (Number(flag('--max-turns')) < 2) {
      console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Max turns (1) exceeded'] }));
    } else {
      thinking('Return the client read request.');
      output({ text: '', tool_calls: [{ name: 'read', input: { path: 'index.txt' } }] });
    }
  } else if (mode === 'agent-timeout' && correction) {
    setInterval(() => {}, 1000);
  } else if (!correction || mode === 'agent-stuck') {
    if (mode === 'agent-timeout') await new Promise(resolve => setTimeout(resolve, 140));
    if (mode === 'agent-snapshot') console.log(JSON.stringify({ type: 'assistant', message: {
      content: [{ type: 'thinking', thinking: 'The next file is needed.', signature: '' }] } }));
    else thinking('The next file is needed.');
    output(results.length ? { text: 'Count received. Let me read the full draft text.', tool_calls: [] }
      : '好，重新读你的文件，看看现在的字数和状态。');
  } else {
    thinking('Request the actual client tool now.');
    if (!results.length) output({ text: 'Reading index.', tool_calls: [{ name: 'read', input: { path: 'index.txt' } }] });
    else if (results.length === 1) output({ text: 'Reading draft.', tool_calls: [{ name: 'read', input: { path: 'draft.txt' } }] });
    else output({ text: `Checked both files: ${results.at(-1).content}`, tool_calls: [] });
  }
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
