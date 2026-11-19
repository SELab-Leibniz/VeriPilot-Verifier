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
