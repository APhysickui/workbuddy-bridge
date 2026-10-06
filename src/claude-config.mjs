import { claudeModelId } from './claude-models.mjs';

export function claudeSettings(config) {
  if (!config.claudeModel || !config.models.has(config.claudeModel)) {
    throw new Error('BRIDGE_CLAUDE_MODEL must name a configured BRIDGE_MODELS entry');
  }
  const model = config.claudeModel;
  const name = config.claudeModelName ?? ({
    'deepseek-v4-flash': 'DeepSeek V4 Flash（workbuddy）',
    'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash（workbuddy）'
  }[model] ?? `${model}（workbuddy）`);
  return {
    model,
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
      ANTHROPIC_API_KEY: config.apiKey,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_MODEL: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: name,
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'WorkBuddy 本地桥接 · 实验性工具转换',
      ANTHROPIC_DEFAULT_FABLE_MODEL: model,
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: name,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: name,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: name,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: name,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
      CLAUDE_CODE_EFFORT_LEVEL: 'low'
    }
  };
}

export function directClaudeSettings(config, project, node) {
  if (!config.claudePassthrough) throw new Error('普通 Claude 接入需要 BRIDGE_CLAUDE_PASSTHROUGH=1，才能保留原服务商。');
  const isolated = claudeSettings(config);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return {
    env: {
      ANTHROPIC_BASE_URL: isolated.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: config.apiKey,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_MODEL_OPTION: claudeModelId(config.claudeModel),
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: isolated.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'WorkBuddy 共享积分 · CodeBuddy CLI 桥接',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1'
    },
    hooks: { SessionStart: [{ hooks: [{ type: 'command',
      command: `cd ${quote(project)} && ${quote(node)} --env-file=.env scripts/ensure-bridge.mjs`, timeout: 15 }] }] }
  };
}

export function claudeEnvironment(config, profileDir, ambient = process.env) {
  // A session-specific configuration, isolated from other provider credentials.
  const clean = Object.fromEntries(Object.entries(ambient).filter(([key]) => !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_') && key !== 'DISABLE_PROMPT_CACHING' && !key.startsWith('DISABLE_PROMPT_CACHING_')));
  return { ...clean, ...claudeSettings(config).env, CLAUDE_CONFIG_DIR: profileDir,
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' };
}
