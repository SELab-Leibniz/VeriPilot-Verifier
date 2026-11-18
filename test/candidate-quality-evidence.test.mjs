import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { gradeArkts, parseHypium } from '../scripts/bench/hypium-results.mjs';
import { candidateQualityInputKind, readCandidateQualityEvidence } from '../scripts/bench/candidate-quality-evidence.mjs';
import { arktsInstrumentRuntime, parseArktsInstrumentResults } from '../scripts/bench/arkts-instrument-results.mjs';

const sha = letter => letter.repeat(64);
const git = letter => letter.repeat(40);
const caseIds = { f2p: ['entry::Feature::mustWork'], p2p: ['entry::Regression::stillWorks'] };
const logCase = (klass, name, pass) => `[Hypium]start running case '${name}'\nOHOS_REPORT_STATUS: class=${klass}\n[Hypium][${pass ? 'pass' : 'fail'}]${name};\n`;
const completeLog = logCase('Feature', 'mustWork', false) + logCase('Regression', 'stillWorks', true) + '[Hypium][end] run suites end\n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-quality-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function save(file, value) {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value, null, 2) + '\n');
    await fs.writeFile(path.join(root, file), bytes);
    return { file, sha256: digest(bytes) };
  }
  const expected = { instanceId: 'fictional-task', baseCommit: git('a'), datasetSha256: sha('b'),
    publicInputSha256: sha('c'), packageSha256: sha('d'), sourceCommit: git('e'), rcEnabled: false };
  const instance = { id: expected.instanceId, baseCommit: expected.baseCommit, datasetDigest: expected.datasetSha256 };
  const candidate = await save('candidate.patch', 'diff --git a/src/a.mjs b/src/a.mjs\n');
  const session = await save('session.jsonl', '{"role":"assistant"}\n');
  const workspacePatch = await save('workspace.patch', 'frozen full workspace patch\n');
  const freeze = { commit: git('f'), commitSha256: sha('a'), preparedHead: git('b'), patchSha256: candidate.sha256,
    sessionSha256: session.sha256, workspacePatchSha256: workspacePatch.sha256, mutationPaths: ['src/a.mjs'] };
  const result = { instance, publicInputSha256: expected.publicInputSha256, packageSha256: expected.packageSha256,
    rcEnabled: false, state: 'finished', businessNatural: false, reason: 'OPENSPEC_APPLY_INCOMPLETE', frozen: freeze,
    requiredChecks: { lint: { status: 'NOT_RUN' } } };
  const manifest = { instance, publicInputSha256: expected.publicInputSha256, packageSha256: expected.packageSha256,
    sourceCommit: expected.sourceCommit, rcEnabled: false, preparedHead: freeze.preparedHead };
  const business = { result: await save('result.json', result), manifest: await save('manifest.json', manifest),
    freeze: await save('freeze.json', freeze), candidate, session, workspacePatch };
  const execution = { freshReport: true, compileSucceeded: true, timedOut: false };
  function rawGrade(coverage = completeLog, edits = {}) {
    return { kind: 'hidden-test-candidate-grade', instanceId: expected.instanceId, baseCommit: expected.baseCommit,
      candidateSha256: candidate.sha256, calibrationDirectory: '/pinned/calibration',
      environment: { datasetDigest: expected.datasetSha256, testPatchSha256: sha('f'), toolchain: { sha256: sha('a') } },
      results: [{ phase: 'candidate', ...gradeArkts({ instance_id: expected.instanceId,
        FAIL_TO_PASS: caseIds.f2p, PASS_TO_PASS: caseIds.p2p }, parseHypium(coverage), execution) }], ...edits };
  }
  const grade = rawGrade();
  const grading = { provenance: 'DIAGNOSTIC', parser: 'HYPIUM', toolchainSha256: sha('a'), testPatchSha256: sha('f'),
    calibrationDirectory: '/pinned/calibration', expectedCases: structuredClone(caseIds),
    record: await save('grade.json', grade), coverage: await save('coverage.log', completeLog) };
  const slot = { id: 'off/repetition-1', stage: 'TERMINAL', expected, business, grading };
  async function read(slots = [slot]) {
    const ref = await save('inputs.json', { kind: candidateQualityInputKind, experimentId: 'fictional-experiment', slots });
    return readCandidateQualityEvidence(path.join(root, ref.file), ref.sha256);
  }
  return { root, save, expected, instance, candidate, session, freeze, result, manifest, business, execution, grade, grading, slot, rawGrade, read };
}

