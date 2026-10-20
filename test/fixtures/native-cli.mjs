import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';

const hasMode = !process.argv[2].startsWith('--');
const mode = hasMode ? process.argv[2] : process.env.WB_NATIVE_MODE ?? 'agent';
const fixtureTrace = {};
function trace(value) {
  if (!['codex-agent', 'codex-mcp'].includes(mode)) return;
  Object.assign(fixtureTrace, value);
  writeFileSync('codex-fixture-trace.json', JSON.stringify(fixtureTrace));
}
if (['codex-agent', 'codex-mcp'].includes(mode)) process.on('uncaughtExceptionMonitor', error => trace({ failure: error.message.slice(0, 500) }));
const args = process.argv.slice(hasMode ? 3 : 2);
const flag = name => args[args.indexOf(name) + 1];
assert.equal(flag('--tools'), '');
assert.equal(flag('--setting-sources'), 'none');
assert.equal(flag('--permission-mode'), 'dontAsk');
assert.ok(!args.includes('--dangerously-skip-permissions'));
assert.ok(args.includes('--strict-mcp-config'));
const config = JSON.parse(flag('--mcp-config'));
const bridge = config.mcpServers.bridge;
assert.deepEqual(Object.keys(config.mcpServers), bridge ? ['bridge'] : []);
assert.equal(flag('--max-turns'), bridge ? '1' : '3');
let text = '';
for await (const chunk of process.stdin) text += chunk;
const history = JSON.parse(text);
const prompt = await readFile(flag('--system-prompt-file'), 'utf8');
assert.ok(prompt.includes('native request proxies'));
assert.ok(!prompt.includes('Return ONLY a JSON object'));
const emit = record => console.log(JSON.stringify(record));
let server;
let tools = [];
const pending = new Map();
let id = 0;
async function request(method, params = {}) {
  const next = ++id;
  const promise = new Promise(resolve => pending.set(next, resolve));
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
  return promise;
}
try {
  if (bridge) {
    assert.equal(flag('--allowedTools'), 'mcp__bridge__*');
    assert.equal(bridge.defer_loading, false);
    assert.equal((await stat(bridge.args[1])).mode & 0o777, 0o600);
    server = spawn(bridge.command, bridge.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: server.stdout }).on('line', line => {
      const response = JSON.parse(line);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    });
    const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    assert.ok(initialized.result.capabilities.tools);
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    tools = (await request('tools/list')).result.tools;
  }
  const names = tools.map(tool => `mcp__bridge__${tool.name}`);
  trace({ tools: tools.map(tool => ({ name: tool.name, client_name: tool.description.split('. ')[0], properties: Object.keys(tool.inputSchema.properties ?? {}) })) });
  emit({ type: 'system', subtype: 'init', model: flag('--model'), tools: mode === 'missing-tools' ? [] : names });
  if (mode === 'missing-tools') { await new Promise(resolve => setTimeout(resolve, 500)); process.exit(0); }
  const event = event => emit({ type: 'stream_event', parent_tool_use_id: null, event });
  event({ type: 'message_start', message: { role: 'assistant' } });
  event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Use the native client tool.', signature: '' } });
  event({ type: 'content_block_stop', index: 0 });
  if (mode === 'hang') { await new Promise(resolve => setTimeout(resolve, 60000)); }
  const results = history.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
  trace({ result_count: results.length, result_preview: results[0]?.content?.slice(0, 1000) });
  const usage = { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 10 };
  const tool = mode === 'codex-agent' ? tools.find(tool => tool.inputSchema.properties?.cmd)
    : mode === 'codex-mcp' ? tools.find(tool => tool.description.includes('WORKBUDDY_CODEX_TEST_READ'))
    : tools.find(tool => /^read$/i.test(tool.name)) ?? tools[0];
  let call;
  const announcement = mode === 'repeated-announcement' || mode === 'announcement' && !text.includes('Transport correction:');
  if (tool && results.length < 2 && mode !== 'thinking-only' && !announcement) {
    const firstText = history[0].content[0].text;
    const path = results.length ? results[0].content : firstText.match(/^Read (.+)\. It names/)?.[1] ?? 'index.txt';
    call = { type: 'tool_use', id: 'native_call_1', name: `mcp__bridge__${tool.name}`, input: { path } };
  }
  if (call) {
    if (['codex-agent', 'codex-mcp'].includes(mode)) {
      const allText = history.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
      const path = results.length ? results[0].content.match(/\/[a-zA-Z0-9_./-]+\/draft\.txt/)?.[0]
        : allText.match(/Read (.+)\. It names/)?.[1];
      assert.ok(path, 'fixture needs the actual first file path or first client read result');
      call.input = mode === 'codex-mcp' ? { path } : { cmd: `cat -- '${path.replaceAll("'", "'\\''")}'`, max_output_tokens: 1024 };
    }
    if (mode === 'custom') call.input = { input: '*** Begin Patch\n*** Add File: proof.txt\n+verified\n*** End Patch' };
    if (mode === 'unknown-tool') call.name = 'Bash';
    if (mode === 'invalid-args') call.input = { path: 12 };
    emit({ type: 'assistant', parent_tool_use_id: null, message: { id: 'generation-1', content: [call], usage } });
    if (mode === 'parallel') {
      // Match CodeBuddy's split snapshots, including a lossy partial tool stream.
      event({ type: 'content_block_start', index: 1, content_block: { ...call, input: {} } });
      emit({ type: 'assistant', parent_tool_use_id: null, message: { id: 'generation-1', content: [
        { ...call, id: 'native_call_2', input: { path: 'second.txt' } }
      ], usage } });
    }
    if (mode === 'duplicate') emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [call], usage } });
    const notice = await request('tools/call', { name: tool.name, arguments: call.input });
    assert.equal(notice.result.isError, true);
    assert.match(notice.result.content[0].text, /CLIENT_TOOL_HANDOFF/);
    if (mode !== 'no-terminal') emit({ type: 'result', subtype: mode === 'max-turns-subtype' ? 'error_max_turns' : 'error_during_execution', is_error: true,
      ...(mode === 'aborted' ? { terminal_reason: 'aborted_tools' } : {}),
      errors: mode === 'mixed-errors' ? ['Max turns (1) exceeded', 'quota exhausted']
        : [mode === 'failed' ? 'quota exhausted PRIVATE_METADATA' : 'Max turns (1) exceeded'], usage });
    if (mode === 'exit-one') process.exitCode = 1;
  } else if (mode === 'thinking-only') {
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Max turns (1) exceeded'], usage });
  } else {
    emit({ type: 'result', subtype: 'success', is_error: false,
      result: announcement ? '看到了。我精确数一下不含空白字符的字数，确认超出多少。'
        : mode === 'json-text' ? '{"text":"a real JSON answer","tool_calls":[]}'
          : ['codex-agent', 'codex-mcp'].includes(mode) ? results.at(-1)?.content.match(/CODEX_TEST_[a-f0-9]+/)?.[0] ?? 'CODEX_TEXT_OK'
            : results.at(-1)?.content ?? 'NATIVE_TEXT_OK', usage });
  }
} finally {
  server?.stdin.end();
  server?.kill();
}
