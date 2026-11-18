import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest } from './arkts-dataset.mjs';
import { arktsInstrumentRuntime, parseArktsInstrumentResults } from './arkts-instrument-results.mjs';
import { gradeArkts, parseHypium } from './hypium-results.mjs';
import { sealedCandidateGrade } from './simplify-arkts-inputs.mjs';

export const candidateQualityInputKind = 'candidate-quality-inputs-v1';
export const candidateQualityEvidenceKind = 'candidate-quality-evidence-v1';
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const groups = ['f2p', 'p2p'];
const statuses = ['UNSTARTED', 'NO_RESULT', 'NO_FROZEN_PATCH', 'GRADING_PENDING', 'GRADE_PARTIAL', 'GRADE_COMPLETE', 'EVIDENCE_MISSING', 'INVALID_EVIDENCE'];
const evidenceError = code => Object.assign(new Error(code), { evidenceCode: code });
const requireEvidence = (condition, code) => { if (!condition) throw evidenceError(code); };

function reference(value) {
  return value && nonempty(value.file) && sha256(value.sha256);
}

function validateInputs(inputs) {
  assert.equal(inputs?.kind, candidateQualityInputKind, 'Unknown candidate-quality input version');
  assert(nonempty(inputs.experimentId), 'Candidate-quality inputs need an experiment identity');
  assert(Array.isArray(inputs.slots) && inputs.slots.length, 'Freeze the complete planned slot list before reading evidence');
  const ids = new Set();
  const results = new Set();
  for (const slot of inputs.slots) {
    assert(nonempty(slot?.id) && !ids.has(slot.id), 'Planned slot identities must be unique');
    ids.add(slot.id);
    assert(['UNSTARTED', 'STARTED', 'TERMINAL'].includes(slot.stage), 'Unknown slot lifecycle stage');
    const pin = slot.expected;
    assert(nonempty(pin?.instanceId) && commit(pin.baseCommit) && commit(pin.sourceCommit)
      && ['datasetSha256', 'publicInputSha256', 'packageSha256'].every(key => sha256(pin[key]))
      && typeof pin.rcEnabled === 'boolean', 'Each slot needs immutable task, input, release and arm pins');
    if (slot.business) {
      assert(reference(slot.business.result) && reference(slot.business.manifest), 'Business evidence needs result and manifest digest references');
      assert(!results.has(slot.business.result.sha256), 'A business result may belong to only one planned slot');
      results.add(slot.business.result.sha256);
      for (const key of ['freeze', 'candidate', 'session', 'workspacePatch'])
        assert(slot.business[key] === undefined || reference(slot.business[key]), `Invalid business ${key} reference`);
      const freezeKeys = ['freeze', 'candidate', 'session'];
      assert(freezeKeys.every(key => !slot.business[key]) || freezeKeys.every(key => slot.business[key]),
        'A frozen candidate needs its freeze, patch and session references together');
    }
    if (slot.grading) {
      const grade = slot.grading;
      assert(['FORMAL_CAMPAIGN', 'DIAGNOSTIC'].includes(grade.provenance), 'Preserve the declared grading provenance');
      assert(reference(grade.record) && reference(grade.coverage), 'Grading needs raw record and coverage digest references');
      assert(['HYPIUM', 'INSTRUMENT'].includes(grade.parser), 'Specify the raw report parser');
      assert(sha256(grade.toolchainSha256) && sha256(grade.testPatchSha256) && nonempty(grade.calibrationDirectory),
        'Grading needs its pinned toolchain, evaluator patch and calibration reference');
      const caseIds = groups.flatMap(key => grade.expectedCases?.[key] ?? []);
      assert(groups.every(key => Array.isArray(grade.expectedCases?.[key]) && grade.expectedCases[key].every(nonempty))
        && caseIds.length > 0 && new Set(caseIds).size === caseIds.length, 'Expected test identities must be unique across nonempty inventory groups');
      if (grade.parser === 'INSTRUMENT') assert(sha256(grade.suiteSha256) && sha256(grade.runnerSha256),
        'Instrument grading needs its suite and runner fingerprints');
      if (grade.provenance === 'FORMAL_CAMPAIGN') assert(reference(grade.campaignReceipt)
        && sha256(grade.calibrationSha256) && grade.campaignSlot?.id === pin.instanceId
        && grade.campaignSlot.arm === (pin.rcEnabled ? 'on' : 'off')
        && Number.isSafeInteger(grade.campaignSlot.repetition) && grade.campaignSlot.repetition > 0,
      'Formal provenance requires its existing campaign receipt, slot and calibration pin');
      assert(slot.business?.freeze && slot.stage === 'TERMINAL', 'Only a terminal frozen business candidate may have grading evidence');
    }
    assert(slot.stage !== 'UNSTARTED' || !slot.business && !slot.grading, 'Unstarted slots cannot contain executed evidence');
  }
}

