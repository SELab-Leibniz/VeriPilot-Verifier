import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewerAgentPool } from '../lib/openclaw/review-concurrency.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('the shared Agent slot waits for physical settlement and drops cancelled or expired queued work', async () => {
  const pool = createReviewerAgentPool(1);
  const active = deferred(), backend = deferred(), caller = deferred();
  const first = pool.run(track => {
    track(backend.promise);
    active.resolve();
    return caller.promise;
  }, { deadlineAt: Infinity });
  await active.promise;
  caller.resolve('caller finished');
  assert.equal(await first, 'caller finished');

  const controller = new AbortController(), starts = [];
  const queued = (label, options = {}) => pool.run(() => starts.push(label), { deadlineAt: Infinity, ...options });
  const cancelled = assert.rejects(queued('cancelled', { signal: controller.signal }), /cancel this review/u);
  const expired = assert.rejects(queued('expired', { deadlineAt: Date.now() + 25 }), { code: 'REVIEWER_DEADLINE' });
  const next = queued('next'), last = queued('last');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancel this review'));
  await Promise.all([cancelled, expired]);
  assert.deepEqual(starts, []);
  backend.resolve();
  await Promise.all([next, last]);
  assert.deepEqual(starts, ['next', 'last']);
});

test('failed dispatch preparation and a rejected host run both return the Agent slot', async () => {
  const pool = createReviewerAgentPool(1), options = { deadlineAt: Date.now() + 1000 };
  await assert.rejects(pool.run(() => { throw new Error('preparation failed'); }, options), /preparation failed/u);
  await assert.rejects(pool.run(track => {
    const native = Promise.reject(new Error('the host failed'));
    track(native);
    return native;
  }, options), /the host failed/u);
  assert.equal(await pool.run(() => 'ready', options), 'ready');
  for (const invalid of [0, 33, 1.5, '2', null]) assert.throws(() => createReviewerAgentPool(invalid), /agentConcurrency/u);
});
