import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sharedBasisFixture as fixture, user, operation } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { withTaskState, withTaskDecision, decisionGuard, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { outsideDecision, decisionScope } from '../lib/runtime-v2/decision-scope.mjs';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { listNativeRuns, recordNativeRun } from '../lib/openclaw/native-runs.mjs';

import { transient, budgetView, prepared, useLastTurnAndRepair } from './helpers/baseline-readonly-fixture.mjs';

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
