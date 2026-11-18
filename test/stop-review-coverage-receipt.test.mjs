import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNativeStopReviews } from '../lib/openclaw/native-stop-review.mjs';
import { createPostRunDispatcher } from '../lib/openclaw/post-run-dispatch.mjs';
import { createStopReviewCoveragePublicationObserver, createStopReviewCoverageReceipt, verifyStopReviewCoverageReceipt } from '../lib/openclaw/stop-review-coverage-receipt.mjs';
import { ensureTask, withTaskDecision, withTaskState, decisionGuard, findTask } from '../lib/runtime-v2/task-store.mjs';

const owner = { projectRoot: path.resolve(os.tmpdir(), 'receipt-project'), sessionId: 'session-a', sessionKey: 'agent:example:a',
  runId: 'run-a', taskId: 'task-a', assessmentId: 'assessment-a', evaluationId: 'evaluation-a', scopeFingerprint: 'scope-a', enabledRevision: 2 };
const example = (status = 'UNVERIFIED') => ({ status, evaluationId: owner.evaluationId, review: { reviewCoverage: { total: 1, unverified: 1,
  unverifiedRatio: 1, items: [{ id: 'requirement-a', type: 'REQUIREMENT', disposition: 'UNVERIFIED', unverified: true,
    reason: 'The exported value has no acknowledged upstream read.', originCoverage: { status: 'UNVERIFIED', reason: 'MISSING_ORIGIN' },
    flow: { entry: { path: 'src/export.ts', start: 3, end: 8, sha256: 'source-version-a' } } }] } } });
const capture = (outcome, identity = owner) => {
  const observer = createStopReviewCoveragePublicationObserver(identity);
  observer.onPublished({ ...identity, result: { stop: outcome } });
  return createStopReviewCoverageReceipt({ owner: identity, reviewStatus: outcome.status, outcome, publication: observer.token });
};
const carrier = (receipt, identity = owner) => ({ status: 'SETTLED', sessionId: identity.sessionId, sessionKey: identity.sessionKey,
  runId: identity.runId, enabledRevision: identity.enabledRevision, evaluationId: identity.evaluationId,
  reviewStatus: receipt?.reviewStatus ?? 'UNVERIFIED', assessmentCompletedAt: 1000,
  reviewSummary: { evaluationId: identity.evaluationId, assessmentId: identity.assessmentId,
    status: receipt?.reviewStatus ?? 'UNVERIFIED', reviewCoverageReceipt: receipt } });
const verify = (receipt, outcome, identity = owner) => verifyStopReviewCoverageReceipt({ record: carrier(receipt), owner: identity,
  reviewStatus: outcome.status, coverage: outcome.review?.reviewCoverage });

test('a host-retained digest binds the complete coverage body without copying source or diagnostic text', () => {
  const outcome = example(), receipt = capture(outcome);
  assert.equal(receipt.status, 'RECORDED');
  assert.deepEqual(verify(receipt, JSON.parse(JSON.stringify(outcome))), {
    status: 'MATCHED', reviewStatus: 'UNVERIFIED', coverageSha256: receipt.coverageSha256 });
  assert.equal(receipt.coverageSha256.length, 64);
  assert.ok(!JSON.stringify(receipt).includes('src/export.ts'));
  assert.ok(!JSON.stringify(receipt).includes('upstream read'));
  assert.ok(!JSON.stringify(receipt).includes('MISSING_ORIGIN'));
  assert.equal(verify(receipt, outcome).reviewStatus, 'UNVERIFIED', 'matching a digest does not promote uncertainty to PASS');
});

test('editing any retained source, origin disposition, uncertainty or diagnostic changes the content check', () => {
  const original = example(), receipt = capture(original);
  for (const edit of [
    value => { value.items[0].flow.entry.sha256 = 'different-source'; },
    value => { value.items[0].originCoverage.status = 'OBSERVED_CANDIDATES_REVIEWED'; },
    value => { value.items[0].originCoverage.reason = 'different-reason'; },
    value => { value.items[0].disposition = 'SOURCE_REVIEWED'; value.items[0].unverified = false; },
    value => { value.items[0].reason = 'Nothing remains to verify.'; },
    value => { value.items.push({ id: 'replacement', disposition: 'PASS' }); },
  ]) {
    const changed = structuredClone(original); edit(changed.review.reviewCoverage);
    assert.deepEqual(verify(receipt, changed), { status: 'MISMATCH', reason: 'COVERAGE_CONTENT_MISMATCH' });
  }
  assert.equal(verify(receipt, original).status, 'MATCHED', 'the original remains independently readable');
});

