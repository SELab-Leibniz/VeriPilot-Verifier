import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { listNativeRuns } from '../lib/openclaw/native-runs.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';

const clauses = ['Require a positive quantity.', 'Reject a blank description.'];
const scope = { stopClassification: 'TASK_COMPLETE', completionClaim: true };

async function fixture(t) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.population = { metrics: {}, reviewPolicy: { deviationOnly: true, metrics: { M16: true } } };
  delete f.input.request.fixedStopClassification;
  const snapshot = { entries: [{ type: 'user', uuid: 'user-original',
    message: { content: ['# SDD', ...clauses].join('\n') } }] };
  f.input.evidence.snapshot = snapshot;
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({
    projectRoot: f.root, snapshot, referenceTier: true,
  });
  return f;
}

async function extract({ brief, readAll, submit }) {
  await readAll();
  const file = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
  assert(file);
  const saved = await submit('append_original_checklist', { items: clauses.map((text, index) => ({
    metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text, path: file, lineStart: index + 2, lineEnd: index + 2,
  })) });
  assert.equal(saved.added, 2);
  return file;
}

const overflow = { meta: { error: { kind: 'context_overflow', message: 'Host context exhausted.' } } };

test('per-item Stop can recover before extraction without accepting unread or omitted items', async t => {
  const f = await fixture(t);
  f.input.request.population.reviewPolicy.deviationOnly = false;
  const result = await f.run(async worker => {
    const { brief, submit } = worker;
    const original = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
    if (!brief.contextReopened) {
      await worker.read(original);
      return;
    }
    const items = clauses.map((text, index) => ({
      metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text, path: original, lineStart: index + 2, lineEnd: index + 2,
    }));
    await assert.rejects(submit('set_original_checklist', { items }), { code: 'TASK_BASIS_UNREAD' });
    const state = await submit('review_history', { mode: 'state' });
    assert.ok(state.taskState.pendingCount > 0);
    assert.ok(!state.taskState.pendingBasis.some(row => row.path === original));
    for (const file of brief.task.basisFiles) if (file !== original) await worker.read(file);
    await submit('set_original_checklist', { items });
    const page = await submit('review_checklist', { ...scope, limit: 20 });
    assert.equal(page.items.length, 1);
    assert.equal(page.nextOffset, 1);
    assert.equal(Object.hasOwn(page, 'artifactCandidates'), false);
    await assert.rejects(submit('review_checklist', { offset: page.nextOffset }), { code: 'REVIEW_ITEM_INCOMPLETE' });
    await submit('submit_review', { taskId: page.items[0].taskId, verdict: 'UNVERIFIED', reason: 'No quantity implementation found.' });
    await assert.rejects(submit('finish_stop_review', { summary: 'Missing the last original.' }), { code: 'REVIEW_ITEM_INCOMPLETE' });
    const next = await submit('review_checklist', { offset: page.nextOffset, includeNavigation: true });
    assert.equal(next.nextOffset, null);
    assert.ok(Array.isArray(next.artifactCandidates));
    await submit('submit_review', { taskId: next.items[0].taskId, verdict: 'UNVERIFIED', reason: 'No description implementation found.' });
    await submit('finish_stop_review', { summary: 'Both original clauses were assessed.' });
  }, { nativeResult: (_params, brief) => brief.contextReopened ? undefined : overflow });
  assert.equal(result.reviewCompleted, true);
  assert.equal(f.calls.length, 2);
  await result.close();
});

test('one-shot per-item review keeps its verdict across overflow and rejects an omitted item', async t => {
  const f = await fixture(t);
  f.input.request.population.reviewPolicy.deviationOnly = false;
  const file = path.join(f.root, 'validation.mjs');
  await fs.writeFile(file, 'export const valid = (quantity, description) => quantity >= 0 && description.trim().length > 0;\n');
  let firstId;
  const result = await f.run(async ({ brief, readAll, submit }) => {
    if (!brief.contextReopened) {
      await readAll();
      const original = brief.task.basisFiles.find(p => path.basename(p).startsWith('user-original-'));
      await submit('set_original_checklist', { items: clauses.map((text, index) => ({
        metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text, path: original, lineStart: index + 2, lineEnd: index + 2,
      })) });
      const page = await submit('review_checklist', { ...scope, limit: 1 });
      firstId = page.items[0].taskId;
      await submit('submit_review', { taskId: firstId, verdict: 'DEVIATION',
        reason: 'The quantity check accepts zero.', citations: [{ path: file, start: 1, end: 1 }] });
      return;
    }
    const first = await submit('review_checklist', { limit: 1, includeNavigation: false });
    assert.equal(first.items[0].taskId, firstId);
    assert.equal(first.items[0].savedResult.judgement, 'DEVIATION');
    const next = await submit('review_checklist', { offset: first.nextOffset, limit: 1, includeNavigation: false });
    assert.equal(next.items[0].savedResult, null);
    await assert.rejects(submit('finish_stop_review', { summary: 'One verdict is still missing.' }), { code: 'REVIEW_ITEM_INCOMPLETE' });
    await submit('submit_review', { taskId: next.items[0].taskId, verdict: 'PASS',
      reason: 'The trimmed description must have positive length.', citations: [{ path: file, start: 1, end: 1 }] });
    await submit('finish_stop_review', { summary: 'Both original clauses were checked.' });
  }, { nativeResult: (_params, brief) => brief.contextReopened ? undefined : overflow });
  assert.equal(f.calls.length, 2);
  assert.equal(result.reviewCompleted, true);
  assert.deepEqual(result.result.metricObjectJudgements.map(row => row.judgement).sort(), ['DEVIATION', 'PASS']);
  await result.close();
});

