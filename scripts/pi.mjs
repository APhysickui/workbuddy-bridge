import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { runClient } from '../src/launcher.mjs';
import { verifyPiCheck, PI_PROVIDER_ID } from '../src/pi-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
try {
  const config = readConfig();
  const check = process.argv.includes('--check');
  const args = ['--provider', PI_PROVIDER_ID, '--model', config.claudeModel,
    '-e', join(project, '.pi/extensions/workbuddy.js')];
  if (check) args.push('--print', '--mode', 'json', '--no-session', '--no-tools', '--no-mcp', '--no-extensions',
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--offline', 'Reply with PI_WORKBUDDY_OK only.');
  const stdout = await runClient('pi', [...args, ...process.argv.slice(2).filter(arg => arg !== '--check')],
    { cwd: project, capture: check, allowFailure: check, timeout: check ? config.timeoutMs + 30000 : undefined });
  if (check) console.log(JSON.stringify({ ...verifyPiCheck(stdout), model: config.claudeModel }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
