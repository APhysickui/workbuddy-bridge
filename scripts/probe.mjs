import { readConfig } from '../src/config.mjs';
import { WorkBuddyAdapter } from '../src/adapters.mjs';

const config = readConfig();
console.log('Invoking the configured official CLI once. This may consume upstream credits; no retry is performed.');
try {
  const result = await new WorkBuddyAdapter(config).complete({ model: config.models.values().next().value,
    messages: [{ role: 'user', content: 'Reply with WORKBUDDY_BRIDGE_OK only.' }] });
  const ok = result.text.trim() === 'WORKBUDDY_BRIDGE_OK';
  console.log(JSON.stringify({ completion_received: true, expected_reply: ok, usage: result.usage,
    credit_sharing: 'unverified; compare WorkBuddy account credits before/after this request' }, null, 2));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ completion_received: false, code: error.code ?? 'probe_failed', message: error.message }));
  process.exitCode = 1;
}
