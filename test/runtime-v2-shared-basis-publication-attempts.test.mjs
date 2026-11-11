import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { skillGraphQuoteCandidate as skillGraphCandidate } from './helpers/skill-source-interpretation.mjs';
import { applyGroundTruthDelta } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { taskDirectory, withTaskState, withTaskDecision, decisionGuard, appendTaskJournal } from '../lib/runtime-v2/task-store.mjs';
import { outsideDecision, decisionScope } from '../lib/runtime-v2/decision-scope.mjs';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { sharedBasisFixture as fixture, user, operation } from './helpers/runtime-v2-shared-basis-fixture.mjs';

// Deliberate library-level parent/child interleaving. This establishes the
// ownership contract; it does not claim this scheduling is production-reachable.
test('actual alignment preserves parent candidate/audit interleavings and reports candidate conflicts', async t => {
  for (const outcome of ['parent-candidate', 'parent-audit-only', 'child-failure']) await t.test(outcome, async t => {
    const f = await fixture(t); await f.select(); const task = await f.task();
    await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { delete state.groundTruth.sharedBasis; });
    await fs.rm(await f.graphFile()); let parent;
    f.state.beforeGraph = async () => {
      await appendTaskJournal(f.root, task.taskId, { type: 'CHILD_GRAPH_VISITED' });
      await decisionScope.run(parent, async () => {
        if (outcome !== 'parent-audit-only') await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { state.parentObservation = 'kept'; });
        for (let i = 0; i < 20; i++) await appendTaskJournal(f.root, task.taskId, { type: 'PARENT_INTERLEAVING_FACT', i });
      });
      if (outcome === 'child-failure') throw new Error('Injected graph transport failure after parent growth.');
    };
    const result = await withTaskDecision({ projectRoot: f.root, taskId: task.taskId,
      context: { assessmentId: 'parent-interleaving', kind: 'hook', guard: decisionGuard(await f.task()) } }, async () => {
      parent = decisionScope.getStore(); return f.select();
    });
    const state = await f.task(), rows = (await fs.readFile(path.join(taskDirectory(f.root, task.taskId), 'journal/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.type === 'PARENT_INTERLEAVING_FACT').length, 20);
    if (outcome === 'parent-audit-only') {
      assert.equal(result.watcher.status, 'ACTIVE'); assert(state.groundTruth.sharedBasis); assert(await readJson(await f.graphFile()));
      assert.equal(rows.filter(row => row.type === 'CHILD_GRAPH_VISITED').length, 1);
    } else {
      assert.equal(state.parentObservation, 'kept'); assert.equal(result.reason, 'SKILL_WATCH_NOT_ESTABLISHED');
      assert.equal(state.groundTruth.sharedBasis, undefined); assert.equal(await readJson(await f.graphFile()), null);
      if (outcome === 'parent-candidate') assert.equal(result.reasonCode, 'DECISION_ATTEMPT_CONFLICT');
      else assert.equal(rows.filter(row => row.type === 'GROUND_TRUTH_REFRESH_FAILED' && row.error === 'Injected graph transport failure after parent growth.').length, 1);
    }
  });
});

test('an ended actual alignment cannot stage delayed task writes while its parent is still active', async t => {
  for (const end of ['accepted', 'failed', 'cancelled']) await t.test(end, async t => {
    const f = await fixture(t); await f.select(); const task = await f.task();
    await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { delete state.groundTruth.sharedBasis; });
    await fs.rm(await f.graphFile()); const controller = new AbortController(); let late;
    f.factory.reviewAbortSignal = controller.signal;
    f.state.beforeGraph = async () => {
      const scope = decisionScope.getStore();
      late = () => decisionScope.run(scope, () => withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { state.lateAlignmentWrite = true; }));
      if (end === 'failed') throw new Error('The alignment attempt failed.');
      if (end === 'cancelled') controller.abort(new Error('Cancelled alignment owner.'));
    };
    await withTaskDecision({ projectRoot: f.root, taskId: task.taskId,
      context: { assessmentId: 'late-alignment-write', kind: 'hook', guard: decisionGuard(await f.task()) } }, async () => {
      const result = await f.select();
      await assert.rejects(late(), { code: 'DECISION_ATTEMPT_CLOSED' });
      return result;
    });
    assert.equal((await f.task()).lateAlignmentWrite, undefined);
  });
});

test('a post-application graph transport failure rolls back its whole attempt before a genuine bounded retry', async t => {
  for (const denyPublication of [false, true]) await t.test(denyPublication ? 'prior publication guard remains mandatory' : 'recovered attempt can publish', async t => {
  const f = await fixture(t); f.state.useNativeGraph = true; await f.select(); const original = await f.task();
  await withTaskState({ projectRoot: f.root, taskId: original.taskId }, state => {
    delete state.groundTruth.sharedBasis;
    for (const watcher of Object.values(state.watchers)) watcher.status = 'PASS';
  });
  await fs.rm(await f.graphFile());
  const revised = user('U2'); revised.message.content = 'Preserve the revised requested feature.';
  await fs.appendFile(f.transcript, JSON.stringify(revised) + '\n');
  f.state.forceOperations = true; f.state.deltaOperation = { ...operation('transcript:U2#L1-L1'), text: revised.message.content };
  const runs = [], budgets = []; let graphs = 0, baselineHandle;
  const auditsBefore = f.audits().length;
  f.state.afterBaseline = async handle => {
    baselineHandle = handle;
    runs.push(path.basename(handle.artifacts));
    assert.equal((await f.truth()).version, 1, 'each extraction starts from the accepted parent baseline');
    assert.equal((await f.task()).groundTruth.sharedBasis, undefined, 'failed coverage cannot leak into the retry');
    assert.equal(await readJson(await f.graphFile()), null);
  };
  f.state.beforeGraph = async () => {
    const { turns, repairs, auditCalls, externalRepairs, generation, maxTurns, maxRepairs } = baselineHandle.baselineTask.budget.verifyClosed();
    budgets.push({ turns, repairs, auditCalls, externalRepairs, generation, maxTurns, maxRepairs });
    assert.equal((await f.truth()).version, 2, 'the graph receives the newly staged delta');
    assert.equal((await outsideDecision(f.truth)).version, 1, 'the new baseline is not published before graph validation');
    if (++graphs === 1) throw Object.assign(new Error('Transient graph transport failure.'), { reviewerRuntimeFailure: true });
  };
  const result = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' }, {
    assessmentContext: { assessmentId: 'retry-with-prior-guard', guard: decisionGuard(await f.task()),
      deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs, evidenceMatches: async () => !denyPublication } });
  assert.equal(graphs, 2); assert.equal(runs.length, 1, 'Retry reuses the completed original candidate without a new actor');
  assert.equal(f.audits().length - auditsBefore, 1, 'The independent auditor is not dispatched again');
  assert.deepEqual(budgets[1], budgets[0], 'Read-only reuse spends no additional baseline allowance');
  if (denyPublication) {
    assert.equal(result.stale, true); assert.equal(result.status, 'UNVERIFIED');
    assert.equal((await f.truth()).version, 1); assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
    assert.equal(await readJson(await f.graphFile()), null);
    return;
  }
  assert.equal(result.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(result));
  const task = await f.task(); assert.equal((await f.truth()).version, 2);
  assert.equal(task.groundTruth.sharedBasis.proof.runId, runs[0], 'the original acknowledged, independently audited worker certifies the fresh guarded application');
  assert.equal(task.stop.infrastructureTotalFailures, 1); assert.equal(task.stop.correctionAttempts, 0);
  assert(await readJson(await f.graphFile()));
  });
});

