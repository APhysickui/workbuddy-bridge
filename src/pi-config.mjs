import { catalogModel, catalogContextWindow, modelDisplayName } from './model-catalog.mjs';

export const PI_PROVIDER_ID = 'workbuddy-cli';

export function registerPiProvider(pi, provider) {
  pi.registerProvider(PI_PROVIDER_ID, provider);
}

export function piProvider(config) {
  return {
    name: 'WorkBuddy',
    baseUrl: `http://127.0.0.1:${config.port}`,
    apiKey: config.apiKey,
    api: 'anthropic-messages',
    models: [...config.models].map(([id, upstreamId]) => {
      const model = catalogModel(upstreamId);
      return {
        id, name: modelDisplayName(config, id),
        reasoning: false, input: ['text'],
        // Pi requires dollar rates. Zero is an unknown placeholder, not free credits.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: catalogContextWindow(model) ?? 64000,
        maxTokens: model?.maxOutputTokens ?? 4096
      };
    })
  };
}

export function verifyPiCheck(stdout, marker = 'PI_WORKBUDDY_OK', needsTool = false) {
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const messages = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message);
  const last = messages.at(-1);
  if (last?.stopReason === 'error') throw new Error(last.errorMessage ?? 'WorkBuddy CLI 请求失败。');
  const text = last?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
  if (!last || last.stopReason === 'error' || last.stopReason === 'aborted' || text.trim() !== marker ||
      (needsTool && !events.some(event => event.type === 'tool_execution_end' && !event.isError))) {
    throw new Error('pi 没有返回已核对的真实回复或工具结果，不能判定接入成功。');
  }
  return { pi_text_verified: true, pi_tools_verified: needsTool };
}
