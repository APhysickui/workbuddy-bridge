import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ownedLegacyProvider } from './pi-unify.mjs';
import { PI_PROVIDER_ID } from './pi-config.mjs';

// Compatibility lives in the current pi process. User models.json and other
// providers are not rewritten when this extension loads or reloads.
export function registerPiLegacyCompatibility(pi, config, createProvider,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent')) {
  let providers;
  try { providers = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')).providers ?? {}; }
  catch { return; }
  const legacy = ['workbuddy', PI_PROVIDER_ID].filter(id => ownedLegacyProvider(id, providers[id]));
  if (!legacy.length) return;
  const models = new Map(config.models);
  const oldFlash = 'deepseek-v4-flash', currentFlash = 'deepseek-v4.1-flash';
  if (!models.has(oldFlash) && models.has(currentFlash)) models.set(oldFlash, models.get(currentFlash));
  const compatible = { ...config, models };
  for (const id of legacy) {
    const provider = createProvider(compatible);
    provider.name = 'WorkBuddy · 旧入口兼容（官方 CLI）';
    provider.models = provider.models.map(model => model.id === oldFlash && !config.models.has(oldFlash)
      ? { ...model, name: 'DeepSeek V4.1 Flash（workbuddy，旧 V4 Flash 入口已迁移）' } : model);
    pi.registerProvider(id, provider);
  }
  async function migrate(ctx) {
    const previous = ctx.model;
    if (!previous || !legacy.includes(previous.provider)) return;
    const id = previous.id === oldFlash && !config.models.has(oldFlash) ? currentFlash : previous.id;
    if (!config.models.has(id)) return;
    if (previous.provider === PI_PROVIDER_ID && previous.id === id) return;
    const target = ctx.modelRegistry.find(PI_PROVIDER_ID, id);
    if (target && await pi.setModel(target)) {
      ctx.ui?.notify(`旧 WorkBuddy 入口已迁移到 ${PI_PROVIDER_ID}/${id}，通过官方 CLI 调用，不再连接旧本地端口。`, 'info');
    }
  }
  pi.on('session_start', (_event, ctx) => migrate(ctx));
  pi.on('model_select', (_event, ctx) => migrate(ctx));
}
