import net from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Use the App's authenticated backend proxy. Remote account tokens stay in App.
export async function connectWorkBuddy({ configDir = join(homedir(), '.workbuddy'), timeoutMs = 60000, socketFactory = endpoint => net.createConnection(endpoint) } = {}) {
  const discovery = join(configDir, 'wbipc', 'endpoint.json');
  const info = await stat(discovery);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid() || info.mode & 0o077) {
    throw new Error('WorkBuddy 本地通道文件权限异常，未读取登录信息。');
  }
  const { endpoint, ticket } = JSON.parse(await readFile(discovery, 'utf8'));
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || typeof ticket !== 'string' || ticket.length < 16) {
    throw new Error('无法识别 WorkBuddy 本地通道；请更新并重新打开 App。');
  }
  const socket = socketFactory(endpoint);
  socket.setEncoding('utf8');
  let buffer = '', sequence = 0, serverNonce;
  const clientNonce = randomBytes(16).toString('base64url');
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = error => {
    readyReject(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    socket.destroy();
  };
  const send = frame => socket.write(JSON.stringify(frame) + '\n');
  function proof(role) {
    const transcript = [role === 'server' ? 'wbipc-s' : 'wbipc-c', '1', endpoint, clientNonce, serverNonce];
    const bytes = transcript.map(value => {
      const data = Buffer.from(value); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
      return Buffer.concat([size, data]);
    });
    return createHmac('sha256', ticket).update(Buffer.concat(bytes)).digest('base64url');
  }
  const timer = setTimeout(() => fail(new Error('WorkBuddy 本地通道握手超时。')), 10000);
  socket.on('connect', () => send({ type: 'session_hello', protocol_min: 1, protocol_max: 1,
    client_nonce: clientNonce, ticket_id: createHash('sha256').update(ticket).digest('hex').slice(0, 16),
    client: { kind: 'cli', id: 'workbuddy-daily-checkin', version: '1.0.0' } }));
  socket.on('data', data => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 1024 * 1024) return fail(new Error('WorkBuddy 响应超出限制。'));
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'session_challenge') {
          serverNonce = frame.server_nonce;
          if (typeof serverNonce !== 'string' || typeof frame.server_proof !== 'string') throw new Error('WorkBuddy 握手格式异常。');
          const expected = Buffer.from(proof('server')), received = Buffer.from(frame.server_proof);
          if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('WorkBuddy 本地通道身份校验失败。');
          send({ type: 'session_prove', client_proof: proof('client') });
        } else if (frame.type === 'session_hello_ack') { clearTimeout(timer); readyResolve(); }
        else if (frame.type === 'session_hello_error') throw new Error('WorkBuddy 本地通道认证失败；请重新打开 App。');
        else if (frame.id !== undefined) {
          const entry = pending.get(frame.id);
          if (!entry) continue;
          pending.delete(frame.id); clearTimeout(entry.timer);
          if (frame.error) entry.reject(new Error('WorkBuddy 本地请求失败：' + String(frame.error.code)));
          else entry.resolve(frame.result);
        }
      } catch (error) { fail(error); }
    }
  });
  socket.on('error', error => fail(Object.assign(new Error('无法连接 WorkBuddy 本地通道：' + (error.code ?? '连接失败')), { code: error.code })));
  socket.on('close', () => { clearTimeout(timer); fail(new Error('WorkBuddy 本地通道已关闭；请保持 App 后台登录。')); });
  function call(method, params, mode) {
    return new Promise((resolve, reject) => {
      if (socket.destroyed) return reject(new Error('WorkBuddy 本地通道已断开。'));
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('WorkBuddy 请求超时；未自动重试领取。')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params, ...(mode ? { mode } : {}) });
    });
  }
  try {
    await ready;
    const pipe = await call('broker/GetPipe', { pipe: 'wb.request' });
    if (typeof pipe.channel !== 'string' || !pipe.methods?.includes('http.fetch')) throw new Error('当前 WorkBuddy 不提供本地请求通道。');
    return {
      async post(path) {
        if (!['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/daily-checkin'].includes(path)) throw new Error('仅允许签到相关请求。');
        const response = await call(pipe.channel + '/http.fetch', { method: 'POST', path,
          headers: { 'content-type': 'application/json' }, body_b64: Buffer.from('{}').toString('base64') }, 'call');
        if (response.status !== 200) throw new Error(`WorkBuddy HTTP ${response.status}；请在 App 检查登录、设备校验及活动状态。`);
        try { return JSON.parse(Buffer.from(response.body_b64, 'base64').toString('utf8')); }
        catch { throw new Error('WorkBuddy 返回了无法识别的签到响应。'); }
      },
      close() { socket.destroy(); }
    };
  } catch (error) { clearTimeout(timer); socket.destroy(); throw error; }
}
