import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { BridgeError } from './errors.mjs';

// Read the original provider at runtime; never copy its credential into project settings.
export async function readOriginalProvider(config, ambient = process.env, settingsPath = join(homedir(), '.claude', 'settings.json')) {
  const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
  const env = { ...ambient, ...settings.env };
  const baseUrl = env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port) === config.port)) {
    throw new Error('原 Claude 服务商 URL 无效或指回桥接自身。');
  }
  const token = env.ANTHROPIC_AUTH_TOKEN;
  const key = env.ANTHROPIC_API_KEY;
  if ((!token && !key) || (token && key) || token === config.apiKey || key === config.apiKey) {
    throw new Error('原 Claude 服务商需要一种独立的认证方式；请检查用户级 settings.json。');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), headers: token ? { authorization: `Bearer ${token}` } : { 'x-api-key': key } };
}

export function passthroughUrl(provider, path) {
  // Some compatible providers already configure /v1 as their base path.
  return provider.baseUrl + (provider.baseUrl.endsWith('/v1') ? path.replace(/^\/v1/, '') : path);
}

export function passthroughHeaders(provider, incoming) {
  const headers = { 'content-type': 'application/json', ...provider.headers };
  for (const name of ['anthropic-version', 'anthropic-beta', 'accept', 'user-agent', 'x-app',
    'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch',
    'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout']) {
    if (typeof incoming[name] === 'string') headers[name] = incoming[name];
  }
  return headers;
}

const quote = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid upstream configuration');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
};
const responseHeaders = new Set(['content-type', 'content-encoding', 'cache-control', 'request-id', 'x-request-id', 'retry-after',
  'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset']);

// Curl respects existing proxy settings. Secrets go through stdin, never argv or logs.
// Raw request and response bodies preserve native tools, thinking, caching and SSE.
export async function forwardAnthropic({ config, provider, path, rawBody, headers, response, signal }, spawnProcess = spawn) {
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(config.runtimeDir, 'forward-'));
  const bodyFile = join(dir, 'body.json');
  let child;
  let timer;
  let killTimer;
  const abort = () => {
    child?.kill('SIGTERM');
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 500);
    killTimer.unref();
  };
  try {
    await writeFile(bodyFile, rawBody, { mode: 0o600 });
    if (signal.aborted) throw new BridgeError(499, 'cancelled', 'Request cancelled.');
    const directives = [`url = ${quote(passthroughUrl(provider, path))}`, 'request = "POST"',
      `data-binary = ${quote('@' + bodyFile)}`,
      ...Object.entries(passthroughHeaders(provider, headers)).map(([key, value]) => `header = ${quote(key + ': ' + value)}`)
    ].join('\n');
    child = spawnProcess('curl', ['-q', '--silent', '--show-error', '--http1.1', '--no-buffer', '--include',
      '--suppress-connect-headers', '--connect-timeout', '15', '--max-time', String(Math.ceil(config.timeoutMs / 1000)), '--config', '-'],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let failedToStart = false;
    child.on('error', () => { failedToStart = true; });
    // Do not expose raw curl diagnostics, which can contain private provider details.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const completion = new Promise(resolve => child.once('close', code => resolve(code)));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, config.timeoutMs + 1000);
    child.stdin.end(directives + '\n');
    let pending = Buffer.alloc(0);
    let sentHeaders = false;
    for await (const chunk of child.stdout) {
      if (signal.aborted) break;
      let payload = chunk;
      if (!sentHeaders) {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const boundary = pending.indexOf('\r\n\r\n');
          if (boundary < 0) {
            if (pending.length > 65536) throw new BridgeError(502, 'provider_invalid_headers', 'Original provider returned invalid headers.');
            payload = null;
            break;
          }
          const lines = pending.subarray(0, boundary).toString('latin1').split('\r\n');
          pending = pending.subarray(boundary + 4);
          const match = /^HTTP\/\S+ (\d{3})(?: |$)/.exec(lines.shift());
          if (!match) throw new BridgeError(502, 'provider_invalid_headers', 'Original provider returned invalid headers.');
          const status = Number(match[1]);
          if (status < 200) continue;
          const outgoing = {};
          for (const line of lines) {
            const i = line.indexOf(':');
            const key = line.slice(0, i).toLowerCase();
            if (i > 0 && responseHeaders.has(key)) outgoing[key] = line.slice(i + 1).trim();
          }
          response.writeHead(status, outgoing);
          sentHeaders = true;
          payload = pending;
          pending = Buffer.alloc(0);
          break;
        }
      }
      if (payload?.length && !response.write(payload)) await once(response, 'drain', { signal });
    }
    const code = await completion;
    if (signal.aborted) return;
    if (failedToStart || code !== 0 || !sentHeaders) {
      if (response.headersSent) { response.destroy(); return; }
      throw new BridgeError(502, 'provider_unavailable', 'Could not reach the original Claude provider.');
    }
    response.end();
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal.removeEventListener('abort', abort);
    child?.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
}
