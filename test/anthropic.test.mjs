import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readConfig } from '../src/config.mjs';
import { createHandler } from '../src/server.mjs';
import { normalizeAnthropic, parseAnthropicResult, anthropicEvents, anthropicMessage } from '../src/anthropic.mjs';
import { claudeEnvironment, claudeSettings, directClaudeSettings } from '../src/claude-config.mjs';

const config = readConfig({ BRIDGE_API_KEY: 'test-local-key-0123456789abcdef',
  BRIDGE_MODELS: 'deepseek-v4-flash=deepseek-v4-flash', BRIDGE_CLAUDE_MODEL: 'deepseek-v4-flash' });
const tool = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } };
const body = { model: 'deepseek-v4-flash', max_tokens: 4096, system: [{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'Read hello.txt' }], tools: [tool] };

test('Anthropic tools normalize to a prompt protocol and preserve model identity', () => {
  const input = normalizeAnthropic(body, config.models);
  assert.equal(input.model, 'deepseek-v4-flash');
  assert.equal(input.system, 'Be helpful.');
  const result = parseAnthropicResult({ text: '{"text":"","tool_calls":[{"name":"Read","input":{"file_path":"hello.txt"}}]}', usage: null }, input);
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.content[0].name, 'Read');
  assert.ok(result.content[0].id.startsWith('toolu_'));
});

test('system and developer messages become instructions without losing user history', () => {
  const input = normalizeAnthropic({ ...body, messages: [
    { role: 'system', content: 'Additional system instruction.' },
    { role: 'developer', content: [{ type: 'text', text: 'Developer instruction.' }] },
    ...body.messages
  ] }, config.models);
  assert.equal(input.system, 'Be helpful.\n\nAdditional system instruction.\n\nDeveloper instruction.');
  assert.deepEqual(input.history, [{ role: 'user', content: [{ type: 'text', text: 'Read hello.txt' }] }]);
});

test('instructions alone, unknown roles and multimodal instructions fail clearly', () => {
  assert.throws(() => normalizeAnthropic({ ...body, messages: [{ role: 'system', content: 'x' }] }, config.models), /last conversation message/);
  for (const role of ['tool', 'PRIVATE_ROLE_VALUE']) {
    assert.throws(() => normalizeAnthropic({ ...body, messages: [{ role, content: 'x' }] }, config.models), error => {
      assert.match(error.message, /Unsupported message role/);
      assert.ok(!error.message.includes('PRIVATE_ROLE_VALUE'));
      return true;
    });
  }
  assert.throws(() => normalizeAnthropic({ ...body, messages: [{ role: 'system', content: [{ type: 'image', source: {} }] }, ...body.messages] }, config.models), /Only text system instructions/);
});

test('tool use and tool result round trip retains IDs and yields a final reply', () => {
  const input = normalizeAnthropic(body, config.models);
  const call = parseAnthropicResult({ text: '{"text":"","tool_calls":[{"name":"Read","input":{"file_path":"hello.txt"}}]}' }, input);
  const next = normalizeAnthropic({ ...body, messages: [body.messages[0], { role: 'assistant', content: call.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.content[0].id, content: [{ type: 'text', text: 'WORKBUDDY_FILE_READ_OK' }] }] }] }, config.models);
  assert.equal(next.history.at(-1).content[0].tool_use_id, call.content[0].id);
  const result = parseAnthropicResult({ text: '{"text":"WORKBUDDY_FILE_READ_OK","tool_calls":[]}' }, next);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.content[0].text, 'WORKBUDDY_FILE_READ_OK');
});

test('malformed, fabricated or schema-invalid tool calls fail explicitly', () => {
  const input = normalizeAnthropic(body, config.models);
  for (const text of ['plain text', '{"text":"","tool_calls":[{"name":"DeleteEverything","input":{}}]}',
    '{"text":"","tool_calls":[{"name":"Read","input":{"file_path":123}}]}', '{"text":"","tool_calls":[]}']) {
    assert.throws(() => parseAnthropicResult({ text }, input), { code: 'upstream_invalid_tool_protocol' });
  }
  assert.throws(() => normalizeAnthropic({ ...body, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fake', content: 'x' }] }] }, config.models));
});

test('forced and disabled tool choices are enforced', () => {
  const input = normalizeAnthropic({ ...body, tool_choice: { type: 'none' } }, config.models);
  assert.throws(() => parseAnthropicResult({ text: '{"text":"","tool_calls":[{"name":"Read","input":{"file_path":"a"}}]}' }, input));
  const any = normalizeAnthropic({ ...body, tool_choice: { type: 'any' } }, config.models);
  assert.throws(() => parseAnthropicResult({ text: '{"text":"hi","tool_calls":[]}' }, any));
});

test('Anthropic SSE tool arguments reconstruct and complete with tool_use', () => {
  const input = normalizeAnthropic(body, config.models);
  const result = parseAnthropicResult({ text: '{"text":"读取文件。","tool_calls":[{"name":"Read","input":{"file_path":"测试🙂.txt"}}]}',
    usage: { prompt_tokens: 100, completion_tokens: 20 } }, input);
  const events = [...anthropicEvents('msg_test', 'deepseek-v4-flash', result)].map(event => event.data);
  assert.equal(events[0].type, 'message_start');
  assert.equal(events[0].message.usage.output_tokens, 0);
  const args = events.filter(event => event.type === 'content_block_delta' && event.delta.type === 'input_json_delta').map(event => event.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(args), { file_path: '测试🙂.txt' });
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).type, 'message_stop');
});

test('Anthropic JSON and SSE preserve cache token categories without double counting', () => {
  const usage = { input_tokens: 0, output_tokens: 43, cache_creation_input_tokens: 25300, cache_read_input_tokens: 10 };
  const result = parseAnthropicResult({ text: '{"text":"hi","tool_calls":[]}',
    usage: { prompt_tokens: 25310, completion_tokens: 43, total_tokens: 25353 }, anthropicUsage: usage }, normalizeAnthropic(body, config.models));
  assert.deepEqual(anthropicMessage('msg_test', 'deepseek-v4-flash', result).usage, usage);
  const events = [...anthropicEvents('msg_test', 'deepseek-v4-flash', result)];
  assert.deepEqual(events[0].data.message.usage, { ...usage, output_tokens: 0 });
  assert.equal(events.at(-2).data.usage.output_tokens, 43);
});

class Response extends EventEmitter {
  body = ''; writableEnded = false; headersSent = false; headers = {};
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; }
  write(value) { this.body += value; return true; }
  end(value = '') { this.body += value; this.writableEnded = true; this.emit('close'); }
}
async function call(handler, path, body, key = config.apiKey) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url: path, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key } });
  const res = new Response();
  await handler(req, res);
  return res;
}

