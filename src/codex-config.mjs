import { catalogModel, catalogContextWindow, modelDisplayName, DEFAULT_WORKBUDDY_MODEL } from './model-catalog.mjs';
import { join } from 'node:path';

export const CODEX_PROVIDER_ID = 'workbuddy';
export function selectedCodexModel(config, requested) {
  const model = requested ?? config.codexModel ?? config.claudeModel ?? DEFAULT_WORKBUDDY_MODEL;
  if (!config.models.has(model)) throw new Error('未知 WorkBuddy 模型；运行 npm run models 查看。');
  return model;
}
export function codexModelCatalog(config) {
  return { models: [...config.models].map(([id, upstream], priority) => {
    const context = catalogContextWindow(catalogModel(upstream)) ?? 64000;
    return { slug: id, display_name: modelDisplayName(config, id), description: `WorkBuddy bridge · ${upstream}`,
      default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort, description: effort })),
      shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority,
      base_instructions: 'You are a coding assistant. Follow client instructions and permissions. Use client tools to complete tasks; never invent their results.',
      model_messages: null, default_reasoning_summary: 'auto', support_verbosity: false,
      apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'tokens', limit: 10000 },
      context_window: context, max_context_window: context, effective_context_window_percent: 90,
      input_modalities: ['text'], supports_search_tool: false, use_responses_lite: false,
      experimental_supported_tools: [],
      supports_reasoning_effort_updates: false, node_repl_disabled: true, tool_mode: null };
  }) };
}
export function codexEnvironment(config, ambient = process.env) {
  const env = { ...ambient, WORKBUDDY_BRIDGE_API_KEY: config.apiKey };
  const exclusions = new Set((ambient.NO_PROXY ?? ambient.no_proxy ?? '').split(',').filter(Boolean));
  for (const host of ['localhost', '127.0.0.1', '::1']) exclusions.add(host);
  env.NO_PROXY = env.no_proxy = [...exclusions].join(',');
  return env;
}
export function codexArguments(config, catalogFile, model, forwarded = []) {
  const upstream = catalogModel(config.models.get(model));
  const context = catalogContextWindow(upstream) ?? 64000;
  const setting = (key, value) => ['-c', `${key}=${JSON.stringify(value)}`];
  return [
    ...setting('model_provider', CODEX_PROVIDER_ID),
    ...setting('model', model),
    ...setting('model_providers.workbuddy.name', 'WorkBuddy Bridge'),
    ...setting('model_providers.workbuddy.base_url', `http://127.0.0.1:${config.port}/v1`),
    ...setting('model_providers.workbuddy.env_key', 'WORKBUDDY_BRIDGE_API_KEY'),
    ...setting('model_providers.workbuddy.wire_api', 'responses'),
    ...setting('model_providers.workbuddy.requires_openai_auth', false),
    ...setting('model_providers.workbuddy.supports_websockets', false),
    ...setting('model_providers.workbuddy.request_max_retries', 0),
    ...setting('model_providers.workbuddy.stream_max_retries', 0),
    ...setting('model_providers.workbuddy.stream_idle_timeout_ms', config.timeoutMs + 10000),
    ...setting('model_catalog_json', catalogFile),
    ...setting('model_context_window', context),
    ...setting('model_auto_compact_token_limit', Math.floor(context * 0.75)),
    ...setting('model_reasoning_effort', 'low'),
    ...setting('model_reasoning_summary', 'auto'),
    ...setting('web_search', 'disabled'),
    ...forwarded
  ];
}
export function codexCatalogFile(config) { return join(config.runtimeDir, 'codex-profile', 'models.json'); }
export function verifyCodexCheck(stdout, expected, requireTool = false) {
  const events = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  if (events.some(event => event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error')) {
    throw new Error('Codex 返回错误；未验证成功回复。');
  }
  const final = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item;
  if (final?.text?.trim() !== expected || !events.some(event => event.type === 'turn.completed')) throw new Error('Codex 未完成准确的验证回复。');
  if (requireTool && !events.some(event => event.type === 'item.completed' && event.item?.type === 'command_execution' &&
    event.item.exit_code === 0 && event.item.aggregated_output?.includes(expected))) throw new Error('Codex 未验证实际文件读取结果。');
  return requireTool ? { codex_tools_verified: true } : { codex_text_verified: true };
}
