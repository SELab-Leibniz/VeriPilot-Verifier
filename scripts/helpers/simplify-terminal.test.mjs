import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { waitPostRunTerminal } from '../../lib/openclaw/post-run-host.mjs';
import { waitSimplifyRunTerminal } from './simplify-native-evaluation.mjs';

function slowGateway() {
  const doneAt = Date.now() + 3000;
  return { async request(method, { runId, timeoutMs: hostWait }, { timeoutMs: clientWait }) {
    assert.equal(method, 'agent.wait');
    const latency = 1500 + Math.min(hostWait, Math.max(0, doneAt - Date.now() - 1500));
    await delay(Math.min(clientWait, latency));
    if (latency > clientWait) throw new Error(`gateway timeout after ${clientWait}ms`);
    return { runId, status: Date.now() >= doneAt ? 'ok' : 'timeout' };
  } };
}

test('evaluation terminal polling tolerates slow authentication and a single poll timeout', async () => {
  const oldGateway = slowGateway();
  await assert.rejects(waitPostRunTerminal(null, null, 'run', Date.now() + 8000, undefined,
    (...args) => oldGateway.request(...args)), /gateway timeout after 2000ms/u);
  assert.deepEqual(await waitSimplifyRunTerminal(slowGateway(), 'run', Date.now() + 8000), { runId: 'run', status: 'ok' });

  let polls = 0;
  const gateway = { async request(method, params, options) {
    assert.equal(method, 'agent.wait');
    assert.deepEqual(params, { runId: 'run', timeoutMs: 1 });
    assert.equal(options.timeoutMs, 5000);
    if (++polls === 1) throw new Error('gateway timeout after 5000ms\nGateway target: loopback');
    return { result: { runId: 'run', status: 'error' } };
  } };
  assert.deepEqual(await waitSimplifyRunTerminal(gateway, 'run', Date.now() + 8000), { runId: 'run', status: 'error' });
  assert.equal(polls, 2);
});
