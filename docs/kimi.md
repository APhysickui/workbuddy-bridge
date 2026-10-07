# Kimi Code 接入与排查

本项目的 Kimi 启动器使用独立 profile，通过 `/v1/messages` 接入文字和实验性客户端工具。适配 Kimi Code 2.1.1 的配置格式。普通 `kimi` 读取的 `~/.kimi-code/config.toml` 不会自动采用项目设置。

在已配置官方 CodeBuddy 的普通终端，先退出旧 Kimi，再从工作目录启动：

```sh
npm --prefix /absolute/path/to/workbuddy-bridge run kimi -- --cwd "$PWD" --model kimi-k3-1
```

启动器依次核对桥接身份、自动启动服务、验证目标模型的短回复，然后才打开 Kimi。读取本项目 `.env` 中的端口，默认 18765；本地密钥通过进程环境传入，profile 中不保存密钥。localhost / 127.0.0.1 始终排除在代理之外。

模型目录包含 19 个入口，默认 Kimi K3 的上下文为 300,000 tokens、最大输出为 32,000。图片与原生 thinking 不开放，客户端工具仍是提示转换。profile 中只配置 WorkBuddy 提供商，并将辅助模型也设为启动时选定的入口，避免继承原配置中的另一个服务商。新会话无需携带旧会话的超限历史。

## `hi` 触发压缩或连接错误

如果屏幕显示 `Resumed session` 和 `102k/62.5k`，输入 `hi` 前就已有 102K 历史。62.5K 是 64,000 tokens 的显示值；这个错误不能用本次输入只有两个字符来判断。

旧 WorkBuddy 配置常见的问题是地址仍为 `http://127.0.0.1:8799/v1`、上下文统一为 64,000、声明 `thinking` / `always_thinking`，且辅助模型可能仍引用原服务商。地址未运行会产生连接错误；旧 OpenAI 文字入口也不提供 Kimi 所需的工具协议。请使用上面的项目启动器，以正确的 Anthropic 入口、限制和新会话验收。

不删除旧会话，也不要反复发送 `hi` 来重试压缩。退出旧客户端后执行启动命令。后续继续本项目 profile 的会话可以传 `--continue`；模型在此 profile 中的别名是 `workbuddy-bridge/<模型ID>`。

## Herdr 实时 agent 状态

Herdr 0.8.2 已内置 Kimi 集成，需要给实际使用的 Kimi profile 安装钩子。仅安装两个 CLI 并不会启用实时状态。

使用本项目启动器时，在 Herdr pane 内运行 `npm run kimi` 就会自动安装官方集成。要单独配置、暂不调用模型，可执行：

```sh
npm run kimi:herdr
```

配置目标是 `.runtime/kimi-profile`。启动器重建配置或切换启动模型后会重新安装钩子，避免状态接入丢失；重复安装不会累积相同钩子。Herdr 不存在或安装失败时会提示，Kimi 的模型预检仍按原流程执行。

如果启动方式是直接输入普通 `kimi`，请在普通终端执行：

```sh
herdr integration install kimi
```

这会给普通 Kimi 使用的 profile 安装集成；默认位置为 `~/.kimi-code`，若设置了 `KIMI_CODE_HOME` 则使用该目录。两个 profile 需要各自安装。安装后退出旧 Kimi，在 Herdr pane 中重新打开。

官方钩子通过 Herdr 提供的 `HERDR_SOCKET_PATH` 和 `HERDR_PANE_ID` 报告状态：提交提示与执行工具时为 `working`，权限请求与 `AskUserQuestion` 为 `blocked`，回复结束或中断为 `idle`。会话开始时报告 session ID。不会发送提示词、工具输入或回复正文；Herdr 外部运行时不报告。

本地验证覆盖 Herdr 0.8.2 安装、Kimi 2.1.1 配置解析、重复安装和 profile 重建，以及官方钩子的状态消息。状态消息测试使用模拟 socket，不修改真实 pane；侧栏显示需重启 Kimi 后在实际 Herdr 中确认。

## 验证范围

```sh
npm run kimi:check
```

该命令先预检，再验证真实 Kimi 文字回复和读取临时随机文件的工具结果，会消耗积分。只看退出码为 0 不算通过。

开发测试验证目录、认证、预检失败处理以及已安装 Kimi 对 profile 的解析。未通过真实账号检查前，不应宣称 Kimi 联机或工具兼容性已验收。限制本地端口或文件监视器的 Codex 沙箱无法执行完整原生会话，请在普通终端运行上述命令。
