# Changelog

## Unreleased

- 修复 Kimi 2.1.1 检查命令中的 `--prompt` / `--yolo` 参数冲突，显示客户端明确的参数错误；新增 `--kimi-tools-only` 继续最后一项真实验收。

- 回退 Herdr 自动状态集成，优先修复客户端调用。
- 修复 pi / Anthropic 入口把普通文字回复也强制解析为工具 JSON 的错误；保留工具名称、参数及强制工具选择检查。
- 新增普通 Kimi 配置迁移，修正旧 8799 OpenAI 地址、thinking、辅助模型和预算，并通过启动 hook 自动启动本项目桥接。
- 新增 `npm run local:repair`，备份并迁移配置、重启桥接、核对 pi / Kimi 的真实文字和文件读取结果；联机成功必须以该命令的实际结果为准。

## 0.1.1

- 新增 Kimi Code 独立 profile 启动器及真实文字 / 文件读取检查命令。
- 统一 Kimi 的桥接地址和模型预算，以 Anthropic 入口连接实验性客户端工具；不声明原生 thinking。
- 启动前核对服务并验证真实短回复；新 profile 的辅助模型也设为选定 WorkBuddy 模型。
- 补充旧会话超出 64K、旧 8799 地址和 secondary model 的排查说明。

## 0.1.0

- 通过正常登录的官方 CodeBuddy CLI 调用 WorkBuddy 模型。
- pi 进程内 provider、可选全局扩展安装和旧配置迁移。
- Claude Code 模型发现、19 个 WorkBuddy 别名和原服务商透传。
- 本地 Anthropic 与 OpenAI 文字接口、实验性客户端工具转换。
- 认证服务管理、隔离测试、配置示例和 Node 22 / 24 CI。

实验版本：真实账号兼容性需自行验收；WorkBuddy 流式输出采用缓冲发送，工具调用通过提示转换。
