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

test('issues-only sections repair both document owners in the original shared allowance and preserve CONTEXT', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageStaged = { omitEmptyLists: true };
  const wrong = ['Write the usage guide.', 'Write the reference guide.'].map(text => ({ ...operation(), text }));
  const corrected = wrong.map(({ implementationRole, ...row }) => ({ ...row, verificationTarget: 'ARTIFACT' }));
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: wrong.map(row => row.text).join(' ') } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = wrong;
  let feedbackTargets, expectedIssues;
  f.state.coverageReport = context => {
    const value = scriptedCoverageReport(context), row = value.sources.find(source => source.kind === 'USER_MESSAGE');
    if (context.view.effectiveLedger.claims.every(claim => claim.verificationTarget === 'ARTIFACT')) return value;
    feedbackTargets = row.mappings.flatMap(mapping => mapping.claimIds);
    assert.equal(feedbackTargets.length, 2);
    value.verdict = 'REPAIR'; row.disposition = 'REPAIR';
    row.issues = [{ ...row.mappings[0], claimIds: feedbackTargets, owner: 'ARTIFACT', condition: '',
      obligationIds: context.inventory.sources.find(source => source.kind === 'USER_MESSAGE').units.flatMap(unit => unit.obligations.map(duty => duty.obligationId)),
      issueKind: 'CANDIDATE', expectedDuty: 'Write both the usage guide and the reference guide.',
      reason: 'Both originals require document content; creating a file does not make either requirement program runtime behavior.' }];
    expectedIssues = [{ ref: row.ref, kind: row.kind, issues: structuredClone(row.issues) }];
    row.mappings = []; f.state.deltaOperations = corrected;
    return value;
  };
  await f.refresh();
  assert.equal(f.audits().length, 2);
  const handoff = f.state.baselinePrompts.find(prompt => prompt.generation === 1);
  const repairControl = JSON.parse(handoff.promptAppend.split('\n').at(-1));
  assert.deepEqual(repairControl.coverageIssues, expectedIssues);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const candidateFiles = bundle.files.filter(file => file.path.startsWith('candidate-'));
  const disclosure = JSON.parse(candidateFiles.map(file => file.text).join(''));
  assert.equal(disclosure.protocol, BASELINE_AUDIT_VIEW_PROTOCOL);
  const decoded = decodeBaselineAuditView(disclosure);
  assert.deepEqual(decoded.identity, coverageIdentity(bundle.input));
  assert.deepEqual(decoded.sources, bundle.input.identity.sources);
  assert.deepEqual(decoded.delta, bundle.input.delta);
  assert.deepEqual(decoded.retainedSourceUnits, bundle.input.retainedSourceUnits);
  assert.deepEqual(decoded.effectiveLedger, bundle.input.plan.current);
  assert.equal(decoded.operationDispositions.length, bundle.input.plan.operationDispositions.length);
  for (const [index, row] of decoded.operationDispositions.entries()) {
    const actual = bundle.input.plan.operationDispositions[index];
    for (const key of ['operationIndex', 'operation', 'disposition']) assert.equal(row[key], actual[key]);
    for (const key of ['target', 'effectiveTarget']) if (actual[key]) {
      for (const field of ['claimId', 'revisionId', 'status']) assert.equal(row[key][field], actual[key][field]);
      assert(!Object.hasOwn(row[key], 'digest'));
    }
  }
  for (const file of candidateFiles) {
    assert(bundle.reads.some(read => read.path === file.path && read.start === 1 && read.end === file.lines));
    assert(bundle.journalEntries.some(entry => entry.message?.details?.citation?.path === file.path
      && entry.message.details.receiptBoundary === 'openclaw.tool_result_persist.v1'));
  }
  assert.equal(bundle.budget.externalRepairs, 1); assert.equal(bundle.budget.repairs, 1);
  assert.equal(bundle.budget.auditCalls, 2);
  assert.equal(bundle.budget.maxTurns, STOP_TASK_LIMITS.maxTurns);
  assert.equal((await f.truth()).claims.length, 2);
  assert((await f.truth()).claims.every(claim => claim.verificationTarget === 'ARTIFACT'));
  assert(bundle.report.sources.some(source => source.disposition === 'CONTEXT'
    && source.mappings.some(mapping => mapping.owner === 'CONTEXT' && mapping.claimIds.length === 0)));
});

