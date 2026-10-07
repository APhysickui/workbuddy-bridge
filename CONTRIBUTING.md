# 参与开发

使用 Node.js 22.9+。项目无 npm 依赖，直接运行：

```sh
npm run check
npm test
```

协议和子进程测试使用 mock / fixture，不读取真实账号，也不消耗积分。安装了相应版本的 pi 或 Claude Code 时，额外执行隔离的客户端兼容检查；缺少客户端时这些检查会跳过。GitHub CI 验证不依赖客户端安装的测试。

真实验收需自行安装并登录官方 CodeBuddy，将 `.env` 配为 workbuddy，然后执行 `npm run integration:check`。这会发出真实模型请求并可能消耗积分。请区分 fixture 测试、客户端界面验证与真实账号端到端验收。

修改协议、进程生命周期、配置迁移或工具转换时，补充覆盖用户可见行为的测试。模型目录更新应同时更新 `src/workbuddy-models.json` 和 `docs/models.md`，保留来源、快照日期和默认上下文的含义。

提交前确认没有包含 `.env`、`.claude/settings.local.json`、`.runtime`、账号配置、原始日志或机器专属路径。请勿将真实认证信息写进测试或 Issue。
