import { access, mkdir, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { kimiProfile, kimiEnvironment } from './kimi-config.mjs';

const execute = promisify(execFile);

export async function installKimiHerdr(profileDir, options = {}) {
  const env = options.env ?? process.env;
  let installed = false;
  try { await access(join(profileDir, 'hooks/herdr-agent-state.sh')); installed = true; } catch {}
  // Reinstall after regenerating config.toml, including when an existing profile
  // is launched outside Herdr. The official installer merges its hooks idempotently.
  if (!options.force && env.HERDR_ENV !== '1' && !installed) return { enabled: false, reason: 'not_requested' };
  try {
    await (options.execute ?? execute)(env.HERDR_BIN_PATH || 'herdr', ['integration', 'install', 'kimi'], {
      env: { ...env, KIMI_CODE_HOME: profileDir }, timeout: 10000, maxBuffer: 128 * 1024
    });
    return { enabled: true };
  } catch (error) {
    return { enabled: false, reason: error.code === 'ENOENT' ? 'herdr_not_found' : 'install_failed' };
  }
}

export async function setupKimiProfile(config, model, profileDir, options = {}) {
  const profile = kimiProfile(config, model);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const path = join(profileDir, 'config.toml');
  await writeFile(path, profile, { mode: 0o600 });
  await chmod(path, 0o600);
  return await installKimiHerdr(profileDir, {
    ...options, env: kimiEnvironment(config, profileDir, options.env ?? process.env)
  });
}
