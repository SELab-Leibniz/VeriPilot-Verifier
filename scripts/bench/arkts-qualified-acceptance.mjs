import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './arkts-dataset.mjs';
import { arktsInstrumentRuntime } from './arkts-instrument-results.mjs';
import { arktsPublicAcceptanceIdentity, loadArktsPublicAcceptance, loadArktsPublicPositiveManifest,
  loadArktsPublicProbeManifest, qualifiedProbeBindings } from './arkts-public-acceptance.mjs';
import { localTestEvidence } from './local-test-evidence.mjs';

const sha256 = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const testResults = ['PASS', 'FAIL', 'ERROR'];
const validId = text => typeof text === 'string' && /^[a-z0-9_-]+$/u.test(text);

async function readBoundedFile(file, maxBytes) {
  const afterResolution = await fs.stat(file);
  assert(afterResolution.isFile() && afterResolution.size > 0 && afterResolution.size <= maxBytes,
    'Qualification evidence must be a bounded regular file');
  const bytes = await fs.readFile(file);
  assert(bytes.length > 0 && bytes.length <= maxBytes, 'Qualification evidence exceeds its byte limit');
  return bytes;
}

async function readPhaseFile(root, id, name, evidence) {
  assert.equal(evidence?.file, id + '/' + name, 'Qualification evidence path differs from its case and phase');
  assert.match(evidence.sha256 ?? '', sha256, 'Qualification phase evidence requires a digest');
  const file = await fs.realpath(path.join(root, id, name));
  const relative = path.relative(root, file);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'Qualification phase evidence escaped its report directory');
  const bytes = await readBoundedFile(file, 32 * 1024 * 1024);
  assert.equal(digest(bytes), evidence.sha256, 'Qualification phase evidence differs from its pinned digest');
  return bytes.toString('utf8');
}

async function readPhase(root, id, prefix, phase) {
  assert.equal(phase.compileOutput?.sha256, phase.execution.compileOutputSha256,
    'Qualification compile output differs from its execution receipt');
  const [raw, compileOutput] = await Promise.all([
    readPhaseFile(root, id, prefix + 'coverage.log', phase.coverage),
    readPhaseFile(root, id, prefix + 'compile-output.log', phase.compileOutput),
  ]);
  const result = localTestEvidence(raw, phase.execution, { freshReport: phase.execution.freshReport, compileOutput });
  assert(result.completeRuntime, 'Qualification phase did not compile and finish with an attributable inventory');
  return result.statuses;
}

function assertExecution(execution, runtime, snapshot) {
  assert(execution && execution.interrupted === false && execution.outputComplete === true
    && execution.freshReport === true && execution.completeRuntime === true
    && Number.isInteger(execution.exitCode) && execution.exitCode >= 0
    && sha256.test(execution.compileOutputSha256), 'Qualification requires complete native execution evidence');
  assert.equal(execution.snapshotSha256, snapshot, 'Qualification execution differs from the phase snapshot');
  assert.equal(execution.runtime, runtime, 'Qualification execution used a different runtime');
  if (runtime === arktsInstrumentRuntime)
    assert(execution.compileSucceeded === true && execution.device?.target && sha256.test(execution.suiteSha256)
      && sha256.test(execution.runnerSha256) && ['test', 'debug'].includes(execution.appBuildMode),
    'Qualification execution lacks native Instrument Test identity');
}

function assertOriginal(row, statuses) {
  const names = Object.keys(statuses);
  const counts = {};
  for (const status of Object.values(statuses)) counts[status] = (counts[status] ?? 0) + 1;
  assert(Object.keys(counts).some(status => testResults.includes(status)),
    'Qualification task-start suite observed no cases');
  assert.deepEqual(row.tests, { observed: names.length, counts, allObservedPassed: counts.PASS === names.length,
    publicInventorySha256: digest(JSON.stringify(names.sort())) }, 'Qualification task-start test inventory changed');
}