test('retains a failed workflow candidate as diagnostic quality without awarding formal credit', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.root, 'result.json'));
  const report = await f.read();
  assert.equal(report.formalEligibility, 'NOT_EVALUATED');
  assert.equal(report.formalPairsAdded, 0);
  assert.equal(report.summary.plannedSlots, 1);
  assert.equal(report.summary.statuses.GRADE_COMPLETE, 1);
  assert.deepEqual(report.summary.slotsWithCompleteGradesByProvenance, { FORMAL_CAMPAIGN: 0, DIAGNOSTIC: 1 });
  assert.equal(report.rows[0].workflow.businessCompleted, false);
  assert.equal(report.rows[0].workflow.completionReason, 'OPENSPEC_APPLY_INCOMPLETE');
  assert.deepEqual(report.rows[0].quality, { f2p: { passed: 0, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: false });
  assert(!Object.hasOwn(report.rows[0], 'score'));
  assert((await fs.readFile(path.join(f.root, 'result.json'))).equals(before));
});

test('keeps an existing formal receipt and diagnostic provenance distinct without inferring pairing eligibility', async t => {
  const f = await fixture(t);
  const formal = structuredClone(f.slot);
  formal.id = 'another-formal-trial';
  formal.business.result = await f.save('formal-result.json', { ...f.result, businessNatural: true, reason: null });
  formal.grading.provenance = 'FORMAL_CAMPAIGN';
  formal.grading.calibrationSha256 = sha('e');
  formal.grading.campaignSlot = { id: f.expected.instanceId, repetition: 2, arm: 'off' };
  formal.grading.campaignReceipt = await f.save('formal-receipt.json', {
    version: 1, slot: formal.grading.campaignSlot, businessResultSha256: formal.business.result.sha256,
    input: { id: f.expected.instanceId, baseCommit: f.expected.baseCommit, datasetSha256: f.expected.datasetSha256,
      candidateSha256: f.candidate.sha256, toolchainSha256: f.grading.toolchainSha256, releaseCommit: f.expected.sourceCommit,
      calibrationSha256: sha('e') }, gradeSha256: f.grading.record.sha256, coverageSha256: f.grading.coverage.sha256,
    execution: { exitCode: 1, interrupted: false, outputComplete: true },
    score: { f2p: { passed: 0, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: false },
  });
  const report = await f.read([f.slot, formal]);
  assert.deepEqual(report.summary.slotsWithCompleteGradesByProvenance, { FORMAL_CAMPAIGN: 1, DIAGNOSTIC: 1 });
  assert.equal(report.formalPairsAdded, 0);
  assert.equal(report.formalEligibility, 'NOT_EVALUATED');
  assert.equal(report.rows[0].workflow.businessCompleted, false);
  assert.equal(report.rows[1].workflow.businessCompleted, true);
  const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'formal-receipt.json')));
  formal.grading.campaignReceipt = await f.save('bad-formal-receipt.json', { ...receipt, gradeSha256: sha('d') });
  assert.equal((await f.read([formal])).rows[0].reason, 'CAMPAIGN_RECEIPT_BINDING_MISMATCH');
});

