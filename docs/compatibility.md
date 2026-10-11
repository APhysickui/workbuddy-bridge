# 兼容范围

| 入口 | 支持 | 当前限制 |
| --- | --- | --- |
| pi `workbuddy-cli` | 文字、公开 thinking、模型列表、实验性客户端工具 | 依赖 pi 扩展 API；不需要本地服务 |
| Claude Code | 模型发现、文字、实验性客户端工具、原服务商透传 | 需支持 gateway model discovery 的版本；设置默认仅作用于本项目 |
| Kimi Code | 独立 profile、普通 Kimi 配置迁移、19 个模型、启动服务、实验性客户端工具入口 | 已验证 2.1.1 配置解析；真实会话与工具往返需验收 |
| `POST /v1/messages` | 文字、公开 thinking 与实验性客户端工具，JSON / SSE | thinking 增量即时发送；最终文字和工具通过校验后发送 |
| `POST /v1/messages/count_tokens` | WorkBuddy token 估算；原服务商透传 | 估算不等于官方账单用量 |
| `POST /v1/chat/completions` | OpenAI 文字子集，JSON / SSE | 不支持工具、图片及完整 OpenAI 参数集 |
| `POST /v1/responses` | OpenAI 文字子集，JSON / SSE | 不支持工具或完整 Responses 能力 |
| `GET /v1/models` | 配置启用的模型目录 | 带 Anthropic version 头时返回 Claude 桥接别名 |

WorkBuddy 路线使用官方 CLI 的正常登录。每次请求启动隔离的 CLI 子进程。默认 `BRIDGE_TOOL_TRANSPORT=native` 将客户端工具作为私有 stdio MCP 函数提供给上游，保留参数结构，接收 CLI 输出的完整原生函数快照，再交给客户端执行工具及权限检查。复杂工具、多轮长任务和全部 Claude 功能尚未完成真实账号验收。对话历史仍作为 JSON 提示提交，这不是完整的原生会话透传。

原生模式中，普通回复直接显示为文字，文字中的工具 JSON 不会被解释为调用。只有 CLI 原生函数快照且通过名称、参数及工具选择校验的请求才交给客户端。`tool_choice=none` 不加载 MCP 工具；指定工具时仅暴露对应函数。没有收到强制要求的调用会报错。

上游 CLI 的内置工具、其他 MCP、插件和用户 hooks 均禁用，仅允许本次请求生成的 MCP 代理；权限模式为 `dontAsk`，不会额外注入 plan 模式。代理只读取私有工具清单，收到函数请求时返回交接通知，不访问工具参数里的路径或执行命令。CLI 使用一轮生成作为工具交接边界；只有完整、合法的原生调用和明确的 `Max turns (1) exceeded` 终态才把轮数错误视为交接成功。额度错误、中断、缺失终态、无工具的 thinking-only 和其他执行失败仍报错。CLI 未加载工具时也会明确失败。

客户端 `auto` 工具选择下，明确以“我先读文件”这类行动预告结束且没有工具调用时，桥接最多追加一次纠正；不会根据文字推测工具参数。纠正共享原请求超时和取消信号，保留公开 thinking、累计两次用量，可能产生额外积分消耗。旧 `BRIDGE_TOOL_TRANSPORT=prompt` 仍保留提示词工具 JSON 转换与最多三轮生成，仅供兼容调试，已知可能反复只输出 thinking。两种模式都不保证识别所有未完成任务。

桥接保留官方 CLI 的公开 thinking 内容和实际签名，接受客户端回传的 assistant thinking 历史；不制造签名，也不读取调试元数据、`reasoning_detail` 或 opaque redacted payload。带 `--include-partial-messages` 的根会话 thinking 增量会立即显示；仅有完整快照时在完成后显示，二者不会重复拼接。没有公开 thinking 的请求只返回答案。pi 会话和 HTML 导出可保留这些内容用于复查。

不接收图片、音频或服务端工具。`max_tokens`、采样、thinking token budget、cache_control 等部分参数不能控制官方 CLI 的原生行为；最大输出仅为声明或提示。支持的 `output_config.effort` 及 pi reasoning 等级传给 CLI 的 `--effort`，其他情况默认 `BRIDGE_REASONING_EFFORT=low`。声明客户端 thinking 能力表示可以显示公开内容，不保证每个目录模型都输出思考，也不保证能强制关闭。同一时刻仅允许一个 WorkBuddy 请求，失败直接报错，不自动切换其他服务商或备用模型。原 Claude 请求不占用此槽位，正文、相关标头和 SSE 直接透传。

模型上下文取官方目录的默认预算，输出占用同一上下文空间。pi 美元费率 0 表示未知占位，不代表免费。CLI 没有给出可靠用量时，桥接会标记未知，不能用这些统计计算账单。

开发时对 macOS、Node 26、pi `@earendil-works/pi-coding-agent` 1.0.4 和 Claude Code 2.1.291 做过隔离兼容检查。Claude 菜单测试使用隔离发现缓存，回复及工具测试使用 fixture CLI，不证明真实上游可用。CI 的 Node 22 / 24 协议测试不需要账号；其他平台与客户端版本请按实际结果反馈。

真实验收：确认官方 CodeBuddy 可用、配置 workbuddy 后，运行 `npm run integration:check`。它核对文字回复和读取临时随机文件的结果，涉及真实请求与积分消耗。积分共享、模型权限和扣费以官方账号页面为准。
