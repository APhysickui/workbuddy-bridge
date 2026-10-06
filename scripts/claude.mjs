import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readConfig } from '../src/config.mjs';
import { MockAdapter, WorkBuddyAdapter } from '../src/adapters.mjs';
import { createHandler } from '../src/server.mjs';
import { claudeSettings, claudeEnvironment } from '../src/claude-config.mjs';
import { checkClaudeUpstream, verifyClaudeCheck } from '../src/claude-preflight.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
const supplied = process.argv.slice(2);
const check = supplied.includes('--check');
const mock = supplied.includes('--mock');
const forwarded = supplied.filter(arg => !['--check', '--mock'].includes(arg));
let server;
let client;
let shutdown;

try {
  const config = readConfig();
  config.claudePassthrough = false; // This launcher uses only the isolated WorkBuddy profile.
  if (mock) config.backend = 'mock';
  else config.backend = 'workbuddy';
  const settings = claudeSettings(config);
  const adapter = config.backend === 'mock' ? new MockAdapter() : new WorkBuddyAdapter(config);
  if (!mock) {
    console.log('先进行一次真实 WorkBuddy 短请求预检（可能消耗额度）；通过后才启动隔离的 Claude 测试会话。');
    await checkClaudeUpstream(config, adapter);
    console.log('WorkBuddy 短请求预检通过；桌面积分共享仍需核实。');
  }
  const profileDir = join(config.runtimeDir, 'claude-profile');
  const playground = join(project, 'playground');
  const settingsFile = join(config.runtimeDir, 'claude-settings.json');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(playground, { recursive: true });
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  shutdown = new AbortController();
  config.shutdownSignal = shutdown.signal;
  server = createServer(createHandler(config, adapter));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.timeout = config.timeoutMs + 10000;
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(config.port, config.host, () => { server.off('error', fail); ready(); });
  });
  console.log(`WorkBuddy → Claude Code: model=${config.claudeModel}, backend=${config.backend}`);
  console.log(`Local endpoint: http://127.0.0.1:${config.port}; workspace: ${playground}`);
  console.log('Experimental prompt-based tool translation. Claude Code end-to-end compatibility and credit sharing remain unverified.');
  const args = ['--bare', '--setting-sources', '', '--settings', settingsFile,
    '--model', config.claudeModel, '--effort', 'low',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', check ? '' : 'Read,Write,Edit,Glob,Grep,Bash'];
  if (check) args.push('--print', '--output-format', 'json', '--no-session-persistence', '--system-prompt', 'Answer briefly.', 'Reply with CLAUDE_WORKBUDDY_OK only.');
  client = spawn('claude', [...args, ...forwarded], { cwd: playground,
    env: claudeEnvironment(config, profileDir), stdio: check ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
  let stdout = '';
  let capturedBytes = 0;
  let checkFailure;
  let checkTimer;
  let killTimer;
  const stop = () => {
    shutdown.abort();
    client.kill('SIGTERM');
    server.closeAllConnections();
    killTimer ??= setTimeout(() => client.kill('SIGKILL'), 500);
    killTimer.unref();
  };
  if (check) {
    const capture = (chunk, save) => {
      capturedBytes += Buffer.byteLength(chunk);
      if (capturedBytes > 2 * 1024 * 1024) {
        checkFailure ??= new Error('Claude Code check output exceeded the limit.');
        stop();
      } else if (save) stdout += chunk;
    };
    client.stdout.setEncoding('utf8');
    client.stdout.on('data', chunk => capture(chunk, true));
    client.stderr.on('data', chunk => capture(chunk, false));
    checkTimer = setTimeout(() => {
      checkFailure ??= new Error('Claude Code check timed out.');
      stop();
    }, config.timeoutMs + 30000);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let code;
  try {
    code = await new Promise((done, fail) => { client.once('error', fail); client.once('close', value => done(value)); });
  } finally {
    clearTimeout(checkTimer);
    clearTimeout(killTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  if (check) {
    if (checkFailure) throw checkFailure;
    if (code !== 0) throw new Error('Claude Code check failed. No end-to-end completion was verified.');
    const verified = verifyClaudeCheck(stdout);
    console.log(JSON.stringify({ ...verified, backend: config.backend, model: config.claudeModel,
      upstream_cli: config.cliPath, credit_sharing_measured: false }));
  }
  process.exitCode = code ?? 1;
} catch (error) {
  const reason = error.code === 'EPERM' ? 'This execution sandbox forbids local port listening. Run npm run claude in a normal macOS terminal.'
    : error.code === 'EADDRINUSE' ? 'The bridge port is occupied. Stop the other bridge instance or change BRIDGE_PORT.'
    : error.code === 'ENOENT' ? 'Claude Code was not found on PATH.' : error.message;
  console.error(reason);
  process.exitCode = 1;
} finally {
  shutdown?.abort();
  if (server) { server.close(); server.closeAllConnections(); }
}
