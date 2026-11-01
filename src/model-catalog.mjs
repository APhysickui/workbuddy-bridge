import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const workbuddyCatalog = JSON.parse(readFileSync(new URL('./workbuddy-models.json', import.meta.url), 'utf8'));
const byId = new Map(workbuddyCatalog.models.map(model => [model.id, model]));

export const DEFAULT_WORKBUDDY_MODEL = workbuddyCatalog.defaultModel;
export const DEFAULT_MODEL_ALIASES = workbuddyCatalog.models.map(model => `${model.id}=${model.id}`).join(',');
export const CATALOG_REVISION = createHash('sha256').update(JSON.stringify(workbuddyCatalog.models)).digest('hex');

export function catalogModel(upstreamId) {
  return byId.get(upstreamId);
}

export function catalogContextWindow(model) {
  // The official CLI treats maxInputTokens as the shared context budget and,
  // when available, uses contextWindow.defaultLength for a new session.
  // Do not add maxOutputTokens or advertise a larger budget than the CLI uses.
  const lengths = catalogContextLengths(model);
  if (lengths.length >= 2) return lengths.includes(model?.contextWindow?.defaultLength) ? model.contextWindow.defaultLength : lengths[0];
  return model?.maxInputTokens;
}

export function catalogContextLengths(model) {
  const lengths = Array.isArray(model?.contextWindow?.supportedLengths) ? model.contextWindow.supportedLengths : [];
  return [...new Set(lengths.filter(value =>
    Number.isSafeInteger(value) && value > 0 && (model?.maxInputTokens === undefined || value <= model.maxInputTokens)))].sort((a, b) => a - b);
}

export function catalogMaximumContextWindow(model) {
  const lengths = catalogContextLengths(model);
  return lengths.length >= 2 ? lengths.at(-1) : model?.maxInputTokens;
}

export function modelDisplayName(config, id) {
  const model = catalogModel(config.models.get(id));
  const name = (id === config.claudeModel ? config.claudeModelName : undefined) ?? model?.displayName ?? model?.name ?? id;
  return name.endsWith('（workbuddy）') ? name : `${name}（workbuddy）`;
}
