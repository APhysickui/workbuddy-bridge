import { readFile, appendFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

// Test-only MCP reader: cannot execute commands or access any other path.
const paths = process.argv.slice(2).map(path => resolve(path));
if (paths.length !== 2) throw new Error('Two fixture paths are required');
const allowed = new Set(paths);
const receipt = join(dirname(paths[0]), 'client-reads.jsonl');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
    capabilities: { tools: {} }, serverInfo: { name: 'workbuddy-codex-fixture', version: '1' } };
  else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') result = { tools: [{ name: 'read',
    description: 'WORKBUDDY_CODEX_TEST_READ: Read one of two allowed temporary UTF-8 fixture files.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] };
  else if (message.method === 'tools/call' && message.params?.name === 'read') {
    const requested = message.params.arguments?.path;
    if (typeof requested !== 'string' || !allowed.has(resolve(requested))) result = { isError: true, content: [{ type: 'text', text: 'Fixture path is not allowed.' }] };
    else {
      const path = resolve(requested), text = await readFile(path, 'utf8');
      await appendFile(receipt, JSON.stringify({ path }) + '\n', { mode: 0o600 });
      result = { content: [{ type: 'text', text }] };
    }
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown fixture method' } }); continue;
  }
  send({ jsonrpc: '2.0', id: message.id, result });
}
