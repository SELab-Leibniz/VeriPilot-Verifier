import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeStopGrace, nativeStopReviewDirectory, nativeStopSettlement, readNativeStopRecords, waitNativeStopSettled } from '../scripts/bench/native-stop-settlement.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const record = (fields = {}) => ({ sessionId: 's', sessionKey: 'k', runId: 'run-1', occurrenceId: 'run-1', enabledRevision: 0, status: 'SETTLED',
  reviewStatus: 'NO_DEVIATION_FOUND', reasonCode: 'NO_DEVIATION_FOUND', evaluationId: 'stop-a', ...fields });

test('a native Stop settles only when every record settled and the current verification has its carrier', () => {
  assert.equal(nativeStopSettlement([], null).settled, true);
  assert.equal(nativeStopSettlement([], { status: 'NO_DEVIATION_FOUND', evaluationId: 'stop-a' }).settled, false);
  const pending = nativeStopSettlement([record({ status: 'PENDING', reviewStatus: undefined, evaluationId: undefined })], null);
  assert.equal(pending.settled, false);
  assert.deepEqual(pending.pending.map(row => [row.occurrenceId, row.status]), [['run-1', 'PENDING']]);
  assert.equal(nativeStopSettlement([record(), record({ runId: 'run-2', occurrenceId: 'run-2', status: 'RUNNING' })], { evaluationId: 'stop-a' }).settled, false);
  assert.equal(nativeStopSettlement([record()], { evaluationId: 'stop-b' }).settled, false, 'a stale record does not carry a newer verification');
  const settled = nativeStopSettlement([record()], { status: 'NO_DEVIATION_FOUND', evaluationId: 'stop-a' });
  assert.equal(settled.settled, true);
  assert.equal(settled.carrier.evaluationId, 'stop-a');
  assert.equal(nativeStopSettlement([record({ reviewStatus: 'SKIPPED', reasonCode: 'STOP_DOCUMENT_ONLY_CHANGES', evaluationId: 'stop-skip-0123' })],
    { status: 'SKIPPED', evaluationId: 'stop-skip-0123' }).settled, true, 'a document-only skip is carried by its evaluationId');
  const terminal = { status: 'UNVERIFIED', evaluationId: 'stop-terminal-abc', terminalRunId: 'run-1', reasonCode: 'MATERIAL_BASIS_CHANGED' };
  assert.equal(nativeStopSettlement([record({ reviewStatus: 'UNVERIFIED', reasonCode: 'MATERIAL_BASIS_CHANGED', evaluationId: null })], terminal).settled, true,
    'a terminal settlement is carried by the settled job of its run');
  assert.equal(nativeStopSettlement([record({ runId: 'run-2', evaluationId: null })], terminal).settled, false);
  assert.equal(nativeStopSettlement([{ file: 'x', status: 'UNREADABLE' }], null).settled, false);
});

test('a settlement that cannot change any more gives up after its grace instead of the run deadline', () => {
  let at = 1_000;
  const grace = nativeStopGrace({ graceMs: 100, now: () => at });
  const running = nativeStopSettlement([record({ status: 'PENDING', deadlineAt: 2_000, evaluationId: undefined })], null);
  assert.equal(grace(running), null);
  at = 2_050;
  assert.equal(grace(running), null, 'a job inside its own deadline plus grace may still settle');
  at = 2_101;
  assert.equal(grace(running), 'NATIVE_STOP_OVERDUE');
  const uncarried = nativeStopSettlement([record()], { evaluationId: 'stop-b' });
  assert.equal(grace(uncarried, false), null, 'an unarmed check never gives up');
  at = 3_000;
  assert.equal(grace(uncarried), null);
  at = 3_050;
  assert.equal(grace(uncarried, false), null);
  at = 3_090;
  assert.equal(grace(uncarried), null, 'disarming restarts the grace clock');
  at = 3_191;
  assert.equal(grace(uncarried), 'NATIVE_STOP_NO_CARRIER');
  assert.equal(grace(nativeStopSettlement([record()], { evaluationId: 'stop-a' })), null);
});

test('records are read from the session directory the product writes and the wait is bounded by the deadline', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-native-stop-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const directory = nativeStopReviewDirectory(projectRoot, 'k', 's');
  assert.equal(directory, path.join(projectRoot, '.runtime-correction/openclaw/native-stop-reviews', sha256(JSON.stringify(['k', 's']))));
  assert.deepEqual(await readNativeStopRecords({ projectRoot, sessionKey: 'k', sessionId: 's' }), []);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${sha256('run-1')}.json`);
  await fs.writeFile(file, JSON.stringify(record({ status: 'PENDING', reviewStatus: undefined, evaluationId: undefined })));
  await fs.writeFile(path.join(directory, `${sha256('run-1')}.json.0a1b.tmp`), '{"status":');
  const verification = { status: 'NO_DEVIATION_FOUND', evaluationId: 'stop-a' };
  const timedOut = await waitNativeStopSettled({ projectRoot, sessionKey: 'k', sessionId: 's', readVerification: async () => verification,
    deadlineAt: Date.now() + 150, pollMs: 20 });
  assert.equal(timedOut.nativeStopSettled, false);
  assert.deepEqual(timedOut.nativeStopPending.map(row => row.status), ['PENDING']);
  let polls = 0;
  const settled = await waitNativeStopSettled({ projectRoot, sessionKey: 'k', sessionId: 's', readVerification: async () => verification,
    deadlineAt: Date.now() + 5000, pollMs: 10, beforePoll: async () => { if (++polls === 3) await fs.writeFile(file, JSON.stringify(record())); } });
  assert.equal(settled.nativeStopSettled, true);
  assert.deepEqual(settled.nativeStopRecords.map(row => [row.occurrenceId, row.status, row.reviewStatus, row.evaluationId]),
    [['run-1', 'SETTLED', 'NO_DEVIATION_FOUND', 'stop-a']]);
  assert.ok(polls >= 3);
  await fs.writeFile(file, JSON.stringify(record({ status: 'RUNNING' })));
  const abandoned = await waitNativeStopSettled({ projectRoot, sessionKey: 'k', sessionId: 's', readVerification: async () => verification,
    deadlineAt: Date.now() + 60_000, pollMs: 10, abandon: () => true });
  assert.equal(abandoned.nativeStopSettled, false);
  assert.equal(abandoned.nativeStopReason, 'ABANDONED');
  assert.ok(abandoned.nativeStopWaitMs < 5000);
  await fs.writeFile(file, JSON.stringify(record()));
  const uncarried = await waitNativeStopSettled({ projectRoot, sessionKey: 'k', sessionId: 's', readVerification: async () => ({ evaluationId: 'stop-b' }),
    deadlineAt: Date.now() + 60_000, pollMs: 10, graceMs: 50 });
  assert.equal(uncarried.nativeStopSettled, false);
  assert.equal(uncarried.nativeStopReason, 'NATIVE_STOP_NO_CARRIER');
  assert.ok(uncarried.nativeStopWaitMs < 5000);
});