test('a matching body cannot reuse another run, project, task, scope, revision or status', () => {
  const outcome = example(), receipt = capture(outcome);
  for (const key of Object.keys(owner)) {
    const changed = { ...owner, [key]: key === 'enabledRevision' ? 3 : owner[key] + '-different' };
    assert.deepEqual(verify(receipt, outcome, changed), { status: 'MISMATCH', reason: 'OWNER_MISMATCH' }, key);
  }
  assert.deepEqual(verify(receipt, { ...outcome, status: 'PASS' }), { status: 'MISMATCH', reason: 'CARRIER_STATUS_MISMATCH' });
  assert.deepEqual(verify({ ...receipt, bindingSha256: '0'.repeat(64) }, outcome), {
    status: 'MISMATCH', reason: 'RECEIPT_BINDING_MISMATCH' });
  assert.deepEqual(verify({ ...receipt, owner: undefined }, outcome), { status: 'MISMATCH', reason: 'OWNER_MISMATCH' });
});

test('absent, stale and expired coverage stays unavailable, including retained historical rows', () => {
  const outcome = example();
  const historical = capture({ ...outcome, savedReviewCollection: { complete: true } });
  assert.equal(historical.status, 'UNAVAILABLE');
  assert.equal(historical.reason, 'EXPIRED_OR_STALE_PUBLICATION');
  assert.equal(historical.coverageSha256, undefined);
  const reused = capture({ ...outcome, reused: true });
  assert.equal(reused.status, 'UNAVAILABLE');
  assert.equal(reused.reason, 'REUSED_ASSESSMENT_NOT_BOUND');
  assert.equal(reused.coverageSha256, undefined, 'rehashing an editable historical evaluation cannot mint current authority');
  for (const missing of [{ status: 'UNVERIFIED' }, { status: 'UNVERIFIED', review: {} }]) {
    const receipt = capture(missing);
    assert.equal(receipt.status, 'UNAVAILABLE'); assert.equal(receipt.reason, 'REVIEW_COVERAGE_MISSING');
  }
  assert.deepEqual(verify(historical, outcome), { status: 'UNAVAILABLE', reason: 'NO_COMMITTED_COVERAGE_DIGEST' });
  assert.deepEqual(verify(undefined, outcome), { status: 'UNAVAILABLE', reason: 'NO_COMMITTED_COVERAGE_DIGEST' });
  assert.deepEqual(verify(capture(outcome), { status: 'UNVERIFIED' }), { status: 'UNAVAILABLE', reason: 'REVIEW_COVERAGE_MISSING' });
  assert.equal(createStopReviewCoverageReceipt({ owner, reviewStatus: 'PASS', outcome }).reason, 'ASSESSMENT_STATUS_MISMATCH');
  assert.equal(createStopReviewCoverageReceipt({ owner: { ...owner, runId: '' }, reviewStatus: outcome.status, outcome }).reason, 'INVALID_OWNER');
});

test('the native committed assessment retains its digest when later workspace rows change', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-coverage-commit-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const outcome = example(), identity = { ...owner, projectRoot }, manager = createNativeStopReviews();
  const receipt = capture(outcome, identity);
  await manager.schedule({ projectRoot, sessionId: identity.sessionId, sessionKey: identity.sessionKey, runId: identity.runId,
    enabledRevision: identity.enabledRevision, signal: new AbortController().signal, budgetMs: 5000,
    run: async ({ commit }) => {
      await commit({ reviewStatus: outcome.status, evaluationId: identity.evaluationId,
        reviewSummary: { evaluationId: identity.evaluationId, assessmentId: identity.assessmentId,
          status: outcome.status, reviewCoverageReceipt: receipt } });
      outcome.review.reviewCoverage.items[0].disposition = 'SOURCE_REVIEWED';
      return { reviewStatus: outcome.status, evaluationId: identity.evaluationId };
    } });
  const [record] = await manager.wait({ drain: true });
  assert.equal(record.reviewSummary.reviewCoverageReceipt.status, 'RECORDED');
  assert.deepEqual(verifyStopReviewCoverageReceipt({ record,
    owner: identity, reviewStatus: outcome.status, coverage: outcome.review.reviewCoverage }), {
    status: 'MISMATCH', reason: 'COVERAGE_CONTENT_MISMATCH' });
  assert.equal(record.reviewStatus, 'UNVERIFIED');
});