test('Messages supports SDK x-api-key authentication and Anthropic error envelopes', async () => {
  const handler = createHandler(config, { completeAnthropic: async () => ({ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: null }) });
  const res = await call(handler, '/v1/messages', body);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).type, 'message');
  assert.equal(res.headers['x-bridge-usage'], 'unknown-reported-as-zero');
  const bad = await call(handler, '/v1/messages', body, 'wrong');
  assert.equal(bad.status, 401);
  assert.equal(JSON.parse(bad.body).error.type, 'authentication_error');
});

test('mixed instruction roles reach the Anthropic adapter after normalization', async () => {
  let received;
  const handler = createHandler(config, { completeAnthropic: async input => {
    received = input;
    return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: null };
  } });
  const res = await call(handler, '/v1/messages', { ...body, messages: [
    { role: 'system', content: 'System message.' },
    { role: 'developer', content: 'Developer message.' }, ...body.messages
  ] });
  assert.equal(res.status, 200);
  assert.match(received.system, /System message\.\n\nDeveloper message\./);
  assert.equal(received.history.length, 1);
});

test('token counting is labeled approximate and makes no upstream request', async () => {
  const handler = createHandler(config, { completeAnthropic() { throw new Error('must not call'); } });
  const { max_tokens, ...request } = body;
  const res = await call(handler, '/v1/messages/count_tokens', request);
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-bridge-token-count'], 'estimated');
  assert.ok(JSON.parse(res.body).input_tokens > 0);
});

test('isolated Claude session uses one auth method and removes inherited cache overrides', () => {
  const settings = claudeSettings(config);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-flash');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18765');
  const env = claudeEnvironment(config, '/private/tmp/isolated-profile', { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'PREVIOUS_KEY', ANTHROPIC_AUTH_TOKEN: 'PREVIOUS_TOKEN', CLAUDE_CODE_OAUTH_TOKEN: 'PREVIOUS_OAUTH', ANTHROPIC_BASE_URL: 'https://previous-provider.invalid', DISABLE_PROMPT_CACHING: '1', DISABLE_PROMPT_CACHING_OPUS: '1' });
  assert.equal(env.ANTHROPIC_API_KEY, config.apiKey);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/private/tmp/isolated-profile');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.DISABLE_PROMPT_CACHING, undefined);
  assert.equal(env.DISABLE_PROMPT_CACHING_OPUS, undefined);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(settings.env.DISABLE_PROMPT_CACHING, undefined);
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'DeepSeek V4 Flash（workbuddy）');
});

test('direct integration adds a custom model and retains original aliases, defaults and caching', () => {
  assert.throws(() => directClaudeSettings(config, '/project', '/usr/local/bin/node'), /BRIDGE_CLAUDE_PASSTHROUGH/);
  const settings = directClaudeSettings({ ...config, claudePassthrough: true }, '/project', '/usr/local/bin/node');
  assert.equal(settings.model, undefined);
  assert.equal(settings.availableModels, undefined);
  assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
  assert.equal(settings.env.DISABLE_PROMPT_CACHING, undefined);
  assert.equal(settings.env.ANTHROPIC_API_KEY, '');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, config.apiKey);
  for (const key of Object.keys(settings.env)) assert.ok(!key.startsWith('ANTHROPIC_DEFAULT_'));
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('ensure-bridge.mjs'));
});

test('V4.1 configuration uses the verified model ID and a matching menu name', () => {
  const current = readConfig({ BRIDGE_API_KEY: config.apiKey, CODEBUDDY_BIN: '/installed/codebuddy',
    BRIDGE_MODELS: 'deepseek-v4.1-flash=deepseek-v4.1-flash', BRIDGE_CLAUDE_MODEL: 'deepseek-v4.1-flash',
    BRIDGE_CLAUDE_MODEL_NAME: 'DeepSeek V4.1 Flash（workbuddy）' });
  const settings = claudeSettings(current);
  assert.equal(current.cliPath, '/installed/codebuddy');
  assert.equal(settings.model, 'deepseek-v4.1-flash');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'DeepSeek V4.1 Flash（workbuddy）');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4.1-flash');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
});