async function readPinned(root, ref) {
  let bytes;
  try {
    bytes = await fs.readFile(path.resolve(root, ref.file));
  } catch (error) {
    if (error.code === 'ENOENT') throw evidenceError('PINNED_FILE_MISSING');
    throw evidenceError('PINNED_FILE_UNREADABLE');
  }
  requireEvidence(digest(bytes) === ref.sha256, 'PINNED_FILE_HASH_MISMATCH');
  return bytes;
}

async function readJson(root, ref) {
  try {
    const value = JSON.parse(await readPinned(root, ref));
    requireEvidence(value && typeof value === 'object' && !Array.isArray(value), 'PINNED_JSON_INVALID');
    return value;
  } catch (error) {
    if (error.evidenceCode) throw error;
    throw evidenceError('PINNED_JSON_INVALID');
  }
}

function verifyBusinessIdentity(result, manifest, pin) {
  const instance = { id: pin.instanceId, baseCommit: pin.baseCommit, datasetDigest: pin.datasetSha256 };
  for (const record of [result, manifest]) {
    requireEvidence(isDeepStrictEqual(record.instance, instance), 'BUSINESS_TASK_IDENTITY_MISMATCH');
    requireEvidence(record.publicInputSha256 === pin.publicInputSha256 && record.packageSha256 === pin.packageSha256
      && record.rcEnabled === pin.rcEnabled, 'BUSINESS_INPUT_OR_RELEASE_MISMATCH');
  }
  requireEvidence(manifest.sourceCommit === pin.sourceCommit, 'BUSINESS_SOURCE_MISMATCH');
  requireEvidence(typeof result.businessNatural === 'boolean', 'BUSINESS_COMPLETION_UNKNOWN');
}

function workflowView(result) {
  return { state: result.state ?? null, completionReason: result.reason ?? null, businessCompleted: result.businessNatural,
    rcEnabled: result.rcEnabled, rcReviewStatus: result.rcEnabled ? result.finalStop?.status ?? null : 'NOT_APPLICABLE',
    requiredChecks: Object.fromEntries(Object.entries(result.requiredChecks ?? {}).map(([key, value]) => [key, value?.status ?? 'NOT_RUN'])) };
}

async function verifyFrozen(root, business, result, manifest) {
  const freeze = await readJson(root, business.freeze);
  const [patch, session] = await Promise.all([readPinned(root, business.candidate), readPinned(root, business.session)]);
  requireEvidence(isDeepStrictEqual(freeze, result.frozen), 'FREEZE_RESULT_MISMATCH');
  requireEvidence(commit(freeze.commit) && commit(freeze.preparedHead) && sha256(freeze.commitSha256)
    && freeze.preparedHead === manifest.preparedHead, 'FREEZE_GIT_IDENTITY_MISMATCH');
  requireEvidence(freeze.patchSha256 === digest(patch) && freeze.sessionSha256 === digest(session), 'FREEZE_CONTENT_MISMATCH');
  if (freeze.workspacePatchSha256 !== undefined) {
    requireEvidence(reference(business.workspacePatch), 'WORKSPACE_PATCH_REFERENCE_MISSING');
    requireEvidence(digest(await readPinned(root, business.workspacePatch)) === freeze.workspacePatchSha256,
      'WORKSPACE_PATCH_MISMATCH');
  }
  return { status: 'SEALED_PATCH_VERIFIED', patchSha256: digest(patch), freezeSha256: business.freeze.sha256 };
}