function assertProbe(probe, statuses, { sha256: hash, testIds, expectedBase }, source, positive) {
  assert.equal(probe.source, source, 'Qualification used a different probe source');
  assert.equal(probe.probeSha256, hash, 'Qualification used different probe bytes');
  assert.equal(probe.status, positive ? 'PASS' : 'FAIL', 'Qualification requires a failing base and passing positive');
  assert(Object.keys(statuses).length === testIds.length && Array.isArray(probe.checks),
    'Qualification probe ran a different case inventory');
  const checks = testIds.map(id => ({ id, status: statuses[id] }));
  assert(checks.every(check => check.status === 'PASS' || check.status === 'FAIL'),
    'Qualification probe case was absent or unresolved');
  assert.deepEqual(probe.checks, checks, 'Qualification probe receipt differs from its raw test results');
  if (positive) assert(checks.every(check => check.status === 'PASS'), 'Qualification positive probe did not fully pass');
  else assert(checks.some(check => check.status === 'FAIL'), 'Qualification base probe did not fail');
  if (!positive && expectedBase) {
    assert.deepEqual(probe.expectedBase, expectedBase, 'Qualification expected base vector differs from the manifest');
    assert(probe.matchesExpectedBase === true, 'Qualification base did not match the declared vector');
    assert.deepEqual(checks.map(check => check.status), expectedBase, 'Qualification base outcomes differ from the manifest');
  }
}

async function verifyCase({ row, task, publicBytes, definition, source, positive, root, runtime }) {
  const { id, preparedTree, snapshotSha256, acceptance, positive: repaired, execution } = row;
  assert.equal(row.baseCommit, task.base_commit, 'Qualification uses a different task base');
  assert.equal(row.publicInputSha256, digest(publicBytes), 'Qualification uses a different public task input');
  assert(row.status === 'PUBLIC_TEST_OBSERVED' && row.qualification === 'BASE_AND_POSITIVE_MATCHED'
    && acceptance && repaired && positive, 'Qualification requires matched native base and positive controls');
  assert(commit.test(preparedTree) && commit.test(repaired.tree) && preparedTree !== repaired.tree,
    'Qualification requires distinct base and positive trees');
  const snapshots = [snapshotSha256, acceptance.snapshotSha256, repaired.snapshotSha256];
  assert(snapshots.every(value => sha256.test(value)) && new Set(snapshots).size === snapshots.length,
    'Qualification requires distinct task-start, base probe and positive probe snapshots');
  assert.equal(repaired.patchSha256, positive.patchSha256, 'Qualification measured a different positive patch');
  assert(Array.isArray(repaired.paths) && repaired.paths.length > 0 && new Set(repaired.paths).size === repaired.paths.length
    && repaired.paths.every(file => typeof file === 'string' && /^entry\/src\/main\/[^\\]+$/u.test(file)
      && file.split('/').every(part => part && part !== '.' && part !== '..')),
  'Qualification positive patch must only change application production paths');
  [execution, acceptance.execution, repaired.execution].forEach((receipt, index) => assertExecution(receipt, runtime, snapshots[index]));
  if (runtime === arktsInstrumentRuntime) {
    for (const receipt of [acceptance.execution, repaired.execution]) {
      assert.deepEqual(receipt.device, execution.device, 'Qualification phases used different devices');
      assert.equal(receipt.runnerSha256, execution.runnerSha256, 'Qualification phases used different runners');
      assert.equal(receipt.appBuildMode, execution.appBuildMode, 'Qualification phases used different app build modes');
    }
    assert.equal(acceptance.execution.suiteSha256, repaired.execution.suiteSha256, 'Qualification probes used different test suites');
  }
  const [original, baseProbe, positiveProbe] = await Promise.all([
    readPhase(root, id, '', row),
    readPhase(root, id, 'acceptance-', acceptance),
    readPhase(root, id, 'positive-', repaired),
  ]);
  assertOriginal(row, original);
  assertProbe(acceptance, baseProbe, definition, source, false);
  assertProbe(repaired, positiveProbe, definition, source, true);
}

