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
import { sourcePage, textBlocks, toolText } from '../lib/review-task/source-tools.mjs';
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

async function sharedBasisFixture(t, options) {
  const fixture = await createSharedBasisFixture(t, options);
  const task = await ensureTask({ projectRoot: fixture.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: fixture.root, taskId: task.taskId }, state => { state.control ??= {}; });
  return fixture;
}

async function scratch(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-coverage-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

async function refreshCapturingAuditFailure(fixture, errors, id) {
  const delegate = fixture.factory;
  const factory = async options => {
    try { return await delegate(options); }
    catch (error) {
      if (options.request.reviewScope?.kind === 'baseline-coverage-audit') errors.push(error);
      throw error;
    }
  };
  Object.assign(factory, delegate);
  return refreshRuntimeRequirements({ projectRoot: fixture.root, input: { cwd: fixture.root, session_id: 'basis-session',
    transcript_path: fixture.transcript, hook_event_name: 'Stop', hook_event_id: id }, plan: fixture.plan, reviewerFactory: factory });
}

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

async function twoClaimFixture(t, mixed = false) {
  const f = await sharedBasisFixture(t), second = { ...operation(), text: mixed ? 'Write the usage guide.' : 'Provide the second requested behavior.' };
  if (mixed) { second.verificationTarget = 'ARTIFACT'; delete second.implementationRole; }
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: `Preserve the requested feature. ${second.text}` } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = [operation(), second];
  return f;
}

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

