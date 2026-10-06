import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { ensureBridge, runClient } from '../src/launcher.mjs';
import { verifyPiCheck, PI_PROVIDER_ID } from '../src/pi-config.mjs';
import { verifyClaudeCheck } from '../src/claude-preflight.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
let fixture;
try {
  const config = readConfig();
  if (config.backend !== 'workbuddy') throw new Error('联机检查必须使用 workbuddy 后端。');
  console.log('检查真实 WorkBuddy 回复、工具往返及 Claude / pi 客户端；可能消耗共享积分。');
  await ensureBridge(project);
  const post = async body => {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs + 5000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `Bridge HTTP ${response.status}`);
    return result;
  };
  const messages = [{ role: 'user', content: 'Call bridge_read_file to read bridge-check.txt.' }];
  const tools = [{ name: 'bridge_read_file', description: 'Read a local check file',
    input_schema: { type: 'object', properties: { path: { type: 'string', const: 'bridge-check.txt' } }, required: ['path'], additionalProperties: false } }];
  const common = { model: config.claudeModel, max_tokens: 512, tools };
  const first = await post({ ...common, messages, tool_choice: { type: 'tool', name: 'bridge_read_file' } });
  const call = first.content.find(block => block.type === 'tool_use');
  if (first.stop_reason !== 'tool_use' || call?.name !== 'bridge_read_file' || call.input.path !== 'bridge-check.txt') throw new Error('WorkBuddy 工具调用未通过核对。');
  const marker = 'WORKBUDDY_TOOL_' + randomUUID();
  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [
    { type: 'tool_result', tool_use_id: call.id, content: marker },
    { type: 'text', text: 'Reply with the exact content from the tool result only.' }
  ] });
  const final = await post({ ...common, messages, tool_choice: { type: 'none' } });
  if (final.stop_reason !== 'end_turn' || final.content.map(block => block.text ?? '').join('').trim() !== marker) throw new Error('WorkBuddy 工具结果往返未通过核对。');
  console.log(JSON.stringify({ bridge_tools_verified: true, model: config.claudeModel }));

  // Explicit local settings also work in Claude print mode, which may omit startup hooks.
  // Use the normal user's models/settings: no isolated alias replacement here.
  const clientEnv = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    ANTHROPIC_AUTH_TOKEN: config.apiKey, ANTHROPIC_API_KEY: '', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' };
  delete clientEnv.DISABLE_PROMPT_CACHING;
  const claude = ['--print', '--no-session-persistence', '--model', config.claudeModel,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', join(project, '.claude/settings.local.json')];
  const text = await runClient('claude', [...claude, '--output-format', 'json', '--tools', '', 'Reply with CLAUDE_WORKBUDDY_OK only.'],
    { cwd: project, env: clientEnv, capture: true, timeout: config.timeoutMs + 30000 });
  console.log(JSON.stringify(verifyClaudeCheck(text)));

  await mkdir(join(project, 'playground'), { recursive: true });
  fixture = join(project, 'playground', 'bridge-check-' + randomUUID() + '.txt');
  const fileMarker = 'WORKBUDDY_FILE_' + randomUUID();
  await writeFile(fixture, fileMarker, { mode: 0o600 });
  const claudeTools = await runClient('claude', [...claude, '--output-format', 'stream-json', '--verbose',
    '--tools', 'Read', '--allowedTools', 'Read', '--max-turns', '4',
    `Use Read to read ${fixture} and reply with the exact file content only.`],
  { cwd: project, env: clientEnv, capture: true, timeout: config.timeoutMs * 3 });
  const events = claudeTools.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast(event => event.type === 'result');
  if (result?.subtype !== 'success' || result.is_error || result.result?.trim() !== fileMarker ||
      !events.some(event => event.type === 'assistant' && event.message?.content?.some(block => block.type === 'tool_use' && block.name === 'Read'))) {
    throw new Error('Claude Code 的真实 Read 工具往返未通过核对。');
  }
  console.log(JSON.stringify({ claude_tools_verified: true }));

  const pi = ['--provider', PI_PROVIDER_ID, '--model', config.claudeModel, '-e', join(project, '.pi/extensions/workbuddy.js'),
    '--print', '--mode', 'json', '--no-session', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--offline'];
  const piText = await runClient('pi', [...pi, '--no-tools', 'Reply with PI_WORKBUDDY_OK only.'],
    { cwd: project, capture: true, timeout: config.timeoutMs + 30000 });
  console.log(JSON.stringify(verifyPiCheck(piText)));
  const piTools = await runClient('pi', [...pi, '--tools', 'read', `Read ${fixture} and reply with the exact file content only.`],
    { cwd: project, capture: true, timeout: config.timeoutMs * 3 });
  console.log(JSON.stringify(verifyPiCheck(piTools, fileMarker, true)));
  console.log('真实模型、两个客户端及文件读取工具检查均通过。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (fixture) await rm(fixture, { force: true });
}
