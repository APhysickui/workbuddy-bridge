import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { DEFAULT_WORKBUDDY_MODEL, modelDisplayName } from '../src/model-catalog.mjs';

try {
  const name = modelDisplayName({ models: new Map([[DEFAULT_WORKBUDDY_MODEL, DEFAULT_WORKBUDDY_MODEL]]) }, DEFAULT_WORKBUDDY_MODEL);
  await writeFile('.env', `BRIDGE_BACKEND=mock\nBRIDGE_PORT=18765\nBRIDGE_API_KEY=${randomBytes(32).toString('hex')}\nBRIDGE_TIMEOUT_MS=120000\nBRIDGE_MAX_BODY_BYTES=2097152\nBRIDGE_MODELS=catalog\nBRIDGE_CLAUDE_MODEL=${DEFAULT_WORKBUDDY_MODEL}\nBRIDGE_CLAUDE_MODEL_NAME=${name}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random local key. Start with npm start.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; left unchanged.');
  else throw error;
}
