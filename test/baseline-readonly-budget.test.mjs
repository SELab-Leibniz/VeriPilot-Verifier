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
