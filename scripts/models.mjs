import { readConfig } from '../src/config.mjs';
import { piProvider } from '../src/pi-config.mjs';
import { catalogModel, catalogMaximumContextWindow, workbuddyCatalog } from '../src/model-catalog.mjs';

const config = readConfig();
console.log(`官方模型目录快照：${workbuddyCatalog.snapshotSavedAt}；提供商：workbuddy-cli`);
console.table(piProvider(config).models.map(model => ({
  ID: model.id,
  名称: model.name,
  当前共享预算: model.contextWindow,
  上游可选最大预算: catalogMaximumContextWindow(catalogModel(config.models.get(model.id))) ?? '未知',
  目录最大输入: catalogModel(config.models.get(model.id))?.maxInputTokens ?? '未知',
  最大输出: model.maxTokens
})));
console.log('单位为 tokens。当前声明跟随 CLI 默认共享预算；可选上限不代表桥接已启用，输入输出不能相加。目录存在不代表账号调用已验证。');
console.log(`HTTP 请求体另限 ${config.maxBodyBytes} bytes；字节不是 tokens，大 JSON 可能先触及请求体上限。`);
