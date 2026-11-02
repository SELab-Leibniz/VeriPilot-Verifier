import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sharedBasisFixture as createSharedBasisFixture, operation, user } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { scriptedCoverageReport, scriptedSourceInventory } from './helpers/baseline-coverage-native.mjs';
import { verifyBaselineCoverageProof, coverageIdentity, validateBaselineAuditReport, validateBaselineSourceInventory, decodeBaselineAuditView, BASELINE_COVERAGE_INSTRUCTIONS, BASELINE_AUDIT_VIEW_PROTOCOL } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { planGroundTruthDelta, groundTruthPlanDigest, applyGroundTruthDelta } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { ObservationJournal } from '../lib/review-task/observation-journal.mjs';
import { createBaselineWorker, BASELINE_EXTRACTION_PROTOCOL } from '../lib/review-task/baseline-task.mjs';
import { sourceUnits } from '../lib/review-task/baseline-selection.mjs';
import { withTaskState, ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { STOP_TASK_LIMITS } from '../lib/review-task/stop-policy.mjs';
import { listNativeRuns } from '../lib/openclaw/native-runs.mjs';

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

test('first-use native audit publishes full evidence and reuses only the unchanged strong basis', async t => {
  const f = await sharedBasisFixture(t);
  await f.refresh();
  const truth = await f.truth(), task = await f.task();
  assert.equal(truth.version, 1); assert.equal(f.audits().length, 1);
  const proof = task.groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { identity: proof.identity, truth });
  assert.notEqual(bundle.nativeRecord.sessionId, bundle.input.extractorSettlement.sessionId);
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

test('multi-target issues repair both document owners in the original shared allowance and preserve CONTEXT', async t => {
  const f = await sharedBasisFixture(t);
  const wrong = ['Write the usage guide.', 'Write the reference guide.'].map(text => ({ ...operation(), text }));
  const corrected = wrong.map(({ implementationRole, ...row }) => ({ ...row, verificationTarget: 'ARTIFACT' }));
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: wrong.map(row => row.text).join(' ') } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = wrong;
  let feedbackTargets;
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
    row.mappings = []; f.state.deltaOperations = corrected;
    return value;
  };
  await f.refresh();
  assert.equal(f.audits().length, 2);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const candidateFiles = bundle.files.filter(file => file.path.startsWith('candidate-'));
  const disclosure = JSON.parse(candidateFiles.map(file => file.text).join(''));
  assert.equal(disclosure.protocol, BASELINE_AUDIT_VIEW_PROTOCOL);
  // This is the pre-codec full view built independently from the raw bundle.
  assert.deepEqual(decodeBaselineAuditView(disclosure), JSON.parse(JSON.stringify({
    identity: coverageIdentity(bundle.input), sources: bundle.input.identity.sources, instructions: BASELINE_COVERAGE_INSTRUCTIONS,
    delta: bundle.input.delta, batches: bundle.input.batches, finish: bundle.input.finish,
    retainedSourceUnits: bundle.input.retainedSourceUnits, effectiveLedger: bundle.input.plan.current, plan: bundle.input.plan,
  })));
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
  f.state.deltaOperations = [{ ...wrong[0], expectedFiles: ['not-named-in-original.txt'] }, wrong[1]];
  f.state.afterBaseline = () => { f.state.deltaOperations = wrong; };
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
  assert.equal(bundle.budget.auditCalls, 2); assert.equal(bundle.input.generation, 2);
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
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    for (const source of report.sources) for (const mapping of source.mappings) { mapping.rangeMode = 'UNIT'; delete mapping.quote; }
    return report;
  };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer, { truth: await f.truth() });
  assert.equal(bundle.input.unitLayout.maxBytes, 16384); assert.equal(bundle.identity.unitLayout.maxBytes, 16384);
  const inventory = bundle.inventory.record.inventory.sources.find(row => row.kind === 'USER_MESSAGE');
  assert.equal(inventory.units.length, 1); assert.equal(bundle.input.identity.sources[0].bytes, Buffer.byteLength(text));
  assert(bundle.initialContext.prompt.includes('at most 16384 bytes'));
  assert.equal(bundle.report.verdict, 'PASS');
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

