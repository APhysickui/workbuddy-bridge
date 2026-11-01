import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { catalogContextWindow, catalogContextLengths, catalogMaximumContextWindow } from './model-catalog.mjs';

export function unwrapProductConfig(value, depth = 0) {
  if (depth > 6 || !value) return null;
  if (typeof value === 'string') { try { return unwrapProductConfig(JSON.parse(value), depth + 1); } catch { return null; } }
  if (Array.isArray(value.models) && Array.isArray(value.agents)) return value;
  for (const key of ['product-config-snapshot', 'data', 'value', 'config', 'productConfig']) {
    const found = unwrapProductConfig(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}
export async function findWorkBuddyCatalog(directory = join(homedir(), '.workbuddy')) {
  const files = [];
  async function list(path) { try { return await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  for (const entry of await list(join(directory, 'cache'))) {
    if (entry.isFile() && /^acc-product-config.*\.json$/.test(entry.name)) files.push(join(directory, 'cache', entry.name));
  }
  for (const user of await list(join(directory, 'storage'))) {
    if (!user.isDirectory() || !user.name.startsWith('user-')) continue;
    const scoped = join(directory, 'storage', user.name, 'scoped');
    for (const scope of await list(scoped)) if (scope.isDirectory()) files.push(join(scoped, scope.name, 'wb-product-config.json'));
  }
  const candidates = [];
  for (const path of files) {
    try {
      const info = await stat(path);
      const product = unwrapProductConfig(JSON.parse(await readFile(path, 'utf8')));
      if (product && product.agents.some(agent => agent.name === 'cli' && Array.isArray(agent.models) && agent.models.length)) {
        candidates.push({ path, product, savedAt: info.mtime.toISOString(), mtime: info.mtimeMs });
      }
    } catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error('没有找到有效的 WorkBuddy 模型目录缓存；请先打开并登录 App 刷新模型列表，或使用 --source 指定官方配置文件。');
  return candidates[0];
}
export function importCatalog(product, previous, savedAt) {
  const agent = product.agents.find(agent => agent.name === 'cli');
  if (!agent || !Array.isArray(agent.models) || !agent.models.length) throw new Error('官方配置未提供非空 cli.models，未更新目录。');
  const byId = new Map(product.models.map(model => [model.id, model]));
  const before = new Map(previous.models.map(model => [model.id, model]));
  const seen = new Set();
  const models = agent.models.map(id => {
    const source = byId.get(id);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(id) || seen.has(id) || !source) throw new Error('CLI 模型 ID 无效、重复或没有对应元数据。');
    seen.add(id);
    if (![source.maxInputTokens, source.maxOutputTokens].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error(`模型 ${id} 的输入/输出限制无效。`);
    if (typeof source.name !== 'string' || !source.name.trim()) throw new Error(`模型 ${id} 缺少名称。`);
    const model = { id, name: source.name, maxInputTokens: source.maxInputTokens, maxOutputTokens: source.maxOutputTokens };
    if (source.contextWindow) {
      const lengths = catalogContextLengths(source), selected = source.contextWindow.defaultLength;
      if (!Number.isSafeInteger(selected) || !lengths.includes(selected) || lengths.length < 2) throw new Error(`模型 ${id} 的可选上下文元数据无效，未发布可能夸大的限制。`);
      model.contextWindow = { defaultLength: selected, supportedLengths: lengths };
    }
    if (source.maxOutputTokens > catalogContextWindow(model)) throw new Error(`模型 ${id} 的最大输出超过默认共享上下文，需人工核对。`);
    const displayName = before.get(id)?.displayName;
    if (displayName) model.displayName = displayName;
    return model;
  });
  const officialDefaultModel = models.find(model => byId.get(model.id).isDefault)?.id ?? models[0].id;
  const defaultModel = seen.has(previous.defaultModel) ? previous.defaultModel : officialDefaultModel;
  const catalog = { source: 'Official WorkBuddy product-config cache; explicit CLI agent selectable models only', snapshotSavedAt: savedAt,
    defaultModel, officialDefaultModel, models };
  const changes = { added: models.filter(model => !before.has(model.id)).map(model => model.id),
    removed: previous.models.filter(model => !seen.has(model.id)).map(model => model.id),
    updated: models.filter(model => before.has(model.id) && JSON.stringify(model) !== JSON.stringify(before.get(model.id))).map(model => model.id) };
  return { catalog, changes };
}
export function planCatalogEnv(raw, previous, next) {
  const env = parseEnv(raw);
  const value = env.BRIDGE_MODELS;
  if (value === undefined || value === 'catalog') return { text: raw, mode: 'catalog' };
  if (/[\r\n]/.test(value)) return { text: raw, mode: 'explicit_list_preserved' };
  const entries = value.split(',').map(entry => entry.trim());
  const old = new Set(previous.models.map(model => `${model.id}=${model.id}`));
  const managed = entries.length === old.size && new Set(entries).size === old.size && entries.every(entry => old.has(entry));
  const nextIds = new Set(next.models.map(model => model.id));
  const defaults = [env.BRIDGE_CLAUDE_MODEL, env.BRIDGE_CODEX_MODEL].filter(Boolean);
  if (!managed || defaults.some(id => !nextIds.has(id))) return { text: raw, mode: 'explicit_list_preserved' };
  return { text: raw.replace(/^([ \t]*(?:export[ \t]+)?BRIDGE_MODELS[ \t]*=[ \t]*)[^\r\n]*/m, '$1catalog'), mode: 'migrated_to_catalog' };
}
export function renderModelDocs(catalog) {
  const numbers = value => new Intl.NumberFormat('en-US').format(value);
  const rows = catalog.models.map(model => `| ${model.displayName ?? model.name} | \`${model.id}\` | ${numbers(catalogContextWindow(model))} | ${numbers(catalogMaximumContextWindow(model))} | ${numbers(model.maxInputTokens)} | ${numbers(model.maxOutputTokens)} |`).join('\n');
  return `# WorkBuddy 可选模型

来源：本机官方 WorkBuddy 缓存，保存时间 \`${catalog.snapshotSavedAt}\`。只导入 cli agent 显式列出的 **${catalog.models.length}** 个入口，排除隐藏实验、图片/视频、补全及仅有 craft 标签但未列入 CLI 菜单的模型。目录默认模型为 \`${catalog.officialDefaultModel}\`；本项目保留已有默认 \`${catalog.defaultModel}\`，不静默替换用户选择。

所有客户端名称带（workbuddy）后缀。目录存在不代表账号权限或真实调用已经逐一验证。

## 上下文限制的含义

单位为 tokens。**默认共享上下文、CLI 可选最大预算、目录 maxInputTokens、maxOutputTokens 是不同字段，不能相加。** CLI 对至少两个合法 supportedLengths 选项使用其中的 defaultLength；无有效默认值时使用最小合法档位，未提供多个档位时使用 maxInputTokens。桥接与该算法一致。系统提示、工具定义、对话与输出会占用上下文，客户端可用输入应留出输出空间。

当前 print 模式调用没有经过验证的上下文档位参数，所以桥接向 pi、Kimi、Codex、Claude 发现接口声明的**实际预算始终为 CLI 默认值**，不把 1M 目录上限当作默认。上游允许在其他会话模式选择更长档位，不代表桥接已经启用了它。未做百万 token 实际满载测试，也不能用本地字符数精确推算模型 tokenizer 的 token 数。

HTTP 字节限制与 token 上限独立：init 的请求体上限是 2 MiB，可通过 BRIDGE_MAX_BODY_BYTES 配置到 4 MiB；很长的 JSON 可能先遇到 413。CLI 输出仍有 2 MiB 保护上限。目录中的 1M / 最大输出是模型元数据，不保证所有编码、封装和客户端都能塞满该容量。

| 模型 | 实际请求 ID | 桥接/CLI 默认预算 | CLI 可选最大预算 | 目录 maxInputTokens | 最大输出 |
| --- | --- | ---: | ---: | ---: | ---: |
${rows}

## 更新与启用

\`npm run models\` 查看当前启用的模型和限制。运行 \`npm run models:refresh\` 先查看最新本地缓存与变更；\`npm run models:refresh -- --apply\` 更新经过字段白名单筛选的项目目录、本文及示例配置。需要重新获取远程目录时先打开已登录 WorkBuddy，让官方 App 刷新缓存。不会请求隐藏接口或导入完整私有配置。

\`BRIDGE_MODELS=catalog\` 自动使用随项目更新的目录。原有完整默认列表会迁移到此模式，自定义列表/别名保持不变；更新前在 .runtime 中备份。目录不再列出的模型从默认列表移除，自定义显式固定的 ID 不会被改成别的模型。

更新后 pi 输入 \`/reload\`；HTTP 客户端运行 \`npm run bridge:restart\`，重开 Claude/Kimi/Codex 启动器生成最新目录。后台身份检查包括目录指纹，模型限制变化也会要求重启，不再错误复用旧预算。

Claude 菜单使用 \`claude-workbuddy-\` 前缀别名，例如 \`claude-workbuddy-glm-5.3\`；实际模型 ID 保持本表原值。原服务商模型和用户默认值保留。Kimi 普通全局配置若曾复制旧目录，可在普通终端用 \`npm run kimi:install -- --apply\` 更新；本项目启动器每次重新生成隔离 profile。

模型发现接口的 context_window / max_input_tokens 使用当前预算，catalog_max_input_tokens / catalog_max_context_window / catalog_supported_context_windows 单独列出目录上限与可选档位，避免客户端把未启用的 1M 当成实际预算。

工具与公开 thinking 保留现有协议支持；图片/音频仍不接收。最大输出为目录声明，CLI 原生最大输出和采样不能由桥接完整控制。pi 美元费率 0 是未知占位，不表示免费；积分以官方账单为准。
`;
}
