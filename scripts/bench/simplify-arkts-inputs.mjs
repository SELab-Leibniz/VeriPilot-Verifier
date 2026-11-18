import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, loadArktsTask } from './arkts-dataset.mjs';
import { arktsInstrumentRuntime } from './arkts-instrument-results.mjs';

export async function sealArktsGradingCandidate(candidate, output, expectedSha256) {
  const bytes = await fs.readFile(candidate), sha256 = digest(bytes);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256)
    throw new Error('The evaluator candidate differs from its frozen digest.');
  const file = path.join(output, 'candidate.patch');
  await fs.writeFile(file, bytes, { flag: 'wx' });
  return { file, sha256, bytes: bytes.length };
}

export function arktsHiddenReward(record, patchSha256, instanceId, datasetDigest) {
  if (record?.instanceId !== instanceId || record.environment?.datasetDigest !== datasetDigest || record.candidateSha256 !== patchSha256) return null;
  const grade = record.results?.find(row => row.phase === 'candidate');
  if (!grade?.executed) return null;
  return { f2p_passed: grade.f2p.passed.length, f2p_total: grade.f2p.expected, p2p_passed: grade.p2p.passed.length, p2p_total: grade.p2p.expected,
    f2p_not_passed: [...grade.f2p.failed, ...grade.f2p.testErrors], p2p_not_passed: [...grade.p2p.failed, ...grade.p2p.testErrors] };
}

const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export function sealedCandidateGrade(record, patchSha256) {
  if (record?.kind !== 'hidden-test-candidate-grade' || !isSha256(patchSha256) || record.candidateSha256 !== patchSha256)
    throw new Error('An independent candidate grade must match its supplied sealed patch hash.');
  const { instanceId, baseCommit, calibrationDirectory, environment, results } = record;
  if (typeof instanceId !== 'string' || !instanceId.trim() || !/^[a-f0-9]{40}$/u.test(baseCommit)
    || typeof calibrationDirectory !== 'string' || !calibrationDirectory.trim()
    || !isSha256(environment?.datasetDigest) || !isSha256(environment?.testPatchSha256) || !isSha256(environment?.toolchain?.sha256))
    throw new Error('The independent grade lacks a pinned task, base, calibration reference or environment.');
  const grade = results?.[0];
  if (!Array.isArray(results) || results.length !== 1 || grade?.phase !== 'candidate' || grade.instanceId !== instanceId
    || grade.executed !== true || grade.complete !== true || !Array.isArray(grade.runtimeErrors) || grade.runtimeErrors.length)
    throw new Error('The independent candidate grade must be complete and executed.');
  const { execution } = grade;
  if (execution?.freshReport !== true || execution.compileSucceeded !== true || execution.timedOut !== false)
    throw new Error('The independent candidate grade needs a fresh report, successful compilation and no timeout.');
  if (environment.runtime === arktsInstrumentRuntime && (!isSha256(execution.suiteSha256) || !isSha256(execution.runnerSha256)))
    throw new Error('The Instrument Test grade lacks its exact suite or runner fingerprint.');
  return grade;
}

function arktsCaseOutcomes(group) {
  const outcomes = new Map();
  const invalid = () => new Error('The grade must contain one outcome per expected case.');
  if (!Number.isSafeInteger(group?.expected) || ['missing', 'ambiguous', 'ignored'].some(key => !Array.isArray(group[key]) || group[key].length))
    throw invalid();
  for (const key of ['passed', 'failed', 'testErrors']) {
    if (!Array.isArray(group[key])) throw invalid();
    for (const id of group[key]) {
      if (typeof id !== 'string' || !id.trim() || outcomes.has(id)) throw invalid();
      outcomes.set(id, key === 'passed');
    }
  }
  if (outcomes.size !== group.expected) throw invalid();
  return outcomes;
}

