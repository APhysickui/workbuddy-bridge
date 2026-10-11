import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkBuddyAdapter, parseCliResult } from '../src/adapters.mjs';
import { nativeTools, nativePrompt, parseNativeCliResult } from '../src/native-tools.mjs';
import { normalizeAnthropic } from '../src/anthropic.mjs';
import { readConfig } from '../src/config.mjs';
import { directPiProvider } from '../src/pi-direct.mjs';

const cli = fileURLToPath(new URL('./fixtures/native-cli.mjs', import.meta.url));
const models = new Map([['test', 'test']]);
const tool = { name: 'read', description: 'Read a UTF-8 file.', input_schema: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false
} };
const request = (fields = {}) => normalizeAnthropic({ model: 'test', max_tokens: 1024,
  messages: [{ role: 'user', content: 'Read the index and draft.' }], tools: [tool], ...fields }, models);
async function setup(t, mode = 'agent') {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'wb-native-tools-'));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const config = { ...readConfig({ BRIDGE_API_KEY: 'native-test-key-0123456789abcdef', BRIDGE_BACKEND: 'workbuddy',
    BRIDGE_MODELS: 'test=test' }), runtimeDir, timeoutMs: 5000 };
  const adapter = new WorkBuddyAdapter(config, { prefixArgs: [cli, mode] });
  return { runtimeDir, config, adapter };
}

test('native is the default; tools are exposed with real schemas and required choices filter the functions', () => {
  const input = request({ tools: [tool, { ...tool, name: 'a'.repeat(128) }] });
  const protocol = nativeTools(input);
  assert.deepEqual(protocol.tools[0].inputSchema, tool.input_schema);
  assert.equal(protocol.aliases.get('mcp__bridge__read').name, 'read');
  assert.equal(protocol.tools[1].name, 'tool_1');
  assert.equal(nativeTools({ ...input, toolChoice: { type: 'none' } }).tools.length, 0);
  assert.equal(nativeTools({ ...input, toolChoice: { type: 'tool', name: 'read' } }).tools.length, 1);
  assert.match(nativePrompt(input, protocol).system, /Do not print tool-call JSON/);
  assert.equal(readConfig({ BRIDGE_API_KEY: 'native-test-key-0123456789abcdef' }).toolTransport, 'native');
});

test('a native function request survives the intentional one-generation CLI handoff boundary', async t => {
  const { adapter } = await setup(t);
  let calls = 0;
  const invoke = adapter.invoke.bind(adapter);
  adapter.invoke = input => { calls++; return invoke(input); };
  const result = await adapter.completeAnthropic(request());
  assert.equal(calls, 1, 'native tools must not depend on JSON correction or repeated model attempts');
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.content.at(-1).input, { path: 'index.txt' });
  assert.equal(result.content.at(-1).name, 'read');
  assert.deepEqual(result.anthropicUsage, { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 10 });
});

test('native handoff accepts official generic max-turn errors and exit 1 only with a validated call', async t => {
  for (const mode of ['exit-one', 'max-turns-subtype']) {
    const { adapter } = await setup(t, mode);
    assert.equal((await adapter.completeAnthropic(request())).stopReason, 'tool_use');
  }
});

test('an unfinished native announcement is corrected once into a real function request', async t => {
  const { adapter } = await setup(t, 'announcement');
  let calls = 0;
  const invoke = adapter.invoke.bind(adapter);
  adapter.invoke = input => { calls++; return invoke(input); };
  const result = await adapter.completeAnthropic(request());
  assert.equal(calls, 2);
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.content.at(-1).name, 'read');
  assert.equal(result.anthropicUsage.output_tokens, 16);
  const repeated = await setup(t, 'repeated-announcement');
  await assert.rejects(repeated.adapter.completeAnthropic(request()), { code: 'upstream_incomplete_turn' });
});

test('split parallel snapshots preserve both native calls without trusting the partial stream', async t => {
  const { adapter } = await setup(t, 'parallel');
  const result = await adapter.completeAnthropic(request());
  assert.deepEqual(result.content.filter(block => block.type === 'tool_use').map(block => block.input.path), ['index.txt', 'second.txt']);
});

test('missing schemas, unknown native tools, invalid arguments and duplicates fail without fabricating actions', async t => {
  for (const [mode, code] of [['missing-tools', 'upstream_native_tools_unavailable'], ['unknown-tool', 'upstream_invalid_native_tool'],
    ['invalid-args', 'upstream_invalid_tool_protocol'], ['duplicate', 'upstream_invalid_native_tool'],
    ['failed', 'upstream_quota'], ['mixed-errors', 'upstream_turn_limit'], ['aborted', 'upstream_incomplete_turn'],
    ['no-terminal', 'upstream_invalid_output'], ['thinking-only', 'upstream_turn_limit']]) {
    const { adapter } = await setup(t, mode);
    await assert.rejects(adapter.completeAnthropic(request()), { code });
  }
});

test('native text output is never interpreted as tool JSON and disabled tools never start MCP', async t => {
  const { adapter } = await setup(t, 'json-text');
  const result = await adapter.completeAnthropic(request({ tool_choice: { type: 'none' } }));
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.content.at(-1).text, '{"text":"a real JSON answer","tool_calls":[]}');
  const forced = request({ tool_choice: { type: 'any' } });
  const stdout = [
    { type: 'system', subtype: 'init', model: 'test' },
    { type: 'result', subtype: 'success', is_error: false, result: 'No tool call.' }
  ].map(JSON.stringify).join('\n');
  assert.throws(() => parseNativeCliResult(stdout, forced, nativeTools(forced), parseCliResult), { code: 'upstream_invalid_native_tool' });
});

