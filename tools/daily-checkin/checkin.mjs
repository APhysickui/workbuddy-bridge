import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWorkBuddy } from './workbuddy-ipc.mjs';

export const STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
export const CLAIM_PATH = '/v2/billing/meter/daily-checkin';
export function chinaDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function statusData(response) {
  const data = response?.data;
  if (response?.code !== 0 || typeof data?.active !== 'boolean' || typeof data.today_checked_in !== 'boolean') {
    throw new Error('无法确认签到状态，请先在 WorkBuddy 加油站检查活动及登录。');
  }
  return data;
}
export async function checkin({ post, state = {}, save = async () => {}, statusOnly = false, day = chinaDay() }) {
  const before = statusData(await post(STATUS_PATH));
  const summary = { day, daily_credit: before.daily_credit ?? null, today_credit: before.today_credit ?? null };
  if (statusOnly) return { ...summary, status: before.today_checked_in ? 'already_claimed' : before.active ? 'available' : 'inactive' };
  if (before.today_checked_in) return { ...summary, status: 'already_claimed' };
  if (!before.active) throw new Error('加油站活动当前未开放；未提交领取。');
  if (state.attempt_day === day) throw new Error('今天已提交过领取但结果未确认；仅查询状态，不重复提交。请在 App 复查。');
  // Persist before a mutation. An ambiguous timeout must never trigger another
  // automatic claim that day, even after process or App restart.
  await save({ attempt_day: day });
  const response = await post(CLAIM_PATH);
  if (response?.code !== 0 && response?.code !== 1001) {
    throw new Error(`签到未成功（业务码 ${Number.isFinite(response?.code) ? response.code : '未知'}）；请在 App 检查，脚本不绕过设备校验。`);
  }
  const after = statusData(await post(STATUS_PATH));
  if (!after.today_checked_in) throw new Error('已提交领取，但复查尚未显示已签到；未标记成功，请稍后在 App 查看。');
  await save({ attempt_day: day, verified_day: day });
  return { ...summary, today_credit: after.today_credit ?? null, status: 'claimed_verified' };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--status')) throw new Error('Usage: node tools/daily-checkin/checkin.mjs [--status]');
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const runtime = join(project, '.runtime', 'daily-checkin');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  // OS releases this exclusive lock file only through our finally. A hard crash
  // leaves it for inspection instead of risking simultaneous claims.
  const lockPath = join(runtime, 'running.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('签到任务正在运行，或上次异常退出留下锁；请检查后删除 .runtime/daily-checkin/running.lock。');
    throw error;
  }
  let client;
  try {
    client = await connectWorkBuddy();
    let state = {};
    try { state = JSON.parse(await readFile(join(runtime, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('签到状态文件损坏；未提交领取。'); }
    const result = await checkin({ post: path => client.post(path), state, statusOnly: args.includes('--status'),
      save: value => writeFile(join(runtime, 'state.json'), JSON.stringify(value) + '\n', { mode: 0o600 }) });
    console.log(JSON.stringify({ time: new Date().toISOString(), ...result }));
    return result;
  } finally { client?.close(); await lock.close(); await rm(lockPath, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ time: new Date().toISOString(), status: 'failed', message: error.message })); process.exitCode = 1; });
}
