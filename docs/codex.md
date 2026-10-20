# Codex CLI / Responses 接入

此入口让 Codex CLI 使用 WorkBuddy 提供的模型，工具仍由 Codex 在自己的沙箱和审批流程中执行。桥接通过官方 CodeBuddy CLI 获取回复和原生工具请求。它不把 WorkBuddy 模型变成 OpenAI 模型，也不替代 Codex 的账号权限。

## 启动

需要 Node 22.9+、已登录且能正常回复的 CodeBuddy，以及 Codex CLI。当前兼容校验使用 Codex CLI **0.163.0**。先按项目 README 设置 `BRIDGE_BACKEND=workbuddy`。

首次加载本次协议更新，或后台仍运行旧代码时：

```sh
npm run bridge:restart
npm run codex
```

默认模型按 `BRIDGE_CODEX_MODEL`、`BRIDGE_CLAUDE_MODEL`、目录默认模型依次选择。切换模型和工作目录：

```sh
npm run codex -- --model kimi-k3-1 --cwd /path/to/project
npm run codex -- --model deepseek-v4.1-flash --cwd /path/to/project
```

也可传递 Codex 原生参数，例如执行一次非交互任务：

```sh
npm run codex -- exec --ephemeral --skip-git-repo-check --sandbox read-only --json "检查当前目录的文件结构"
```

启动器只对这次 Codex 进程设置 `model_provider=workbuddy`、Responses HTTP 地址、认证环境变量和本项目模型目录；不写入全局 `~/.codex/config.toml` 或 `auth.json`。普通 `codex` 命令仍沿用原来的配置。当前桥接会话的模型目录来自 WorkBuddy，名称带（workbuddy）后缀。启动器保留 Codex 自己的沙箱与审批，不注入绕过审批选项。

## 验收

```sh
npm run codex:check
```

该命令使用临时 Codex home，先要求准确短回复，再要求 Codex 实际读取新建的随机文件并返回内容；只有完整 turn、准确答案和成功的命令输出均吻合才打印 `codex_text_verified` / `codex_tools_verified`。它使用真实模型，可能消耗积分。退出码为 0 或只看到思考都不算验证成功。

本地测试覆盖 Responses 正文、SSE、函数与 custom 工具、namespace、两次真实客户端文件读取、原生 MCP 交接、取消和上游失败。上述读取测试使用合成上游，不证明真实模型稳定。CI 安装固定版本 Codex，以合成上游验证真正的 Codex CLI 通过受限 MCP reader 连续读取两个临时文件，保留客户端沙箱设置，避免依赖 CI runner 的 Linux 用户命名空间权限；不需要 OpenAI / WorkBuddy 账号。

当前开发沙箱禁止本地端口连接与监听（EPERM），所以本机完整 Codex socket 流程和真实模型验收仍需普通终端执行。模型目录已被本机已安装 Codex 成功加载。官方文档站在本次核对时返回 403；请求/响应兼容校验使用本机 Codex 生成的协议 schema 和 CLI 行为，不声明完整 OpenAI API 或所有 Codex 版本兼容。

## 接口范围

`POST /v1/responses` 支持以下文字与客户端工具子集：

- 完整 `input` 历史：message、公开 reasoning summary、function_call/output、custom_tool_call/output。
- `tools`：JSON Schema function、文本 custom 工具及单层 namespace；`apply_patch` 的原始补丁文本作为 custom 调用回到 Codex。
- `tool_choice`：auto、none、required、指定 function/custom；`parallel_tool_calls=false` 通过共享校验拒绝多工具响应。
- JSON 回复和 SSE；公开思考即时映射到 reasoning summary 事件，答案和工具在最终校验后发送。上游失败产生明确失败事件，不伪装为完成。

custom grammar 会随描述交给模型，但桥接不执行 Lark/regex 文法校验；原始工具输入由 Codex 再解析和执行。不要将这个接口的接受字段等同于完整参数支持。

每次请求需 `store=false` 并重发完整历史；不支持 `previous_response_id`、后台响应、图片/音频、服务端 web search / computer tools、structured output、WebSocket 或 provider 原生 encrypted reasoning / remote compaction。启用搜索或其他未支持的工具会明确拒绝。公开 reasoning 可供复查，opaque encrypted_content 不被读取或制造。

`max_output_tokens`、采样、缓存参数、verbosity、reasoning summary/budget 等部分字段仅为提示或兼容声明，响应 `x-bridge-advisory-fields` 列出它们。支持的 reasoning effort 传给官方 CLI。用量未知时返回 null，不能由此推算官方积分账单。

桥接协议为 8。更换源码后重启桥接即可；无需重新安装 pi / Kimi 接入。配置项参考官方页面：<https://developers.openai.com/codex/config-reference/>；Responses 事件参考：<https://platform.openai.com/docs/api-reference/responses-streaming>。
