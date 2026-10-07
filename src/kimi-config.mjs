import { catalogModel, catalogContextWindow, modelDisplayName } from './model-catalog.mjs';

export const KIMI_PROVIDER_ID = 'workbuddy-bridge';
export const KIMI_CHECK_REPLY = 'KIMI_WORKBUDDY_OK';

export function kimiAlias(id) { return `${KIMI_PROVIDER_ID}/${id}`; }

export function kimiProfile(config, model) {
  if (!config.models.has(model)) throw new Error('未知 WorkBuddy 模型；请运行 npm run models 查看。');
  const lines = [
    '# Generated WorkBuddy-only profile; global Kimi settings are not modified.',
    `default_model = ${JSON.stringify(kimiAlias(model))}`,
    'telemetry = false',
    '', '[thinking]', 'enabled = false',
    '', '[secondary_model]', `default_model = ${JSON.stringify(kimiAlias(model))}`,
    '', '[model_catalog]', 'refresh_on_start = false',
    '', `[providers.${KIMI_PROVIDER_ID}]`, 'type = "anthropic"',
    `base_url = "http://127.0.0.1:${config.port}"`,
    'api_key_env = "WORKBUDDY_BRIDGE_API_KEY"'
  ];
  for (const [id, upstream] of config.models) {
    const entry = catalogModel(upstream);
    lines.push('', `[models.${JSON.stringify(kimiAlias(id))}]`,
      `provider = ${JSON.stringify(KIMI_PROVIDER_ID)}`,
      `model = ${JSON.stringify(id)}`,
      `display_name = ${JSON.stringify(modelDisplayName(config, id))}`,
      `max_context_size = ${catalogContextWindow(entry) ?? 64000}`,
      `max_output_size = ${entry?.maxOutputTokens ?? 4096}`,
      'capabilities = ["tool_use"]');
  }
  return lines.join('\n') + '\n';
}

export function kimiEnvironment(config, profileDir, env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_')));
  const exclusions = new Set((env.NO_PROXY ?? env.no_proxy ?? '').split(',').filter(Boolean));
  for (const host of ['localhost', '127.0.0.1', '::1']) exclusions.add(host);
  return { ...clean, KIMI_CODE_HOME: profileDir, WORKBUDDY_BRIDGE_API_KEY: config.apiKey,
    NO_PROXY: [...exclusions].join(','), no_proxy: [...exclusions].join(',') };
}

export async function checkKimiUpstream(config, model, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`http://127.0.0.1:${config.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
      body: JSON.stringify({ model, max_tokens: 128, messages: [{ role: 'user', content: `Reply with ${KIMI_CHECK_REPLY} only.` }] }),
      signal: AbortSignal.timeout(config.timeoutMs + 5000)
    });
  } catch {
    throw new Error(`无法连接 WorkBuddy 桥接 127.0.0.1:${config.port}；未启动 Kimi 会话。`);
  }
  let body;
  try { body = await response.json(); } catch { throw new Error('WorkBuddy 桥接返回了无法识别的响应；未启动 Kimi 会话。'); }
  if (!response.ok) throw new Error(`WorkBuddy 预检失败（HTTP ${response.status}）：${body.error?.message ?? '请检查官方 CodeBuddy 登录及桥接配置。'}`);
  if (body.model !== model || body.stop_reason !== 'end_turn' || body.content?.length !== 1 ||
      body.content[0]?.type !== 'text' || typeof body.content[0]?.text !== 'string' || body.content[0].text.trim() !== KIMI_CHECK_REPLY) {
    throw new Error('WorkBuddy 预检未返回目标模型的准确回复；未启动 Kimi 会话。');
  }
}

export function verifyKimiCheck(stdout, expected = KIMI_CHECK_REPLY, requireTool = false) {
  const events = stdout.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  if (events.some(event => event.role === 'meta' && /error|fail|retry/.test(event.type ?? ''))) {
    throw new Error('Kimi 返回了错误或重试，未验证成功回复。');
  }
  const final = events.filter(event => event.role === 'assistant').at(-1);
  if (typeof final?.content !== 'string' || final.content.trim() !== expected || final.tool_calls?.length) throw new Error('Kimi 未返回准确的验证文字。');
  if (requireTool && !events.some(event => event.role === 'tool' && String(event.content).includes(expected))) {
    throw new Error('Kimi 未验证实际读取文件的工具结果。');
  }
  return requireTool ? { kimi_tools_verified: true } : { kimi_text_verified: true };
}