test('all fixed slots remain in the denominator when unstarted, resultless, unfrozen or awaiting a grade', async t => {
  const f = await fixture(t);
  const noFreezeResult = { ...f.result, frozen: null, state: 'stopped' };
  const noFreezeBusiness = { result: await f.save('no-freeze-result.json', noFreezeResult), manifest: f.business.manifest };
  const report = await f.read([
    { id: 'unstarted', stage: 'UNSTARTED', expected: f.expected },
    { id: 'no-result', stage: 'STARTED', expected: f.expected },
    { id: 'unfrozen', stage: 'TERMINAL', expected: f.expected, business: noFreezeBusiness },
    { ...f.slot, id: 'pending', grading: undefined },
  ]);
  assert.equal(report.summary.plannedSlots, 4);
  assert.deepEqual(report.rows.map(row => row.status), ['UNSTARTED', 'NO_RESULT', 'NO_FROZEN_PATCH', 'GRADING_PENDING']);
  assert.equal(Object.values(report.summary.statuses).reduce((a, b) => a + b, 0), 4);
  assert(report.rows.every(row => row.quality === null));
  assert.equal(report.summary.sealedPatchVerified, 1);
});

test('partial raw reports preserve missing counts without a complete quality score', async t => {
  const f = await fixture(t);
  const partialLog = logCase('Feature', 'mustWork', true);
  f.slot.grading.record = await f.save('partial-grade.json', f.rawGrade(partialLog));
  f.slot.grading.coverage = await f.save('partial-coverage.log', partialLog);
  const report = await f.read();
  assert.equal(report.rows[0].status, 'GRADE_PARTIAL');
  assert.equal(report.rows[0].quality, null);
  assert.equal(report.rows[0].observation.counts.f2p.passed, 1);
  assert.equal(report.rows[0].observation.counts.p2p.missing, 1);
  assert.equal(report.summary.slotsWithCompleteGradesByProvenance.DIAGNOSTIC, 0);
});

test('a missing pinned file is distinct from an unstarted slot and never disappears', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, 'coverage.log'));
  const report = await f.read();
  assert.equal(report.rows[0].status, 'EVIDENCE_MISSING');
  assert.equal(report.rows[0].reason, 'PINNED_FILE_MISSING');
  assert.equal(report.summary.plannedSlots, 1);
  assert.equal(report.summary.sealedPatchVerified, 1);
  assert.equal(report.rows[0].quality, null);
});

test('changed evidence bytes are invalid even when they would improve the result', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'candidate.patch'), 'better candidate');
  const report = await f.read();
  assert.equal(report.rows[0].status, 'INVALID_EVIDENCE');
  assert.equal(report.rows[0].reason, 'PINNED_FILE_HASH_MISMATCH');
  assert.equal(report.summary.sealedPatchVerified, 0);
  assert.equal(report.rows[0].quality, null);
});

test('re-pinned but mismatched task, freeze and grader identities are rejected', async t => {
  const f = await fixture(t);
  for (const [file, modified, role, reason] of [
    ['result.json', { ...f.result, instance: { ...f.instance, id: 'another-task' } }, 'result', 'BUSINESS_TASK_IDENTITY_MISMATCH'],
    ['freeze.json', { ...f.freeze, preparedHead: git('c') }, 'freeze', 'FREEZE_RESULT_MISMATCH'],
  ]) {
    const slot = structuredClone(f.slot);
    slot.business[role] = await f.save(`different-${file}`, modified);
    const report = await f.read([slot]);
    assert.equal(report.rows[0].reason, reason);
    assert.equal(report.rows[0].status, 'INVALID_EVIDENCE');
  }
  f.slot.grading.record = await f.save('different-grade.json', { ...f.grade, candidateSha256: sha('c') });
  assert.equal((await f.read()).rows[0].reason, 'GRADE_CANDIDATE_IDENTITY_MISMATCH');
});

test('raw outcome recomputation rejects a plausible complete grade bound to different report bytes', async t => {
  const f = await fixture(t);
  f.slot.grading.coverage = await f.save('different-coverage.log', completeLog.replace('[fail]', '[pass]'));
  const report = await f.read();
  assert.equal(report.rows[0].status, 'INVALID_EVIDENCE');
  assert.equal(report.rows[0].reason, 'GRADE_RAW_REPORT_MISMATCH');
  assert.equal(report.rows[0].quality, null);
});

