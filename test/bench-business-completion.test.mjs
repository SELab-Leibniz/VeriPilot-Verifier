import test from 'node:test';
import assert from 'node:assert/strict';
import { readBusinessTerminal, knownBusinessTerminal, businessCompleted, createBusinessRunTracker } from '../scripts/bench/business-completion.mjs';
test('an outer context-compaction error remains failed after a successful diagnostic attempt', async () => {
  const terminal = await readBusinessTerminal(async () => ({ result: { runId: 'host', status: 'error' } }), 'host');
  assert.equal(knownBusinessTerminal(terminal, 'host'), true);
  assert.equal(businessCompleted(terminal, 'host'), false);
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