function verifyGradeIdentity(record, grading, pin, frozen) {
  requireEvidence(record?.kind === 'hidden-test-candidate-grade' && record.instanceId === pin.instanceId
    && record.baseCommit === pin.baseCommit && record.candidateSha256 === frozen.patchSha256,
  'GRADE_CANDIDATE_IDENTITY_MISMATCH');
  requireEvidence(record.environment?.datasetDigest === pin.datasetSha256
    && record.environment.testPatchSha256 === grading.testPatchSha256
    && record.environment.toolchain?.sha256 === grading.toolchainSha256
    && record.calibrationDirectory === grading.calibrationDirectory, 'GRADE_ENVIRONMENT_MISMATCH');
  requireEvidence(grading.parser === 'INSTRUMENT' ? record.environment.runtime === arktsInstrumentRuntime
    : record.environment.runtime === undefined, 'GRADE_RUNTIME_MISMATCH');
}

async function qualityView(root, grading, pin, frozen) {
  const [record, coverage] = await Promise.all([readJson(root, grading.record), readPinned(root, grading.coverage)]);
  verifyGradeIdentity(record, grading, pin, frozen);
  requireEvidence(Array.isArray(record.results) && record.results.length === 1 && record.results[0]?.phase === 'candidate',
    'GRADE_PHASE_IDENTITY_MISMATCH');
  const original = record.results[0];
  requireEvidence(original.instanceId === pin.instanceId, 'GRADE_PHASE_IDENTITY_MISMATCH');
  if (grading.parser === 'INSTRUMENT') requireEvidence(original.execution?.suiteSha256 === grading.suiteSha256
    && original.execution.runnerSha256 === grading.runnerSha256, 'GRADE_SUITE_OR_RUNNER_MISMATCH');
  const parse = grading.parser === 'INSTRUMENT' ? parseArktsInstrumentResults : parseHypium;
  const parsed = parse(coverage.toString('utf8'));
  const recomputed = gradeArkts({ instance_id: pin.instanceId, FAIL_TO_PASS: grading.expectedCases.f2p,
    PASS_TO_PASS: grading.expectedCases.p2p }, parsed, original.execution ?? {});
  for (const key of ['complete', 'executed', 'resolved', 'runtimeErrors', 'testInventory', ...groups])
    requireEvidence(isDeepStrictEqual(original[key], recomputed[key]), 'GRADE_RAW_REPORT_MISMATCH');
  const observation = { provenance: grading.provenance, recordSha256: grading.record.sha256,
    coverageSha256: grading.coverage.sha256, counts: Object.fromEntries(groups.map(key => [key,
      Object.fromEntries(['expected', 'passed', 'failed', 'testErrors', 'missing', 'ignored', 'ambiguous']
        .map(field => [field, Array.isArray(recomputed[key][field]) ? recomputed[key][field].length : recomputed[key][field]]))])),
    runtimeErrors: recomputed.runtimeErrors.length };
  if (!recomputed.executed || !recomputed.complete) return { status: 'GRADE_PARTIAL', observation, quality: null };
  try {
    sealedCandidateGrade(record, frozen.patchSha256);
  } catch {
    throw evidenceError('GRADE_COMPLETE_RECEIPT_INVALID');
  }
  return { status: 'GRADE_COMPLETE', observation, quality: { f2p: { passed: recomputed.f2p.passed.length, total: recomputed.f2p.expected },
    p2p: { passed: recomputed.p2p.passed.length, total: recomputed.p2p.expected }, resolved: recomputed.resolved } };
}

