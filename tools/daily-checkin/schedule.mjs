import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { main as runCheckin } from './checkin.mjs';
const execute = promisify(execFile);
const label = 'cn.workbuddy-bridge.daily-checkin';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = join(project, '.runtime', 'daily-checkin');
const plistPath = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>WorkbuddyBridgeDailyCheckin</key><true/>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(project, 'tools/daily-checkin/checkin.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>RunAtLoad</key><true/>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>5</integer></dict>
<key>StartInterval</key><integer>3600</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(runtime, 'schedule.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(runtime, 'schedule.log'))}</string>
</dict></plist>
`;
}
async function checkExisting() {
  try {
    const text = await readFile(plistPath, 'utf8');
    if (!text.includes('<key>WorkbuddyBridgeDailyCheckin</key><true/>')) throw new Error('同名 LaunchAgent 不属于本工具，未覆盖。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function bootout() {
  try { await execute('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]); }
  catch (error) { if (![3, 113].includes(error.code)) throw new Error('无法卸载旧定时任务；请在已登录的普通 macOS 终端运行。'); }
}
async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (extra.length || !['--plan', '--install', '--uninstall'].includes(action)) throw new Error('Usage: node tools/daily-checkin/schedule.mjs --plan|--install|--uninstall');
  if (process.platform !== 'darwin') throw new Error('此定时安装器只支持 macOS launchd。');
  if (action === '--plan') {
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const file = join(runtime, label + '.plist');
    await writeFile(file, plist(), { mode: 0o600 });
    console.log(JSON.stringify({ installed: false, preview: file, schedule: '本机时间每日 09:05，另每小时补查；需要 WorkBuddy 后台登录' }));
    return;
  }
  await checkExisting();
  if (action === '--uninstall') {
    await bootout(); await rm(plistPath, { force: true });
    console.log('WorkBuddy 自动签到任务已移除。'); return;
  }
  // Do not install a task that has never verified an actual claim/status.
  const result = await runCheckin([]);
  if (!['claimed_verified', 'already_claimed'].includes(result.status)) throw new Error('真实签到未验证，未安装定时任务。');
  await mkdir(dirname(plistPath), { recursive: true });
  await bootout();
  await writeFile(plistPath, plist(), { mode: 0o600 });
  try { await execute('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]); }
  catch { throw new Error('LaunchAgent 文件已生成，但加载失败；请在已登录的普通 macOS 终端重新运行 credits:install。'); }
  console.log('已安装：每天本机时间 09:05 自动签到，每小时补查一次；请保持 WorkBuddy 后台登录。');
  console.log('日志：' + join(runtime, 'schedule.log'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
