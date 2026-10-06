import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const settingsPath = join(homedir(), '.claude/settings.json');
const text = await readFile(settingsPath, 'utf8');
const settings = JSON.parse(text);
if (settings.model !== 'deepseek-v4-flash') {
  console.log('Global default is no longer deepseek-v4-flash; left unchanged.');
} else {
  settings.model = 'opus';
  const temporary = `${settingsPath}.workbuddy-restore-${randomUUID()}.tmp`;
  try {
    const mode = (await stat(settingsPath)).mode & 0o777;
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode });
    if (await readFile(settingsPath, 'utf8') !== text) throw new Error('Claude settings changed during restoration. Retry after closing Claude.');
    await rename(temporary, settingsPath);
    console.log('Restored the global default model to opus. Provider settings and all other fields were preserved.');
  } finally {
    await rm(temporary, { force: true });
  }
}
