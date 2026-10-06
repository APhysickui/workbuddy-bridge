import { readConfig } from '../src/config.mjs';
import { piProvider } from '../src/pi-config.mjs';
import { catalogModel, workbuddyCatalog } from '../src/model-catalog.mjs';

const config = readConfig();
console.log(`官方模型目录快照：${workbuddyCatalog.snapshotSavedAt}；提供商：workbuddy-cli`);
console.table(piProvider(config).models.map(model => ({
  ID: model.id,
  名称: model.name,
  当前上下文: model.contextWindow,
  目录上下文上限: catalogModel(config.models.get(model.id))?.maxInputTokens ?? '未知',
  最大输出: model.maxTokens
})));
console.log('单位为 tokens。按官方 CLI 默认上下文设置；目录存在不代表当前账号调用已验证。');
