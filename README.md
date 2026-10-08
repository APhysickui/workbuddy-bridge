# WorkBuddy Bridge

通过已登录的官方 CodeBuddy CLI，在 **pi、Claude Code、Kimi Code 和本地 API 客户端**中使用 WorkBuddy 模型。模型名称带 **（workbuddy）** 后缀，pi / Claude 默认 **DeepSeek V4.1 Flash**，Kimi 启动器默认 **Kimi K3**。目录包含 19 个入口，涵盖 DeepSeek、GLM、Kimi、MiniMax、混元及官方自动档位。

A local, experimental bridge from the official CodeBuddy CLI to pi, Claude Code, Kimi Code, and OpenAI/Anthropic-compatible text clients. Uses the CLI’s normal login; no desktop token extraction.

**实验版本。** 已有协议、进程和隔离客户端测试；真实账号端到端调用需要在自己的环境验收。WorkBuddy 工具调用通过提示转换，流式输出在 CLI 回复完成后发送。[兼容范围](docs/compatibility.md) · [模型及输入输出限制](docs/models.md) · [配置说明](docs/configuration.md)

## 准备

需要 Node.js **22.9+**、已安装并能正常回复的官方 CodeBuddy CLI，以及要使用的 pi 或 Claude Code。项目无 npm 依赖；Claude 原服务商透传另需系统 `curl`。

无需一直开启 WorkBuddy 桌面应用，调用依赖官方 CodeBuddy CLI 的正常登录。pi 的 WorkBuddy 扩展直接启动 CLI；Kimi / Claude Code 的接入需要本地桥接服务在后台运行，启动 hook 会自动检查并拉起服务。

```sh
cd workbuddy-bridge
npm run init
```

初始化生成随机本地密钥和 mock 配置，已有 `.env` 会保留。安装并登录官方 CodeBuddy 后，编辑 `.env`：

```dotenv
BRIDGE_BACKEND=workbuddy
CODEBUDDY_BIN=/absolute/path/to/codebuddy
```

用 `command -v codebuddy` 确认入口。`CODEBUDDY_BIN` 必须指向官方 CLI 的 JavaScript 文件，桥接使用 Node 启动它。其余参数见 `.env.example`。可先运行 `npm run doctor` 检查路径和配置；这不会调用模型。

## 使用 pi

在项目目录运行：

```sh
npm run pi
```

通过 `/model` 选择带 **（workbuddy）** 后缀、provider 为 **`workbuddy-cli`** 的模型。扩展在 pi 进程内调用官方 CLI，无需 HTTP 服务或额外 API key。首次使用按 pi 的正常流程信任项目扩展。

要从任意目录直接运行 `pi`，先查看全局接入方案，再安装：

```sh
npm run pi:unify
npm run pi:unify -- --apply
pi
```

脚本备份并更新 `~/.pi/agent`，移除旧本地 WorkBuddy provider，注册本项目扩展；其他服务商和默认模型保留。若默认曾指向旧 WorkBuddy，则迁移到 V4.1 Flash。项目目录移动后需重新注册。模型更新后 `/reload` 或退出重开。

## 使用 Claude Code

先确认 `~/.claude/settings.json` 中有可用的原服务商 URL 和认证，然后在 `.env` 启用：

```dotenv
BRIDGE_CLAUDE_PASSTHROUGH=1
```

在项目目录执行：

```sh
npm run claude:install
npm run bridge:restart
claude
```

输入 `/model`，选择带 **（workbuddy）** 后缀的模型。也可显式启动：

```sh
claude --model claude-workbuddy-deepseek-v4.1-flash
```

例如 `/model claude-workbuddy-glm-5.3-flash`。Claude 的模型发现会过滤普通非 Claude ID，因此菜单使用 `claude-workbuddy-` 别名，桥接再映射到真实官方 ID。pi 与 OpenAI 客户端使用原 ID。

安装在本项目 `.claude/settings.local.json` 中启用 gateway model discovery 和启动 hook，保留原 Claude 模型菜单及默认档位。WorkBuddy 选择走官方 CLI，其余模型透传到原服务商。原认证只在运行时读取，不复制到项目。首次启动或更新先执行 `bridge:restart`，让服务在模型发现前就绪。

**项目设置仅在本目录及其子目录生效。** 首次使用按 Claude 的正常流程完成项目信任。取消接入使用 `npm run claude:uninstall`。`npm run claude` 是单独的隔离调试启动器；普通使用按上面的流程直接运行 `claude`。

## 使用 Kimi Code

安装官方 Kimi Code 后，在项目目录运行：

```sh
npm run kimi
```

在任意工作目录启动，或切换模型：

```sh
npm --prefix /absolute/path/to/workbuddy-bridge run kimi -- --cwd "$PWD" --model kimi-k3-1
```

启动器自动检查并启动桥接，再用目标模型验证一次真实短回复；失败会停在具体错误，不打开一个无法调用的会话。预检会消耗积分。默认打开新会话，使用 `.runtime/kimi-profile`，不会自动恢复原 Kimi 账号下的旧会话。要继续这个 profile 中的会话，可传 `--continue`。