test('expanded audit allowance retains an unresolved report and retries source-first without changing the candidate or resetting counters', async t => {
  const f = await sharedBasisFixture(t, { baselineLimits: { timeoutMs: 86400000, maxSteps: 2000,
    maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000 } });
  let attempts = 0;
  f.state.coverageReport = context => {
    const report = scriptedCoverageReport(context);
    if (++attempts > 1) return report;
    const row = report.sources.find(source => source.kind === 'USER_MESSAGE');
    report.verdict = 'UNRESOLVED'; row.disposition = 'UNRESOLVED';
    row.issues = row.mappings.map(mapping => ({ ...mapping, issueKind: 'SOURCE_INVENTORY', owner: 'UNKNOWN',
      expectedDuty: 'Preserve the requested feature.', reason: 'Controlled first-auditor uncertainty; not a candidate defect or acceptance.' }));
    row.mappings = []; return report;
  };
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(attempts, 2); assert.equal(bundle.budget.auditCalls, 2);
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

test('original citation rejection identifies the unit and catalog citation without granting an original read or changing the inventory', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  const inventory = structuredClone(bundle.inventory.record.inventory), unit = inventory.sources[0].units[0];
  const catalog = bundle.citations.find(cite => cite.path.startsWith('unit-catalog-'));
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

test('an audit disclosure gap identifies the actual unread file and requires its native receipt before the same audit finishes', async t => {
  const f = await sharedBasisFixture(t); let repairs = 0;
  f.state.coverageSkipRead = file => file === 'original-baseline-0000.txt';
  f.state.coverageRepairReport = async context => {
    const feedback = JSON.parse(context.result.content[0].text);
    assert.equal(feedback.validation.reason, 'AUDIT_DISCLOSURE_GAP');
    assert.deepEqual(feedback.validation.recoverWith, [{ tool: 'source_read', path: 'original-baseline-0000.txt', offset: 1 }]);
    await context.readFile(feedback.validation.recoverWith[0].path); repairs++;
    return scriptedCoverageReport(context);
  };
  await f.refresh(); assert.equal(repairs, 1);
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  assert.equal(bundle.budget.auditCalls, 1);
  assert(bundle.citations.some(cite => cite.path === 'original-baseline-0000.txt'));
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
  f.state.sourceFrom = true;
  f.state.deltaOperations = [{ ...operation(), expectedFiles: ['not-named-in-original.txt'] }];
  await assert.rejects(f.refresh(), /baseline extraction failed/);
  assert.equal((await f.truth()).version, 0); assert.equal(f.audits().length, 0);
  assert.equal(f.state.baselinePrompts.length, limit + 1);
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

test('above6000-byte native text blocks match the exact one-block durable ACK without normalization', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. ' + 'x'.repeat(7000) } }) + '\n');
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const results = bundle.nativeTranscript.split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.message?.role === 'toolResult' && row.message.toolName === 'source_read');
  const multi = results.filter(row => row.message.content.length > 1 && Buffer.byteLength(row.message.content.map(block => block.text).join('')) > 6000);
  assert(multi.length > 0, 'the production source tool must really emit multiple blocks');
  for (const row of multi) {
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

test('an independently detected original omission repairs the same extractor within one shared allowance', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. Read and follow skills/demo/SKILL.md.' } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = [operation()];
  f.state.coverageReport = context => {
    if (context.view.effectiveLedger.claims.some(claim => claim.text === 'Read and follow skills/demo/SKILL.md.')) return scriptedCoverageReport(context);
    const duty = { ...operation(), text: 'Read and follow skills/demo/SKILL.md.', verificationTarget: 'PROCESS' };
    delete duty.implementationRole;
    f.state.deltaOperations = [operation(), duty];
    return missingReadReport(context);
  };
  await f.refresh();
  assert.equal((await f.truth()).claims.length, 2);
  assert.equal(f.audits().length, 2); assert.equal(f.globals().length, 1);
  assert.equal(f.state.baselinePrompts.length, 2);
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
  assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
  assert.equal((await f.task()).groundTruth.sourceCursors['shared-original-basis'], undefined);
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

test('actual finish and KEEP_EXISTING decisions are fully read and bound into the candidate identity', async t => {
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
  assert.deepEqual(view.finish, input.finish);
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
    const row = records.find(row => row.message?.role === 'toolResult' && row.message.toolName === 'source_read'
      && row.message.content.length > 1 && Buffer.byteLength(row.message.content.map(block => block.text).join('')) > 6000);
    assert(row, 'mutation requires an actual above6000-byte multiblock result');
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
    const amended = structuredClone(inventoryArgs); amended.inventory.sources[0].units[0].reason += ' changed after source-only commitment';
    assert.equal((await nativeAuditAttempt(params, tools, 'commit_baseline_inventory', amended, 'late-amendment')).isError, true);
    assert.equal(params.abortSignal.aborted, false);
  };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  assert.equal(bundle.inventory.record.toolCallId, originalId); assert.equal(bundle.inventory.nativeToolCallId, originalId);
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
