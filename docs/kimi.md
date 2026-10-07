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

## 验证范围

```sh
npm run kimi:check
```

该命令先预检，再验证真实 Kimi 文字回复和读取临时随机文件的工具结果，会消耗积分。只看退出码为 0 不算通过。

开发测试验证目录、认证、预检失败处理以及已安装 Kimi 对 profile 的解析。未通过真实账号检查前，不应宣称 Kimi 联机或工具兼容性已验收。限制本地端口或文件监视器的 Codex 沙箱无法执行完整原生会话，请在普通终端运行上述命令。