Kimi 使用 Anthropic 文字与客户端工具入口，上下文和输出限制取自模型目录，Kimi K3 默认上下文为 300,000 tokens、最大输出为 32,000。支持显示 CLI 公开输出的 thinking 内容，不支持图片；辅助模型也使用启动时选定的 WorkBuddy 入口。通过 `/model` 选择同一 profile 中的其他模型。

以上隔离启动器不修改 `~/.kimi-code` 的配置与会话。直接运行普通 `kimi` 时，要安装到它实际读取的配置：

```sh
npm run kimi:install               # 查看迁移方案，无模型请求
npm run kimi:install -- --apply    # 备份并更新普通 Kimi 配置
kimi
```

安装仅替换已知本地 WorkBuddy 提供商及其模型，保留其他提供商和用户 hook；原默认指向 WorkBuddy 时同时修正 thinking 和辅助模型。WorkBuddy 改用本项目端口上的 Anthropic 接口，模型预算取自目录。启动 hook 会在新会话开始时自动检查并启动桥接。本地桥接密钥写入用户的私有 Kimi 配置，不写进仓库。退出旧客户端后重开，避免继续使用旧会话的 64K 配置。

如果 pi 提示工具 JSON 格式错误，或 Kimi 仍连旧端口，可在普通终端执行 `npm run local:repair`。它备份并迁移普通 Kimi 配置、重启桥接，然后核对 pi / Kimi 的真实文字回复和读取临时随机文件的结果，会消耗积分；只有全部通过才打印 `LOCAL_REPAIR_OK`。`npm run local:repair -- --plan` 只查看方案。

如果前三项已通过，只剩 Kimi 文件读取失败，可执行 `npm run local:repair -- --kimi-tools-only` 继续剩余检查。Kimi 2.1.1 不允许 `--prompt` 与 `--yolo` / `--auto` / `--plan` 组合，项目检查命令使用 prompt 模式自身的非交互权限。

详情及旧 8799 / 64K 配置的排查见 [Kimi 说明](docs/kimi.md)。隔离启动器的真实文字和文件读取验收：`npm run kimi:check`。配置解析与 fixture 测试不代表真实账号调用成功，联机结果以自己运行检查命令为准。

## 推理显示与复查

桥接保留官方 CLI 的公开 `thinking` 块，并把增量内容实时转发给 pi / Kimi / Claude 的 Anthropic 客户端。最终回答和工具调用在 JSON 与工具参数校验通过后发送；如果 CLI 只给出了最终 thinking 快照，就在完成后显示。某个模型或请求没有公开 thinking 时，只显示答案。不会从答案中推测或补写推理内容，也不读取调试元数据。

pi 更新后 `/reload` 或重开，`Ctrl+T` 展开或收起 thinking。这些内容保存在 pi 会话中，`/export review.html` 可导出复查；实际工具记录和文件 diff 仍由客户端保存。CLI 默认 effort 为 `low`，pi 选择的 reasoning 等级及 Anthropic `output_config.effort` 会传给 CLI；其他情况使用 `.env` 的 `BRIDGE_REASONING_EFFORT`。原生 token budget、强制关闭 thinking 等参数仍不保证得到相同行为。

Kimi / Claude 更新后运行 `npm run bridge:restart` 加载新协议。普通 Kimi 再运行 `npm run kimi:install -- --apply`，备份并更新为可显示 thinking 的配置，然后退出旧会话重开。隔离 Kimi 启动器会自动生成新 profile。OpenAI Chat Completions 返回 `reasoning_content`，目前仍在完成后发送。

## 其他 API 客户端

```sh
npm start
```

配置 OpenAI Base URL 为 `http://127.0.0.1:18765/v1`，Anthropic Base URL 为 `http://127.0.0.1:18765`；API key 使用 `.env` 中的 `BRIDGE_API_KEY`。支持 `/v1/chat/completions`、`/v1/responses` 和 `/v1/messages` 的文字子集，详情见[兼容表](docs/compatibility.md)。HTTP 服务只监听本机回环地址。

## 验证与维护

```sh
npm run check          # 语法与模型目录检查，无上游调用
npm test               # 协议、进程、配置迁移及可选客户端兼容测试
npm run models         # 模型、默认上下文与最大输出
npm run doctor         # 路径及配置诊断，无模型调用
npm run bridge:restart # 更新并启动 HTTP 后台服务
npm run bridge:stop    # 认证关闭 HTTP 后台服务
```

真实账号验收：

```sh
npm run integration:check
```

此命令验证 WorkBuddy 工具往返、Claude 和 pi 的文字及读取临时随机文件结果，会调用真实模型并可能消耗积分。官方 CLI 可回复不等于桥接端到端已通过。缺少本地客户端时，相应隔离客户端测试会跳过；CI 不需要账号。

WorkBuddy 使用积分，pi 的美元费率 0 只是未知占位，不代表免费。积分共享、模型权限和实际价格以[官方说明](https://www.codebuddy.cn/docs/workbuddy/Pricing)及账号记录为准。模型列表是 2026-10-06 的官方目录快照，不保证每个账号都能调用。图片、音频和完整原生工具协议尚未支持；公开思考内容以 CLI 实际输出为准，失败不会自动切换服务商。

`.env`、本地 Claude 设置、运行日志和私有调试记录均不应提交。参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。采用 [MIT](LICENSE) 许可证。
