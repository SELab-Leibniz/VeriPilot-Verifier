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
import { runtimeFailureDiagnostics } from './helpers/runtime-failure-diagnostics.mjs';

for (const poison of ['none', 'turn', 'repair']) test(`successful exact-cap candidate: ${poison} later poison`, async t => {
  const { f, counts, stop, audits, rollback } = await prepared(t), budgets = [];
  f.state.coverageSubmissions = []; const launches = [];
  f.state.coverageLaunch = params => {
    const startedAt = Date.now(), originalDeadlineAt = f.state.auditInputs.at(-1)?.budgetLimits?.deadlineAt;
    launches.push({ timeoutMs: params.timeoutMs, startedAt, originalDeadlineAt,
      originalBudgetRemainingMs: originalDeadlineAt - startedAt });
  };
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
  if (counts.actors !== 1 || audits() !== 1 || counts.graphs !== (poison === 'none' ? 2 : 1)
    || result.stop.status !== (poison === 'none' ? 'NO_DEVIATION_FOUND' : 'UNVERIFIED')) {
    let budget;
    try {
      const view = counts.handle.baselineTask.budget.verifyClosed();
      budget = { turns: view.turns, maxTurns: view.maxTurns, repairs: view.repairs, maxRepairs: view.maxRepairs,
        deadlineExpiredAtDiagnostic: Date.now() >= view.deadlineAt };
    } catch (error) { budget = { code: /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code ?? '') ? error.code : 'UNCLASSIFIED' }; }
    t.diagnostic(JSON.stringify({ fixturePhase: 'EXACT_CAP_GRAPH_PREPARATION_OR_RESULT',
      actorCallbacks: counts.actors, graphPreparationCallbacks: counts.graphs, auditCalls: audits(), budgetAtDiagnostic: budget,
      ...await runtimeFailureDiagnostics({ root: f.root, calls: f.calls, submissions: f.state.coverageSubmissions, launches }) }));
  }
  assert.equal(counts.actors, 1); assert.equal(audits(), 1);
  if (poison === 'none') {
    assert.equal(result.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(result)); assert.equal(counts.graphs, 2);
    assert.deepEqual(budgets[1], budgets[0]);
  } else {
    assert.equal(result.stop.status, 'UNVERIFIED'); assert.equal(counts.graphs, 1); await rollback();
  }
});
