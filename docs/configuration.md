# 配置

先运行 `npm run init`。它以 0600 权限创建 `.env`，生成随机本地密钥；已有文件会保留。默认后端为 mock，便于在没有账号时检查接口。`.env.example` 是参数说明，不能直接用其中的占位密钥启动服务。

| 变量 | 用途 |
| --- | --- |
| `BRIDGE_BACKEND` | `mock` 本地演示；`workbuddy` 调用官方 CLI |
| `CODEBUDDY_BIN` | 官方 CodeBuddy 的 JavaScript 入口绝对路径；使用 Node 启动，不接受 shell 包装脚本 |
| `BRIDGE_API_KEY` | 本地 HTTP 认证，至少 24 个无空白字符；由 init 随机生成 |
| `BRIDGE_PORT` | HTTP 端口，示例为 18765；监听固定为 127.0.0.1 |
| `BRIDGE_TIMEOUT_MS` | 单个桥接请求的 WorkBuddy 调用总超时（含最多一次协议纠正），init 为 120000，范围 1000–300000 |
| `BRIDGE_REASONING_EFFORT` | CLI 默认推理 effort，默认 `low`；可选 `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，具体效果和积分以模型为准 |
| `BRIDGE_MAX_BODY_BYTES` | 请求大小上限，init 为 2097152，最高 4 MiB |
| `BRIDGE_MODELS` | 逗号分隔的 `公开ID=官方ID`；默认加载完整目录 |
| `BRIDGE_CLAUDE_MODEL` | 便捷启动器及 Claude 自定义项的模型 ID，默认 V4.1 Flash |
| `BRIDGE_CLAUDE_MODEL_NAME` | Claude 自定义项名称，例如 `DeepSeek V4.1 Flash（workbuddy）` |
| `BRIDGE_CLAUDE_PASSTHROUGH` | 设为 `1`，启用原 Claude 服务商透传；普通 Claude 接入需要此项 |

macOS 未指定 CLI 路径时，会尝试 `/Applications/WorkBuddy.app` 中的内置 CLI。推荐安装并登录官方 CodeBuddy 后，用 `command -v codebuddy` 确认 JavaScript 入口，并配置明确路径。如果返回的是 shell 包装器，需定位其实际调用的 JS 文件。

Claude 透传在运行时读取 `~/.claude/settings.json` 的原服务商 URL 与认证配置。需有可用的原服务商配置及系统 curl；仅有交互式 Claude 登录不等于提供了透传所需凭据。原服务商地址不能指回本桥接。请解决原环境里同时设置 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_API_KEY` 的冲突后再安装。

`npm run claude:install` 将桥接地址、单一认证变量、模型发现和 SessionStart hook 写入本项目 `.claude/settings.local.json`。不生成全局模型白名单。安装备份保存在 `.runtime/before-direct-settings.json`；`npm run claude:uninstall` 移除本项目桥接设置。

pi 扩展读取本项目 `.env`，通过 `workbuddy-cli` provider 在进程内调用 CLI，无需 HTTP 端口。`npm run pi:unify` 只查看全局迁移方案；`npm run pi:unify -- --apply` 才写入 `~/.pi/agent`，备份位于该目录的 `workbuddy-bridge-backups/`。安装后保留项目目录位置；移动项目后需重新注册扩展。

修改 `.env` 后，HTTP 客户端应运行 `npm run bridge:restart`；pi 应 `/reload` 或退出重开。服务核对密钥、协议、CLI 路径、推理 effort 及模型配置，配置不匹配时拒绝复用旧服务。认证关闭使用 `npm run bridge:stop`。
