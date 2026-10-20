# Changelog

## Unreleased

- 新增实验性 Buddy 加油站签到脚本：复用 App 本地认证代理，先查后领并复查结果，防止不确定结果重复提交；提供 macOS 每日任务安装/移除。真实领取仍需普通终端验证。

- 修复真实集成检查中 Claude 的 `--tools` 吞掉提示词、尚未请求模型就退出的问题；在提示词前加 `--`，并显示安全的缺失输入诊断。

- 修复 Claude / Kimi 预检误拒绝带公开 thinking 的准确回复；仍要求正确终态和完整验证文字。
- 按生成轮次合并 thinking 增量与快照，保留独立思考块、补全公开后缀及签名，跳过空块并使用连续 SSE 编号；冲突内容明确报错，避免流式记录和最终记录不一致。
- 校验并执行 `tool_choice.disable_parallel_tool_use`：两种工具模式都提示每次最多调用一个工具，违反限制时整批拒绝，不截断调用。
- `/health`、响应兼容标头及启动日志反映实际工具模式。服务协议升级至 7；更新后运行 `npm run bridge:restart`，pi 运行 `/reload`，Kimi / Claude 重开会话。

- 默认通过 CodeBuddy 原生 MCP 函数暴露客户端工具和参数结构，替代仅靠提示词生成工具 JSON 的接法。代理不执行客户端动作，完整函数快照经过校验后交回 Kimi / pi / Claude。
- 工具交接使用明确的一轮边界，仅接受完整合法调用及特定轮数终态；保留并行调用、thinking 和用量，拒绝其他上游失败。工具传输模式纳入服务身份检查。
- 新增官方 MCP SDK 隔离验证、原生工具失败与取消测试，以及已安装 pi 的连续工具验收。旧 `prompt` 模式保留供调试；此前增加重试轮数仍可能反复只输出 thinking，不能作为可靠修复。

- 旧提示词模式保留最多三轮生成；取消桥接强制 plan 模式，客户端权限仍由客户端处理。
- 对没有工具调用的明确行动预告进行一次受限纠正，保留 thinking 并累计用量，共享原超时和取消；新增连续两个工具及最终回答的 SDK 测试和 `agent:check` 真实模型检查。
- 保留 CodeBuddy CLI 公开 thinking 块和真实签名，实时转发 Anthropic thinking 增量；pi 本地传输改为流式读取，支持会话保存与 HTML 复查。
- pi / Kimi 开放公开 thinking 显示；支持 CLI effort 配置与 pi reasoning 等级，默认仍为 low。最终工具 JSON 保持校验，推理后的失败和取消仍返回错误。

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

实验版本：真实账号兼容性需自行验收；公开 thinking 增量实时发送，最终文字与原生工具调用在校验后发送。
