import { createServer } from 'node:http';
import { readConfig } from './config.mjs';
import { MockAdapter, WorkBuddyAdapter } from './adapters.mjs';
import { createHandler } from './server.mjs';
import { readOriginalProvider } from './passthrough.mjs';

try {
  const config = readConfig();
  if (config.claudePassthrough) config.originalProvider = await readOriginalProvider(config);
  const shutdown = new AbortController();
  config.shutdownSignal = shutdown.signal;
  const adapter = config.backend === 'mock' ? new MockAdapter() : new WorkBuddyAdapter(config);
  const server = createServer(createHandler(config, adapter));
  config.shutdown = () => {
    shutdown.abort();
    server.close();
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.timeout = config.timeoutMs + 10000;
  server.on('error', error => {
    console.error(`Cannot listen on 127.0.0.1:${config.port}: ${error.code ?? 'unknown error'}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`WorkBuddy Bridge: http://${config.host}:${config.port}/v1 (backend=${config.backend}, experimental Anthropic tools, buffered SSE)`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, config.shutdown);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
