import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, loadArktsTask } from './arkts-dataset.mjs';

export function arktsHiddenReward(record, patchSha256, instanceId, datasetDigest) {
  if (record?.instanceId !== instanceId || record.environment?.datasetDigest !== datasetDigest || record.candidateSha256 !== patchSha256) return null;
  const grade = record.results?.find(row => row.phase === 'candidate');
  if (!grade?.executed) return null;
  return { f2p_passed: grade.f2p.passed.length, f2p_total: grade.f2p.expected, p2p_passed: grade.p2p.passed.length, p2p_total: grade.p2p.expected,
    f2p_not_passed: [...grade.f2p.failed, ...grade.f2p.testErrors], p2p_not_passed: [...grade.p2p.failed, ...grade.p2p.testErrors] };
}

export async function readArktsComparisonInputs({ file, sha256, planSha256, artifactSha256, dataset }) {
  const bytes = await fs.readFile(file);
  const inputs = JSON.parse(bytes);
  if (digest(bytes) !== sha256 || inputs.planSha256 !== planSha256 || inputs.artifactSha256 !== artifactSha256 || !inputs.samples?.length)
    throw new Error('ArkTS input list differs from the committed plan or package.');
  const samples = await Promise.all(inputs.samples.map(async input => {
    if (input.case !== 'security_tool_1') throw new Error('The approved second round uses only security_tool_1.');
    const { datasetDigest } = await loadArktsTask(dataset, input.case);
    const freeze = await fs.readFile(path.join(input.frozenRoot, 'freeze.json'));
    const manifest = JSON.parse(freeze);
    const calibration = await fs.readFile(path.join(input.calibrationDir, 'results.json'));
    const checked = JSON.parse(calibration);
    const grade = await fs.readFile(input.gradeFile);
    const before = arktsHiddenReward(JSON.parse(grade), manifest.patchSha256, input.case, datasetDigest);
    if (digest(freeze) !== input.freezeSha256 || manifest.planSha256 !== planSha256
      || manifest.artifactSha256 !== (inputs.frozenSourceArtifactSha256 ?? artifactSha256)
      || manifest.instanceId !== input.case || manifest.datasetDigest !== datasetDigest
      || digest(calibration) !== input.calibrationSha256 || checked.instanceId !== input.case || checked.environment?.datasetDigest !== datasetDigest
      || !checked.results?.find(row => row.phase === 'base')?.validFailToPassBase || !checked.results?.find(row => row.phase === 'gold')?.resolved
      || digest(grade) !== input.gradeSha256 || !before || JSON.stringify(input.before) !== JSON.stringify(before)
      || (before.f2p_passed < before.f2p_total) !== (input.kind === 'defect'))
      throw new Error(`Pinned ArkTS freeze or hidden score differs for ${input.id}.`);
    return { ...input, datasetDigest };
  }));
  return { ...inputs, samples };
}
