import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sharedBasisFixture as fixture, user, operation } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { withTaskState, withTaskDecision, decisionGuard, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { outsideDecision, decisionScope } from '../lib/runtime-v2/decision-scope.mjs';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { listNativeRuns, recordNativeRun } from '../lib/openclaw/native-runs.mjs';

const transient = () => Object.assign(new Error('Controlled retryable graph transport failure.'), { reviewerRuntimeFailure: true });
const budgetView = handle => {
  const { journal, ...view } = handle.baselineTask.budget.verifyClosed(); return view;
};
async function prepared(t) {
  const f = await fixture(t); f.state.useNativeGraph = true; await f.select();
  const task = await f.task();
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => {
    delete state.groundTruth.sharedBasis;
    for (const watcher of Object.values(state.watchers)) watcher.status = 'PASS';
  });
  await fs.rm(await f.graphFile());
  const revised = user('U2'); revised.message.content = 'Preserve the revised requested feature.';
  await fs.appendFile(f.transcript, JSON.stringify(revised) + '\n');
  f.state.forceOperations = true; f.state.deltaOperation = { ...operation('transcript:U2#L1-L1'), text: revised.message.content };
  const counts = { actors: 0, graphs: 0, handle: null }, auditStart = f.audits().length;
  const cursors = structuredClone((await f.task()).groundTruth.sourceCursors);
  f.state.afterBaseline = async handle => { counts.actors++; counts.handle = handle; };
  const stop = options => f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' }, options ?? {
    assessmentContext: { assessmentId: 'same-assessment-readonly', guard: decisionGuard(task),
      deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs } });
  const rollback = async () => {
    assert.equal((await f.truth()).version, 1);
    assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
    assert.deepEqual((await f.task()).groundTruth.sourceCursors, cursors);
    assert.equal(await readJson(await f.graphFile()), null);
  };
  return { f, counts, stop, rollback, audits: () => f.audits().length - auditStart };
}

test('an actual dispatched graph failure reuses one actor/audit and the unchanged original budget', async t => {
  const { f, counts, stop, audits } = await prepared(t), budgets = [];
  f.state.beforeGraph = async () => {
    assert.equal((await f.truth()).version, 2); assert.equal((await outsideDecision(f.truth)).version, 1);
    budgets.push(budgetView(counts.handle));
  };
  f.state.graphNativeScript = async ({ result }) => { if (++counts.graphs === 1) throw transient(); return result; };
  const result = await stop();
  assert.equal(result.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(result));
  assert.equal(counts.actors, 1); assert.equal(audits(), 1); assert.equal(counts.graphs, 2);
  assert.deepEqual(budgets[1], budgets[0]);
  assert.equal((await f.task()).groundTruth.sharedBasis.proof.runId, path.basename(counts.handle.artifacts));
  assert.equal((await f.task()).stop.infrastructureTotalFailures, 1);
});

test('repeated graph failures stay within the original three preparations and never reopen the actor pool', async t => {
  const { f, counts, stop, audits, rollback } = await prepared(t);
  f.state.beforeGraph = async () => { counts.graphs++; throw transient(); };
  const result = await stop();
  assert.equal(result.stop.status, 'UNVERIFIED'); assert.equal(result.stop.infrastructureAttempt, 3);
  assert.equal(counts.graphs, 3); assert.equal(counts.actors, 1); assert.equal(audits(), 1);
  assert.equal((await f.task()).stop.correctionAttempts, 0); await rollback();
});