test('zero-write path repair leaves the single semantic audit repair available in the same original budget', async t => {
  const f = await sharedBasisFixture(t);
  const wrong = ['Write the usage guide.', 'Write the reference guide.'].map(text => ({ ...operation(), text }));
  const corrected = wrong.map(({ implementationRole, ...row }) => ({ ...row, verificationTarget: 'ARTIFACT' }));
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: wrong.map(row => row.text).join(' ') } }) + '\n');
  f.state.sourceFrom = true;
  f.state.deltaOperations = wrong;
  f.state.beforeBaselineSave = async ({ call }) => {
    const { source, ...fields } = wrong[0];
    await assert.rejects(call('save_baseline_batch', { batchId: 1, operations: [{
      ...fields, sourceFrom: { unitId: 'S0L1' }, expectedFiles: ['not-named-in-original.txt'],
    }] }), error => {
      assert.equal(error.code, 'GROUND_TRUTH_EXPECTED_FILES_INVALID');
      assert.deepEqual(error.baselineValidation.issues[0].correctionPath, ['operations', 0, 'expectedFiles']);
      return true;
    });
    f.state.beforeBaselineSave = undefined;
  };
  f.state.coverageReport = context => {
    const value = scriptedCoverageReport(context), row = value.sources.find(source => source.kind === 'USER_MESSAGE');
    if (context.view.effectiveLedger.claims.every(claim => claim.verificationTarget === 'ARTIFACT')) return value;
    value.verdict = 'REPAIR'; row.disposition = 'REPAIR';
    row.issues = [{ ...row.mappings[0], claimIds: row.mappings.flatMap(mapping => mapping.claimIds), owner: 'ARTIFACT',
      obligationIds: context.inventory.sources.find(source => source.kind === 'USER_MESSAGE').units.flatMap(unit => unit.obligations.map(duty => duty.obligationId)),
      issueKind: 'CANDIDATE', expectedDuty: 'Write both guides.', condition: '', reason: 'These originals require document contents, not program runtime behavior.' }];
    row.mappings = []; f.state.deltaOperations = corrected; return value;
  };
  await f.refresh();
  const truth = await f.truth(), proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth });
  assert.equal(truth.version, 1); assert(truth.claims.every(claim => claim.verificationTarget === 'ARTIFACT'));
  assert.equal(bundle.budget.repairs, 2); assert.equal(bundle.budget.externalRepairs, 1);
  assert.equal(bundle.budget.auditCalls, 2); assert.equal(bundle.input.generation, 1);
  assert.equal(bundle.budget.turns, bundle.budget.consumers.extractor + bundle.budget.consumers.checker);
  assert.equal(new Set(f.state.baselinePrompts.map(prompt => prompt.identity.requestId)).size, 1);
});

test('configured 24-hour 2000-step baseline permits multiple genuine repair/audit rounds in one original budget', async t => {
  const began = Date.now(), f = await sharedBasisFixture(t, { baselineLimits: {
    timeoutMs: 86400000, maxSteps: 2000, maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000,
  } });
  const wrong = ['Write the usage guide.', 'Write the reference guide.'].map(text => ({ ...operation(), text }));
  const corrected = wrong.map(({ implementationRole, ...row }) => ({ ...row, verificationTarget: 'ARTIFACT' }));
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: wrong.map(row => row.text).join(' ') } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = wrong; let rounds = 0;
  f.state.coverageReport = context => {
    const value = scriptedCoverageReport(context), row = value.sources.find(source => source.kind === 'USER_MESSAGE');
    const bad = new Set(context.view.effectiveLedger.claims.filter(claim => claim.verificationTarget !== 'ARTIFACT').map(claim => claim.claimId));
    if (!bad.size) return value;
    value.verdict = 'REPAIR'; row.disposition = 'REPAIR';
    row.issues = row.mappings.filter(mapping => mapping.claimIds.some(id => bad.has(id))).map(mapping => ({ ...mapping,
      owner: 'ARTIFACT', issueKind: 'CANDIDATE', expectedDuty: 'Write the required document content.',
      reason: 'The original requires document content, not delivered runtime behavior.' }));
    row.mappings = row.mappings.filter(mapping => !mapping.claimIds.some(id => bad.has(id)));
    f.state.deltaOperations = ++rounds === 1 ? [corrected[0], wrong[1]] : corrected; return value;
  };
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.maxTurns, 2000); assert.equal(bundle.budget.maxRepairs, 2000);
  assert.equal(bundle.budget.maxAuditCalls, 2000); assert.equal(bundle.budget.maxExternalRepairs, 2000);
  assert.equal(bundle.budget.auditCalls, 3); assert.equal(bundle.budget.externalRepairs, 2); assert.equal(bundle.budget.repairs, 2);
  assert(bundle.budget.deadlineAt - began > 23 * 3600000);
  assert(f.state.baselineTimeouts.every(timeout => timeout > 23 * 3600000));
  assert.equal(new Set(f.state.baselinePrompts.map(prompt => prompt.identity.requestId)).size, 1);
});