test('cancelling native thinking terminates the CLI and its MCP child', async t => {
  const { adapter } = await setup(t, 'hang');
  const controller = new AbortController();
  await assert.rejects(adapter.completeAnthropic({ ...request(), signal: controller.signal,
    onThinking: () => controller.abort() }), { code: 'cancelled' });
});

test('the official CodeBuddy MCP SDK accepts the proxy and shell requests perform no filesystem action', async t => {
  const sdk = join(homedir(), '.npm-global/lib/node_modules/@tencent-ai/codebuddy-code/node_modules/@modelcontextprotocol/sdk/dist/esm');
  try { await access(join(sdk, 'client/index.js')); } catch { t.skip('official CLI MCP SDK is not installed'); return; }
  const { Client } = await import(pathToFileURL(join(sdk, 'client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'client/stdio.js')));
  const { runtimeDir } = await setup(t);
  const file = join(runtimeDir, 'must-not-be-created');
  const manifest = join(runtimeDir, 'tools.json');
  await writeFile(manifest, JSON.stringify([{ name: 'Bash', description: 'Client shell request.', inputSchema: {
    type: 'object', properties: { command: { type: 'string' } }, required: ['command']
  } }]), { mode: 0o600 });
  const client = new Client({ name: 'official-mcp-compatibility-check', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp-tools.mjs', import.meta.url)), manifest], stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools[0].name, 'Bash');
  const result = await client.callTool({ name: 'Bash', arguments: { command: `touch ${file}` } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /has not executed/);
  await assert.rejects(access(file), { code: 'ENOENT' });
});

test('installed pi SDK completes two actual client reads through native schemas and snapshots', async t => {
  const sdk = join(homedir(), '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist');
  try { await access(join(sdk, 'api/anthropic-messages.js')); } catch { t.skip('pi SDK is not installed'); return; }
  const api = await import(pathToFileURL(join(sdk, 'api/anthropic-messages.js')));
  const { normalizeContext } = await import(pathToFileURL(join(sdk, 'utils/transcript.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(sdk, 'utils/event-stream.js')));
  const { adapter, config, runtimeDir } = await setup(t);
  const index = join(runtimeDir, 'index.txt');
  const draft = join(runtimeDir, 'draft.txt');
  const marker = randomUUID();
  await writeFile(index, draft);
  await writeFile(draft, marker);
  const provider = directPiProvider(config, adapter, api, createAssistantMessageEventStream);
  const model = { ...provider.models[0], provider: 'workbuddy-cli', api: provider.api, baseUrl: provider.baseUrl };
  const context = { systemPrompt: 'Read both files and finish.', tools: [{ name: 'read', description: tool.description, parameters: tool.input_schema }],
    messages: [{ role: 'user', content: `Read ${index}. It names a second file. Read it and return its marker.`, timestamp: Date.now() }] };
  let invocations = 0;
  const invoke = adapter.invoke.bind(adapter);
  adapter.invoke = input => { invocations++; return invoke(input); };
  for (let step = 0; step < 3; step++) {
    const answer = await provider.streamSimple(model, normalizeContext(context)).result();
    assert.notEqual(answer.stopReason, 'error', answer.errorMessage);
    context.messages.push(answer);
    if (step === 2) {
      assert.equal(answer.stopReason, 'stop');
      assert.equal(answer.content.find(block => block.type === 'text').text, marker);
    } else {
      assert.equal(answer.stopReason, 'toolUse');
      const call = answer.content.find(block => block.type === 'toolCall');
      assert.equal(call.arguments.path, step ? draft : index);
      context.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: await readFile(call.arguments.path, 'utf8') }], isError: false, timestamp: Date.now() });
    }
  }
  assert.equal(invocations, 3);
});

test('installed pi CLI executes both native client reads and completes without user continuation', { timeout: 30000 }, async t => {
  const pi = join(homedir(), '.npm-global/bin/pi');
  try { await access(pi); } catch { t.skip('pi is not installed'); return; }
  const project = await mkdtemp(join(tmpdir(), 'wb-native-pi-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const original = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(join(project, '.pi/extensions'), { recursive: true });
  await cp(join(original, 'src'), join(project, 'src'), { recursive: true });
  await cp(join(original, '.pi/extensions/workbuddy.js'), join(project, '.pi/extensions/workbuddy.js'));
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  await writeFile(join(project, '.env'), `BRIDGE_API_KEY=native-test-key-0123456789abcdef\nBRIDGE_BACKEND=workbuddy\nBRIDGE_MODELS=test=test\nCODEBUDDY_BIN=${cli}\n`, { mode: 0o600 });
  const index = join(project, 'index.txt');
  const draft = join(project, 'draft.txt');
  const marker = randomUUID();
  await writeFile(index, draft);
  await writeFile(draft, marker);
  const running = promisify(execFile)(pi, ['--offline', '--approve', '--no-extensions', '-e', join(project, '.pi/extensions/workbuddy.js'),
    '--provider', 'workbuddy-cli', '--model', 'test', '--print', '--mode', 'json', '--no-session', '--tools', 'read',
    '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files',
    `Read ${index}. It names a second file. Read it and return its marker.`], {
    cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: join(project, '.agent') }, timeout: 15000, maxBuffer: 4 * 1024 * 1024
  });
  running.child.stdin.end();
  const { stdout } = await running;
  const records = stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
  const answers = records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant').map(record => record.message);
  assert.deepEqual(answers.map(answer => answer.stopReason), ['toolUse', 'toolUse', 'stop']);
  assert.equal(answers.at(-1).content.find(block => block.type === 'text').text, marker);
  assert.equal(records.filter(record => record.type === 'tool_execution_end' && !record.isError).length, 2);
});