test('proof verification rejects rehashed report, source, candidate and ACK mutations without repairing raw evidence', async t => {
  const f = await twoClaimFixture(t, true); await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const original = JSON.parse(await fs.readFile(proof.pointer.path, 'utf8'));
  const cases = [
    ['missing tuple', bundle => bundle.report.sources.pop(), /omitted or duplicated/u],
    ['duplicate tuple', bundle => { bundle.report.sources[1] = structuredClone(bundle.report.sources[0]); }, /omitted or duplicated/u],
    ['foreign ref', bundle => { bundle.report.sources[0].ref = 'transcript:foreign'; }, /source denominator/u],
    ['foreign kind', bundle => { bundle.report.sources[0].kind = bundle.report.sources[0].kind === 'USER_MESSAGE' ? 'MATERIAL' : 'USER_MESSAGE'; }, /source denominator/u],
    ['wrong top identity', bundle => { bundle.report.identityDigest = 'foreign'; }, /Foreign or malformed semantic/u],
    ['legacy model hash', bundle => { bundle.report.sources[0].sha256 = bundle.input.identity.sources[0].sha256; }, /Foreign or malformed/u],
    ['grouped targets', bundle => {
      const row = bundle.report.sources.find(source => source.kind === 'USER_MESSAGE');
      row.mappings = [{ ...row.mappings[0], claimIds: row.mappings.flatMap(mapping => mapping.claimIds) }];
    }, /at most one effective claim/u],
    ['wrong owner', bundle => { bundle.report.sources.find(source => source.kind === 'USER_MESSAGE').mappings[0].owner = 'PROCESS'; }, /ownership does not match/u],
    ['wrong condition', bundle => { bundle.report.sources.find(source => source.kind === 'USER_MESSAGE').mappings[0].condition = 'invented trigger'; }, /condition mapping differs/u],
    ['private source hash', bundle => {
      bundle.input.identity.sources[0].sha256 = '0'.repeat(64);
      bundle.identity = coverageIdentity(bundle.input); bundle.report.identityDigest = sha256(bundle.identity);
    }, /[Uu]nit original source identity changed|Original source identity changed/u],
    ['candidate disclosure', bundle => { bundle.files.find(file => file.path === 'candidate-0.txt').text += ' '; }, /Effective candidate disclosure changed/u],
    ['program-only input bytes', bundle => { bundle.auxiliaryFiles[0].text += ' '; }, /Audit program-only input proof changed/u],
    ['program-only input with rewritten hashes', bundle => {
      const file = bundle.auxiliaryFiles[0]; file.text += ' '; file.sha256 = sha256(Buffer.from(file.text));
      bundle.input.fileHashes[file.path] = file.sha256;
      bundle.identity = coverageIdentity(bundle.input); bundle.report.identityDigest = sha256(bundle.identity);
    }, /Source inventory changed or belongs to another/u],
    ['candidate index gap', bundle => { bundle.files.find(file => file.path === 'candidate-0.txt').path = 'candidate-2.txt'; }, /Effective candidate fragment changed/u],
    ['extra empty candidate fragment', bundle => {
      const count = bundle.files.filter(file => file.path.startsWith('candidate-')).length;
      bundle.files.push({ path: `candidate-${count}.txt`, text: '', sha256: sha256(Buffer.alloc(0)), lines: 1 });
    }, /Effective candidate fragment changed/u],
    ['repacked candidate fragments', bundle => {
      const index = bundle.files.findIndex(file => file.path === 'candidate-0.txt'), old = bundle.files[index];
      // Concatenated bytes are unchanged: exact original per-fragment identity must still reject this.
      const pieces = [old.text.slice(0, 1), old.text.slice(1)].map((text, offset) => ({ ...old,
        path: `candidate-${offset}.txt`, text, sha256: sha256(Buffer.from(text)), lines: text.split('\n').length }));
      bundle.files.splice(index, 1, ...pieces);
    }, /Effective candidate fragment changed/u],
    ['missing candidate definition read', bundle => {
      const file = bundle.files.find(file => file.path === 'candidate-0.txt');
      bundle.reads = bundle.reads.filter(read => read.path !== file.path);
    }, /incomplete original\/candidate disclosure/u],
    ['missing candidate definition ACK', bundle => {
      const index = bundle.journalEntries.findIndex(entry => entry.message?.details?.citation?.path === 'candidate-0.txt');
      assert(index > 0); bundle.journalEntries.splice(index, 1);
    }, /not a genuine successful native disclosure/u],
    ['missing owned ACK', bundle => {
      const index = bundle.journalEntries.findIndex(entry => entry.message?.details?.citation);
      assert(index > 0); bundle.journalEntries.splice(index, 1);
    }, /not a genuine successful native disclosure/u],
    ['old protocol', bundle => { bundle.protocol = 'baseline-original-effective-coverage-v2-finish-retention'; }, /Stale or foreign/u],
  ];
  for (const [name, mutate, expected] of cases) {
    const bundle = structuredClone(original); mutate(bundle);
    if (['missing tuple', 'duplicate tuple', 'foreign ref', 'foreign kind', 'wrong top identity', 'legacy model hash', 'grouped targets', 'wrong owner', 'wrong condition'].includes(name))
      assert.throws(() => validateBaselineAuditReport(bundle.report, bundle.input, bundle.files, bundle.citations, bundle.inventory.record.inventory),
        error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && expected.test(error.message), `${name} reaches the report guard directly`);
    const bytes = Buffer.from(JSON.stringify(bundle)), file = path.join(path.dirname(proof.pointer.path), `${sha256(bundle)}.json`);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    if (['candidate index gap', 'extra empty candidate fragment', 'repacked candidate fragments',
      'missing candidate definition read', 'missing candidate definition ACK'].includes(name))
      await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(bundle), bytesDigest: sha256(bytes) }),
        error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && expected.test(error.message), `${name} reaches its specific disclosure guard`);
    await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(bundle), bytesDigest: sha256(bytes) }),
      error => error.code === 'BASELINE_COVERAGE_UNVERIFIED', name);
  }
  const rawMismatch = structuredClone(original); rawMismatch.report.sources[0].reason += ' Changed return only.';
  const bytes = Buffer.from(JSON.stringify(rawMismatch)), file = path.join(path.dirname(proof.pointer.path), `${sha256(rawMismatch)}.json`);
  await fs.writeFile(file, bytes, { flag: 'wx' });
  await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(rawMismatch), bytesDigest: sha256(bytes) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED');
  assert.deepEqual(JSON.parse(await fs.readFile(proof.pointer.path, 'utf8')), original, 'Original evidence is never rewritten');
  await verifyBaselineCoverageProof(proof.pointer, { identity: proof.identity, truth: await f.truth() });
});

const isLongNativeRead = ({ message }) => message?.role === 'toolResult' && message.toolName === 'source_read'
  && Buffer.byteLength(toolText(message)) > 6000;

test('legacy multiblock native reads still match the exact durable ACK', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. ' + 'x'.repeat(7000) } }) + '\n');
  f.state.coverageMutation = async ({ params }) => {
    const rows = (await fs.readFile(params.sessionFile, 'utf8')).trimEnd().split('\n').map(JSON.parse);
    const reads = rows.filter(isLongNativeRead);
    assert(reads.length > 0);
    for (const { message } of reads) {
      assert.equal(message.content.length, 1, 'New OpenClaw results should deliver one contiguous text block');
      message.content = textBlocks(toolText(message));
    }
    await fs.writeFile(params.sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const results = bundle.nativeTranscript.split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.message?.role === 'toolResult' && row.message.toolName === 'source_read');
  const multi = results.filter(isLongNativeRead);
  for (const row of multi) {
    assert(row.message.content.length > 1);
    assert(row.message.content.every(block => block.type === 'text' && typeof block.text === 'string'));
    const ack = bundle.journalEntries.find(entry => entry.message?.toolCallId === row.message.toolCallId)?.message;
    assert.equal(ack.content.length, 1);
    assert.equal(ack.content[0].text, row.message.content.map(block => block.text).join(''));
  }
  assert.equal((await f.truth()).version, 1);
});