test('configured 16 KiB audit units carry one complete long original through native source-only inventory and guarded publication', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000, auditUnitBytes: 16384 } });
  const text = 'Preserve the requested feature. ' + 'x'.repeat(7000);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: text } }) + '\n');
  f.state.sourceFrom = true;
  f.state.coverageInventory = context => {
    const inventory = scriptedSourceInventory(context, ({ source, fullText }) => {
      if (source.kind !== 'USER_MESSAGE') return [];
      assert.equal(fullText, text);
      return [{ statement: 'Preserve the requested feature.', owner: 'IMPLEMENTATION', condition: 'During this task.' }];
    });
    for (const source of inventory.sources) for (const unit of source.units) delete unit.citeIds;
    return inventory;
  };
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    for (const source of report.sources) for (const mapping of source.mappings) {
      mapping.rangeMode = 'UNIT'; delete mapping.quote; delete mapping.citeIds;
      if (mapping.obligationIds.length) delete mapping.unitId;
    }
    return report;
  };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth: await f.truth() });
  assert.equal(bundle.input.unitLayout.maxBytes, 16384); assert.equal(bundle.identity.unitLayout.maxBytes, 16384);
  const inventory = bundle.inventory.record.inventory.sources.find(row => row.kind === 'USER_MESSAGE');
  assert.equal(inventory.units.length, 1); assert.equal(bundle.input.identity.sources[0].bytes, Buffer.byteLength(text));
  assert.equal(Object.hasOwn(inventory.units[0], 'citeIds'), false);
  const catalog = bundle.files.filter(file => /^unit-catalog-\d+\.txt$/u.test(file.path));
  const navigators = JSON.parse(catalog.map(file => file.text).join(''));
  assert(!navigators.some(unit => Object.hasOwn(unit, 'text')));
  assert.equal(navigators.find(unit => unit.kind === 'USER_MESSAGE').endByte, Buffer.byteLength(text));
  assert(catalog.reduce((bytes, file) => bytes + Buffer.byteLength(file.text), 0) < Buffer.byteLength(text) / 2);
  assert(bundle.initialContext.prompt.includes('at most 16384 bytes'));
  assert.equal(bundle.report.verdict, 'PASS');
  assert(bundle.report.sources.every(row => row.mappings.every(mapping => !Object.hasOwn(mapping, 'citeIds'))));
  assert(bundle.report.sources.some(row => row.mappings.some(mapping => mapping.obligationIds.length && !Object.hasOwn(mapping, 'unitId'))));
});

test('one configured large original unit preserves independently authored runtime and artifact duties before candidate exposure', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000, auditUnitBytes: 16384 } });
  const text = 'Preserve the requested feature. Write the usage guide. ' + 'Background context. '.repeat(250);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: text } }) + '\n');
  const guide = { ...operation(), text: 'Write the usage guide.', verificationTarget: 'ARTIFACT' }; delete guide.implementationRole;
  f.state.sourceFrom = true; f.state.deltaOperations = [operation(), guide];
  f.state.coverageInventory = context => scriptedSourceInventory(context, ({ source, fullText }) => {
    if (source.kind !== 'USER_MESSAGE') return [];
    assert.equal(fullText, text);
    return [{ statement: 'Preserve the requested feature.', owner: 'IMPLEMENTATION', condition: 'During this task.' },
      { statement: 'Write the usage guide.', owner: 'ARTIFACT', condition: 'During this task.' }];
  });
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    for (const source of report.sources) for (const mapping of source.mappings) { mapping.rangeMode = 'UNIT'; delete mapping.quote; }
    return report;
  };
  await f.refresh();
  const truth = await f.truth(), bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth });
  assert.equal(truth.claims.length, 2);
  const original = bundle.inventory.record.inventory.sources.find(row => row.kind === 'USER_MESSAGE');
  assert.equal(original.units.length, 1); assert.deepEqual(new Set(original.units[0].obligations.map(row => row.owner)), new Set(['IMPLEMENTATION', 'ARTIFACT']));
});
