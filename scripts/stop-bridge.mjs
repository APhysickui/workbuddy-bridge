import { readConfig } from '../src/config.mjs';
import { stopKnownBridge } from '../src/bridge-service.mjs';

try {
  const config = readConfig();
  console.log(await stopKnownBridge(config) ? 'Background bridge is stopping.' : 'No background bridge is running.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