/** Validates a trusted, independently pinned public smoke report. */
export async function loadArktsQualifiedAcceptance({ reportFile, reportSha256, probeManifest,
  probeManifestSha256, positiveManifest, positiveManifestSha256, planSha256, releaseCommit, toolchainSha256, runtime, inputs }) {
  assert([reportSha256, probeManifestSha256, positiveManifestSha256, planSha256, toolchainSha256].every(value => sha256.test(value))
    && commit.test(releaseCommit), 'Qualification requires trusted input digests');
  assert(runtime === undefined || runtime === arktsInstrumentRuntime, 'Unsupported qualification runtime');
  const ids = inputs.map(input => input.id);
  assert(ids.length && ids.every(validId) && new Set(ids).size === ids.length, 'Qualification requires distinct frozen task inputs');
  const realReport = await fs.realpath(reportFile);
  const reportBytes = await readBoundedFile(realReport, 2 * 1024 * 1024);
  assert.equal(digest(reportBytes), reportSha256, 'Qualification report differs from its trusted digest');
  const report = JSON.parse(reportBytes);
  assert(report?.kind === 'arkts-public-test-worker-smoke-v1' && report.status === 'PUBLIC_TESTS_OBSERVED'
    && report.formalPairsAdded === 0, 'Qualification requires a terminal native public smoke report');
  assert.equal(report.planSha256, planSha256, 'Qualification uses a different paired plan');
  assert.equal(report.releaseCommit, releaseCommit, 'Qualification uses a different release');
  assert.equal(report.toolchainSha256, toolchainSha256, 'Qualification uses a different toolchain');
  assert.equal(report.runtime, runtime, 'Qualification uses a different runtime');
  const inputsById = new Map(inputs.map(input => [input.id, input]));
  const [{ probes, authoredAgainstCommit }, positives] = await Promise.all([
    loadArktsPublicProbeManifest(probeManifest, probeManifestSha256, planSha256, ids),
    loadArktsPublicPositiveManifest(positiveManifest, positiveManifestSha256, planSha256,
      new Map(inputs.map(({ id, task }) => [id, task.base_commit]))),
  ]);
  assert.deepEqual(report.probeManifest, { sha256: probeManifestSha256, authoredAgainstCommit },
    'Qualification uses a different probe manifest');
  assert.deepEqual(report.positiveManifest, { sha256: positiveManifestSha256 }, 'Qualification uses a different positive manifest');
  assert(Array.isArray(report.cases) && report.cases.every(row => inputsById.has(row?.id)),
    'Qualification contains cases outside the frozen plan');
  const rows = new Map(report.cases.map(row => [row.id, row]));
  assert(rows.size === report.cases.length && [...probes.keys()].every(id => rows.has(id)),
    'Qualification requires exactly one native result for every candidate probe');
  const root = path.dirname(realReport);
  const checks = new Map();
  for (const [id, row] of rows) {
    const { task, publicBytes } = inputsById.get(id);
    const candidate = probes.get(id);
    const registered = await loadArktsPublicAcceptance(task, digest(publicBytes));
    assert(!candidate || !registered, 'An external probe cannot replace a registered acceptance check: ' + id);
    const definition = candidate ?? registered;
    assert(definition, 'Qualification contains a case without a registered or candidate probe: ' + id);
    await verifyCase({ row, task, publicBytes, definition, source: candidate ? 'CANDIDATE_MANIFEST' : 'REGISTERED',
      positive: positives.get(id), root, runtime });
    if (candidate) {
      const { probeBytes, sha256, testIds } = candidate;
      const descriptor = { sha256, testIds, requirementBindings: qualifiedProbeBindings(task, testIds, candidate.requirementBindings) };
      checks.set(id, { ...descriptor, probeBytes, identitySha256: arktsPublicAcceptanceIdentity(digest(publicBytes), descriptor) });
    }
  }
  return { qualification: { reportSha256, probeManifestSha256, positiveManifestSha256, toolchainSha256,
    ...(runtime ? { runtime } : {}) }, checks };
}
