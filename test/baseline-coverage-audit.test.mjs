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

test('partial Stop targets omit disputed claims and preserve independently supported siblings', () => {
  const claims = ['covered', 'disputed', 'dependent'].map(claimId => ({
    claimId, status: 'ACTIVE', authority: 'USER_EXPLICIT', verificationTarget: 'IMPLEMENTATION', applicabilityKind: 'CURRENT_TASK',
  }));
  const audit = { report: { verdict: 'UNRESOLVED' }, anchoredSources: [{ kind: 'USER_MESSAGE',
    mappings: claims.map(({ claimId }, index) => ({
      owner: 'IMPLEMENTATION', claimIds: [claimId], unitId: 'S0U0', obligationIds: [`O${index}`],
      ...(claimId === 'dependent' ? { dependencyUnitIds: ['S1U1'] } : {}),
    })), issues: [{ claimIds: ['disputed'], unitId: 'S0U0', obligationIds: ['O1'] }],
  }, { kind: 'PROJECT_FILE', mappings: [], issues: [{ claimIds: [], unitId: 'S1U1', obligationIds: [] }] }] };
  assert.deepEqual(coveredImplementationClaims(audit, claims).map(claim => claim.claimId), ['covered']);
});

test('a missing separator byte identifies the source/unit and an overlapping read actually repairs its coverage', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: operation().text + '\n' } }) + '\n');
  f.state.coverageInventory = context => scriptedSourceInventory(context, () => [{
    statement: 'Preserve the requested feature.', owner: 'IMPLEMENTATION', condition: 'During this task.',
  }]);
  await f.refresh();
  const truth = await f.truth(), proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { identity: proof.identity, truth });
  const source = bundle.input.identity.sources.find(row => row.kind === 'USER_MESSAGE');
  const file = bundle.files.find(row => row.path === `original-${source.parts[0].file}`), bytes = Buffer.from(file.text);
  const registry = new Map(), unit = baselineAuditSourceUnits(bundle.input, bundle.files).find(row => row.ref === source.ref);
  const short = registerCitation({ registry, bytes, file: file.path, sha256: file.sha256, range: { start: 1, end: 1 } });
  const inventory = structuredClone(bundle.inventory.record.inventory);
  const entry = inventory.sources.find(row => row.ref === source.ref).units.find(row => row.unitId === unit.unitId);
  entry.rangeMode = 'UNIT'; delete entry.quote; entry.citeIds = [short.citeId];
  let diagnostic;
  assert.throws(() => validateBaselineSourceInventory(inventory, bundle.input, bundle.files, [...bundle.citations, short]), error => {
    diagnostic = error.auditValidation;
    assert.equal(diagnostic.reason, 'ORIGINAL_CITATION_RANGE_GAP'); assert.equal(diagnostic.ref, source.ref);
    assert.equal(diagnostic.unitId, unit.unitId); assert.equal(diagnostic.gaps[0].end - diagnostic.gaps[0].start, 1);
    return true;
  });
  const args = diagnostic.recoverWith[0], page = sourcePage(bytes, args);
  const restored = registerCitation({ registry, bytes, file: file.path, sha256: file.sha256,
    range: { start: page.details.page.start, end: page.details.page.end } });
  entry.citeIds = [restored.citeId];
  validateBaselineSourceInventory(inventory, bundle.input, bundle.files, [...bundle.citations, restored]);
});

test('first-use native audit publishes full evidence and reuses only the unchanged strong basis', async t => {
  const f = await sharedBasisFixture(t);
  await f.refresh();
  const truth = await f.truth(), task = await f.task();
  assert.equal(truth.version, 1); assert.equal(f.audits().length, 1);
  const proof = task.groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { identity: proof.identity, truth });
  assert.notEqual(bundle.nativeRecord.sessionId, bundle.input.extractorSettlement.sessionId);
  const extractorRequest = JSON.parse(bundle.auxiliaryFiles.filter(file => file.path.startsWith('request-'))
    .sort((left, right) => left.path.localeCompare(right.path)).map(file => file.text).join(''));
  const phaseTwo = JSON.parse(bundle.files.find(file => file.path === 'phase-two-manifest.json').text);
  const phaseOne = JSON.parse(bundle.initialContext.prompt);
  const sharedScopeRules = TASK_SCOPE_INSTRUCTIONS.filter(rule =>
    /^(For compound rules|Encoding and read-back|Regression and tests|Troubleshooting and scope|Test methods and scope)/u.test(rule));
  assert.equal(sharedScopeRules.length, 5);
  for (const stage of [extractorRequest, phaseOne, phaseTwo])
    assert(sharedScopeRules.every(rule => stage.instructions.includes(rule)));
  assert(bundle.files.some(file => file.path.startsWith('candidate-')));
  assert.equal(bundle.report.sources.length, bundle.input.identity.sources.length);
  assert(bundle.report.sources.every(source => !Object.hasOwn(source, 'sha256')));
  assert(bundle.input.identity.sources.every(source => /^[a-f0-9]{64}$/u.test(source.sha256)), 'Private source hashes remain mandatory');
  assert(bundle.budget.consumers.extractor > 0 && bundle.budget.consumers.checker > 0);
  assert.equal(bundle.budget.turns, bundle.budget.consumers.extractor + bundle.budget.consumers.checker);
  assert(bundle.budget.turns <= bundle.budget.maxTurns);
  await f.refresh();
  assert.equal(f.audits().length, 1); assert.equal(f.globals().length, 1);
});

