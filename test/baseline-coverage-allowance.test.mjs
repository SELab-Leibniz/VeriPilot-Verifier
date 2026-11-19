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

for (const contested of [false, true]) test(`unresolved audit rechecks the same candidate (${contested ? 'candidate issue in a disputed unit' : 'inventory issue only'})`, async t => {
  const f = await sharedBasisFixture(t);
  let attempts = 0;
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    if (++attempts > 1) return report;
    const row = report.sources.find(source => source.kind === 'USER_MESSAGE');
    report.verdict = 'UNRESOLVED'; row.disposition = 'UNRESOLVED';
    row.issues = row.mappings.map(mapping => ({ ...mapping, issueKind: 'SOURCE_INVENTORY', owner: 'UNKNOWN',
      expectedDuty: 'Preserve the requested feature.', reason: 'Controlled first-auditor uncertainty; not a candidate defect or acceptance.' }));
    if (contested) row.issues.push({ ...row.mappings[0], issueKind: 'CANDIDATE',
      expectedDuty: 'Preserve the requested feature.', reason: 'This issue depends on the disputed inventory unit.' });
    row.mappings = []; return report;
  };
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(attempts, 2); assert.equal(bundle.budget.auditCalls, 2);
  assert.equal(bundle.budget.maxAuditCalls, 2);
  assert.equal(bundle.budget.repairs, 0); assert.equal(bundle.budget.externalRepairs, 0);
  assert.equal(bundle.input.generation, 0); assert.equal(f.state.baselinePrompts.length, 1);
});

test('expanded audit allowance retries an exactly settled native return without a final ACK, without repairing or accepting it', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000 } });
  let attempts = 0;
  f.state.coverageReturnWithoutFinish = () => ++attempts === 1;
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth: await f.truth() });
  assert.equal(attempts, 2); assert.equal(bundle.budget.auditCalls, 2);
  assert.equal(bundle.budget.repairs, 0); assert.equal(bundle.budget.externalRepairs, 0);
  assert.equal(bundle.input.generation, 0); assert.equal(f.state.baselinePrompts.length, 1);
  const records = await listNativeRuns(f.root, bundle.input.identity.taskId);
  const auditors = records.filter(row => row.sessionId !== bundle.input.extractorSettlement.sessionId);
  assert.equal(auditors.length, 2); assert(auditors.every(row => row.status === 'SETTLED'));
});

test('incomplete native audit retries still stop at their configured finite audit allowance without publication', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 2000, maxAuditCalls: 3, maxExternalRepairs: 2000 } });
  let attempts = 0; f.state.coverageReturnWithoutFinish = () => { attempts++; return true; };
  await assert.rejects(f.refresh()); assert.equal(attempts, 3);
  assert.equal((await f.truth()).version, 0); assert.equal(f.state.baselinePrompts.length, 1);
});

test('an accepted audit submission with missing persistence proof fails closed even with a large retry allowance', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000 } });
  let launches = 0; f.state.coverageLaunch = () => { launches++; }; f.state.coverageObserveFinish = false;
  await assert.rejects(f.refresh()); assert.equal(launches, 1); assert.equal((await f.truth()).version, 0);
});

test('native runtime failures are not retried as incomplete semantic audits under a large allowance', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000 } });
  let launches = 0; f.state.coverageLaunch = () => { launches++; };
  f.state.coverageReturnWithoutFinish = () => ({ payloads: [{ text: 'Transient provider failure', isError: true }], meta: { stopReason: 'error' } });
  await assert.rejects(f.refresh()); assert.equal(launches, 1); assert.equal((await f.truth()).version, 0);
});

test('a native length stop remains an output limit when the host returns a generic incomplete turn', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 20, maxAuditCalls: 5, maxExternalRepairs: 1 } });
  let launches = 0; f.state.coverageLaunch = () => { launches++; };
  f.state.coverageReturnWithoutFinish = async (_context, params) => {
    params.onAssistantMessageStart?.();
    await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
      stopReason: 'length', usage: { output: 32768, reasoningTokens: 32768 }, content: [] } }) + '\n');
    return { meta: { error: { kind: 'incomplete_turn', message: "Agent couldn't generate a response." } } };
  };
  await assert.rejects(f.refresh(), { code: 'REVIEWER_OUTPUT_LIMIT' });
  assert.equal(launches, 1); assert.equal((await f.truth()).version, 0);
});

test('original citation rejection identifies the unit and catalog citation without granting an original read or changing the inventory', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  const inventory = structuredClone(bundle.inventory.record.inventory), unit = inventory.sources[0].units[0];
  const catalog = bundle.citations.find(cite => cite.path.startsWith('unit-catalog-'));
  assert.match(catalog.citeId, /^N/u);
  assert(bundle.citations.filter(cite => cite.path.startsWith('original-source-')).every(cite => /^O\d+P\d+L\d+-\d+R\d+$/u.test(cite.citeId)));
  unit.citeIds.push(catalog.citeId);
  assert.throws(() => validateBaselineSourceInventory(inventory, bundle.input, bundle.files, bundle.citations), error => {
    assert.equal(error.auditValidation.reason, 'ORIGINAL_CITATION_SOURCE_MISMATCH');
    assert.equal(error.auditValidation.unitId, unit.unitId);
    const bad = error.auditValidation.submitted.find(row => row.citeId === catalog.citeId);
    assert.equal(bad.path, catalog.path); assert.equal(bad.acceptedOriginalPath, false);
    assert(error.auditValidation.originalPaths.every(name => name.startsWith('original-source-')));
    return true;
  });
});