function missingReadReport(context) {
  const report = scriptedCoverageReport(context), row = report.sources.find(row => row.ref === 'transcript:U1');
  report.verdict = 'REPAIR'; row.disposition = 'REPAIR';
  row.issues = [{ rangeMode: 'QUOTE', supportMode: 'DIRECT', dependencyUnitIds: [],
    obligationIds: context.inventory.sources.find(source => source.ref === 'transcript:U1').units.flatMap(unit => unit.obligations.filter(duty => duty.owner === 'PROCESS').map(duty => duty.obligationId)),
    issueKind: 'CANDIDATE', expectedDuty: 'Read and follow skills/demo/SKILL.md.',
    unitId: row.mappings[0].unitId, citeIds: row.mappings[0].citeIds, quote: 'Read and follow skills/demo/SKILL.md.',
    claimIds: [], owner: 'PROCESS', condition: '', reason: 'The original read/follow duty is absent from the effective ledger.' }];
  return report;
}

for (const mixed of [false, true]) test(`an independently detected original omission repairs within one shared allowance (${mixed ? 'mixed verdict' : 'repair verdict'})`, async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. Read and follow skills/demo/SKILL.md.' } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = [operation()];
  f.state.coverageReport = context => {
    if (context.view.effectiveLedger.claims.some(claim => claim.text === 'Read and follow skills/demo/SKILL.md.')) return scriptedCoverageReport(context);
    const duty = { ...operation(), text: 'Read and follow skills/demo/SKILL.md.', verificationTarget: 'PROCESS' };
    delete duty.implementationRole;
    f.state.deltaOperations = [operation(), duty];
    const report = missingReadReport(context);
    if (mixed) {
      // The wire protocol permits omission when the sealed duty identifies one unit.
      delete report.sources.find(source => source.kind === 'USER_MESSAGE').issues[0].unitId;
      const row = report.sources.find(source => source.kind === 'MATERIAL');
      const [mapping] = row.mappings;
      report.verdict = 'UNRESOLVED';
      row.disposition = 'UNRESOLVED';
      row.mappings = [];
      row.issues = [{ ...mapping, issueKind: 'SOURCE_INVENTORY', owner: 'UNKNOWN',
        expectedDuty: 'Determine the role of this material.', reason: 'Controlled disputed inventory marker.' }];
    }
    return report;
  };
  await f.refresh();
  assert.equal((await f.truth()).claims.length, 2);
  assert.equal(f.audits().length, 2); assert.equal(f.globals().length, 1);
  assert.equal(f.state.baselinePrompts.length, 2);
  if (mixed) {
    const prompt = JSON.stringify(f.state.baselinePrompts[1]);
    assert.match(prompt, /The original read\/follow duty is absent/);
    assert.doesNotMatch(prompt, /Controlled disputed inventory marker/);
  }
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.externalRepairs, 1); assert.equal(bundle.budget.repairs, 1);
  assert.equal(bundle.budget.auditCalls, 2);
  assert.equal(bundle.budget.maxTurns, STOP_TASK_LIMITS.maxTurns);
});

test('a repeated semantic omission leaves no staged truth, cursor or certificate', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. Read and follow skills/demo/SKILL.md.' } }) + '\n');
  f.state.coverageReport = missingReadReport;
  await assert.rejects(f.refresh());
  assert.equal(f.audits().length, 2);
  assert.equal(f.state.baselinePrompts.length, 2, 'do not dispatch another repair after the final audit');
  assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
  assert.equal((await f.task()).groundTruth.sourceCursors['shared-original-basis'], undefined);
});

test('a settled truncated extractor resumes its acknowledged reads within the same generation', async t => {
  const f = await sharedBasisFixture(t);
  const calls = [];
  f.state.replayBaseline = async ({ call, readAll, params }) => {
    calls.push({ sessionId: params.sessionId, ...JSON.parse(params.prompt) });
    if (calls.length === 1) {
      await readAll();
      throw Object.assign(new Error('Controlled native output limit'), { code: 'REVIEWER_OUTPUT_LIMIT' });
    }
    const { source, ...claim } = operation();
    await call('save_baseline_batch', { batchId: 1, operations: [{ ...claim, sourceFrom: { unitId: 'S0L1' } }] });
    await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Finished the resumed candidate.' });
  };
  await f.refresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.equal(calls[1].generation, calls[0].generation);
  assert.match(calls[1].promptAppend, /output was truncated/);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.repairs, 1);
  assert.equal(bundle.budget.auditCalls, 1);
});