test('a repinned false complete report and duplicate expected case identities cannot inflate counts', async t => {
  const f = await fixture(t);
  const invalid = structuredClone(f.grade);
  invalid.results[0].f2p.passed = [caseIds.f2p[0], caseIds.f2p[0]];
  f.slot.grading.record = await f.save('duplicate-grade.json', invalid);
  assert.equal((await f.read()).rows[0].reason, 'GRADE_RAW_REPORT_MISMATCH');
  f.slot.grading.expectedCases.p2p = [...f.slot.grading.expectedCases.f2p];
  await assert.rejects(f.read(), /Expected test identities/);
});

test('input digest and unique slot validation reject denominator changes', async t => {
  const f = await fixture(t);
  const ref = await f.save('inputs.json', { kind: candidateQualityInputKind, experimentId: 'experiment', slots: [f.slot] });
  await assert.rejects(readCandidateQualityEvidence(path.join(f.root, ref.file), sha('a')), /inputs changed/);
  await assert.rejects(f.read([f.slot, f.slot]), /slot identities must be unique/);
  await assert.rejects(f.read([f.slot, { ...f.slot, id: 'duplicate-business-proof' }]), /business result may belong to only one/);
  await assert.rejects(f.read([{ ...f.slot, stage: 'UNSTARTED' }]), /Only a terminal frozen/);
});

test('instrument results require the pinned suite and runner and preserve all expected outcomes', async t => {
  const f = await fixture(t);
  const frame = (klass, name, current, code) => `OHOS_REPORT_STATUS: id=JS\nOHOS_REPORT_STATUS: numtests=2\nOHOS_REPORT_STATUS: class=${klass}\nOHOS_REPORT_STATUS: current=${current}\nOHOS_REPORT_STATUS: test=${name}\nOHOS_REPORT_STATUS_CODE: ${code}\n`;
  const coverage = frame('Feature', 'mustWork', 1, 1) + frame('Feature', 'mustWork', 1, -2)
    + frame('Regression', 'stillWorks', 2, 1) + frame('Regression', 'stillWorks', 2, 0)
    + 'OHOS_REPORT_RESULT: stream=Tests run: 2, Failure: 1, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: -1\nTestFinished-ResultCode: 0\nuser test finished.\n';
  const execution = { ...f.execution, suiteSha256: sha('b'), runnerSha256: sha('c') };
  const grade = { ...f.grade, environment: { ...f.grade.environment, runtime: arktsInstrumentRuntime }, results: [{ phase: 'candidate',
    ...gradeArkts({ instance_id: f.expected.instanceId, FAIL_TO_PASS: caseIds.f2p, PASS_TO_PASS: caseIds.p2p },
      parseArktsInstrumentResults(coverage), execution) }] };
  Object.assign(f.slot.grading, { parser: 'INSTRUMENT', suiteSha256: sha('b'), runnerSha256: sha('c'),
    record: await f.save('instrument-grade.json', grade), coverage: await f.save('instrument.log', coverage) });
  assert.equal((await f.read()).rows[0].status, 'GRADE_COMPLETE');
  f.slot.grading.runnerSha256 = sha('d');
  assert.equal((await f.read()).rows[0].reason, 'GRADE_SUITE_OR_RUNNER_MISMATCH');
});

test('invalid JSON structure is retained as an invalid slot rather than aborting other observations', async t => {
  const f = await fixture(t);
  f.slot.business.result = await f.save('null-result.json', 'null\n');
  const report = await f.read([f.slot, { id: 'future', stage: 'UNSTARTED', expected: f.expected }]);
  assert.deepEqual(report.rows.map(row => row.status), ['INVALID_EVIDENCE', 'UNSTARTED']);
  assert.equal(report.rows[0].reason, 'PINNED_JSON_INVALID');
  assert.equal(report.summary.plannedSlots, 2);
});