// Spend the real original callbacks/tools, rather than lowering production limits or editing saved counters.
function useLastTurnAndRepair(f, counts) {
  f.state.beforeBaselineSave = async ({ call }) => {
    for (let i = 0; i < 3; i++) await assert.rejects(call('finish_baseline', {
      batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Controlled incomplete finish before the actual batch.' }), { code: 'BASELINE_INCOMPLETE' });
  };
  f.state.coverageMutation = async ({ params }) => {
    const budget = counts.handle.baselineTask.budget;
    const initial = budget.snapshot(); assert.equal(initial.maxTurns, 200); assert.equal(initial.maxRepairs, 3);
    while (budget.snapshot().turns < initial.maxTurns - 1) {
      params.onAssistantMessageStart();
      await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Controlled original-turn boundary.' }] } }) + '\n');
    }
  };
}

for (const poison of ['none', 'turn', 'repair']) test(`successful exact-cap candidate: ${poison} later poison`, async t => {
  const { f, counts, stop, audits, rollback } = await prepared(t), budgets = [];
  useLastTurnAndRepair(f, counts);
  f.state.beforeGraph = async () => {
    const budget = counts.handle.baselineTask.budget, view = budgetView(counts.handle);
    budgets.push(view); assert.equal(view.turns, view.maxTurns); assert.equal(view.repairs, view.maxRepairs);
    if (++counts.graphs === 1) {
      if (poison === 'turn') assert.throws(() => budget.consumeTurn('extractor'), { code: 'TURN_LIMIT' });
      if (poison === 'repair') await assert.rejects(counts.handle.followUp({ prompt: 'Attempting a forbidden fourth repair.' }), { code: 'BASELINE_REPAIR_LIMIT' });
      throw transient();
    }
  };
  const result = await stop();
  assert.equal(counts.actors, 1); assert.equal(audits(), 1);
  if (poison === 'none') {
    assert.equal(result.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(result)); assert.equal(counts.graphs, 2);
    assert.deepEqual(budgets[1], budgets[0]);
  } else {
    assert.equal(result.stop.status, 'UNVERIFIED'); assert.equal(counts.graphs, 1); await rollback();
  }
});

for (const invalid of ['journal', 'actor-pending', 'auditor-missing', 'source', 'model']) test(`read-only reuse rejects changed ${invalid} without a new actor or auditor`, async t => {
  const { f, counts, stop, audits, rollback } = await prepared(t);
  let modelIdentityChange = null;
  f.state.beforeGraph = async () => {
    counts.graphs++;
    if (invalid === 'journal') await fs.appendFile(counts.handle.baselineTask.budget.verifyClosed().journal.path, '{}\n');
    else if (invalid === 'source') await fs.appendFile(f.skillFile, '\nA new original duty.\n');
    else if (invalid === 'model') {
      const reviewer = f.plan.runtimeV2.reviewers.groundTruthExtractor;
      const before = f.factory.reviewCacheIdentity(reviewer), changed = structuredClone(f.api.config);
      changed.models.providers.fixture.baseUrl = 'https://changed-model-backend.invalid/v1';
      // Replace the real mutable host configuration; the compiled reviewer remains frozen.
      assert.doesNotThrow(() => { f.api.config = changed; });
      assert.equal(f.api.config.models.providers.fixture.baseUrl, 'https://changed-model-backend.invalid/v1');
      const after = f.factory.reviewCacheIdentity(reviewer);
      assert.notEqual(after, before, 'The actual host model/backend identity must change before testing rejection');
      modelIdentityChange = { before, after };
    }
    else {
      const records = await listNativeRuns(f.root, (await f.task()).taskId);
      const last = f.state.auditInputs.at(-1);
      const own = records.filter(record => last.extractorSettlement.runIds.includes(record.runId));
      assert(own.length > 0);
      if (invalid === 'actor-pending') await recordNativeRun(f.root, { ...own[0], status: 'DISPATCH_COMMITTED' });
      else {
        const record = records.find(row => row.sessionId !== last.extractorSettlement.sessionId
          && row.startedAt >= own[0].startedAt);
        assert(record, 'The actual independently dispatched auditor record must exist before tampering');
        await fs.rm(path.join(f.root, '.runtime-correction/openclaw/native-runs', sha256(record.taskId), `${record.runId}.json`));
      }
    }
    throw transient();
  };
  const result = await stop();
  assert.equal(result.stop.status, 'UNVERIFIED'); assert.equal(counts.graphs, 1);
  if (invalid === 'model') {
    assert(modelIdentityChange, 'The model mutation must complete, rather than failing with TypeError');
    assert.notEqual(modelIdentityChange.before, modelIdentityChange.after);
    assert.equal(result.stop.reasonCode, 'BASELINE_INPUT_CHANGED', JSON.stringify(result));
    assert.doesNotMatch(result.stop.error ?? '', /TypeError|read.only|Cannot assign/u);
  }
  assert.equal(counts.actors, 1); assert.equal(audits(), 1); await rollback();
});

for (const changed of ['assessment', 'deadline', 'cancel']) test(`a changed parent ${changed} cannot authorize the completed candidate`, async t => {
  const { f, counts, stop, audits, rollback } = await prepared(t), task = await f.task();
  const controller = new AbortController(); f.factory.reviewAbortSignal = controller.signal;
  const result = await withTaskDecision({ projectRoot: f.root, taskId: task.taskId, context: {
    assessmentId: `parent-${changed}`, guard: decisionGuard(task), deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs,
  } }, async () => {
    const parent = decisionScope.getStore();
    f.state.beforeGraph = async () => {
      counts.graphs++;
      if (changed === 'assessment') parent.context.assessmentId += '-changed';
      else if (changed === 'deadline') parent.context.deadlineAt = Date.now() - 1;
      else controller.abort(Object.assign(new Error('Controlled parent cancellation'), { code: 'STOP_CANCELLED' }));
      throw transient();
    };
    return stop({});
  });
  assert(result.stale === true || result.stop?.status === 'UNVERIFIED', JSON.stringify(result));
  assert.equal(counts.actors, 1); assert.equal(audits(), 1); assert.equal(counts.graphs, 1); await rollback();
});

test('the closed adapter rejects a foreign scope and changed effective plan without reopening model work', async t => {
  const { f, counts, stop, audits } = await prepared(t);
  f.state.beforeGraph = async () => { throw transient(); }; await stop();
  const input = f.state.auditInputs.at(-1), handle = counts.handle, before = budgetView(handle);
  await assert.rejects(handle.baselineTask.reuseCompleted({ plan: input.plan, scopeDigest: 'another-assessment', assertCurrent: async () => {} }), { code: 'BASELINE_INPUT_CHANGED' });
  const changed = structuredClone(input.plan); changed.current.claims[0].text += ' changed';
  await assert.rejects(handle.baselineTask.reuseCompleted({ plan: changed, scopeDigest: input.scopeDigest, assertCurrent: async () => {} }), { code: 'BASELINE_INPUT_CHANGED' });
  assert.deepEqual(budgetView(handle), before); assert.equal(counts.actors, 1); assert.equal(audits(), 1);
});

test('an intervening formal baseline version rejects reuse and cannot publish the discarded candidate', async t => {
  const { f, counts, stop, audits } = await prepared(t);
  f.state.beforeGraph = async () => {
    counts.graphs++;
    const truth = await outsideDecision(f.truth), task = await f.task();
    truth.version++;
    await fs.writeFile(path.join(taskDirectory(f.root, task.taskId), 'ground-truth/current.json'), JSON.stringify(truth));
    await outsideDecision(() => withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { state.groundTruth.version = truth.version; }));
    throw transient();
  };
  const result = await stop();
  assert(result.stale === true || result.stop?.status === 'UNVERIFIED', JSON.stringify(result));
  assert.equal(counts.actors, 1); assert.equal(audits(), 1); assert.equal(counts.graphs, 1);
  assert.equal((await f.truth()).claims.some(claim => claim.source?.ref?.startsWith('transcript:U2')), false);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined); assert.equal(await readJson(await f.graphFile()), null);
});