test('a frozen omission without new user authority does not dispatch an impossible candidate repair', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. Read and follow skills/demo/SKILL.md.' } }) + '\n');
  const { taskId } = await f.task();
  await applyGroundTruthDelta({ projectRoot: f.root, taskId, delta: { operations: [operation()] } });
  await freezeGroundTruth({ projectRoot: f.root, taskId });
  const before = await f.truth();
  f.state.coverageReport = missingReadReport;
  await assert.rejects(f.refresh(), error => error.code === 'BASELINE_FROZEN_AUTHORIZATION_REQUIRED');
  assert.equal(f.audits().length, 1);
  assert.equal(f.state.baselinePrompts.length, 1);
  assert.deepEqual(await f.truth(), before);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

test('NO_CHANGE with seen input and a missing certificate is independently audited again', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  const before = await f.truth(), task = await f.task();
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { delete state.groundTruth.sharedBasis.acceptedSourceCertificate; });
  await f.refresh();
  assert.equal(f.audits().length, 2);
  assert.deepEqual(f.state.auditInputs.at(-1).delta.operations, []);
  assert.equal((await f.truth()).digest, before.digest);
  assert((await f.task()).groundTruth.sharedBasis.acceptedSourceCertificate);
});

test('actual finish remains in program proof while complete KEEP_EXISTING semantics are disclosed and identity-bound', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  await fs.appendFile(f.material, ' Additional controlled unadopted context.');
  await f.refresh();
  const input = f.state.auditInputs.at(-1);
  assert.equal(input.finish.receipt.status, 'NO_CHANGE');
  assert(input.retainedSourceUnits.length > 0, 'exercise actual retained groups, not an empty placeholder');
  assert(input.retainedSourceUnits.every(row => row.action === 'KEEP_EXISTING'));
  assert(input.retainedSourceUnits[0].claims.length > 0, 'retain a real ACTIVE target');
  const finish = JSON.parse(await fs.readFile(path.join(input.directory, `candidates-${input.generation}/finish.json`), 'utf8'));
  const checkpoint = JSON.parse(await fs.readFile(path.join(input.directory, 'review-checkpoint.json'), 'utf8'));
  assert.deepEqual(input.finish, finish);
  assert.deepEqual(input.retainedSourceUnits, checkpoint.taskState.retainedSourceUnits);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const view = decodeBaselineAuditView(JSON.parse(bundle.files.filter(file => /^candidate-\d+\.txt$/u.test(file.path))
    .sort((a, b) => Number(a.path.slice(10, -4)) - Number(b.path.slice(10, -4))).map(file => file.text).join('')));
  assert(!Object.hasOwn(view, 'finish'));
  assert.deepEqual(bundle.input.finish, input.finish);
  assert(bundle.auxiliaryFiles.some(file => /^baseline-/.test(file.path)));
  assert(!bundle.files.some(file => /^original-(?:baseline|request)-/.test(file.path)));
  assert.deepEqual(view.retainedSourceUnits, input.retainedSourceUnits);
  const originalIdentity = coverageIdentity(input);
  const changedFinish = structuredClone(input);
  changedFinish.finish.receipt.annotation = 'changed durable control metadata';
  assert.notEqual(coverageIdentity(changedFinish).candidateDigest, originalIdentity.candidateDigest);
  await assert.rejects(verifyBaselineCoverageProof(proof.pointer, { identity: coverageIdentity(changedFinish) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && /Stale or foreign audit proof/u.test(error.message));
  const changedRetained = structuredClone(input);
  changedRetained.retainedSourceUnits[0].claims[0].digest = 'changed retained target';
  assert.throws(() => coverageIdentity(changedRetained), error => error.code === 'BASELINE_COVERAGE_UNVERIFIED'
    && /retained decisions differ from the original identity/u.test(error.message));
  changedRetained.identity.retainedSourcesDigest = sha256(changedRetained.retainedSourceUnits);
  assert.notEqual(coverageIdentity(changedRetained).candidateDigest, originalIdentity.candidateDigest);
  await assert.rejects(verifyBaselineCoverageProof(proof.pointer, { identity: coverageIdentity(changedRetained) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && /Stale or foreign audit proof/u.test(error.message));
});

test('multipart originals with no sourceUnits retain the full audit denominator', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature.\r\n' + '说明：该段为背景上下文。\r\n'.repeat(1500) } }) + '\n');
  await f.refresh();
  const input = f.state.auditInputs[0];
  assert.equal(sourceUnits(input.identity).length, 0);
  assert(input.identity.sources.find(source => source.kind === 'USER_MESSAGE').parts.length > 1);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(bundle.report.sources.length, input.identity.sources.length);
});

for (const mutation of ['one-byte', 'non-text', 'non-string-text']) test(`multiblock ${mutation} evidence is rejected for its exact proof failure`, async t => {
  const f = await sharedBasisFixture(t);
  const errors = [];
  f.state.coverageMutation = async ({ params }) => {
    const records = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const row = records.find(isLongNativeRead);
    assert(row, 'mutation requires an actual above6000-byte read');
    row.message.content = textBlocks(toolText(row.message));
    if (mutation === 'one-byte') row.message.content[0].text = (row.message.content[0].text[0] === '[' ? '{' : '[') + row.message.content[0].text.slice(1);
    if (mutation === 'non-text') row.message.content.push({ type: 'image', data: 'controlled-non-text-block' });
    if (mutation === 'non-string-text') row.message.content.push({ type: 'text', text: 42 });
    await fs.writeFile(params.sessionFile, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  await assert.rejects(refreshCapturingAuditFailure(f, errors, `bad-native-${mutation}`));
  assert.equal(errors.length, 1, 'reach the independent audit proof gate, not an earlier fixture error');
  assert.equal(errors[0].code, 'BASELINE_COVERAGE_UNVERIFIED');
  assert.match(errors[0].message, mutation === 'one-byte'
    ? /Audit ACK does not match the same native transcript call\/result/u : /Audit native result contains non-text content/u);
  assert.equal(f.audits().length, 1);
  assert.equal((await f.truth()).version, 0);
});

test('an exact interrupted stage cannot reopen its journal with zero budget counters', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageMutation = async ({ params }) => { await fs.writeFile(params.sessionFile, 'incomplete native tail'); };
  const options = { projectRoot: f.root, input: { cwd: f.root, session_id: 'basis-session', transcript_path: f.transcript,
    hook_event_name: 'Stop', hook_event_id: 'same-interrupted-stage' }, plan: f.plan, reviewerFactory: f.factory };
  await assert.rejects(refreshRuntimeRequirements(options));
  const calls = f.state.baselinePrompts.length, audits = f.audits().length;
  f.state.coverageMutation = null;
  await assert.rejects(refreshRuntimeRequirements(options));
  assert.equal(f.state.baselinePrompts.length, calls);
  assert.equal(f.audits().length, audits);
  assert.equal((await f.truth()).version, 0);
});

test('legal ADD dedup retains every operation target in the shared planner and actual apply result', async t => {
  const root = await scratch(t), task = await ensureTask({ projectRoot: root, sessionId: 'dedup' });
  const first = await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [operation()] } });
  const delta = { operations: [operation(), operation()] }, plan = planGroundTruthDelta({ current: first.current, delta });
  assert.equal(plan.accepted.length, 0); assert.equal(plan.operationDispositions.length, 2);
  for (const row of plan.operationDispositions) {
    assert.equal(row.disposition, 'DEDUPLICATED');
    assert.equal(row.target.claimId, first.current.claims[0].claimId);
    assert.equal(row.target.revisionId, first.current.claims[0].revisionId);
    assert.equal(row.target.digest, sha256(first.current.claims[0]));
    assert.deepEqual(row.effectiveTarget, row.target);
  }
  const actual = await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta });
  assert.deepEqual(actual.operationDispositions, plan.operationDispositions);
  const altered = structuredClone(plan); altered.operationDispositions[0].target.digest = 'wrong';
  assert.notEqual(groundTruthPlanDigest(altered), plan.digest);
});

