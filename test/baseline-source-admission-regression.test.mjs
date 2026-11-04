import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sharedBasisFixture, operation } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { applyGroundTruthDelta, freezeGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { ensureTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { verifyBaselineCoverageProof, BASELINE_COVERAGE_PROTOCOL } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

test('onboarding-frozen summarized claims reject old-source ADD before save and use full NO_CHANGE plus actual current-protocol audit in the original allowance', async t => {
  for (const initialMode of ['draft', 'compact', null]) {
    const f = await sharedBasisFixture(t, { wireMode: initialMode });
    const task = await ensureTask({ projectRoot: f.root, sessionId: 'basis-session' });
    await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { state.control ??= {}; });
    // Use the real ledger/freeze path, like onboarding; the retained wording is
    // a summary, deliberately not the whole original required by USER exclude.
    await applyGroundTruthDelta({ projectRoot: f.root, taskId: task.taskId,
      delta: { operations: [{ ...operation(), text: 'Keep the requested behavior.' }] },
      sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE', contentDigest: sha256('Preserve the requested feature.') }] });
    await freezeGroundTruth({ projectRoot: f.root, taskId: task.taskId });
    const original = await f.truth(), existingId = original.claims[0].claimId;
    assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
    const invocations = []; let reads, deadline, rejected = 0;
    f.state.replayBaseline = async ({ params, call, readAll }) => {
      const prompt = JSON.parse(params.prompt); invocations.push({ runId: params.runId, sessionId: params.sessionId });
      assert.equal(prompt.admission.mode, 'READ_ONLY_RECONCILIATION');
      assert.deepEqual(prompt.admission.eligibleUserRefs, []);
      assert.equal(prompt.admission.currentClaims[0].claimId, existingId);
      const state = async () => JSON.parse((await call('review_history', { mode: 'state' })).content[0].text).taskState;
      if (initialMode === null) {
        assert.equal(prompt.wireMode, 'full');
        await readAll();
        await call('finish_baseline', { batchIds: [], taskClassification: 'NO_CHANGE', summary: 'Verify the existing obligations without new authority.' });
        return;
      }
      if (prompt.wireMode !== 'full') {
        await readAll(); const before = await state(); reads = before.metrics.readBytes; deadline = before.deadlineAt;
        const { source: _source, ...oldOperation } = operation();
        const value = initialMode === 'draft'
          ? { batchId: 1, operations: [{ ...oldOperation, sourceFrom: { unitId: 'S0L1' } }] }
          : { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
            applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', sourceIndex: 0 },
            outcomes: [{ name: 'Keep the existing requested feature.', lines: [1, 1] }] };
        await assert.rejects(call('save_baseline_batch', value), error => {
          assert.equal(error.code, 'BASELINE_ADMISSION_INVALID');
          assert.equal(error.baselineValidation.reason, 'PROCESSED_OR_AMBIGUOUS_USER_SOURCE');
          assert.deepEqual(error.baselineValidation.admission.eligibleUserRefs, []);
          assert(error.message.includes('"eligibleUserRefs":[]') && error.message.includes(existingId), 'Native Error.message carries the actual program navigation');
          assert.match(error.message, /did not create an owned draft.*same unsaved batchId/u);
          assert.match(error.baselineValidation.repair, /full mode.*NO_CHANGE/u); rejected++; return true;
        });
        const after = await state();
        assert.equal(after.nextBatchId, 1); assert.equal(after.repairs, before.repairs + 1);
        assert.equal(after.externalRepairs, 0); assert.equal(after.auditCalls, 0);
        assert.equal(after.deadlineAt, deadline); assert.equal(after.metrics.readBytes, reads);
        assert.notEqual(after.phase, 'CANDIDATE_COMPLETE');
        const directory = path.resolve(params.cwd, '../candidates-0');
        await assert.rejects(fs.access(path.join(directory, 'batch-1.json')), { code: 'ENOENT' });
        await assert.rejects(fs.access(path.join(directory, 'finish.json')), { code: 'ENOENT' });
        if (initialMode === 'draft') {
          await assert.rejects(call('save_baseline_batch', { batchId: 1, exclude: [{ units: ['S0L1'], claimIds: [existingId],
            reason: 'A summary is not the exact whole original.' }] }), error => error.code === 'BASELINE_SCOPE_INVALID'
              && error.baselineValidation.reason === 'WHOLE_ORIGINAL_NOT_PRESENT');
        }
        await call('save_baseline_batch', { batchId: 1, fullTextReason: 'Read-only reconciliation of summarized existing claims requires the existing full NO_CHANGE route.' });
        return; // Existing mode switch, same actor/session and original budget.
      }
      const before = await state(); assert.equal(before.deadlineAt, deadline); assert.equal(before.metrics.readBytes, reads);
      assert.equal(before.nextBatchId, 1); assert.equal(before.generation, 0);
      await call('finish_baseline', { batchIds: [], taskClassification: 'NO_CHANGE', summary: 'Preserve the summarized ledger; independently audit all complete originals and current claims.' });
    };
    await f.refresh();
    assert.equal(rejected, initialMode === null ? 0 : 1); assert.equal(f.globals().length, 1); assert.equal(f.audits().length, 1);
    const expectedInvocations = initialMode === null ? 1 : 2;
    assert.equal(invocations.length, expectedInvocations); assert.equal(new Set(invocations.map(x => x.sessionId)).size, 1);
    assert.equal(new Set(invocations.map(x => x.runId)).size, expectedInvocations);
    const current = await f.truth(); assert.equal(current.version, original.version); assert.equal(current.digest, original.digest);
    assert.deepEqual(current.claims, original.claims);
    const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
    const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: current });
    assert.equal(bundle.protocol, BASELINE_COVERAGE_PROTOCOL);
    assert.equal(bundle.input.finish.receipt.status, 'NO_CHANGE'); assert.deepEqual(bundle.input.delta.operations, []);
    assert.equal(bundle.budget.externalRepairs, 0); assert.equal(bundle.budget.auditCalls, 1);
    assert.equal(bundle.budget.repairs, initialMode === 'draft' ? 2 : initialMode === 'compact' ? 1 : 0);
    assert.equal(bundle.budget.maxRepairs, 3);
    assert.equal(bundle.budget.maxTurns, 200); assert(bundle.budget.turns <= 200);
  }
});
