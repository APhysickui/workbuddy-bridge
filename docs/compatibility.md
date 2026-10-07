# 兼容范围

| 入口 | 支持 | 当前限制 |
| --- | --- | --- |
| pi `workbuddy-cli` | 文字、模型列表、实验性客户端工具 | 依赖 pi 扩展 API；不需要本地服务 |
| Claude Code | 模型发现、文字、实验性客户端工具、原服务商透传 | 需支持 gateway model discovery 的版本；设置默认仅作用于本项目 |
| Kimi Code 启动器 | 独立 profile、19 个模型、启动预检、实验性客户端工具入口 | 仅完成 2.1.1 配置解析验证；真实会话与工具往返需验收 |
| `POST /v1/messages` | 文字与实验性客户端工具，JSON / SSE | WorkBuddy 回复完成后才发送 SSE |
| `POST /v1/messages/count_tokens` | WorkBuddy token 估算；原服务商透传 | 估算不等于官方账单用量 |
| `POST /v1/chat/completions` | OpenAI 文字子集，JSON / SSE | 不支持工具、图片及完整 OpenAI 参数集 |
| `POST /v1/responses` | OpenAI 文字子集，JSON / SSE | 不支持工具或完整 Responses 能力 |
| `GET /v1/models` | 配置启用的模型目录 | 带 Anthropic version 头时返回 Claude 桥接别名 |

WorkBuddy 路线使用官方 CLI 的正常登录。每次请求启动隔离的 CLI 子进程；提示要求模型输出工具 JSON，再交由客户端执行工具及权限检查。复杂工具、多轮长任务和全部 Claude 功能尚未完成真实账号验收。它不是模型原生工具调用协议。

只支持文字；不接收图片、音频、原生 thinking 块或服务端工具。`max_tokens`、采样、thinking、cache_control 等部分参数不能控制官方 CLI 的原生行为；最大输出仅为声明或提示。同一时刻仅允许一个 WorkBuddy 请求，失败直接报错，不自动切换其他服务商或备用模型。原 Claude 请求不占用此槽位，正文、相关标头和 SSE 直接透传。

模型上下文取官方目录的默认预算，输出占用同一上下文空间。pi 美元费率 0 表示未知占位，不代表免费。CLI 没有给出可靠用量时，桥接会标记未知，不能用这些统计计算账单。

开发时对 macOS、Node 26、pi `@earendil-works/pi-coding-agent` 1.0.4 和 Claude Code 2.1.291 做过隔离兼容检查。Claude 菜单测试使用隔离发现缓存，回复及工具测试使用 fixture CLI，不证明真实上游可用。CI 的 Node 22 / 24 协议测试不需要账号；其他平台与客户端版本请按实际结果反馈。

真实验收：确认官方 CodeBuddy 可用、配置 workbuddy 后，运行 `npm run integration:check`。它核对文字回复和读取临时随机文件的结果，涉及真实请求与积分消耗。积分共享、模型权限和扣费以官方账号页面为准。
