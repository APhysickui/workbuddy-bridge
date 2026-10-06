# WorkBuddy 可选模型

来源：官方 WorkBuddy 模型目录缓存，快照时间 `2026-10-06T04:31:25.007000Z`。仅加入 `cli` agent 的 19 个可选入口，模型 ID 原样传给官方 CodeBuddy。默认是 DeepSeek V4.1 Flash；账号权限及模型变动以官方结果为准。

pi 中所有名称带 **（workbuddy）** 后缀，提供商为 `workbuddy-cli`。按 [README](../README.md) 加载项目扩展或安装全局入口后，用 `/model` 选择；目录更新后 `/reload` 或退出重开。

输入与输出单位都是 tokens。官方目录中的 `maxInputTokens` 被 CLI 用作共享上下文预算；pi 使用其 `contextWindow.defaultLength`，未提供该字段时使用 `maxInputTokens`。因此部分模型虽然最高支持 1,000,000，上下文默认仍是 300,000；输出占用同一预算，输入实际可用空间需预留回答与系统提示。

| 模型 | 实际请求 ID | 默认上下文（pi / CLI） | 目录上下文上限 | 最大输出 |
| --- | --- | ---: | ---: | ---: |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash` | 300,000 | 1,000,000 | 128,000 |
| 快速 | `fast-model` | 300,000 | 300,000 | 48,000 |
| 均衡 | `balanced-model` | 300,000 | 300,000 | 48,000 |
| 极致 | `deep-model` | 300,000 | 300,000 | 48,000 |
| Hy4 preview | `hy4-preview` | 300,000 | 960,000 | 64,000 |
| Hy3 | `hy3` | 192,000 | 192,000 | 64,000 |
| Hy3 X | `hy3-x` | 192,000 | 192,000 | 64,000 |
| Space-Bunny | `space-bunny` | 1,000,000 | 1,000,000 | 128,000 |
| GLM-5.3 | `glm-5.3` | 300,000 | 1,000,000 | 64,000 |
| GLM-5.3-Flash | `glm-5.3-flash` | 300,000 | 1,000,000 | 131,072 |
| GLM-5.2 | `glm-5.2` | 300,000 | 1,000,000 | 64,000 |
| GLM-5.1 | `glm-5.1` | 200,000 | 200,000 | 48,000 |
| GLM-5v-Turbo | `glm-5v-turbo` | 200,000 | 200,000 | 64,000 |
| MiniMax-M3 | `minimax-m3` | 300,000 | 512,000 | 64,000 |
| Kimi-K3 | `kimi-k3-1` | 300,000 | 1,000,000 | 32,000 |
| Kimi-K2.8-Preview | `kimi-k2.8-preview` | 300,000 | 1,000,000 | 64,000 |
| Kimi-K2.7-Code | `kimi-k2.7` | 256,000 | 256,000 | 32,000 |
| Kimi-K2.6 | `kimi-k2.6` | 256,000 | 256,000 | 32,000 |
| DeepSeek V4 Pro | `deepseek-v4-pro` | 300,000 | 1,000,000 | 128,000 |

查看本机实际启用列表：

```sh
npm run models
```

Claude Code 安装项目接入后，同样可在 `/model` 菜单选择这 19 个带（workbuddy）后缀的入口。安装器开启 gateway model discovery；Claude 的发现逻辑只接受包含 `claude` 或 `anthropic` 的 ID，所以菜单使用 `claude-workbuddy-` 前缀作为桥接别名。例如 `/model claude-workbuddy-glm-5.3-flash`；实际调用仍为表中的 `glm-5.3-flash`。pi 和 OpenAI 客户端继续使用表中原 ID。原 Claude 服务商的模型菜单和默认值保留。

退出旧 Claude 会话，在项目目录先运行 `npm run bridge:restart`，再运行 `claude`。服务先启动，Claude 才能在首次发现时读到完整列表。项目设置仅在本目录及其子目录生效，其他目录中的普通 Claude 不会自动加载它。

这些限制来自官方目录，不代表逐模型的账号调用验收。请先确认官方 CodeBuddy 可调用目标模型，再执行桥接真实验收。账号是否有权使用、实际扣费以官方结果为准；桥接拒绝静默切换其他模型。

接入仍只接收文字与提示转换的客户端工具；上游目录的图片、原生思考能力没有在本项目中开放。pi 的美元费率为未知占位 0，不能换算 WorkBuddy 积分。最大输出是客户端声明，桥接的 `max_tokens` 通过提示传达给模型，无法强制 CLI 的原生 token 预算。
