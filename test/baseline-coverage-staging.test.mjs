import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sharedBasisFixture as createSharedBasisFixture, operation, user } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { scriptedCoverageReport, scriptedSourceInventory } from './helpers/baseline-coverage-native.mjs';
import { verifyBaselineCoverageProof, coverageIdentity, validateBaselineAuditReport, validateBaselineSourceInventory, baselineAuditSourceUnits, decodeBaselineAuditView, BASELINE_COVERAGE_INSTRUCTIONS, BASELINE_AUDIT_VIEW_PROTOCOL } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { registerCitation } from '../lib/review-task/evidence-utils.mjs';
import { sourcePage } from '../lib/review-task/source-tools.mjs';
import { planGroundTruthDelta, groundTruthPlanDigest, applyGroundTruthDelta, freezeGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { ObservationJournal } from '../lib/review-task/observation-journal.mjs';
import { createBaselineWorker, BASELINE_EXTRACTION_PROTOCOL } from '../lib/review-task/baseline-task.mjs';
import { sourceUnits } from '../lib/review-task/baseline-selection.mjs';
import { withTaskState, ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { STOP_TASK_LIMITS } from '../lib/review-task/stop-policy.mjs';
import { listNativeRuns } from '../lib/openclaw/native-runs.mjs';
import { coveredImplementationClaims } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { TASK_SCOPE_INSTRUCTIONS } from '../lib/runtime-v2/ground-truth-provenance.mjs';

import { sharedBasisFixture, scratch, refreshCapturingAuditFailure, twoClaimFixture, missingReadReport, nativeAuditAttempt } from './helpers/baseline-coverage-fixture.mjs';

test('staged audit uses complete acknowledged units and only a final verified report publishes', async t => {
  const f = await twoClaimFixture(t, true);
  f.state.coverageStagedInventory = { replaceFirst: true, tryWrongDisposition: true, repeatIdentity: true, async beforeSeal({ params, tools, request }) {
    const denied = await nativeAuditAttempt(params, tools, 'source_read', { path: request.phaseTwoManifest, offset: 1 }, 'before-seal');
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /genuine appended ACK/u);
  } };
  f.state.coverageStaged = { tryIncomplete: true, tryWrongDuty: true, replaceFirst: true, compactDependency: true, compactUnitAnchor: true };
  await f.refresh();
  const truth = await f.truth(), proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth });
  assert.equal(truth.version, 1);
  assert.equal(bundle.inventory.record.sectionControl.action, 'seal_units');
  assert.equal(bundle.inventory.record.inventory.sources[0].units[0].obligations[0].reason, 'Explicit replacement of the first source-only duty reason.');
  assert.equal(bundle.finish.record.sectionControl.action, 'finish_sections');
  assert.equal(bundle.report.sources[0].mappings[0].reason, 'Explicit replacement of one staged section.');
  assert.equal(Object.hasOwn(bundle.report.sources[0].mappings[0], 'supportMode'), false);
  assert.deepEqual(bundle.report.sources[0].mappings[0].dependencyUnitIds, [bundle.report.sources.flatMap(row => row.unitIds)[1]]);
  assert.equal(bundle.budget.repairs, 3);
  assert.equal(bundle.budget.auditCalls, 1);
});

test('an inventory unit without a genuine persistence callback cannot unlock the candidate or publish', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageStagedInventory = { skipUnitAck: true };
  await assert.rejects(f.refresh(), /baseline extraction failed/u);
  assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

test('an explicit staged context reason preserves the complete unit and cannot waive a sealed duty', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageStaged = { compactContext: true };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth: await f.truth() });
  const context = bundle.report.sources.flatMap(row => row.mappings).find(entry => entry.owner === 'CONTEXT');
  assert.equal(context.reason, 'This original states background only and adds no new duty.');
  assert.deepEqual(context.claimIds, []);
  assert.deepEqual(context.obligationIds, []);
  assert.equal(bundle.budget.repairs, 1);
});

test('staged audit reports exact unread files without spending a revision and still requires genuine reads', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageStaged = {};
  f.state.coverageAfterInventory = async ({ params, tools, request, inventory }) => {
    const section = { unitId: inventory.sources[0].units[0].unitId, mappings: [], issues: [] };
    for (let i = 0; i < 2; i++) {
      const denied = await nativeAuditAttempt(params, tools, 'finish_baseline_audit',
        { action: 'save_section', section }, `unread-stage-${i}`);
      const feedback = JSON.parse(denied.content[0].text);
      assert.equal(feedback.accepted, false);
      assert.equal(feedback.validation.reason, 'AUDIT_DISCLOSURE_GAP');
      assert(feedback.validation.recoverWith.some(read => read.path === request.phaseTwoManifest && read.offset === 1));
    }
  };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.repairs, 0);
  assert.equal(bundle.report.verdict, 'PASS');
});

