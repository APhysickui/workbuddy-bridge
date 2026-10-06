import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { BridgeError } from './errors.mjs';
import { normalize, chatCompletion, responseObject, chatEvents, responseEvents } from './protocol.mjs';
import { normalizeAnthropic, anthropicMessage, anthropicEvents, estimatedInputTokens } from './anthropic.mjs';
import { forwardAnthropic } from './passthrough.mjs';
import { bridgeIdentity } from './bridge-service.mjs';
import { claudeRouteModels, bridgeModelList } from './claude-models.mjs';

function authenticated(header, apiKey) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(apiKey));
}

function apiKeyAuthenticated(value, apiKey) {
  return typeof value === 'string' && authenticated(`Bearer ${value}`, apiKey);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request, maxBytes) {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new BridgeError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  }
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new BridgeError(413, 'body_too_large', 'Request body exceeds the limit.');
  const buffers = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError(413, 'body_too_large', 'Request body exceeds the limit.');
    buffers.push(chunk);
  }
  const raw = Buffer.concat(buffers);
  try { return { body: JSON.parse(raw.toString('utf8')), raw }; }
  catch { throw new BridgeError(400, 'invalid_json', 'Invalid JSON body.'); }
}

export function createHandler(config, adapter, forward = forwardAnthropic) {
  const models = claudeRouteModels(config);
  let active = false;
  let upstreamVerified = false;
  return async (request, response) => {
    let ownsSlot = false;
    let anthropic = false;
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    const shutdown = () => controller.abort();
    config.shutdownSignal?.addEventListener('abort', shutdown, { once: true });
    if (config.shutdownSignal?.aborted) shutdown();
    request.on('aborted', disconnected);
    response.on('close', disconnected);
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      anthropic = url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens';
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { status: 'ok', backend: config.backend, text_only: false, anthropic_tools: 'experimental_prompt_translation',
          upstream_verified: upstreamVerified, credit_sharing_verified: false, stream_mode: 'buffered', busy: active });
      }
      if (!authenticated(request.headers.authorization, config.apiKey) && !apiKeyAuthenticated(request.headers['x-api-key'], config.apiKey)) {
        throw new BridgeError(401, 'unauthorized', 'Provide the local bridge key as a Bearer token.');
      }
      if (request.method === 'GET' && url.pathname === '/_bridge/status') {
        return json(response, 200, { ...bridgeIdentity(config),
          upstream_verified: upstreamVerified, credit_sharing_verified: false });
      }
      if (request.method === 'POST' && url.pathname === '/_bridge/shutdown') {
        if (typeof config.shutdown !== 'function') throw new BridgeError(503, 'shutdown_unavailable', 'This bridge instance does not support background shutdown.');
        json(response, 200, { status: 'stopping' });
        setImmediate(config.shutdown);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const { body, raw } = await readBody(request, config.maxBodyBytes);
        if (typeof body?.model === 'string' && !models.has(body.model) && config.originalProvider) {
          return await forward({ config, provider: config.originalProvider, path: url.pathname + url.search,
            rawBody: raw, headers: request.headers, response, signal: controller.signal });
        }
        normalizeAnthropic({ ...body, max_tokens: body.max_tokens ?? 1024 }, models);
        response.setHeader('x-bridge-token-count', 'estimated');
        return json(response, 200, { input_tokens: estimatedInputTokens(body) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const anthropicList = typeof request.headers['anthropic-version'] === 'string';
        response.setHeader('vary', 'anthropic-version');
        return json(response, 200, { object: 'list', data: bridgeModelList(config, anthropicList), has_more: false });
      }
      const kind = { '/v1/chat/completions': 'chat', '/v1/responses': 'responses', '/v1/messages': 'anthropic' }[url.pathname];
      if (request.method !== 'POST' || !kind) throw new BridgeError(404, 'not_found', 'Unknown endpoint.');
      const { body, raw } = await readBody(request, config.maxBodyBytes);
      if (kind === 'anthropic' && typeof body?.model === 'string' && !models.has(body.model) && config.originalProvider) {
        return await forward({ config, provider: config.originalProvider, path: url.pathname + url.search,
          rawBody: raw, headers: request.headers, response, signal: controller.signal });
      }
      if (active) throw new BridgeError(429, 'bridge_busy', 'One request is already running. Retry after it finishes.');
      active = true;
      ownsSlot = true;
      const input = kind === 'anthropic' ? normalizeAnthropic(body, models) : normalize(body, kind, models);
      const result = kind === 'anthropic'
        ? await adapter.completeAnthropic({ ...input, signal: controller.signal })
        : await adapter.complete({ ...input, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (config.backend === 'workbuddy') upstreamVerified = true;
      const id = `${kind === 'chat' ? 'chatcmpl' : kind === 'anthropic' ? 'msg' : 'resp'}_${randomUUID().replaceAll('-', '')}`;
      const created = Math.floor(Date.now() / 1000);
      if (kind === 'anthropic') {
        response.setHeader('x-bridge-compatibility', 'experimental-prompt-tools');
        response.setHeader('x-bridge-advisory-fields', input.advisoryFields.join(','));
        if (!result.usage) response.setHeader('x-bridge-usage', 'unknown-reported-as-zero');
      }
      if (!input.stream && kind === 'anthropic') return json(response, 200, anthropicMessage(id, input.publicModel, result));
      if (!input.stream) return json(response, 200, kind === 'chat' ? chatCompletion(id, input.publicModel, result, created) : responseObject(id, input.publicModel, result, created));
      // Buffered SSE: CLI completes first, then its final text is emitted as protocol events.
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const events = kind === 'chat' ? chatEvents(id, input.publicModel, result, created, input.includeUsage)
        : kind === 'anthropic' ? anthropicEvents(id, input.publicModel, result) : responseEvents(id, input.publicModel, result, created);
      for (const event of events) {
        const value = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
        const line = `${event.event ? `event: ${event.event}\n` : ''}data: ${value}\n\n`;
        if (!response.write(line)) {
          await once(response, 'drain', { signal: controller.signal });
        }
        if (controller.signal.aborted) return;
      }
      response.end();
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const safe = error instanceof BridgeError ? error : new BridgeError(500, 'internal_error', 'Internal bridge error.');
      if (!response.headersSent) json(response, safe.status, anthropic
        ? { type: 'error', error: { type: safe.status === 401 ? 'authentication_error' : safe.status === 400 ? 'invalid_request_error' : safe.status === 429 ? 'rate_limit_error' : 'api_error', message: safe.message }, request_id: `req_${randomUUID()}` }
        : { error: { type: safe.code, code: safe.code, message: safe.message } });
      else response.end();
    } finally {
      if (ownsSlot) active = false;
      request.off('aborted', disconnected);
      response.off('close', disconnected);
      config.shutdownSignal?.removeEventListener('abort', shutdown);
    }
  };
}
