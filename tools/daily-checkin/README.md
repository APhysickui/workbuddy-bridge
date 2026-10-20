# Buddy 加油站自动签到（实验性）

通过本机 WorkBuddy 自带的 WBIPC 请求代理查询和领取，远程登录 token 留在 App 内，不复制 Cookie、不调用模型。需要新版 WorkBuddy 提供 `wb.request` 通道，并在后台保持登录。此入口来自当前安装版本，非稳定公开 API，升级后可能变化。

在普通 macOS 终端、项目目录中执行：

```sh
npm run credits:status       # 仅查询当天状态和官方返回的积分数
npm run credits:claim        # 领取一次并复查签到状态
npm run credits:install      # 先真实验证，再安装每日定时任务
npm run credits:uninstall    # 移除定时任务
```

安装任务每天本机时间 09:05 运行，同时每小时补查一次，登录后也补查。Mac 关机、睡眠、未登录时不会运行；恢复运行后补查。需要 WorkBuddy 已打开并保持登录。活动日按北京时间计算，领取额度由官方规则决定，不保证永远为 100。

脚本先查询状态，已签到则跳过。提交领取前记下当天尝试；请求超时、设备校验或其他结果不明时当天不会自动再次提交，只会查询。只有重新查询确认 `today_checked_in=true` 才报告领取成功。活动结束、账号不符合条件或要求设备验证时停止，请在 App 内处理；不伪造或绕过设备校验。

定时任务的日志和私有状态保存在 `.runtime/daily-checkin/`；安装文件位于用户 `Library/LaunchAgents/cn.workbuddy-bridge.daily-checkin.plist`。用 `node tools/daily-checkin/schedule.mjs --plan` 可只生成项目内预览，不安装或领取。

若异常退出留下 `running.lock`，确认没有签到进程正在运行后再删除该文件。不要随意删除 `state.json`，它用于防止当天不确定结果被重复提交。

当前开发执行环境连接 App 本地 socket 返回 EPERM，尚未取得真实签到成功结果。`credits:install` 只有实际签到确认成功或官方状态显示已签到，才会安装，不能将本地测试通过视为已经领取或启用定时任务。