test('a staged section without the genuine persistence callback cannot publish', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageStaged = { skipSectionAck: true };
  await assert.rejects(f.refresh(), /baseline extraction failed/u);
  assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

for (const acknowledged of [true, false]) {
  test(`an interrupted audit exposes only genuinely acknowledged staged implementation evidence (${acknowledged})`, async t => {
    const f = await sharedBasisFixture(t);
    f.state.coverageStaged = { outputLimitAfterSections: true, skipSectionAck: !acknowledged };
    await assert.rejects(f.refresh(), error => {
      assert.equal(error.code, 'REVIEWER_OUTPUT_LIMIT');
      const claims = error.cause?.coveredImplementationClaims ?? [];
      assert.equal(claims.length, acknowledged ? 1 : 0);
      if (acknowledged) assert.equal(claims[0].text, operation().text);
      return true;
    });
    assert.equal((await f.truth()).version, 0);
  });
}

test('an exhausted audit allowance still exposes its earlier acknowledged implementation evidence', async t => {
  const f = await sharedBasisFixture(t);
  f.plan.runtimeV2 = { ...f.plan.runtimeV2, reviewers: { ...f.plan.runtimeV2.reviewers,
    groundTruthExtractor: { ...f.plan.runtimeV2.reviewers.groundTruthExtractor, formatRepairAttempts: 0 } } };
  f.state.coverageStaged = { exhaustRepairAfterSections: true };
  await assert.rejects(f.refresh(), error => {
    assert.equal(error.code, 'BASELINE_REPAIR_LIMIT');
    assert.deepEqual(error.cause?.coveredImplementationClaims?.map(claim => claim.text), [operation().text]);
    return true;
  });
  assert.equal((await f.truth()).version, 0);
});

test('staged candidate issues are rejected at the unit if their owner disagrees with the sealed duty', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageStaged = { tryWrongIssue: true };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.repairs, 1);
  assert.equal(bundle.report.verdict, 'PASS');
});

test('a rejected positive owner mapping can be corrected without spending candidate repair budget', async t => {
  const f = await sharedBasisFixture(t);
  f.plan.runtimeV2 = { ...f.plan.runtimeV2, reviewers: { ...f.plan.runtimeV2.reviewers,
    groundTruthExtractor: { ...f.plan.runtimeV2.reviewers.groundTruthExtractor, formatRepairAttempts: 0 } } };
  f.state.coverageStaged = { tryWrongOwner: true };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.repairs, 0);
  assert.equal(bundle.report.verdict, 'PASS');
});

test('terminal staged repair exhaustion preserves the audit defect that consumed the limit', async t => {
  const f = await sharedBasisFixture(t);
  f.plan.runtimeV2 = { ...f.plan.runtimeV2, reviewers: { ...f.plan.runtimeV2.reviewers,
    groundTruthExtractor: { ...f.plan.runtimeV2.reviewers.groundTruthExtractor, formatRepairAttempts: 0 } } };
  f.state.coverageStaged = { tryWrongIssue: true };
  await assert.rejects(f.refresh(), error => {
    assert.match(error.cause?.message ?? '', /audit section repair allowance exhausted.*issue does not match its sealed duty/su);
    return true;
  });
  assert.equal((await f.truth()).version, 0);
});

test('condition mismatch feedback locates the exact field and permits an explicit same-run correction', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageSubmissions = [];
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    report.sources.find(source => source.kind === 'USER_MESSAGE').mappings[0].condition = 'invented trigger';
    return report;
  };
  f.state.coverageRepairReport = context => {
    assert.equal(context.attempt, 1);
    const feedback = JSON.parse(context.result.content[0].text).validation;
    assert.equal(feedback.reason, 'CONDITION_IDENTITY_MISMATCH');
    assert.equal(feedback.mappingIndex, 0);
    assert.deepEqual(feedback.submittedCondition, { value: 'invented trigger' });
    assert.deepEqual(feedback.targets[0].expectedCondition, { value: 'CURRENT_TASK' });
    assert.equal(feedback.recoverWith.path, 'phase-two-manifest.json');
    return scriptedCoverageReport(context);
  };
  await f.refresh();
  assert.equal((await f.truth()).version, 1);
  assert.equal(f.audits().length, 1);
  assert.equal(f.state.coverageSubmissions.length, 2);
  assert.equal(new Set(f.state.coverageSubmissions.map(row => row.params.runId)).size, 1);
});

for (const missing of ['native-append', 'genuine-persist-hook']) test(`successful generic callback cannot replace missing finish ${missing}`, async t => {
  const f = await sharedBasisFixture(t); f.state.coverageSubmissions = [];
  if (missing === 'native-append') f.state.coveragePersistFinish = false;
  else f.state.coverageObserveFinish = false;
  await assert.rejects(f.refresh());
  assert.equal(f.state.coverageSubmissions.length, 1);
  assert.equal(f.state.coverageSubmissions[0].result.isError, false, 'The finish tool and generic callback looked successful');
  assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

for (const mixed of [false, true]) test(`native audit rejects ${mixed ? 'mixed-owner' : 'homogeneous'} grouped positive targets`, async t => {
  const f = await twoClaimFixture(t, mixed), errors = [];
  f.state.coverageReport = context => {
    const value = scriptedCoverageReport(context), row = value.sources.find(source => source.kind === 'USER_MESSAGE');
    assert.equal(row.mappings.length, 2, 'Exercise two real effective claims');
    row.mappings = [{ ...row.mappings[0], claimIds: row.mappings.flatMap(mapping => mapping.claimIds) }];
    return value;
  };
  await assert.rejects(refreshCapturingAuditFailure(f, errors, `grouped-targets-${mixed}`));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /at most one effective claim/u);
  assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});
