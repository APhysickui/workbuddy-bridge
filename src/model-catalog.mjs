import { readFileSync } from 'node:fs';

export const workbuddyCatalog = JSON.parse(readFileSync(new URL('./workbuddy-models.json', import.meta.url), 'utf8'));
const byId = new Map(workbuddyCatalog.models.map(model => [model.id, model]));

export const DEFAULT_WORKBUDDY_MODEL = workbuddyCatalog.defaultModel;
export const DEFAULT_MODEL_ALIASES = workbuddyCatalog.models.map(model => `${model.id}=${model.id}`).join(',');

export function catalogModel(upstreamId) {
  return byId.get(upstreamId);
}

export function catalogContextWindow(model) {
  // The official CLI treats maxInputTokens as the shared context budget and,
  // when available, uses contextWindow.defaultLength for a new session.
  // Do not add maxOutputTokens or advertise a larger budget than the CLI uses.
  return model?.contextWindow?.defaultLength ?? model?.maxInputTokens;
}

export function modelDisplayName(config, id) {
  const model = catalogModel(config.models.get(id));
  const name = (id === config.claudeModel ? config.claudeModelName : undefined) ?? model?.displayName ?? model?.name ?? id;
  return name.endsWith('（workbuddy）') ? name : `${name}（workbuddy）`;
}
