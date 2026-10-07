import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBridge } from '../src/launcher.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { await ensureBridge(project); }
catch (error) { console.error(error.message); process.exitCode = 1; }