for (const fault of ['zero-write', 'short-write', 'fsync']) test(`journal ${fault} poisons future acceptance and preserves failed bytes`, async t => {
  const root = await scratch(t), journal = new ObservationJournal(root), before = journal.verify();
  if (fault === 'fsync') t.mock.method(fsSync, 'fsyncSync', () => { throw new Error('Controlled fsync failure'); });
  else {
    const write = fsSync.writeSync;
    t.mock.method(fsSync, 'writeSync', (fd, buffer, offset, length) => fault === 'zero-write' ? 0 : write(fd, buffer, offset, length - 1));
  }
  assert.throws(() => journal.append({ content: '中文\r\n' }), { code: 'JOURNAL_UNCERTAIN' });
  assert.equal(journal.getEntries().length, 0);
  t.mock.restoreAll();
  assert.throws(() => journal.append({ content: 'Cannot recover with zero counters' }), { code: 'JOURNAL_UNCERTAIN' });
  assert.throws(() => journal.verify(), { code: 'JOURNAL_UNCERTAIN' });
  assert((await fs.stat(before.path)).size >= before.bytes);
});

test('journal accounts for exact UTF8 byte lengths and refuses uncertain restoration', async t => {
  const root = await scratch(t), journal = new ObservationJournal(root);
  journal.append({ text: '中文\r\n😀' });
  const proof = journal.verify();
  assert.equal(proof.bytes, (await fs.readFile(journal.file)).length);
  const before = await fs.readFile(journal.file);
  assert.throws(() => new ObservationJournal(root), { code: 'JOURNAL_UNCERTAIN' });
  assert.deepEqual(await fs.readFile(journal.file), before);
});

