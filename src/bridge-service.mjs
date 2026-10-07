export const BRIDGE_PROTOCOL = 3;

export function bridgeIdentity(config) {
  return { bridge: 'workbuddy-bridge', protocol: BRIDGE_PROTOCOL, backend: config.backend,
    models: Object.fromEntries(config.models), claude_model: config.claudeModel ?? null,
    cli_path: config.cliPath ?? null, claude_passthrough: Boolean(config.claudePassthrough) };
}

export async function readBridgeStatus(config, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`http://127.0.0.1:${config.port}/_bridge/status`, {
      headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(750)
    });
  } catch (error) {
    const codes = [error.cause?.code, ...(error.cause?.errors ?? []).map(value => value.code)];
    if (codes.includes('EPERM') || codes.includes('EACCES')) throw new Error('当前执行环境不允许连接本地端口；请在普通终端运行对应的 Claude / pi / Kimi 启动命令。');
    if (codes.includes('ECONNREFUSED') || error.name === 'TimeoutError' || codes.includes('ECONNRESET')) return null;
    throw new Error('无法检查本地桥接服务，未自动启动替代服务。');
  }
  if (!response.ok) throw new Error('桥接端口已有服务，但密钥或服务接口不匹配。请检查端口占用。');
  let status;
  try { status = await response.json(); } catch { throw new Error('桥接端口返回了无法识别的服务状态。'); }
  if (status?.bridge !== 'workbuddy-bridge') throw new Error('桥接端口已有无法识别的服务，未停止或替换它。');
  return status;
}

export async function stopKnownBridge(config, fetcher = fetch) {
  // Configuration/protocol changes should not prevent stopping our old instance.
  // Authentication and the bridge identity are still required before shutdown.
  if (!await readBridgeStatus(config, fetcher)) return false;
  const response = await fetcher(`http://127.0.0.1:${config.port}/_bridge/shutdown`, {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error('The bridge could not be stopped.');
  return true;
}

export async function matchingBridge(config, fetcher = fetch) {
  const status = await readBridgeStatus(config, fetcher);
  if (!status) return false;
  const expected = bridgeIdentity(config);
  if (status.bridge !== expected.bridge || status.protocol !== expected.protocol || status.backend !== 'workbuddy' ||
      status.cli_path !== expected.cli_path || status.claude_passthrough !== expected.claude_passthrough ||
      JSON.stringify(status.models) !== JSON.stringify(expected.models)) {
    throw new Error('已有桥接服务的协议、后端或模型不匹配；请先 npm run bridge:stop 再重新启动。');
  }
  return true;
}
