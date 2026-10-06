import { catalogModel, catalogContextWindow, modelDisplayName } from './model-catalog.mjs';

export function claudeModelId(id) {
  return `claude-workbuddy-${id}`;
}

export function claudeRouteModels(config) {
  const models = new Map(config.models);
  for (const [id, upstreamId] of config.models) {
    const alias = claudeModelId(id);
    if (models.has(alias) && models.get(alias) !== upstreamId) throw new Error('Conflicting Claude WorkBuddy model alias');
    models.set(alias, upstreamId);
  }
  return models;
}

export function bridgeModelList(config, anthropic = false) {
  // Claude's gateway discovery only accepts IDs containing "claude" or "anthropic".
  // These are explicit bridge aliases. The official CLI still receives its real ID.
  return [...config.models].map(([id, upstreamId]) => {
    const model = catalogModel(upstreamId);
    return { id: anthropic ? claudeModelId(id) : id, object: 'model', type: 'model', created: 0,
      owned_by: 'local-bridge', display_name: modelDisplayName(config, id),
      description: `WorkBuddy · official CodeBuddy CLI · ${upstreamId}`,
      ...(model ? { context_window: catalogContextWindow(model), max_input_tokens: model.maxInputTokens,
        max_output_tokens: model.maxOutputTokens } : {}) };
  });
}