test('extractor and checker debit one original turn pool and cannot mint a third turn', async t => {
  const root = await scratch(t), frozen = path.join(root, 'frozen'); await fs.mkdir(frozen);
  await fs.writeFile(path.join(frozen, 'source.txt'), 'Original.');
  const worker = await createBaselineWorker({ root: frozen, outputDir: root,
    identity: { requestId: 'shared-budget', taskId: 'budget-task', protocol: BASELINE_EXTRACTION_PROTOCOL, sources: [], sourceCatalog: [] },
    requiredFiles: ['source.txt'], schema: GROUND_TRUTH_REVIEW_SCHEMA, active() {}, assertCurrent() {},
    maxTurns: 2, maxRepairs: 3, deadlineAt: Date.now() + 10000, nativeRun: async () => {} });
  worker.budget.consumeTurn('extractor', { runId: 'actor', sessionId: 'actor' });
  worker.budget.beginAudit({ runId: 'checker', sessionId: 'checker' }, 'candidate');
  worker.budget.consumeTurn('checker', { runId: 'checker', sessionId: 'checker' });
  assert.equal(worker.budget.snapshot().turns, 2);
  assert.deepEqual(worker.budget.snapshot().consumers, { extractor: 1, checker: 1 });
  assert.throws(() => worker.budget.consumeTurn('extractor'), { code: 'TURN_LIMIT' });
  assert.throws(() => worker.budget.snapshot(), { code: 'TURN_LIMIT' });
  await worker.close();
});

test('configured 2000-step pool passes the old 200-step boundary and stops both consumers at the configured cap', async t => {
  const root = await scratch(t), frozen = path.join(root, 'frozen'); await fs.mkdir(frozen);
  await fs.writeFile(path.join(frozen, 'source.txt'), 'Original.');
  const worker = await createBaselineWorker({ root: frozen, outputDir: root,
    identity: { requestId: 'large-shared-budget', taskId: 'budget-task', protocol: BASELINE_EXTRACTION_PROTOCOL, sources: [], sourceCatalog: [] },
    requiredFiles: ['source.txt'], schema: GROUND_TRUTH_REVIEW_SCHEMA, active() {}, assertCurrent() {},
    maxTurns: 2000, maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000,
    deadlineAt: Date.now() + 86400000, nativeRun: async () => {} });
  worker.budget.beginAudit({ runId: 'checker', sessionId: 'checker' }, 'candidate');
  for (let i = 0; i < 2000; i++) worker.budget.consumeTurn(i % 2 ? 'checker' : 'extractor',
    i % 2 ? { runId: 'checker', sessionId: 'checker' } : { runId: 'actor', sessionId: 'actor' });
  assert.equal(worker.budget.snapshot().turns, 2000);
  assert.deepEqual(worker.budget.snapshot().consumers, { extractor: 1000, checker: 1000 });
  assert.throws(() => worker.budget.consumeTurn('checker', { runId: 'checker', sessionId: 'checker' }), { code: 'TURN_LIMIT' });
  assert.throws(() => worker.budget.consumeTurn('extractor'), { code: 'TURN_LIMIT' });
  await worker.close();
});


async function nativeAuditAttempt(params, tools, name, args, id) {
  params.onAssistantMessageStart();
  await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }] } }) + '\n');
  const result = await tools.find(tool => tool.name === name).execute(id, args);
  await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: id,
    toolName: name, content: result.content, isError: Boolean(result.isError) } }) + '\n');
  return result;
}

