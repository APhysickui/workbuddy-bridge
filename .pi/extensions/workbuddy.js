import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { readConfig } from '../../src/config.mjs';
import { registerPiProvider } from '../../src/pi-config.mjs';
import { WorkBuddyAdapter } from '../../src/adapters.mjs';
import { directPiProvider } from '../../src/pi-direct.mjs';
import { anthropicMessagesApi, createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

export default function workbuddy(pi) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const config = readConfig({ ...process.env, ...parseEnv(readFileSync(join(project, '.env'), 'utf8')) });
  config.runtimeDir = join(project, '.runtime');
  config.backend = 'workbuddy';
  registerPiProvider(pi, directPiProvider(config, new WorkBuddyAdapter(config), anthropicMessagesApi(), createAssistantMessageEventStream));
}