test('a native assessment that expires before commit cannot publish a late coverage digest', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-coverage-expiry-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const outcome = example(), manager = createNativeStopReviews(), identity = { ...owner, projectRoot };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await manager.schedule({ projectRoot, sessionId: identity.sessionId, sessionKey: identity.sessionKey, runId: identity.runId,
    signal: new AbortController().signal, budgetMs: 100,
    run: async ({ commit }) => {
      await gate;
      await commit({ reviewStatus: outcome.status, evaluationId: identity.evaluationId,
        reviewSummary: { reviewCoverageReceipt: capture(outcome, identity) } });
      return { reviewStatus: outcome.status, evaluationId: identity.evaluationId };
    } });
  const [expired] = await manager.wait();
  assert.equal(expired.reasonCode, 'REVIEW_DEADLINE_EXPIRED');
  assert.equal(expired.reviewSummary, undefined);
  release();
  const [settled] = await manager.wait({ drain: true });
  assert.equal(settled.reviewSummary, undefined);
  assert.equal(settled.evaluationId, null);
});

test('a restored, pending or foreign containing record cannot authenticate a matching digest', () => {
  const outcome = example(), receipt = capture(outcome), record = carrier(receipt);
  for (const fields of [{ reused: true }, { reasonCode: 'REVIEW_OWNER_LOST' }, { status: 'RUNNING' }, { assessmentCompletedAt: undefined }]) {
    assert.deepEqual(verifyStopReviewCoverageReceipt({ record: { ...record, ...fields }, owner, reviewStatus: outcome.status,
      coverage: outcome.review.reviewCoverage }), { status: 'UNAVAILABLE', reason: 'NO_FRESH_COMMITTED_CARRIER' });
  }
  for (const fields of [{ runId: 'other' }, { sessionId: 'other' }, { sessionKey: 'other' }, { evaluationId: 'other' }, { enabledRevision: 7 }]) {
    assert.deepEqual(verifyStopReviewCoverageReceipt({ record: { ...record, ...fields }, owner, reviewStatus: outcome.status,
      coverage: outcome.review.reviewCoverage }), { status: 'MISMATCH', reason: 'CARRIER_OWNER_MISMATCH' });
  }
  assert.deepEqual(verifyStopReviewCoverageReceipt({ owner, reviewStatus: outcome.status, coverage: outcome.review.reviewCoverage }), {
    status: 'UNAVAILABLE', reason: 'NO_FRESH_COMMITTED_CARRIER' });
});

test('the actual native manager restore cannot promote its old workspace digest to fresh authority', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-coverage-restore-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const outcome = example(), identity = { ...owner, projectRoot }, receipt = capture(outcome, identity);
  const options = { projectRoot, sessionId: identity.sessionId, sessionKey: identity.sessionKey, runId: identity.runId,
    enabledRevision: identity.enabledRevision, signal: new AbortController().signal, budgetMs: 5000 };
  const original = createNativeStopReviews();
  await original.schedule({ ...options, run: async ({ commit }) => {
    await commit({ reviewStatus: outcome.status, evaluationId: identity.evaluationId,
      reviewSummary: { status: outcome.status, evaluationId: identity.evaluationId, assessmentId: identity.assessmentId,
        reviewCoverageReceipt: receipt } });
    return { reviewStatus: outcome.status, evaluationId: identity.evaluationId };
  } });
  const [committed] = await original.wait({ drain: true });
  assert.equal(verifyStopReviewCoverageReceipt({ record: committed, owner: identity, reviewStatus: outcome.status,
    coverage: outcome.review.reviewCoverage }).status, 'MATCHED');
  const restored = createNativeStopReviews();
  await restored.schedule({ ...options, run: async () => assert.fail('restoration cannot launch a new assessment') });
  const [record] = await restored.wait({ drain: true });
  assert.equal(record.reused, true); assert.deepEqual(record.reviewSummary.reviewCoverageReceipt, receipt);
  assert.deepEqual(verifyStopReviewCoverageReceipt({ record, owner: identity, reviewStatus: outcome.status,
    coverage: outcome.review.reviewCoverage }), { status: 'UNAVAILABLE', reason: 'NO_FRESH_COMMITTED_CARRIER' });
});

