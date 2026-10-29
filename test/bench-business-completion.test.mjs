import test from 'node:test';
import assert from 'node:assert/strict';
import { readBusinessTerminal, knownBusinessTerminal, businessCompleted, createBusinessRunTracker, createBusinessTerminalObserver } from '../scripts/bench/business-completion.mjs';
test('an outer context-compaction error remains failed after a successful diagnostic attempt', async () => {
  const terminal = await readBusinessTerminal(async () => ({ result: { runId: 'host', status: 'error' } }), 'host');
  assert.equal(knownBusinessTerminal(terminal, 'host'), true);
  assert.equal(businessCompleted(terminal, 'host'), false);
});

test('a real public terminal captured before review survives gateway cache expiration', async () => {
  let clock = 100, requests = 0;
  const observer = createBusinessTerminalObserver({ now: () => clock });
  const starts = [{ runId: 'main', seq: 1, ts: 10 }];
  const request = async () => { requests++; return clock < 600000
    ? { runId: 'main', status: 'ok', startedAt: 10, endedAt: 90 }
    : { runId: 'main', status: 'timeout', timeoutPhase: 'queue', providerStarted: false }; };
  assert.equal(await observer.poll(request, 'main', starts, 'RUNNING'), null);
  const actual = await observer.poll(request, 'main', starts, 'REVIEWING');
  clock += 11 * 60000;
  assert.deepEqual(await observer.poll(request, 'main', starts, 'IDLE'), actual);
  assert.equal(requests, 1);
  assert.equal(businessCompleted(observer.terminal, 'main'), true);
  assert.equal(observer.drainEvents()[0].type, 'public-reply');
});

test('private activity does not invalidate a captured business terminal, but a correction does', async () => {
  const observer = createBusinessTerminalObserver();
  const first = [{ runId: 'main', seq: 1, ts: 10 }];
  await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 20 }), 'main', first, 'REVIEWING');
  const privateActivity = [...first, { runId: 'reviewer', seq: 2, ts: 30 }];
  assert.equal((await observer.poll(() => { throw Error('No new RPC needed'); }, 'main', privateActivity, 'REVIEWING')).status, 'ok');
  assert.equal(await observer.poll(async () => ({ runId: 'correction', status: 'ok' }), 'correction', privateActivity, 'RUNNING'), null);
  assert.equal(observer.terminal, null);
  assert(observer.drainEvents().some(event => event.type === 'invalidated' && event.reason === 'business-run-replaced'));
});

test('same-run retries invalidate old outcomes and reject terminals older than the latest model start', async () => {
  const observer = createBusinessTerminalObserver({ pollIntervalMs: 0 });
  let starts = [{ runId: 'main', seq: 1, ts: 10 }];
  await observer.poll(async () => ({ runId: 'main', status: 'error', endedAt: 20 }), 'main', starts, 'FINALIZING');
  starts = [...starts, { runId: 'main', seq: 2, ts: 30 }];
  await observer.poll(async () => ({}), 'main', starts, 'RUNNING');
  assert.equal(observer.terminal, null);
  assert.equal(await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 20 }), 'main', starts, 'REVIEWING'), null);
  assert.equal(businessCompleted(await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 40 }), 'main', starts, 'IDLE'), 'main'), true);
  assert(observer.drainEvents().some(event => event.type === 'stale-reply-rejected'));
});

test('timeouts, errors and cross-run replies are preserved honestly without a fabricated success', async () => {
  let clock = 0, calls = 0;
  const observer = createBusinessTerminalObserver({ now: () => clock, pollIntervalMs: 2000 });
  const request = async () => { calls++; return { runId: 'main', status: 'timeout', timeoutPhase: 'queue', providerStarted: false }; };
  assert.equal(await observer.poll(request, 'main', [], 'IDLE'), null);
  clock = 1000;
  await observer.poll(request, 'main', [], 'IDLE');
  assert.equal(calls, 1);
  clock = 2000;
  await observer.poll(async () => ({ runId: 'other', status: 'ok' }), 'main', [], 'IDLE');
  assert.equal(observer.terminal, null);
  const failed = await observer.poll(async () => ({ runId: 'main', status: 'error' }), 'main', [], 'IDLE', { force: true });
  assert.equal(businessCompleted(failed, 'main'), false);
  assert.equal(failed.status, 'error');
});

test('a business retry beginning during the public query rejects its old reply', async () => {
  const observer = createBusinessTerminalObserver({ pollIntervalMs: 0 });
  const starts = [{ runId: 'main', seq: 1, ts: 10 }];
  const old = await observer.poll(async () => {
    starts.push({ runId: 'main', seq: 2, ts: 30 });
    return { runId: 'main', status: 'ok', endedAt: 20 };
  }, 'main', () => starts, 'REVIEWING');
  assert.equal(old, null);
  assert.equal(observer.terminal, null);
  assert.equal(businessCompleted(await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 40 }),
    'main', () => starts, 'IDLE'), 'main'), true);
});
test('a confirmed outer success remains successful after prior diagnostic failures', async () => {
  const terminal = await readBusinessTerminal(async () => ({ runId: 'host', status: 'ok' }), 'host');
  assert.equal(businessCompleted(terminal, 'host'), true);
});
test('unknown, unavailable and cross-run terminals never establish completion', async () => {
  for (const response of [{ runId: 'host', status: 'timeout' }, { runId: 'other', status: 'ok' }, {}]) {
    const terminal = await readBusinessTerminal(async () => response, 'host');
    assert.equal(knownBusinessTerminal(terminal, 'host'), false);
    assert.equal(businessCompleted(terminal, 'host'), false);
  }
  assert.equal(businessCompleted(await readBusinessTerminal(async () => { throw new Error('Unavailable'); }, 'host'), 'host'), false);
});
test('memory runs in the same session cannot replace the authoritative business identity', () => {
  const tracker = createBusinessRunTracker('original', 'business');
  tracker.observe({ sessionId: 'business', runId: 'memory-flush', phase: 'FINALIZING' });
  assert.equal(tracker.runId, 'original');
  tracker.observe({ sessionId: 'reviewer', correctionRunId: 'foreign' });
  assert.equal(tracker.runId, 'original');
  tracker.observe({ sessionId: 'business', runId: 'original', correctionRunId: 'trusted-correction' });
  assert.equal(tracker.runId, 'trusted-correction');
  tracker.observe({ sessionId: 'business', phase: 'IDLE', correctionRunId: null });
  assert.equal(tracker.runId, 'trusted-correction', 'settlement must retain the actual correction identity');
});