test('new-format range-gap feedback is repaired inside the same auditor invocation and budget', async t => {
  const f = await sharedBasisFixture(t);
  const texts = ['Read the original contract.', 'Verify after the final edit.'];
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: texts.join(' ') } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = texts.map(text => {
    const row = { ...operation(), text, verificationTarget: 'PROCESS' }; delete row.implementationRole; return row;
  });
  f.state.coverageSubmissions = [];
  f.state.coverageReport = context => {
    const value = scriptedCoverageReport(context), row = value.sources.find(source => source.kind === 'USER_MESSAGE');
    const target = context.view.effectiveLedger.claims.find(claim => claim.text === texts[1]).claimId;
    row.mappings = [{ ...row.mappings.find(mapping => mapping.claimIds.includes(target)), quote: texts[1] }];
    return value;
  };
  f.state.coverageRepairReport = context => {
    assert.equal(context.attempt, 1);
    const feedback = JSON.parse(context.result.content[0].text);
    assert.equal(feedback.validation.reason, 'ORIGINAL_RANGE_GAP');
    assert.match(feedback.validation.gaps[0].quote, /Read the original contract/u);
    const value = scriptedCoverageReport(context), row = value.sources.find(source => source.kind === 'USER_MESSAGE');
    for (const mapping of row.mappings) {
      const claim = context.view.effectiveLedger.claims.find(claim => claim.claimId === mapping.claimIds[0]);
      mapping.quote = claim.text === texts[0] ? texts[0] + ' ' : texts[1];
    }
    return value;
  };
  await f.refresh();
  assert.equal(f.audits().length, 1); assert.equal(f.state.coverageSubmissions.length, 2);
  assert.equal(new Set(f.state.coverageSubmissions.map(item => item.params.runId)).size, 1);
  assert.equal(new Set(f.state.coverageSubmissions.map(item => item.params.sessionId)).size, 1);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer);
  assert.equal(bundle.budget.auditCalls, 1); assert.equal(bundle.budget.externalRepairs, 0);
  assert.equal(bundle.budget.maxTurns, STOP_TASK_LIMITS.maxTurns);
});

test('multiple incompatible owner mappings are rejected together and can be corrected in one same-run submission', async t => {
  const f = await twoClaimFixture(t, true);
  f.state.coverageSubmissions = [];
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    const row = report.sources.find(source => source.kind === 'USER_MESSAGE');
    assert.equal(row.mappings.length, 2);
    const [first, second] = row.mappings;
    [first.claimIds, second.claimIds] = [second.claimIds, first.claimIds];
    return report;
  };
  f.state.coverageRepairReport = context => {
    assert.equal(context.attempt, 1);
    const feedback = JSON.parse(context.result.content[0].text).validation;
    assert.equal(feedback.reason, 'OWNER_DUTY_MISMATCH');
    assert.deepEqual([feedback, ...feedback.related].map(issue => issue.mappingIndex), [0, 1]);
    assert([feedback, ...feedback.related].every(issue => issue.obligations[0].expectedInventoryOwner !== issue.targets[0].verificationTarget));
    assert.equal(feedback.remainingMismatches, 0);
    return scriptedCoverageReport(context);
  };
  await f.refresh();
  assert.equal((await f.truth()).version, 1);
  assert.equal(f.state.coverageSubmissions.length, 2);
  assert.equal(new Set(f.state.coverageSubmissions.map(row => row.params.runId)).size, 1);
});

test('both inconsistent dependency selections are located in the same rejected report', async t => {
  const f = await twoClaimFixture(t);
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context), sourceIndex = report.sources.findIndex(row => row.kind === 'USER_MESSAGE');
    const [first, second] = report.sources[sourceIndex].mappings;
    first.supportMode = 'DIRECT'; first.dependencyUnitIds = [second.unitId];
    second.supportMode = 'IMMUTABLE_DEPENDENCY'; second.dependencyUnitIds = [];
    return report;
  };
  f.state.coverageRepairReport = context => {
    const validation = JSON.parse(context.result.content[0].text).validation;
    assert.equal(validation.reason, 'REPORT_SELECTION_INVALID');
    assert.equal(validation.issueCount, 2);
    assert.deepEqual(validation.issues.map(issue => issue.path.slice(-3)), [
      ['mappings', 0, 'dependencyUnitIds'], ['mappings', 1, 'dependencyUnitIds'],
    ]);
    return scriptedCoverageReport(context);
  };
  await f.refresh();
  assert.equal((await f.truth()).version, 1);
  assert.equal(f.audits().length, 1);
});

test('a duplicated report source identifies both the duplicate row and the omitted original', async t => {
  const f = await sharedBasisFixture(t);
  let expected;
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    assert(report.sources.length >= 2);
    expected = { index: 1, kind: report.sources[1].kind, ref: report.sources[1].ref };
    report.sources[1] = structuredClone(report.sources[0]);
    return report;
  };
  f.state.coverageRepairReport = context => {
    const validation = JSON.parse(context.result.content[0].text).validation;
    assert.equal(validation.reason, 'SOURCE_ROWS_INVALID');
    assert.deepEqual(validation.missing, [expected]);
    assert.equal(validation.duplicates[0].index, 1);
    return scriptedCoverageReport(context);
  };
  await f.refresh();
  assert.equal((await f.truth()).version, 1);
});
