# Kimi Code 接入与排查

本项目的 Kimi 启动器使用独立 profile，通过 `/v1/messages` 接入文字和实验性客户端工具。适配 Kimi Code 2.1.1 的配置格式。普通 `kimi` 读取的 `~/.kimi-code/config.toml` 需要单独安装接入，不能仅修改项目 profile。

在已配置官方 CodeBuddy 的普通终端，先退出旧 Kimi，再从工作目录启动：

```sh
npm --prefix /absolute/path/to/workbuddy-bridge run kimi -- --cwd "$PWD" --model kimi-k3-1
```

启动器依次核对桥接身份、自动启动服务、验证目标模型的短回复，然后才打开 Kimi。读取本项目 `.env` 中的端口，默认 18765；本地密钥通过进程环境传入，profile 中不保存密钥。localhost / 127.0.0.1 始终排除在代理之外。

模型目录包含 19 个入口，默认 Kimi K3 的上下文为 300,000 tokens、最大输出为 32,000。profile 开启 thinking 显示，桥接转发 CLI 公开返回的思考增量；有些模型或请求可能只返回答案。图片不支持，客户端工具仍是提示转换。profile 中只配置 WorkBuddy 提供商，并将辅助模型也设为启动时选定的入口。新会话无需携带旧会话的超限历史。

## `hi` 触发压缩或连接错误

如果屏幕显示 `Resumed session` 和 `102k/62.5k`，输入 `hi` 前就已有 102K 历史。62.5K 是 64,000 tokens 的显示值；这个错误不能用本次输入只有两个字符来判断。

旧 WorkBuddy 配置常见的问题是地址仍为 `http://127.0.0.1:8799/v1`、上下文统一为 64,000、声明 `thinking` / `always_thinking`，且辅助模型可能仍引用原服务商。地址未运行会产生连接错误；旧 OpenAI 文字入口也不提供 Kimi 所需的工具协议。请使用上面的项目启动器，或执行下面的普通 Kimi 修复，以正确的 Anthropic 入口、限制和新会话验收。

不删除旧会话，也不要反复发送 `hi` 来重试压缩。退出旧客户端后执行启动命令。后续继续本项目 profile 的会话可以传 `--continue`；模型在此 profile 中的别名是 `workbuddy-bridge/<模型ID>`。

## 修复直接运行的普通 Kimi

退出旧 pi / Kimi 后，在项目目录的普通终端执行：

```sh
npm run local:repair
```

命令会备份并更新实际 `KIMI_CODE_HOME` 的 `config.toml`，未设置时是 `~/.kimi-code/config.toml`。识别并替换已知本地 WorkBuddy 提供商及其模型，保留其他提供商、认证和用户 hook。旧默认指向 WorkBuddy 时保留已启用的模型 ID，并将辅助模型设为同一入口、开启公开 thinking 的显示能力；使用 19 个模型各自的上下文和输出预算。已有用户在升级后运行 `npm run bridge:restart` 和 `npm run kimi:install -- --apply`，退出旧会话重开。

普通 Kimi 使用 Anthropic 类型和本项目 `.env` 中的端口，不再读取 8799 的旧 OpenAI 入口。它需要直接读取认证，因此本地桥接密钥保存在用户的私有配置中。新增 `SessionStart` hook 自动检查并启动本项目桥接，不含 Herdr 状态集成。

迁移采用配置锁、私有备份及原子替换，先交给已安装的 Kimi doctor 验证。验证失败保留原文件。配置中同名提供商若指向其他服务则拒绝覆盖。已有外部默认模型会保留；可通过 `/model` 选择 WorkBuddy。

修复命令重启已认证的本项目服务，并实际验证 pi 普通回复（工具列表仍开启）、pi 读取临时随机文件、普通 Kimi 回复及 Kimi 文件读取。会发出真实请求并消耗积分；只在全部核对通过后输出 `LOCAL_REPAIR_OK`。失败处会停下，已完成的配置迁移和备份仍保留。

若前三项已通过，只有 Kimi 文件读取失败，可执行 `npm run local:repair -- --kimi-tools-only`。它要求本地记录已有这些成功结果，保留结果并继续最后一项。Kimi 2.1.1 明确拒绝 `--prompt` 与 `--yolo`、`--auto` 或 `--plan` 组合；这类错误发生在模型请求前。项目的两种 Kimi 检查都使用同一套合法的 prompt 参数，客户端启动失败时会显示安全的参数冲突诊断。

仅检查方案：`npm run local:repair -- --plan`。仅迁移配置、不调用模型：`npm run kimi:install -- --apply`。安装后在任意目录运行 `kimi` 使用修复后的全局 profile；本项目 `npm run kimi` 仍使用独立 profile。

本地端口和全局目录受限制的 Codex 沙箱无法完成应用及真实调用，请在普通终端执行。原会话与其他服务商的密钥不会被迁移到仓库。

## 验证范围

```sh
npm run kimi:check
```

该命令先预检，再验证真实 Kimi 文字回复和读取临时随机文件的工具结果，会消耗积分。只看退出码为 0 不算通过。

开发测试验证目录、认证、预检失败处理以及已安装 Kimi 对 profile 的解析。未通过真实账号检查前，不应宣称 Kimi 联机或工具兼容性已验收。限制本地端口或文件监视器的 Codex 沙箱无法执行完整原生会话，请在普通终端运行上述命令。
