import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { workbuddyCatalog, catalogContextWindow } from '../src/model-catalog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
async function sourceFiles(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : /\.(mjs|js)$/.test(entry.name) ? [path] : [];
  }));
  return groups.flat();
}
const files = (await Promise.all(['src', 'scripts', 'test', '.pi/extensions'].map(sourceFiles))).flat();
for (const file of files) execFileSync(process.execPath, ['--check', resolve(root, file)], { stdio: 'pipe' });

const ids = new Set();
assert.ok(workbuddyCatalog.models.length > 0);
const doc = await readFile(resolve(root, 'docs/models.md'), 'utf8');
for (const model of workbuddyCatalog.models) {
  assert.match(model.id, /^[a-zA-Z0-9_.-]+$/);
  assert.ok(!ids.has(model.id), `Duplicate model: ${model.id}`);
  ids.add(model.id);
  const context = catalogContextWindow(model);
  for (const limit of [model.maxInputTokens, model.maxOutputTokens, context]) {
    assert.ok(Number.isSafeInteger(limit) && limit > 0, `Invalid limit: ${model.id}`);
  }
  assert.ok(context <= model.maxInputTokens, `Default context exceeds maximum: ${model.id}`);
  assert.ok(model.maxOutputTokens <= context, `Output exceeds context: ${model.id}`);
  assert.ok(doc.includes('`' + model.id + '`'), `Undocumented model: ${model.id}`);
}
assert.ok(ids.has(workbuddyCatalog.defaultModel), 'Default model is absent from catalog');
console.log(`Checked ${files.length} JavaScript files and ${ids.size} catalog entries; no upstream requests.`);
