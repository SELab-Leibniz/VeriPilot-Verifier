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
