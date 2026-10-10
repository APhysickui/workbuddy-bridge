import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError } from './errors.mjs';
import { anthropicPrompt, deferredClientAction, parseAnthropicResult } from './anthropic.mjs';
import { CliThinking } from './cli-thinking.mjs';

export class MockAdapter {
  async complete({ messages, signal }) {
    if (signal?.aborted) throw new BridgeError(499, 'cancelled', 'Request cancelled');
    const last = messages.findLast(message => message.role === 'user');
    return { text: `[本地演示，未调用 WorkBuddy]\n收到：${last?.content ?? ''}`, usage: null };
  }

  async completeAnthropic(input) {
    if (input.signal?.aborted) throw new BridgeError(499, 'cancelled', 'Request cancelled');
    return { content: [{ type: 'text', text: '[本地演示，未调用 WorkBuddy] Claude Code 的 Anthropic 接口已连接。' }], stopReason: 'end_turn', usage: null };
  }
}

function classifyFailure(text) {
  // Never return raw CLI stdout/stderr: it can contain credentials or private paths.
  if (/error_max_turns|max(?:imum)?(?: number of)? turns.{0,40}(?:exceed|reach)|MaxTurnsExceededError/i.test(text)) {
    return new BridgeError(502, 'upstream_turn_limit', 'The CLI exhausted its bounded recovery turns without a final answer. No completion was verified.');
  }
  if (/not logged|log ?in|unauthenticated|unauthorized|authentication|401/i.test(text)) {
    return new BridgeError(502, 'upstream_auth_required', 'CLI authentication unavailable. Sign in through the official client/CLI and retry.');
  }
  if (/EPERM|EACCES|permission denied/i.test(text)) {
    return new BridgeError(502, 'upstream_permission_denied', 'CLI encountered an OS or sandbox permission restriction.');
  }
  if (/quota|insufficient.*credit|积分不足|额度不足|credit.*exhaust/i.test(text)) {
    return new BridgeError(502, 'upstream_quota', 'The upstream CLI reported insufficient quota.');
  }
  if (/unknown model|unsupported model|invalid model|model.{0,80}(?:not supported|not available|unavailable)/i.test(text)) {
    return new BridgeError(502, 'upstream_model_unavailable', 'The requested model is unavailable to this CLI/account. No fallback model was requested.');
  }
  return new BridgeError(502, 'upstream_failed', 'CLI failed. No model completion was verified.');
}

export function parseCliResult(stdout) {
  if (!stdout.trim()) {
    throw new BridgeError(502, 'upstream_empty_output', 'The CLI exited without output. Run npm run probe in the terminal where CodeBuddy works; no completion was verified.');
  }
  let result;
  let model;
  const thinking = new CliThinking();
  try {
    const value = JSON.parse(stdout);
    if (value?.type === 'result') result = value;
  } catch {}
  if (!result) {
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const value = JSON.parse(line);
        thinking.read(value);
        if (value?.type === 'system' && value.subtype === 'init' && typeof value.model === 'string') model = value.model;
        if (value?.type === 'result') result = value;
      } catch {}
    }
  }
  if (!result) throw new BridgeError(502, 'upstream_invalid_output', 'CLI did not return a recognized JSON result.');
  if (result.is_error || (result.subtype && result.subtype !== 'success')) {
    throw classifyFailure(JSON.stringify({ subtype: result.subtype, errors: result.errors ?? [] }));
  }
  if (typeof result.result !== 'string' || !result.result.trim()) {
    throw new BridgeError(502, 'upstream_empty_result', 'CLI returned no text completion.');
  }
  const input = result.usage?.input_tokens;
  const output = result.usage?.output_tokens;
  const read = result.usage?.cache_read_input_tokens ?? 0;
  const creation = result.usage?.cache_creation_input_tokens ?? 0;
  const prompt = input + read + creation;
  const usage = [input, output, read, creation, prompt, prompt + output].every(value => Number.isSafeInteger(value) && value >= 0)
    ? { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
      ...(read || creation ? { prompt_tokens_details: { cached_tokens: read } } : {}) }
    : null;
  const thinkingBlocks = thinking.blocks();
  return { text: result.result, usage, model,
    ...(thinkingBlocks.length ? { thinking: thinkingBlocks } : {}),
    ...(usage && (read || creation) ? { anthropicUsage: {
      input_tokens: input, output_tokens: output,
      cache_read_input_tokens: read, cache_creation_input_tokens: creation
    } } : {}) };
}