async function verifyCampaignReceipt(root, slot, quality) {
  const grading = slot.grading;
  const receipt = await readJson(root, grading.campaignReceipt);
  const input = receipt.input;
  requireEvidence(receipt.version === 1 && isDeepStrictEqual(receipt.slot, grading.campaignSlot)
    && receipt.businessResultSha256 === slot.business.result.sha256
    && input?.id === slot.expected.instanceId && input.baseCommit === slot.expected.baseCommit
    && input.datasetSha256 === slot.expected.datasetSha256 && input.candidateSha256 === slot.business.candidate.sha256
    && input.toolchainSha256 === grading.toolchainSha256 && input.releaseCommit === slot.expected.sourceCommit
    && input.calibrationSha256 === grading.calibrationSha256
    && receipt.gradeSha256 === grading.record.sha256 && receipt.coverageSha256 === grading.coverage.sha256,
  'CAMPAIGN_RECEIPT_BINDING_MISMATCH');
  requireEvidence(quality && isDeepStrictEqual(receipt.score, quality)
    && receipt.execution?.interrupted === false && receipt.execution.outputComplete === true
    && receipt.execution.exitCode === (quality.resolved ? 0 : 1), 'CAMPAIGN_RECEIPT_OUTCOME_MISMATCH');
}

async function readSlot(root, slot) {
  const row = { id: slot.id, stage: slot.stage, status: slot.stage === 'UNSTARTED' ? 'UNSTARTED' : 'NO_RESULT',
    workflow: null, frozen: null, observation: null, quality: null };
  if (!slot.business) return row;
  try {
    const [result, manifest] = await Promise.all([readJson(root, slot.business.result), readJson(root, slot.business.manifest)]);
    verifyBusinessIdentity(result, manifest, slot.expected);
    row.workflow = workflowView(result);
    if (!slot.business.freeze) {
      requireEvidence(!result.frozen, 'FROZEN_RESULT_REQUIRES_REFERENCES');
      row.status = 'NO_FROZEN_PATCH';
      return row;
    }
    requireEvidence(slot.stage === 'TERMINAL' && result.state === 'finished' && !result.frameworkError,
      'FROZEN_BUSINESS_NOT_TERMINAL');
    row.frozen = await verifyFrozen(root, slot.business, result, manifest);
    row.status = 'GRADING_PENDING';
    if (slot.grading) {
      Object.assign(row, await qualityView(root, slot.grading, slot.expected, row.frozen));
      if (slot.grading.provenance === 'FORMAL_CAMPAIGN') {
        requireEvidence(result.businessNatural === true, 'CAMPAIGN_RECEIPT_WORKFLOW_MISMATCH');
        await verifyCampaignReceipt(root, slot, row.quality);
      }
    }
  } catch (error) {
    if (!error.evidenceCode) throw error;
    row.status = error.evidenceCode === 'PINNED_FILE_MISSING' ? 'EVIDENCE_MISSING' : 'INVALID_EVIDENCE';
    row.reason = error.evidenceCode;
    row.observation = null;
    row.quality = null;
  }
  return row;
}

// This reader never launches a grader, reconstructs a candidate, writes a
// campaign observation, or awards formal eligibility. The caller must retain
// the input digest independently; hashes prove consistency, not provenance.
export async function readCandidateQualityEvidence(file, expectedSha256) {
  assert(sha256(expectedSha256), 'An independently retained input SHA-256 is required');
  const bytes = await fs.readFile(file);
  assert.equal(digest(bytes), expectedSha256, 'Candidate-quality inputs changed after pinning');
  const inputs = JSON.parse(bytes);
  validateInputs(inputs);
  const rows = [];
  for (const slot of inputs.slots) rows.push(await readSlot(path.dirname(path.resolve(file)), slot));
  return { kind: candidateQualityEvidenceKind, experimentId: inputs.experimentId, inputsSha256: expectedSha256,
    formalEligibility: 'NOT_EVALUATED', formalPairsAdded: 0,
    summary: { plannedSlots: rows.length, sealedPatchVerified: rows.filter(row => row.frozen).length,
      statuses: Object.fromEntries(statuses.map(status => [status, rows.filter(row => row.status === status).length])),
      slotsWithCompleteGradesByProvenance: Object.fromEntries(['FORMAL_CAMPAIGN', 'DIAGNOSTIC'].map(provenance =>
        [provenance, rows.filter(row => row.status === 'GRADE_COMPLETE' && row.observation.provenance === provenance).length])) },
    rows };
}
