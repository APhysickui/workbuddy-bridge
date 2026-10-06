import { spawn } from 'node:child_process';
import { join } from 'node:path';

export async function ensureBridge(project, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file=.env', join(project, 'scripts/ensure-bridge.mjs')],
      { cwd: project, env, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let errorText = '';
    child.stderr.on('data', chunk => { if (errorText.length < 4096) errorText += chunk; });
    child.on('error', () => reject(new Error('无法启动 WorkBuddy 桥接。')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || 'WorkBuddy 桥接启动失败。')));
  });
}

export async function runClient(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false, detached: options.capture && process.platform !== 'win32' });
    let stdout = '';
    let bytes = 0;
    let failure;
    let killTimer;
    const kill = signal => {
      try {
        if (options.capture && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const stop = reason => {
      failure ??= new Error(reason);
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 500);
      killTimer.unref();
    };
    const timer = options.timeout ? setTimeout(() => stop('客户端验证超时。'), options.timeout) : undefined;
    const interrupt = () => stop('客户端已中断。');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    if (options.capture) {
      const capture = (chunk, save) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) stop('客户端输出超过验证限制。');
        else if (save) stdout += chunk;
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => capture(chunk, true));
      child.stderr.on('data', chunk => capture(chunk, false));
    }
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); };
    child.on('error', () => { cleanup(); reject(new Error(`${command} 无法启动；请检查安装。`)); });
    child.on('close', code => {
      cleanup();
      if (options.capture) kill('SIGKILL');
      if (failure) reject(failure);
      else if (code !== 0 && !(options.capture && options.allowFailure && stdout.trim())) reject(new Error(`${command} 退出失败；没有验证成功回复。`));
      else resolve(stdout);
    });
  });
}