export function compareArktsCandidateGrades(before, after, { beforePatchSha256, afterPatchSha256 } = {}) {
  const beforeGrade = sealedCandidateGrade(before, beforePatchSha256);
  const afterGrade = sealedCandidateGrade(after, afterPatchSha256);
  // Saved grades carry a calibration directory reference, without an immutable content hash.
  if (before.instanceId !== after.instanceId || before.baseCommit !== after.baseCommit
    || before.calibrationDirectory !== after.calibrationDirectory || !isDeepStrictEqual(before.environment, after.environment))
    throw new Error('The grades must share the same task, base, calibration reference and pinned environment.');
  if (before.environment.runtime === arktsInstrumentRuntime && (beforeGrade.execution.suiteSha256 !== afterGrade.execution.suiteSha256
    || beforeGrade.execution.runnerSha256 !== afterGrade.execution.runnerSha256))
    throw new Error('The Instrument Test suite and runner fingerprints must match between grades.');
  const compare = kind => {
    const previous = arktsCaseOutcomes(beforeGrade[kind]), next = arktsCaseOutcomes(afterGrade[kind]);
    if (previous.size !== next.size || [...previous.keys()].some(id => !next.has(id)))
      throw new Error('The expected case sets differ between grades.');
    const counts = { total: previous.size, gains: 0, losses: 0, unchanged: 0 };
    for (const [id, passed] of previous) {
      const current = next.get(id);
      if (passed === current) counts.unchanged++;
      else if (current) counts.gains++;
      else counts.losses++;
    }
    return counts;
  };
  return { kind: 'sealed-arkts-grade-comparison', beforePatchSha256, afterPatchSha256, f2p: compare('f2p'), p2p: compare('p2p') };
}

export async function readArktsComparisonInputs({ file, sha256, planSha256, artifactSha256, dataset }) {
  const bytes = await fs.readFile(file);
  const inputs = JSON.parse(bytes);
  if (digest(bytes) !== sha256 || inputs.planSha256 !== planSha256 || inputs.artifactSha256 !== artifactSha256 || !inputs.samples?.length)
    throw new Error('ArkTS input list differs from the committed plan or package.');
  const samples = await Promise.all(inputs.samples.map(async input => {
    if (!/^security_tool_[12]$/u.test(input.case) || !inputs.approvedCases?.includes(input.case)
      || !input.id?.startsWith(input.case + '-'))
      throw new Error('Round 2 requires an approved ArkTS case with a matching object ID.');
    const { datasetDigest } = await loadArktsTask(dataset, input.case);
    const freeze = await fs.readFile(path.join(input.frozenRoot, 'freeze.json'));
    const manifest = JSON.parse(freeze);
    const calibration = await fs.readFile(path.join(input.calibrationDir, 'results.json'));
    const checked = JSON.parse(calibration);
    const grade = await fs.readFile(input.gradeFile);
    const candidate = JSON.parse(grade);
    const before = arktsHiddenReward(candidate, manifest.patchSha256, input.case, datasetDigest);
    // Keep an attributable compile failure in the comparison without inventing a test score.
    const execution = candidate.results?.find(row => row.phase === 'candidate')?.execution;
    const uncompilable = input.initialGradeState === 'candidate-compile-error' && input.id === input.case + '-natural'
      && input.kind === 'defect' && before === null && input.before === null
      && candidate.instanceId === input.case && candidate.environment?.datasetDigest === datasetDigest
      && candidate.candidateSha256 === manifest.patchSha256 && Number.isInteger(execution?.code) && execution.code !== 0
      && execution.timedOut === false && execution.compileSucceeded === false && execution.freshReport === false;
    if (digest(freeze) !== input.freezeSha256 || manifest.planSha256 !== planSha256
      || manifest.artifactSha256 !== (inputs.frozenSourceArtifactSha256 ?? artifactSha256)
      || manifest.instanceId !== input.case || manifest.datasetDigest !== datasetDigest
      || digest(calibration) !== input.calibrationSha256 || checked.instanceId !== input.case || checked.environment?.datasetDigest !== datasetDigest
      || !checked.results?.find(row => row.phase === 'base')?.validFailToPassBase || !checked.results?.find(row => row.phase === 'gold')?.resolved
      || digest(grade) !== input.gradeSha256
      || !uncompilable && (!before || JSON.stringify(input.before) !== JSON.stringify(before)
        || (before.f2p_passed < before.f2p_total) !== (input.kind === 'defect')))
      throw new Error(`Pinned ArkTS freeze or hidden score differs for ${input.id}.`);
    return { ...input, datasetDigest };
  }));
  return { ...inputs, samples };
}