for (const nativeIsError of [true, false]) test(`a failed audit page read remains an owned negative transaction with native isError=${nativeIsError}`, async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageAfterInventory = async ({ params, tools }) => {
    const result = await nativeAuditAttempt(params, tools, 'source_read', { path: 'candidate-0.txt', offset: 2 }, 'invalid-candidate-page');
    assert.equal(result.isError, true); assert.equal(result.details?.citation, undefined);
    const feedback = JSON.parse(result.content[0].text);
    assert.equal(feedback.code, 'SOURCE_READ_RANGE_INVALID');
    if (!nativeIsError) {
      const rows = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      rows.find(row => row.message?.toolCallId === 'invalid-candidate-page').message.isError = false;
      await fs.writeFile(params.sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
  };
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const denied = bundle.disclosures.find(row => row.toolCallId === 'invalid-candidate-page');
  assert.equal(denied.phase, 'DENIED'); assert.equal(denied.isError, true);
  assert(bundle.citations.some(row => row.path === 'candidate-0.txt' && row.start === 1));
  assert(!bundle.citations.some(row => row.path === 'candidate-0.txt' && row.start === 2));
});

test('a native success flag cannot hide candidate content behind an owned denial', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageBeforeInventory = async ({ params, tools }) => {
    await nativeAuditAttempt(params, tools, 'source_read', { path: 'candidate-0.txt' }, 'tampered-early-read');
    const rows = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const message = rows.find(row => row.message?.toolCallId === 'tampered-early-read').message;
    message.isError = false; message.content = [{ type: 'text', text: '{"accepted":true,"text":"unexpected candidate content"}' }];
    await fs.writeFile(params.sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  await assert.rejects(f.refresh()); assert.equal((await f.truth()).version, 0);
});

for (const missing of ['native-append', 'genuine-persist-hook']) test(`inventory generic callback cannot unlock phase two without ${missing}`, async t => {
  const f = await sharedBasisFixture(t); let observed = false;
  if (missing === 'native-append') f.state.coveragePersistInventory = false;
  else f.state.coverageObserveInventory = false;
  f.state.coverageOnInventory = ({ params, request, inventoryResult }) => {
    const receipt = JSON.parse(inventoryResult.content[0].text);
    assert.equal(receipt.accepted, true); assert.equal(receipt.complete, false);
    assert.equal(receipt.phase, 'INVENTORY_SEALED'); assert.equal(receipt.nextAction.navigationOnly, true);
    assert.equal(receipt.nextAction.tool, 'source_read'); assert.equal(receipt.nextAction.path, request.phaseTwoManifest);
    assert.equal(receipt.nextAction.offset, 1);
    assert.match(receipt.nextAction.instruction, /next assistant response of this SAME invocation/);
    assert.match(receipt.nextAction.instruction, /genuinely persisted and appended/);
    assert.match(receipt.nextAction.instruction, /Do not await a new user\/host message/);
    assert.equal(params.abortSignal.aborted, false, 'Inventory never completes or aborts the SDK'); observed = true;
  };
  await assert.rejects(f.refresh()); assert.equal(observed, true);
  assert.equal(f.audits().length, 1); assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

test('source-only paths and every search tool deny candidate/control access without leaking and bounded continuation succeeds', async t => {
  const f = await sharedBasisFixture(t), attempts = [];
  f.state.coverageBeforeInventory = async ({ params, tools, request }) => {
    assert(request.requiredFiles.every(file => file.startsWith('original-source-') || file.startsWith('unit-catalog-')));
    assert(!Object.hasOwn(request, 'candidateViewProtocol'));
    const rows = [['source_read', { path: 'candidate-0.txt' }], ['source_read', { path: request.phaseTwoManifest }],
      ['source_read', { path: 'original-request-0000.txt' }], ['source_read', { path: 'original-baseline-0.txt' }],
      ['source_read', { path: './' + request.requiredFiles[0] }], ['source_read', { path: '../coverage-source/' + request.requiredFiles[0] }],
      ['source_read', { path: path.join(path.dirname(params.sessionFile), 'coverage-source', request.requiredFiles[0]) }],
      ['source_grep', { pattern: '.', path: '.' }], ['source_find', { pattern: '*' }], ['source_ls', { path: '.' }]];
    for (const [index, [name, args]] of rows.entries()) {
      const result = await nativeAuditAttempt(params, tools, name, args, `early-denied-${index}`);
      assert.equal(result.isError, true); assert.equal(result.details?.citation, undefined);
      const text = result.content.map(block => block.text).join('');
      assert.doesNotMatch(text, /Preserve the requested feature\.|requirements-[a-f0-9]{16}/u);
      attempts.push(result);
    }
  };
  await f.refresh(); assert.equal(attempts.length, 10);
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  assert(bundle.journalEntries.some(entry => entry.message?.role === 'historical_observation'
    && entry.message.content.includes('before a later assistant response')));
  assert.equal(bundle.budget.auditCalls, 1); assert.equal(bundle.budget.externalRepairs, 0);
});

test('same-assistant-batch inventory plus candidate read stays denied even after inventory append; exact replay keeps first commitment', async t => {
  const f = await sharedBasisFixture(t); let originalId, sameArgs, originalNextAction, sameId = 'same-batch-candidate';
  f.state.coverageRepeatInventoryIdentity = true;
  f.state.coverageOnInventory = async ({ params, tools, request, inventoryId, inventoryResult }) => {
    originalId = inventoryId; sameArgs = { path: 'candidate-0.txt' };
    originalNextAction = JSON.parse(inventoryResult.content[0].text).nextAction;
    assert.equal(originalNextAction.path, request.phaseTwoManifest);
    const rows = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const call = rows.find(row => row.message?.role === 'assistant' && row.message.content.some(block => block.id === inventoryId));
    call.message.content.push({ type: 'toolCall', id: sameId, name: 'source_read', arguments: sameArgs });
    await fs.writeFile(params.sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.equal(JSON.parse(inventoryResult.content[0].text).complete, false);
    assert.equal((await tools.find(tool => tool.name === 'source_read').execute(sameId, sameArgs)).isError, true);
    assert.equal(params.abortSignal.aborted, false, 'Genuine hook is pre-append, not final completion');
  };
  f.state.coverageAfterInventory = async ({ params, tools, inventoryArgs, inventoryResult }) => {
    const denied = await tools.find(tool => tool.name === 'source_read').execute(sameId, sameArgs);
    assert.equal(denied.isError, true, 'Even an appended inventory ACK cannot make its earlier assistant batch causal');
    await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: sameId,
      toolName: 'source_read', content: denied.content, isError: true } }) + '\n');
    const replay = await nativeAuditAttempt(params, tools, 'commit_baseline_inventory', inventoryArgs, 'late-exact-replay');
    assert.deepEqual(replay.content, inventoryResult.content); assert.equal(replay.isError, false);
    const foreign = await nativeAuditAttempt(params, tools, 'commit_baseline_inventory',
      { ...inventoryArgs, identityDigest: 'different-identity' }, 'late-foreign-identity');
    assert.equal(foreign.isError, true);
    assert.match(foreign.content[0].text, /Repeated source inventory identity differs/u);
    const amended = structuredClone(inventoryArgs); amended.inventory.sources[0].units[0].reason += ' changed after source-only commitment';
    assert.equal((await nativeAuditAttempt(params, tools, 'commit_baseline_inventory', amended, 'late-amendment')).isError, true);
    assert.equal(params.abortSignal.aborted, false);
  };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  assert.equal(bundle.inventory.record.toolCallId, originalId); assert.equal(bundle.inventory.nativeToolCallId, originalId);
  assert.equal(bundle.inventory.record.repeatedIdentity, true);
  assert.equal(bundle.inventory.record.receipt.complete, false); assert.equal(bundle.finish.record.receipt.complete, true);
  assert.deepEqual(bundle.inventory.record.receipt.nextAction, originalNextAction);
  assert.equal(bundle.budget.auditCalls, 1);
  assert.equal(bundle.report.inventoryDigest, sha256(bundle.inventory.record.inventory));
  const messages = bundle.nativeTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line).message).filter(Boolean);
  assert(messages.findIndex(message => message.toolCallId === 'late-exact-replay') > bundle.inventory.position.result);
});