test('the host scheduler retains the actual commit carrier across reload and clears it for a new run', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-coverage-host-carrier-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const outcome = example(), identity = { ...owner, projectRoot }, receipt = capture(outcome, identity);
  const scope = { agentId: 'main', projectRoot, sessionId: identity.sessionId, sessionKey: identity.sessionKey,
    scopeTaskId: identity.taskId, scopeFingerprint: identity.scopeFingerprint, controlRevision: identity.enabledRevision };
  const actual = { ...carrier(receipt, identity), feedback: 'excluded-feedback', privateReasoning: 'excluded-reasoning' };
  const options = { directoryFor: () => projectRoot, defaultDirectory: projectRoot, validate: async () => true,
    waitTerminal: async () => ({ status: 'ok' }), review: async () => actual, sendUser: async () => assert.fail('no user turn') };
  const manager = createPostRunDispatcher(options);
  t.after(() => manager.dispose());
  await manager.started(scope, identity.runId);
  await manager.candidate(scope, { runId: identity.runId, text: 'finished', reviewBudgetMs: 5000 }); await manager.drain();
  const committed = manager.snapshot(scope);
  assert.equal(committed.phase, 'IDLE');
  assert.equal(committed.reviewCoverageCarrier.assessmentCompletedAt, actual.assessmentCompletedAt);
  assert.equal(committed.reviewCoverageCarrier.feedback, undefined);
  assert.equal(committed.reviewCoverageCarrier.privateReasoning, undefined);
  const verifyHost = record => verifyStopReviewCoverageReceipt({ record, owner: identity, reviewStatus: outcome.status,
    coverage: outcome.review.reviewCoverage });
  assert.equal(verifyHost(committed).status, 'MATCHED');
  const restored = createPostRunDispatcher(options); t.after(() => restored.dispose());
  await restored.load();
  assert.deepEqual(restored.snapshot(scope).reviewCoverageCarrier, committed.reviewCoverageCarrier);
  assert.equal(verifyHost(restored.snapshot(scope)).status, 'MATCHED', 'a private host-store reload retains the original committed evidence');
  assert.equal(verifyHost({ ...committed, runId: 'another-run' }).reason, 'HOST_RECORD_OWNER_MISMATCH');
  assert.equal(verifyHost({ ...committed, reviewStatus: 'PASS' }).reason, 'HOST_RECORD_STATUS_MISMATCH');
  const poisoned = structuredClone(committed); poisoned.reviewCoverageCarrier.reused = true;
  assert.equal(verifyHost(poisoned).reason, 'NO_FRESH_COMMITTED_CARRIER');
  const switched = structuredClone(committed); switched.reviewSummary.reviewCoverageReceipt.coverageSha256 = '0'.repeat(64);
  assert.equal(verifyHost(switched).reason, 'HOST_RECORD_SUMMARY_MISMATCH');
  await manager.started(scope, 'next-run');
  assert.equal(manager.snapshot(scope).reviewCoverageCarrier, undefined, 'previous-run carrier cannot remain attached to a new run');
});

test('publication binds exact coverage bytes and evaluation identity rather than a mutable result label', () => {
  const outcome = example(), observer = createStopReviewCoveragePublicationObserver(owner);
  observer.onPublished({ ...owner, result: { stop: outcome } });
  const create = (identity = owner) => createStopReviewCoverageReceipt({ owner: identity, reviewStatus: outcome.status,
    outcome, publication: observer.token });
  assert.equal(create().status, 'RECORDED');
  assert.equal(create({ ...owner, evaluationId: 'changed-projection-id' }).reason, 'FRESH_PUBLICATION_NOT_OBSERVED');
  outcome.review.reviewCoverage.items[0].reason = 'changed after publication';
  assert.equal(create().reason, 'PUBLICATION_CONTENT_CHANGED');
  const foreign = createStopReviewCoveragePublicationObserver(owner);
  foreign.onPublished({ ...owner, result: { stop: { ...example(), taskId: 'other-task' } } });
  assert.equal(createStopReviewCoverageReceipt({ owner, reviewStatus: outcome.status, outcome,
    publication: foreign.token }).reason, 'FRESH_PUBLICATION_NOT_OBSERVED');
});

