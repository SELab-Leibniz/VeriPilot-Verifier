import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureDeadline, fixtureRuntimeHealth } from './support/fixture-deadline.mjs';
function fakeClock() {
  let time = 0, serial = 0; const timers = new Map();
  return { now: () => time,
    setTimer: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id),
    advance: value => { time += value; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } },
    timers };
}
const pending = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
test('fixture observer accepts delayed scheduling only inside its original fixed parent deadline', async () => {
  const clock = fakeClock(), fixture = createFixtureDeadline(null, { timeoutMs: 30000, ...clock }), event = pending();
  const observed = fixture.wait(event.promise, 'callback');
  clock.advance(15000); event.resolve('observed'); assert.equal(await observed, 'observed');
  assert.equal(fixture.deadlineAt, 30000); assert.equal(fixture.remaining(), 15000);
  clock.advance(15000); await assert.rejects(fixture.wait(pending().promise, 'later callback'), { code: 'RC_FIXTURE_DEADLINE' });
  fixture.close(); assert.equal(clock.timers.size, 0);
});
test('a longer fixture observer never overrides the original child abort', async () => {
  const clock = fakeClock(), fixture = createFixtureDeadline(null, { timeoutMs: 30000, ...clock });
  const reviewController = new AbortController(), state = { reviewController };
  const observed = fixture.wait(pending().promise, 'callback', { state });
  clock.advance(4000); reviewController.abort(Object.assign(new Error('arbitrary private text'), { code: 'STOP_DEADLINE_EXPIRED' }));
  await assert.rejects(observed, { code: 'RC_FIXTURE_REVIEW_ABORTED', causeCode: 'STOP_DEADLINE_EXPIRED' });
  assert.equal(fixture.deadlineAt, 30000); fixture.close(); assert.equal(clock.timers.size, 0);
});
test('settled detached work cannot leave the observer waiting for a callback it will never issue', async () => {
  const clock = fakeClock(), fixture = createFixtureDeadline(null, { timeoutMs: 30000, ...clock });
  await assert.rejects(fixture.wait(pending().promise, 'callback', { work: { promise: Promise.resolve() } }),
    { code: 'RC_FIXTURE_WORK_SETTLED_WITHOUT_OBSERVATION' });
  fixture.close(); assert.equal(clock.timers.size, 0);
});
test('fixture runtime diagnostics expose only booleans and a validated error code', () => {
  const reviewController = new AbortController(); reviewController.abort(Object.assign(new Error('PRIVATE_TEXT'), { code: 'STOP_DEADLINE_EXPIRED' }));
  const health = fixtureRuntimeHealth({ reviewController, nativeInvalidated: true, hotReviewWork: { started: true, secret: 'PRIVATE_TEXT' } });
  assert.equal(health.abortReasonCode, 'STOP_DEADLINE_EXPIRED'); assert.equal(health.nativeInvalidated, true);
  assert(!JSON.stringify(health).includes('PRIVATE_TEXT'));
  assert.equal(fixtureRuntimeHealth({ reviewController: { signal: { aborted: true, reason: { code: 'private text with spaces' } } } }).abortReasonCode, undefined);
});

test('an already-observed callback wins over settled-work diagnostic without a false failure', async () => {
  const clock = fakeClock(), fixture = createFixtureDeadline(null, { timeoutMs: 30000, ...clock });
  assert.equal(await fixture.wait(Promise.resolve('already observed'), 'callback',
    { work: { promise: Promise.resolve() } }), 'already observed');
  const callback = pending();
  const work = Promise.resolve().then(() => { callback.resolve('observed in work'); });
  assert.equal(await fixture.wait(callback.promise, 'callback', { work: { promise: work } }), 'observed in work');
  fixture.close(); assert.equal(clock.timers.size, 0);
});
