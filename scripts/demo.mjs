import { readConfig } from '../src/config.mjs';

const config = readConfig();
const endpoint = `http://127.0.0.1:${config.port}/v1/chat/completions`;
try {
  const response = await fetch(endpoint, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.models.keys().next().value,
      messages: [{ role: 'user', content: '你好，请用一句话介绍你自己。' }] }), signal: AbortSignal.timeout(config.timeoutMs + 5000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  console.log(body.choices[0].message.content);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
