import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readConfig } from '../src/config.mjs';

const config = readConfig();
let found = false;
try { await access(config.cliPath); found = true; } catch {}
let packageName = 'unknown';
try { packageName = JSON.parse(await readFile(resolve(dirname(await realpath(config.cliPath)), '../package.json'), 'utf8')).name; } catch {}
console.log(JSON.stringify({ node: process.version, backend: config.backend, cli_installed: found,
  cli_path: config.cliPath, package_name: packageName, endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens'],
  claude_model: config.claudeModel ?? null, claude_passthrough: config.claudePassthrough,
  pi_provider: 'workbuddy-cli', pi_transport: 'in_process_official_cli', anthropic_tools: 'experimental_prompt_translation',
  stream_mode: 'live_thinking_buffered_answer', thinking: 'public_cli_blocks_only', reasoning_effort: config.reasoningEffort, credit_sharing: 'unverified',
  configured_models: config.models.size, model_list_command: 'npm run models',
  next: found ? 'npm run probe performs one small real request using the official CLI login' : 'Install and sign in to official CodeBuddy CLI, then set CODEBUDDY_BIN' }, null, 2));
