import { resolve } from 'node:path';
import { DEFAULT_MODEL_ALIASES } from './model-catalog.mjs';

export const bundledCli = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';

function integer(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

export function readConfig(env = process.env) {
  const backend = env.BRIDGE_BACKEND ?? 'mock';
  if (!['mock', 'workbuddy'].includes(backend)) throw new Error('BRIDGE_BACKEND must be mock or workbuddy');
  const apiKey = env.BRIDGE_API_KEY;
  if (!apiKey || apiKey.length < 24 || /\s/.test(apiKey) || apiKey === 'replace-with-a-random-local-key') {
    throw new Error('Run npm run init first, or set BRIDGE_API_KEY to a random key of at least 24 characters');
  }
  const models = new Map();
  for (const entry of (env.BRIDGE_MODELS ?? DEFAULT_MODEL_ALIASES).split(',')) {
    const match = /^([a-zA-Z0-9_.-]+)=([a-zA-Z0-9_.-]+)$/.exec(entry.trim());
    if (!match || models.has(match[1])) throw new Error('Invalid or duplicate BRIDGE_MODELS entry');
    models.set(match[1], match[2]);
  }
  return {
    backend,
    apiKey,
    host: '127.0.0.1',
    port: integer(env.BRIDGE_PORT, 18765, 1024, 65535, 'BRIDGE_PORT'),
    timeoutMs: integer(env.BRIDGE_TIMEOUT_MS, 60000, 1000, 300000, 'BRIDGE_TIMEOUT_MS'),
    models,
    cliPath: env.CODEBUDDY_BIN ?? bundledCli,
    runtimeDir: resolve('.runtime'),
    maxBodyBytes: integer(env.BRIDGE_MAX_BODY_BYTES, 64 * 1024, 1024, 4 * 1024 * 1024, 'BRIDGE_MAX_BODY_BYTES'),
    claudeModel: env.BRIDGE_CLAUDE_MODEL,
    claudeModelName: env.BRIDGE_CLAUDE_MODEL_NAME,
    claudePassthrough: env.BRIDGE_CLAUDE_PASSTHROUGH === '1'
  };
}