export function cliArgs(model, systemPromptFile, effort = 'low') {
  return [
    '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', 'none', '--settings', '{"disableAllHooks":true,"enabledPlugins":{}}',
    // Some models end a generation with thinking only. The CLI needs another
    // internal turn to obtain text; this does not run the client's agent loop.
    '--no-session-persistence', '--max-turns', '3',
    '--permission-mode', 'dontAsk', '--model', model, '--effort', effort,
    '--system-prompt-file', systemPromptFile
  ];
}

export class WorkBuddyAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.command = options.command ?? process.execPath;
    this.prefixArgs = options.prefixArgs ?? [config.cliPath];
  }

  async complete({ model, messages, signal }) {
    const instructions = messages.filter(message => ['system', 'developer'].includes(message.role));
    const history = messages.filter(message => !['system', 'developer'].includes(message.role));
    const systemPrompt = [
      'You are a text assistant. Respond to the last user message in the JSON conversation provided on stdin.',
      'The JSON role fields describe conversation history. Do not use tools or access files.',
      ...instructions.map(message => message.content)
    ].join('\n\n');
    return this.invoke({ model, systemPrompt, history, signal });
  }

  async completeAnthropic(input) {
    const prompt = anthropicPrompt(input);
    const deadline = Date.now() + this.config.timeoutMs;
    const results = [];
    const allThinking = [];
    let history = prompt.history;
    // At most one correction for an explicit unfinished tool announcement.
    // Both calls share the request deadline and cancellation signal.
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new BridgeError(504, 'upstream_timeout', 'CLI exceeded the configured timeout.');
      const offset = allThinking.length;
      const emitted = new Set();
      const result = await this.invoke({ model: input.model, systemPrompt: prompt.system, history,
        signal: input.signal, effort: input.effort, timeoutMs, onThinking: event => {
          if (event.type === 'start') emitted.add(event.index);
          input.onThinking?.({ ...event, index: offset + event.index });
        } });
      results.push(result);
      // A snapshot-only first call must precede live thinking from a correction.
      for (const [index, block] of (result.thinking ?? []).entries()) {
        if (!emitted.has(index)) {
          input.onThinking?.({ type: 'start', index: offset + index, thinking: block.thinking, signature: block.signature });
          input.onThinking?.({ type: 'stop', index: offset + index });
        }
        allThinking.push(block);
      }
      const parsed = parseAnthropicResult(result, input);
      if (!deferredClientAction(parsed, input)) {
        const sum = (field, keys) => results.every(item => item[field])
          ? Object.fromEntries(keys.map(key => [key, results.reduce((total, item) => total + (item[field][key] ?? 0), 0)])) : undefined;
        const anthropicUsage = results.every(item => item.usage) ? results.map(item => item.anthropicUsage ?? {
          input_tokens: item.usage.prompt_tokens, output_tokens: item.usage.completion_tokens
        }) : [];
        return { ...parsed, content: [...allThinking, ...parsed.content.filter(block => block.type !== 'thinking')],
          usage: results.length === 1 ? result.usage : sum('usage', ['prompt_tokens', 'completion_tokens', 'total_tokens']) ?? null,
          anthropicUsage: results.length === 1 ? result.anthropicUsage : anthropicUsage.length
            ? Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
              .map(key => [key, anthropicUsage.reduce((total, usage) => total + (usage[key] ?? 0), 0)])) : undefined };
      }
      if (attempt) throw new BridgeError(502, 'upstream_incomplete_turn', 'The model announced a tool action twice without returning a tool call. The task is incomplete; no tool was inferred or executed.');
      history = [...history, { role: 'assistant', content: [{ type: 'text', text: result.text }] },
        { role: 'user', content: [{ type: 'text', text: 'Transport correction: your last response ended with an announcement of a tool action but no tool_calls. Continue the existing task now. Return the required JSON envelope with the actual next client tool call, or a completed answer if no tool is needed. Do not repeat the announcement. Respect all client permissions and tool_choice; do not execute tools yourself.' }] }];
    }
  }

  async invoke({ model, systemPrompt, history, signal, onThinking, effort, timeoutMs = this.config.timeoutMs }) {
    await mkdir(this.config.runtimeDir, { recursive: true, mode: 0o700 });
    if (signal?.aborted) throw new BridgeError(499, 'cancelled', 'Request cancelled');
    const requestDir = await mkdtemp(join(this.config.runtimeDir, 'request-'));
    const promptFile = join(requestDir, 'system.txt');
    try {
      await writeFile(promptFile, systemPrompt, { mode: 0o600 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_')));
      return await new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.prefixArgs, ...cliArgs(model, promptFile, effort ?? this.config.reasoningEffort ?? 'low')], {
        cwd: this.config.runtimeDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32'
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let lines = '';
      let failure;
      let killTimer;
      let modelVerified = model === 'auto';
      const thinking = new CliThinking(event => { if (modelVerified && !failure) onThinking?.(event); });
      const kill = force => {
        try {
          if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM');
          else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {}
      };
      const stop = error => {
        if (failure) return;
        failure = error;
        kill(false);
        killTimer = setTimeout(() => kill(true), 300);
        killTimer.unref();
      };
      const abort = () => stop(new BridgeError(499, 'cancelled', 'Request cancelled'));
      const timer = setTimeout(() => stop(new BridgeError(504, 'upstream_timeout', 'CLI exceeded the configured timeout.')), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        // Descendants must not outlive a completed or cancelled bridge request.
        kill(true);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const capture = (chunk, destination) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > 2 * 1024 * 1024) {
          stop(new BridgeError(502, 'upstream_output_limit', 'CLI output exceeded the bridge limit.'));
          return;
        }
        if (destination === 'stdout') {
          stdout += chunk;
          lines += chunk;
          let boundary;
          while ((boundary = lines.indexOf('\n')) >= 0) {
            const line = lines.slice(0, boundary);
            lines = lines.slice(boundary + 1);
            let value;
            try { value = JSON.parse(line); } catch { continue; }
            if (model !== 'auto' && value?.type === 'system' && value.subtype === 'init' && value.model !== model) {
              stop(new BridgeError(502, 'upstream_model_mismatch', 'CLI selected a different model. The request was stopped; no fallback is accepted.'));
            }
            if (value?.type === 'system' && value.subtype === 'init' && value.model === model) modelVerified = true;
            thinking.read(value);
          }
        }
        else stderr += chunk;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => capture(chunk, 'stdout'));
      child.stderr.on('data', chunk => capture(chunk, 'stderr'));
      child.stdin.on('error', () => {});
      child.on('error', () => {
        failure ??= new BridgeError(502, 'upstream_start_failed', 'Could not start the configured CLI.');
      });
      child.on('close', code => {
        cleanup();
        if (failure) return reject(failure);
        if (code !== 0) return reject(classifyFailure(stdout + '\n' + stderr));
        try {
          const result = parseCliResult(stdout);
          if (model !== 'auto' && result.model !== model) {
            throw new BridgeError(502, 'upstream_model_unverified', 'CLI did not confirm the requested model in its initialization event.');
          }
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(history));
      });
    } finally {
      await rm(requestDir, { recursive: true, force: true });
    }
  }
}
