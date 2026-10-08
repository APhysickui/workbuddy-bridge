import test from 'node:test';
import assert from 'node:assert/strict';
import { runClient } from '../src/launcher.mjs';

test('client argument failures show the precise safe diagnostic without exposing arbitrary stderr', async () => {
  const script = 'process.stderr.write("error: Cannot combine --prompt with --yolo.\\nprivate_key=DO_NOT_EXPOSE\\n"); process.exit(1);';
  await assert.rejects(runClient(process.execPath, ['--eval', script], { capture: true, allowFailure: true, timeout: 5000 }), error => {
    assert.equal(error.code, 'client_arguments_invalid');
    assert.equal(error.exitCode, 1);
    assert.match(error.message, /Cannot combine --prompt with --yolo/);
    assert.ok(!error.message.includes('DO_NOT_EXPOSE'));
    return true;
  });
});

test('other early client failures never disclose raw stderr', async () => {
  const script = 'process.stderr.write("private_key=DO_NOT_EXPOSE\\n"); process.exit(1);';
  await assert.rejects(runClient(process.execPath, ['--eval', script], { capture: true, allowFailure: true, timeout: 5000 }), error => {
    assert.match(error.message, /退出失败/);
    assert.ok(!error.message.includes('DO_NOT_EXPOSE'));
    return true;
  });
});
