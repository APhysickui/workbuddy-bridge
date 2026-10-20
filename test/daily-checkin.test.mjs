import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { checkin, chinaDay, STATUS_PATH, CLAIM_PATH } from '../tools/daily-checkin/checkin.mjs';
import { connectWorkBuddy } from '../tools/daily-checkin/workbuddy-ipc.mjs';
const status = (checked, active = true) => ({ code: 0, data: { active, today_checked_in: checked, daily_credit: 100, today_credit: checked ? 100 : 0 } });
const day = '2026-10-19';

test('checkin uses Beijing activity dates across UTC boundaries', () => {
  assert.equal(chinaDay(new Date('2026-10-18T16:00:00Z')), day);
  assert.equal(chinaDay(new Date('2026-10-18T15:59:59Z')), '2026-10-18');
});
test('status-only and already-claimed checks never submit a claim', async () => {
  for (const checked of [true, false]) {
    const paths = [];
    const result = await checkin({ post: async path => { paths.push(path); return status(checked); }, statusOnly: true });
    assert.deepEqual(paths, [STATUS_PATH]);
    assert.equal(result.status, checked ? 'already_claimed' : 'available');
  }
  const paths = [];
  assert.equal((await checkin({ post: async path => { paths.push(path); return status(true); } })).status, 'already_claimed');
  assert.deepEqual(paths, [STATUS_PATH]);
});
test('successful claim requires a fresh confirmed status, preserving the official credit amount', async () => {
  const paths = [], saved = [];
  const result = await checkin({ day, save: async value => saved.push(value), post: async path => {
    paths.push(path);
    if (path === CLAIM_PATH) { assert.deepEqual(saved, [{ attempt_day: day }]); return { code: 0 }; }
    const reply = status(paths.length > 1); reply.data.today_credit = paths.length > 1 ? 150 : 0;
    return reply;
  } });
  assert.deepEqual(paths, [STATUS_PATH, CLAIM_PATH, STATUS_PATH]);
  assert.deepEqual(saved.at(-1), { attempt_day: day, verified_day: day });
  assert.equal(result.status, 'claimed_verified'); assert.equal(result.today_credit, 150);
});
test('inactive, malformed or unverified responses never count as successful claims', async () => {
  for (const response of [status(false, false), {}, { code: 401 }, { code: 0, data: { active: true } }]) {
    let count = 0;
    await assert.rejects(checkin({ post: async path => { assert.equal(path, STATUS_PATH); count++; return response; } }));
    assert.equal(count, 1);
  }
  await assert.rejects(checkin({ post: async path => path === CLAIM_PATH ? { code: 0 } : status(false) }), /尚未显示已签到/);
});
test('business restrictions stop without retries or forged device information', async () => {
  let claims = 0;
  await assert.rejects(checkin({ post: async path => path === CLAIM_PATH ? (claims++, { code: 1002 }) : status(false) }), /1002/);
  assert.equal(claims, 1);
});
test('uncertain mutation survives restart and is never automatically submitted twice that day', async () => {
  let state = {}, claims = 0;
  const post = async path => { if (path === STATUS_PATH) return status(false); claims++; throw new Error('timeout'); };
  await assert.rejects(checkin({ day, post, state, save: async value => { state = value; } }), /timeout/);
  await assert.rejects(checkin({ day, post, state }), /不重复提交/);
  assert.equal(claims, 1);
  assert.equal((await checkin({ day, state, post: async () => status(true) })).status, 'already_claimed');
});
test('a failed local receipt write prevents the remote mutation', async () => {
  await assert.rejects(checkin({ post: async path => { assert.equal(path, STATUS_PATH); return status(false); },
    save: async () => { throw new Error('disk full'); } }), /disk full/);
});

async function fixture(t, { badProof = false } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), 'wb-checkin-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await mkdir(join(configDir, 'wbipc'));
  const endpoint = '/tmp/test-wb-checkin.sock', ticket = 'test-only-ticket-0123456789abcdef';
  await writeFile(join(configDir, 'wbipc', 'endpoint.json'), JSON.stringify({ endpoint, ticket }), { mode: 0o600 });
  let hello, serverProof, calls = 0;
  function proof(role) {
    return createHmac('sha256', ticket).update(Buffer.concat([role === 'server' ? 'wbipc-s' : 'wbipc-c', '1', endpoint, hello.client_nonce, 'test-server-nonce'].map(value => {
      const data = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32BE(data.length); return Buffer.concat([size, data]);
    }))).digest('base64url');
  }
  class Socket extends EventEmitter {
    destroyed = false;
    setEncoding() {}
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } }
    write(line) {
      const frame = JSON.parse(line);
      queueMicrotask(() => {
        if (frame.type === 'session_hello') {
          hello = frame; serverProof = proof('server');
          const payload = JSON.stringify({ type: 'session_challenge', server_nonce: 'test-server-nonce', server_proof: badProof ? 'incorrect' : serverProof }) + '\n';
          this.emit('data', payload.slice(0, 10)); this.emit('data', payload.slice(10));
        } else if (frame.type === 'session_prove') {
          assert.equal(frame.client_proof, proof('client'));
          this.emit('data', JSON.stringify({ type: 'session_hello_ack', protocol: 1 }) + '\n');
        } else {
          let result;
          if (frame.method === 'broker/GetPipe') {
            assert.deepEqual(frame.params, { pipe: 'wb.request' });
            result = { channel: 'c:wb.request', methods: ['http.fetch'] };
          } else {
            calls++; assert.equal(frame.method, 'c:wb.request/http.fetch'); assert.equal(frame.mode, 'call');
            assert.equal(frame.params.path, STATUS_PATH); assert.equal(frame.params.method, 'POST');
            assert.deepEqual(frame.params.headers, { 'content-type': 'application/json' });
            assert.equal(Buffer.from(frame.params.body_b64, 'base64').toString(), '{}');
            result = { status: 200, body_b64: Buffer.from(JSON.stringify(status(true))).toString('base64') };
          }
          this.emit('data', JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
        }
      });
    }
  }
  const socket = new Socket();
  return { configDir, socketFactory: value => { assert.equal(value, endpoint); queueMicrotask(() => socket.emit('connect')); return socket; }, getCalls: () => calls };
}
test('official IPC challenge proof and fragmented frames work without remote credential extraction', async t => {
  const options = await fixture(t);
  const client = await connectWorkBuddy(options);
  try {
    assert.deepEqual(await client.post(STATUS_PATH), status(true));
    await assert.rejects(client.post('/some-other-api'), /仅允许签到/);
    assert.equal(options.getCalls(), 1);
  } finally { client.close(); }
});
test('an invalid local server proof prevents all account requests', async t => {
  const options = await fixture(t, { badProof: true });
  await assert.rejects(connectWorkBuddy(options), /身份校验失败/);
  assert.equal(options.getCalls(), 0);
});