test('a sealed Stop survives typed context overflow within the original budget and re-presents pending items', async t => {
  const f = await fixture(t);
  let firstId;
  const result = await f.run(async worker => {
    const { brief, params, submit, calls } = worker;
    if (calls.length === 1) {
      await extract(worker);
      await submit('seal_original_checklist', {});
      const first = await submit('review_checklist', { ...scope, limit: 1 });
      firstId = first.items[0].taskId;
      assert.equal(brief.contextReopened, undefined);
      return;
    }
    const [previous] = calls;
    assert.equal(brief.contextReopened, true);
    assert.notEqual(params.sessionId, previous.sessionId);
    assert.notEqual(params.sessionKey, previous.sessionKey);
    assert.notEqual(params.sessionFile, previous.sessionFile);
    assert(params.timeoutMs <= previous.timeoutMs);
    const prior = (await listNativeRuns(f.root, f.input.taskId)).find(record => record.runId === previous.runId);
    assert.equal(prior.status, 'SETTLED');
    const pending = await submit('review_checklist', { offset: 1, limit: 1 });
    assert.equal(pending.total, 2);
    await assert.rejects(submit('finish_stop_review', { summary: 'Only saw the later item.' }), { code: 'REVIEW_ITEM_INCOMPLETE' });
    const first = await submit('review_checklist', { limit: 1 });
    assert.equal(first.items[0].taskId, firstId);
    await submit('finish_stop_review', { summary: 'Checked the original checklist in the renewed host context.' });
  }, { nativeResult: (_params, brief) => brief.contextReopened ? undefined : overflow });
  assert.equal(f.calls.length, 2);
  assert.equal(result.reviewCompleted, true);
  assert.equal(result.result.sourceCoverage.complete, true);
  const protocol = JSON.parse(await fs.readFile(path.join(result.artifacts, 'result.json'), 'utf8'));
  assert.equal(protocol.attempts, 2);
  await result.close();
});

test('Stop leaves ordinary native errors in their original scope, even with a sealed checklist', async t => {
  const f = await fixture(t);
  const result = await f.run(async worker => {
    await extract(worker);
    await worker.submit('seal_original_checklist', {});
    await worker.submit('review_checklist', { ...scope, limit: 1 });
  }, { nativeResult: () => ({ meta: { error: { kind: 'incomplete_turn', message: 'An error mentions context overflow.' } } }) });
  assert.equal(f.calls.length, 1);
  assert.equal(result.reviewCompleted, false);
  await result.close();
});

test('a second native context overflow settles the same Stop with its remaining scope open', async t => {
  const f = await fixture(t);
  const result = await f.run(async worker => {
    if (worker.calls.length === 1) {
      await extract(worker);
      await worker.submit('seal_original_checklist', {});
      await worker.submit('review_checklist', { ...scope, limit: 1 });
    } else {
      assert.equal(worker.brief.contextReopened, true);
      await worker.submit('review_checklist', { limit: 1 });
    }
  }, { nativeResult: () => overflow });
  assert.equal(f.calls.length, 2);
  assert.equal(result.reviewCompleted, false);
  assert.equal(result.result.sourceCoverage.checklistSubmitted, true);
  assert.equal(result.result.unverifiedItems.filter(item => item.reviewState === 'UNREVIEWED').length, 2);
  await result.close();
});

test('deviation-only Stop does not reopen an unsealed checklist or a changed original', async t => {
  for (const mode of ['unsealed', 'changed']) await t.test(mode, async t => {
    const f = await fixture(t);
    await assert.rejects(f.run(async worker => {
      const file = await extract(worker);
      if (mode === 'changed') {
        await worker.submit('seal_original_checklist', {});
        await fs.appendFile(file, '\nNew requirement.');
      }
    }, { nativeResult: () => overflow }));
    assert.equal(f.calls.length, 1);
  });
});
