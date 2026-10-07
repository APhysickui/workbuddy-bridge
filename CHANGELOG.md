# Changelog

## 0.1.2

- 在 Herdr 中启动 WorkBuddy Kimi 时自动安装官方实时状态集成，支持工作、等待确认、空闲及会话识别。
- 每次重建 Kimi profile 后恢复状态钩子，切换启动模型和重复安装不会丢失或累积钩子。
- 新增 `npm run kimi:herdr`，仅配置状态集成，不调用模型；补充普通 Kimi 的安装说明及隔离状态消息测试。

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