async function transactionFixture(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-coverage-publication-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot, sessionId: owner.sessionId, explicitTaskId: owner.taskId });
  const identity = { ...owner, projectRoot, taskId: task.taskId }, target = { projectRoot, taskId: task.taskId };
  const context = { assessmentId: identity.assessmentId, kind: 'native-stop', guard: decisionGuard(task) };
  const receipt = (observer, result) => {
    const outcome = result.stop ? { ...result, ...result.stop, decision: result.decision, feedback: result.feedback } : result;
    return createStopReviewCoverageReceipt({ owner: identity, reviewStatus: outcome.status, outcome, publication: observer?.token });
  };
  const calculate = async (outcome = example()) => {
    await withTaskState(target, state => { state.verification = { status: outcome.status, evaluationId: outcome.evaluationId }; });
    return { handled: true, decision: 'allow', stop: outcome };
  };
  return { identity, target, context, receipt, calculate };
}

test('same-run crash recovery without a new assessment cannot retain the earlier coverage carrier', async t => {
  const f = await transactionFixture(t), observer = createStopReviewCoveragePublicationObserver(f.identity);
  const result = await withTaskDecision({ ...f.target, context: { ...f.context, onPublished: observer.onPublished } }, f.calculate);
  const receipt = f.receipt(observer, result), coverage = result.stop.review.reviewCoverage;
  assert.equal(receipt.status, 'RECORDED');
  const native = createNativeStopReviews();
  await native.schedule({ ...f.identity, signal: new AbortController().signal, budgetMs: 5000, run: async ({ commit }) => {
    const value = { reviewStatus: result.stop.status, evaluationId: f.identity.evaluationId,
      reviewSummary: { status: result.stop.status, evaluationId: f.identity.evaluationId,
        assessmentId: f.identity.assessmentId, reviewCoverageReceipt: receipt } };
    await commit(value); return value;
  } });
  const [nativeRecord] = await native.wait({ drain: true });
  const hostDirectory = path.join(f.identity.projectRoot, 'private-host-checkpoint'); await fs.mkdir(hostDirectory);
  const scope = { agentId: 'main', projectRoot: f.identity.projectRoot, sessionId: f.identity.sessionId, sessionKey: f.identity.sessionKey,
    scopeTaskId: f.identity.taskId, scopeFingerprint: f.identity.scopeFingerprint, controlRevision: f.identity.enabledRevision };
  const options = { directoryFor: () => hostDirectory, defaultDirectory: hostDirectory, validate: async () => true,
    waitTerminal: async () => ({ status: 'ok' }), sendUser: async () => assert.fail('no user dispatch') };
  const first = createPostRunDispatcher({ ...options, review: async () => nativeRecord });
  t.after(() => first.dispose());
  let checkpoint, checkpointFile;
  const originalRename = fs.rename;
  fs.rename = async function (from, to) {
    const renamed = await originalRename.call(fs, from, to);
    if (!checkpoint && String(to).startsWith(hostDirectory + path.sep) && String(to).endsWith('.json')) {
      const bytes = await fs.readFile(to), value = JSON.parse(bytes);
      if (value.phase === 'REVIEWING' && value.reviewCoverageCarrier && value.candidate?.runId === f.identity.runId) {
        checkpoint = bytes; checkpointFile = to;
      }
    }
    return renamed;
  };
  try {
    await first.started(scope, f.identity.runId);
    await first.candidate(scope, { runId: f.identity.runId, text: 'controlled candidate', reviewBudgetMs: 10000 });
    await first.drain();
  } finally { fs.rename = originalRename; }
  assert.ok(checkpoint, 'capture the actual atomic host save after the carrier and before finish');
  const checked = record => verifyStopReviewCoverageReceipt({ record, owner: f.identity, reviewStatus: result.stop.status, coverage });
  assert.equal(checked(first.snapshot(scope)).status, 'MATCHED');
  await first.dispose();
  const saved = JSON.parse(checkpoint);
  assert.equal(saved.phase, 'REVIEWING'); assert.equal(saved.completedRuns.includes(f.identity.runId), false);
  await fs.writeFile(checkpointFile, checkpoint);
  let resumedReviews = 0;
  const recovered = createPostRunDispatcher({ ...options, review: async () => {
    resumedReviews++; return { reviewStatus: 'UNVERIFIED', reasonCode: 'RECOVERY_NO_NEW_ASSESSMENT' };
  } });
  t.after(() => recovered.dispose());
  await recovered.load(); await recovered.drain();
  const final = recovered.snapshot(scope);
  assert.equal(resumedReviews, 1); assert.equal(final.phase, 'IDLE'); assert.equal(final.runId, f.identity.runId);
  assert.equal(final.reviewStatus, 'UNVERIFIED'); assert.equal(final.reason, 'RECOVERY_NO_NEW_ASSESSMENT');
  assert.deepEqual(final.reviewSummary, saved.reviewSummary, 'the previous summary remains historical context');
  assert.equal(final.reviewCoverageCarrier, undefined, 'a new review admission clears the earlier proof even on the same run');
  assert.deepEqual(checked(final), { status: 'UNAVAILABLE', reason: 'NO_FRESH_COMMITTED_CARRIER' });
});

