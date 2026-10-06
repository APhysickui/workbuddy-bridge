import { appendFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
assert.ok(args.includes('--print'));
assert.equal(args[args.indexOf('--tools') + 1], '');
assert.equal(args[args.indexOf('--setting-sources') + 1], 'none');
await appendFile('fixture-invocations.txt', 'call\n');
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const history = JSON.parse(stdin);
const all = JSON.stringify(history);
if (all.includes('SIMULATE_EMPTY_CLI')) process.exit(0);
const model = args[args.indexOf('--model') + 1];
console.log(JSON.stringify({ type: 'system', subtype: 'init', model }));
const toolResults = history.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
let result;
if (toolResults.length) {
  const marker = JSON.stringify(toolResults).match(/PI_CLI_FILE_[a-f0-9-]+/)?.[0];
  assert.ok(marker);
  result = { text: marker, tool_calls: [] };
} else if (all.includes('Use read to read ')) {
  const text = history.at(-1).content.map(block => block.text ?? '').join('');
  const path = text.match(/Use read to read (\S+)/)?.[1];
  assert.ok(path);
  result = { text: '', tool_calls: [{ name: 'read', input: { path } }] };
} else result = { text: 'PI_WORKBUDDY_OK', tool_calls: [] };
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result),
  usage: { input_tokens: 2, output_tokens: 5 } }));
