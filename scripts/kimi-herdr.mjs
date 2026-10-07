import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { setupKimiProfile } from '../src/kimi-setup.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const config = readConfig();
  const model = config.models.has('kimi-k3-1') ? 'kimi-k3-1' : config.claudeModel;
  const result = await setupKimiProfile(config, model, join(project, '.runtime/kimi-profile'), { force: true });
  if (!result.enabled) throw new Error(result.reason === 'herdr_not_found'
    ? '未找到 herdr；请先安装 Herdr 或将它加入 PATH。'
    : 'Herdr 的 Kimi 集成安装失败；请在普通终端检查 herdr integration install kimi。');
  console.log('已为 WorkBuddy Kimi profile 安装 Herdr 实时状态 hook。退出旧 Kimi 会话后，在 Herdr pane 中重新启动 npm run kimi。');
  console.log('普通 kimi 的全局接入可在终端执行 herdr integration install kimi。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