test('actual task-decision publication permits a receipt; the same-assessment cache cannot mint one', async t => {
  const f = await transactionFixture(t), first = createStopReviewCoveragePublicationObserver(f.identity);
  let calculations = 0;
  const result = await withTaskDecision({ ...f.target, context: { ...f.context, onPublished: first.onPublished } }, async () => {
    calculations++; return f.calculate();
  });
  assert.equal(f.receipt(first, result).status, 'RECORDED');
  const cachedObserver = createStopReviewCoveragePublicationObserver(f.identity);
  const cached = await withTaskDecision({ ...f.target, context: { ...f.context, onPublished: cachedObserver.onPublished } }, () => {
    calculations++; assert.fail('same assessment must return its existing result');
  });
  assert.deepEqual(cached, result); assert.equal(calculations, 1);
  assert.equal(cached.reused, undefined, 'no cache behavior or persisted result format was changed');
  assert.equal(f.receipt(cachedObserver, cached).reason, 'FRESH_PUBLICATION_NOT_OBSERVED');
  assert.equal(f.receipt(first, cached).reason, 'FRESH_PUBLICATION_NOT_OBSERVED', 'an earlier token cannot bind a reloaded coverage object');
  assert.equal(f.receipt({ token: JSON.parse(JSON.stringify(first.token)) }, result).reason, 'FRESH_PUBLICATION_NOT_OBSERVED');
});

test('a concurrently calculated duplicate cannot claim the winner publication', async t => {
  const f = await transactionFixture(t), observers = [0, 1].map(() => createStopReviewCoveragePublicationObserver(f.identity));
  let calculations = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const results = await Promise.all(observers.map(observer => withTaskDecision({ ...f.target,
    context: { ...f.context, onPublished: observer.onPublished } }, async () => {
    const result = await f.calculate(); if (++calculations === 2) release(); await gate; return result;
  })));
  assert.equal(calculations, 2, 'both callbacks really calculated before the duplicate publication check');
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results.map((result, i) => f.receipt(observers[i], result).status).sort(), ['RECORDED', 'UNAVAILABLE']);
});

test('failed, cancelled and unobserved task decisions cannot establish fresh publication', async t => {
  for (const kind of ['failed', 'cancelled', 'unobserved']) await t.test(kind, async t => {
    const f = await transactionFixture(t), observer = createStopReviewCoveragePublicationObserver(f.identity), controller = new AbortController();
    let calculated;
    const operation = withTaskDecision({ ...f.target, context: { ...f.context,
      ...(kind === 'unobserved' ? {} : { onPublished: observer.onPublished }),
      ...(kind === 'failed' ? { beforePublish: () => { throw new Error('test publication failed'); } } : {}),
      abortSignal: controller.signal } }, async () => {
      calculated = await f.calculate(); if (kind === 'cancelled') controller.abort(); return calculated;
    });
    if (kind === 'failed') await assert.rejects(operation, /test publication failed/);
    else {
      const result = await operation;
      if (kind === 'cancelled') assert.equal(result.stale, true);
    }
    assert.equal(f.receipt(observer, calculated).reason, 'FRESH_PUBLICATION_NOT_OBSERVED');
  });
});

test('observation failure cannot undo a published task decision or change cache replay', async t => {
  const f = await transactionFixture(t);
  const result = await withTaskDecision({ ...f.target, context: { ...f.context, onPublished: () => { throw new Error('observer only'); } } }, f.calculate);
  const task = await findTask({ projectRoot: f.identity.projectRoot, sessionId: f.identity.sessionId });
  assert.equal(task.assessments[f.identity.assessmentId].result.stop.status, 'UNVERIFIED');
  assert.deepEqual(await withTaskDecision({ ...f.target, context: f.context }, () => assert.fail('must replay')), result);
});