test('proof replay rejects inventory tampering and successful pre-commit disclosures even with a late identical inventory replay', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  const pointer = (await f.task()).groundTruth.sharedBasis.coverageAudit.pointer;
  const original = await verifyBaselineCoverageProof(pointer);
  for (const mutate of [bundle => { bundle.inventory.record.inventory.sources[0].units[0].reason += ' forged'; },
    bundle => { bundle.inventory.position.result++; }, bundle => { bundle.report.inventoryDigest = 'foreign'; },
    bundle => {
      const rows = bundle.nativeTranscript.split('\n').filter(Boolean).map(JSON.parse), id = 'forged-success-before-commit';
      const inventoryIndex = rows.findIndex(row => row.message?.role === 'assistant' && row.message.content.some(block => block.name === 'commit_baseline_inventory'));
      rows.splice(inventoryIndex, 0,
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'source_grep', arguments: { pattern: '.', path: '.' } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'source_grep', content: [{ type: 'text', text: 'Actual successful candidate content leak' }], isError: false } });
      bundle.inventory.position.call += 2; bundle.inventory.position.result += 2;
      bundle.disclosures.push({ toolCallId: id, name: 'source_grep', args: { pattern: '.', path: '.' },
        phase: 'CANDIDATE', callIndex: inventoryIndex - 1, isError: false });
      rows.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'late-inventory-forgery',
        name: 'commit_baseline_inventory', arguments: { inventory: bundle.inventory.record.inventory } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: 'late-inventory-forgery', toolName: 'commit_baseline_inventory',
          content: [{ type: 'text', text: JSON.stringify(bundle.inventory.record.receipt) }], isError: false } });
      bundle.nativeTranscript = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    }]) {
    const bundle = structuredClone(original); mutate(bundle);
    const bytes = Buffer.from(JSON.stringify(bundle)), file = path.join(path.dirname(pointer.path), `${sha256(bundle)}.json`);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(bundle), bytesDigest: sha256(bytes) }), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  }
  await verifyBaselineCoverageProof(pointer);
});
