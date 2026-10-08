import { createHandler } from './server.mjs';
import { createLocalFetch } from './local-fetch.mjs';
import { piProvider } from './pi-config.mjs';

function localError(message) {
  const body = message.match(/^\d{3}\s+({[\s\S]*})$/)?.[1];
  if (!body) return message;
  try {
    const detail = JSON.parse(body);
    if (detail.type === 'error' && typeof detail.error?.message === 'string') return 'WorkBuddy CLI: ' + detail.error.message;
  } catch {}
  return 'WorkBuddy CLI failed to return a valid local response.';
}

export function directPiProvider(config, adapter, anthropicApi, createStream) {
  // The pi route only invokes configured CLI models. Original Claude auth is irrelevant here.
  const localConfig = { ...config, claudePassthrough: false, originalProvider: undefined };
  const localFetch = createLocalFetch(createHandler(localConfig, adapter));
  return {
    ...piProvider(config),
    name: 'WorkBuddy · CodeBuddy CLI',
    baseUrl: 'http://workbuddy-cli.local',
    streamSimple(model, context, options = {}) {
      const outer = createStream();
      (async () => {
        try {
          const inner = anthropicApi.streamSimple(model, context, { ...options,
            apiKey: config.apiKey, fetch: localFetch, maxRetries: 0,
            onPayload: async (payload, target) => {
              const next = await options.onPayload?.(payload, target) ?? payload;
              // pi's budget-based Anthropic options do not name the selected
              // effort. Carry it explicitly to the official CLI when selected.
              return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.reasoning)
                ? { ...next, output_config: { ...next.output_config, effort: options.reasoning } } : next;
            } });
          for await (const event of inner) {
            // A local CLI startup/protocol failure is not a retryable HTTP 502.
            // Keep the actual safe message so pi's agent-level retry also stops.
            outer.push(event.type === 'error' ? { ...event, error: { ...event.error,
              errorMessage: localError(event.error.errorMessage ?? 'WorkBuddy CLI failed.') } } : event);
          }
          outer.end();
        } catch {
          const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), stopReason: options.signal?.aborted ? 'aborted' : 'error',
            errorMessage: 'WorkBuddy CLI stream could not start.', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
              totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          outer.push({ type: 'error', reason: message.stopReason, error: message });
          outer.end();
        }
      })();
      return outer;
    }
  };
}