test('an audit disclosure gap identifies the unacknowledged candidate and requires its genuine receipt before the same audit finishes', async t => {
  const f = await sharedBasisFixture(t); let repairs = 0, withheld = false;
  f.state.coverageSkipReadReceipt = file => {
    if (file !== 'candidate-0.txt' || withheld) return false;
    withheld = true; return true;
  };
  f.state.coverageRepairReport = async context => {
    const feedback = JSON.parse(context.result.content[0].text);
    assert.equal(feedback.validation.reason, 'AUDIT_DISCLOSURE_GAP');
    assert.deepEqual(feedback.validation.recoverWith, [{ tool: 'source_read', path: 'candidate-0.txt', offset: 1 }]);
    await context.readFile(feedback.validation.recoverWith[0].path); repairs++;
    return scriptedCoverageReport(context);
  };
  await f.refresh(); assert.equal(repairs, 1);
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  assert.equal(bundle.budget.auditCalls, 1);
  assert(bundle.citations.some(cite => cite.path === 'candidate-0.txt'));
});

test('an abbreviated inventory digest gets the complete owned identity without automatic report repair', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  const report = structuredClone(bundle.report), completeDigest = report.inventoryDigest; report.inventoryDigest = completeDigest.slice(0, 8);
  assert.throws(() => validateBaselineAuditReport(report, bundle.input, bundle.files, bundle.citations, bundle.inventory.record.inventory), error => {
    assert.equal(error.auditValidation.reason, 'INVENTORY_DIGEST_MISMATCH');
    assert.equal(error.auditValidation.expectedInventoryDigest, completeDigest);
    assert.equal(report.inventoryDigest.length, 8); return true;
  });
});

test('unsupported candidate feedback grants no original-duty coverage and only an explicit extractor revision removes the extra claim', async t => {
  const f = await sharedBasisFixture(t); f.state.sourceFrom = true;
  const real = operation(), extra = { ...operation(), text: 'Deliver an unrequested sample report.', verificationTarget: 'ARTIFACT' };
  delete extra.implementationRole; f.state.deltaOperations = [real, extra];
  let completeRepair, rejectedMissingDuty = 0;
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context), row = report.sources.find(source => source.kind === 'USER_MESSAGE');
    const bad = context.view.effectiveLedger.claims.find(claim => claim.text === extra.text);
    if (!bad) return report;
    const mapping = row.mappings.find(item => item.claimIds.includes(bad.claimId));
    report.verdict = 'REPAIR'; row.disposition = 'REPAIR';
    row.mappings = row.mappings.filter(item => !item.claimIds.includes(bad.claimId));
    row.issues = [{ ...mapping, owner: 'CONTEXT', obligationIds: [], claimIds: [bad.claimId], issueKind: 'CANDIDATE',
      expectedDuty: 'Remove the unrequested sample report claim and preserve the original requested feature.',
      reason: 'The complete original requests only the feature; it does not adopt an extra report deliverable.' }];
    completeRepair = structuredClone(report); row.mappings = []; // Unsupported feedback cannot account for the real duty.
    f.state.deltaOperations = [real]; return report;
  };
  f.state.coverageRepairReport = context => {
    assert.equal(JSON.parse(context.result.content[0].text).validation.reason, 'COMMITTED_DUTY_UNACCOUNTED');
    assert.equal(f.state.baselinePrompts.length, 1); rejectedMissingDuty++;
    return structuredClone(completeRepair);
  };
  await f.refresh(); assert.equal(rejectedMissingDuty, 1);
  const truth = await f.truth(), bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth });
  assert.equal(truth.claims.length, 1); assert.equal(truth.claims[0].text, real.text);
  assert.equal(bundle.budget.externalRepairs, 1); assert.equal(bundle.budget.auditCalls, 2); assert.equal(bundle.input.generation, 1);
});

for (const limit of [0, 1]) test(`zero-write baseline repairs stop at configured limit ${limit} without publication`, async t => {
  const f = await sharedBasisFixture(t);
  f.plan.runtimeV2 = { ...f.plan.runtimeV2, reviewers: { ...f.plan.runtimeV2.reviewers,
    groundTruthExtractor: { ...f.plan.runtimeV2.reviewers.groundTruthExtractor, formatRepairAttempts: limit } } };
  let submissions = 0;
  f.state.beforeBaselineSave = async ({ call }) => {
    const { source, ...fields } = operation();
    const invalid = { batchId: 1, operations: [{ ...fields, sourceFrom: { unitId: 'S0L1' },
      expectedFiles: ['not-named-in-original.txt'] }] };
    for (let i = 0; i < limit; i++) {
      submissions++;
      await assert.rejects(call('save_baseline_batch', invalid), { code: 'GROUND_TRUTH_EXPECTED_FILES_INVALID' });
    }
    submissions++;
    await call('save_baseline_batch', invalid);
  };
  await assert.rejects(f.refresh(), /baseline extraction failed/);
  assert.equal((await f.truth()).version, 0); assert.equal(f.audits().length, 0);
  assert.equal(submissions, limit + 1);
  assert.equal(f.state.baselinePrompts.length, 1);
});
