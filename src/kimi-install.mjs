import { mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { kimiProfile } from './kimi-config.mjs';

const markerStart = '# >>> workbuddy-bridge kimi startup';
const markerEnd = '# <<< workbuddy-bridge kimi startup';

function stringValue(block, key) {
  let state = null;
  for (const line of block.split('\n')) {
    const value = !state && line.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`))?.[1];
    state = nextStringState(line, state);
    if (!value) continue;
    try { return value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value); } catch { return null; }
  }
  return null;
}

function tablePath(line) {
  const header = /^\s*(\[\[?)(.*?)\]\]?\s*(?:#.*)?$/.exec(line);
  if (!header) return null;
  const tokens = header[2].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+|\./g);
  if (!tokens || tokens.join('').replaceAll(' ', '') !== header[2].replace(/\s+/g, '')) return null;
  const path = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i % 2) { if (tokens[i] !== '.') return null; continue; }
    try { path.push(tokens[i][0] === '"' ? JSON.parse(tokens[i]) : tokens[i][0] === "'" ? tokens[i].slice(1, -1) : tokens[i]); }
    catch { return null; }
  }
  return { path, array: header[1] === '[[' };
}

// Keep unrelated TOML bytes and comments. Headers inside multiline strings
// are data, not tables; their contents must never be edited or removed.
function nextStringState(line, state) {
  let quote = state;
  for (let i = 0; i < line.length; i++) {
    if (quote?.length === 3) {
      if (quote === '"""' && line[i] === '\\') { i++; continue; }
      if (line.startsWith(quote, i)) { i += 2; quote = null; }
    } else if (quote) {
      if (quote === '"' && line[i] === '\\') { i++; continue; }
      if (line[i] === quote) quote = null;
    } else {
      if (line[i] === '#') break;
      if (line[i] === '"' || line[i] === "'") {
        quote = line.startsWith(line[i].repeat(3), i) ? line[i].repeat(3) : line[i];
        if (quote.length === 3) i += 2;
      }
    }
  }
  return quote?.length === 3 ? quote : null;
}

function tables(raw) {
  const sections = [{ path: [], array: false, text: '' }];
  let state = null;
  for (const line of raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const table = state ? null : tablePath(line.trimEnd());
    if (table) sections.push({ ...table, text: '' });
    sections.at(-1).text += line;
    state = nextStringState(line, state);
  }
  if (state) throw new Error('Kimi 配置的多行字符串未结束，未修改。');
  return sections;
}

function setValue(section, key, value) {
  const lines = section.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let state = null, replaced = false;
  section.text = lines.map(line => {
    const match = !state && new RegExp(`^\\s*${key}\\s*=`).test(line);
    state = nextStringState(line, state);
    if (!match) return line;
    if (replaced) throw new Error(`Kimi 配置存在重复 ${key}，未修改。`);
    replaced = true;
    return `${key} = ${JSON.stringify(value)}\n`;
  }).join('');
  if (!replaced) section.text = section.text.trimEnd() + `\n${key} = ${JSON.stringify(value)}\n\n`;
}

function ownedProvider(section, port) {
  if (section.array || section.path.length !== 2 || section.path[0] !== 'providers' ||
      !['workbuddy', 'workbuddy-bridge'].includes(section.path[1])) return false;
  try {
    const url = new URL(stringValue(section.text, 'base_url'));
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      ['8799', '18765', String(port)].includes(url.port);
  } catch { return false; }
}

export function planKimiInstallation(raw, config, project, nodePath) {
  let start = -1, end = -1, offset = 0, state = null;
  for (const line of raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (!state && line.trim() === markerStart) {
      if (start >= 0) throw new Error('Kimi 启动 hook 标记重复，未修改。');
      start = offset;
    }
    if (!state && line.trim() === markerEnd) end = offset + line.length;
    state = nextStringState(line, state);
    offset += line.length;
  }
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error('Kimi 启动 hook 标记损坏，未修改。');
  if (start >= 0) raw = raw.slice(0, start) + raw.slice(end);
  let sections = tables(raw);
  const owned = new Set(sections.filter(section => ownedProvider(section, config.port)).map(section => section.path[1]));
  const provider = owned.has('workbuddy') ? 'workbuddy' : 'workbuddy-bridge';
  if (sections.some(section => section.path[0] === 'providers' && section.path[1] === provider) && !owned.has(provider)) {
    throw new Error(`Kimi 提供商 ${provider} 指向其他服务，未覆盖。`);
  }
  const previous = stringValue(sections[0].text, 'default_model');
  const oldId = previous?.split('/').slice(1).join('/');
  const model = config.models.has(oldId) ? oldId : config.models.has('kimi-k3-1') ? 'kimi-k3-1' : config.claudeModel;
  const alias = `${provider}/${model}`;
  const selectDefault = !previous || owned.has(previous.split('/')[0]);
  sections = sections.filter(section => !(section.path[0] === 'providers' && owned.has(section.path[1])) &&
    !(section.path[0] === 'models' && owned.has(stringValue(section.text, 'provider'))));
  const setTable = (name, key, value) => {
    let section = sections.find(section => !section.array && section.path.length === 1 && section.path[0] === name);
    if (!section) { section = { path: [name], array: false, text: `[${name}]\n` }; sections.push(section); }
    setValue(section, key, value);
  };
  if (selectDefault) {
    setValue(sections[0], 'default_model', alias);
    setTable('thinking', 'enabled', true);
    setTable('secondary_model', 'default_model', alias);
  }
  const profile = kimiProfile(config, model, { providerId: provider, includeApiKey: true });
  const managed = profile.slice(profile.indexOf(`[providers.${provider}]`));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `${quote(nodePath)} ${quote(join(project, 'scripts/kimi-startup.mjs'))}`;
  const startup = `${markerStart}\n[[hooks]]\nevent = "SessionStart"\ncommand = ${JSON.stringify(command)}\ntimeout = 15\n${markerEnd}\n`;
  return { text: sections.map(section => section.text.endsWith('\n') ? section.text : section.text + '\n').join('').trimEnd() + '\n\n' + managed.trimEnd() + '\n\n' + startup,
    summary: { provider, model, default: selectDefault ? alias : previous, api: 'anthropic', base_url: `http://127.0.0.1:${config.port}`,
      models: config.models.size, removed_providers: [...owned], startup: 'start_authenticated_project_bridge', thinking: selectDefault ? true : 'preserved' } };
}

export async function installKimi(kimiDir, config, project, nodePath, options = {}) {
  const path = join(kimiDir, 'config.toml');
  const original = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const plan = planKimiInstallation(original, config, project, nodePath);
  if (!options.apply) return { ...plan.summary, applied: false };
  await mkdir(kimiDir, { recursive: true, mode: 0o700 });
  const lock = join(kimiDir, 'config.toml.workbuddy-lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Kimi 配置正在被写入，未修改。'); throw error; }
  let temp;
  try {
    const latest = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (latest !== original) throw new Error('Kimi 配置在检查后发生变化，未覆盖。');
    if (original === plan.text) return { ...plan.summary, applied: true, backup: null };
    const backup = join(kimiDir, `config.toml.workbuddy-backup-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
    const target = await realpath(path).catch(error => { if (error.code === 'ENOENT') return path; throw error; });
    temp = target + '.workbuddy-' + randomUUID();
    await writeFile(temp, plan.text, { mode: 0o600, flag: 'wx' });
    if (options.validate) await options.validate(temp);
    await rename(temp, target);
    return { ...plan.summary, applied: true, backup };
  } finally {
    if (temp) await rm(temp, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
