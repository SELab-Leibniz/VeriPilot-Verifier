import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serveArktsWorkerJobs, submitArktsWorkerJob } from '../scripts/bench/arkts-worker-exchange.mjs';
import { createArktsGradingCalibrationRegistry, createArktsGradingWorker } from '../scripts/run-arkts-grading-worker.mjs';

const worker = fileURLToPath(new URL('../scripts/run-arkts-grading-worker.mjs', import.meta.url));

function calibrationFixture(id, value) {
  const baseCommit = value.repeat(40), datasetSha256 = value.repeat(64);
  const calibration = { sha256:datasetSha256, logs:{ base:'a'.repeat(64), gold:'b'.repeat(64) } };
  return {
    input: { id, task:{ base_commit:baseCommit }, datasetDigest:datasetSha256 },
    calibration,
    grade: { id, baseCommit, datasetSha256, calibrationSha256:calibration.sha256 },
  };
}

test('concurrent disjoint calibrations keep both exact grading pins across worker restarts', async t => {
  const { options } = await fixture(t);
  const outputRoot = options['output-root'];
  const firstWorker = createArktsGradingCalibrationRegistry(outputRoot);
  const secondWorker = createArktsGradingCalibrationRegistry(outputRoot);
  const releaseCommit = 'c'.repeat(40), toolchainSha256 = 'd'.repeat(64);
  const pc = calibrationFixture('security_tool_4', '1');
  const phone = calibrationFixture('happyword_12', '2');
  const pcGrade = { ...pc.grade, releaseCommit, toolchainSha256 };
  const phoneGrade = { ...phone.grade, releaseCommit, toolchainSha256 };
  await assert.rejects(firstWorker.require(pcGrade), /verify matching calibrations/u);
  await Promise.all([
    firstWorker.record(releaseCommit, toolchainSha256, [pc.input], { [pc.input.id]:pc.calibration }),
    secondWorker.record(releaseCommit, toolchainSha256, [phone.input], { [phone.input.id]:phone.calibration }),
  ]);

  const restartedWorker = createArktsGradingCalibrationRegistry(outputRoot);
  assert.deepEqual(await restartedWorker.require(pcGrade), pc.calibration);
  assert.deepEqual(await restartedWorker.require(phoneGrade), phone.calibration);
  const differentRoot = createArktsGradingCalibrationRegistry(options['workspace-root']);
  await assert.rejects(differentRoot.require(pcGrade), /verify matching calibrations/u);
  for (const changed of [
    { id:'happyword_13' }, { baseCommit:'e'.repeat(40) }, { datasetSha256:'e'.repeat(64) },
    { calibrationSha256:'e'.repeat(64) }, { releaseCommit:'e'.repeat(40) }, { toolchainSha256:'e'.repeat(64) },
  ]) await assert.rejects(restartedWorker.require({ ...pcGrade, ...changed }), /verify matching calibrations/u);

  const refreshed = calibrationFixture(pc.input.id, '3');
  await firstWorker.record(releaseCommit, toolchainSha256, [refreshed.input], { [refreshed.input.id]:refreshed.calibration });
  await assert.rejects(restartedWorker.require(pcGrade), /verify matching calibrations/u);
  assert.deepEqual(await restartedWorker.require({ ...refreshed.grade, releaseCommit, toolchainSha256 }), refreshed.calibration);
  assert.deepEqual(await restartedWorker.require(phoneGrade), phone.calibration);
});

test('a new worker fingerprint invalidates earlier case pins for the release', async t => {
  const { options } = await fixture(t);
  const registry = createArktsGradingCalibrationRegistry(options['output-root']);
  const restartedWorker = createArktsGradingCalibrationRegistry(options['output-root']);
  const releaseCommit = 'c'.repeat(40), initialToolchain = 'd'.repeat(64), changedToolchain = 'e'.repeat(64);
  const pc = calibrationFixture('security_tool_4', '1');
  const phone = calibrationFixture('happyword_12', '2');
  const pcGrade = { ...pc.grade, releaseCommit, toolchainSha256:initialToolchain };
  await registry.record(releaseCommit, initialToolchain, [pc.input], { [pc.input.id]:pc.calibration });
  assert.deepEqual(await restartedWorker.require(pcGrade), pc.calibration);

  await registry.record(releaseCommit, changedToolchain, [phone.input], { [phone.input.id]:phone.calibration });
  await assert.rejects(restartedWorker.require(pcGrade), /verify matching calibrations/u);
  assert.deepEqual(await restartedWorker.require({ ...phone.grade, releaseCommit, toolchainSha256:changedToolchain }), phone.calibration);

  await registry.record(releaseCommit, initialToolchain, [phone.input], { [phone.input.id]:phone.calibration });
  await assert.rejects(restartedWorker.require(pcGrade), /verify matching calibrations/u);
  assert.deepEqual(await restartedWorker.require({ ...phone.grade, releaseCommit, toolchainSha256:initialToolchain }), phone.calibration);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-grade-worker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = Object.fromEntries(['dataset', 'calibrations', 'tool-root', 'java-home', 'cache', 'workspace-root', 'output-root']
    .map(key => [key, path.join(root, 'private', key)]));
  options.exchange = path.join(root, 'exchange');
  for (const directory of Object.values(options)) await fs.mkdir(directory, { recursive: true });
  options['json5-package'] = path.join(root, 'private', 'package.json');
  const module = path.join(path.dirname(options['json5-package']), 'node_modules', 'json5');
  await fs.mkdir(module, { recursive: true });
  await fs.writeFile(options['json5-package'], '{}');
  await fs.writeFile(path.join(module, 'index.js'), '');
  return { root, options };
}

test('worker help is usable before provisioning a toolchain', () => {
  const usage = execFileSync(process.execPath, [worker, '--help'], { encoding: 'utf8' });
  assert.match(usage, /--exchange=.*--dataset=/u);
  assert.match(usage, /--workspace-root=.*--output-root=/u);
});

test('worker refuses direct and symlinked overlap with the private exchange boundary', async t => {
  const { root, options } = await fixture(t);
  const exposed = path.join(options.exchange, 'exposed');
  await assert.rejects(createArktsGradingWorker({ ...options, 'output-root': exposed }), /outside the shared exchange/u);
  await assert.rejects(fs.stat(exposed), { code: 'ENOENT' });
  const linked = path.join(root, 'shared-alias');
  await fs.symlink(options.exchange, linked, 'junction');
  await assert.rejects(createArktsGradingWorker({ ...options, dataset: linked }), /outside the shared exchange/u);
});

test('worker rejects unexpected request fields and publishes only generic failure receipts', async t => {
  const { options } = await fixture(t);
  const { exchange, handle } = await createArktsGradingWorker(options);
  const controller = new AbortController();
  const logs = [];
  const serving = serveArktsWorkerJobs(exchange, handle, { signal: controller.signal, pollMs: 5, onError: error => logs.push(error) });
  try {
    const input = { releaseCommit: 'e'.repeat(40), tasks: [], dataset: options.dataset };
    await assert.rejects(submitArktsWorkerJob(exchange, 'calibration', input, { timeoutMs: 5000, pollMs: 5 }), /See the worker log/u);
    assert.match(logs[0], /Invalid ArkTS worker request fields/u);
    const [id] = await fs.readdir(exchange);
    const response = JSON.parse(await fs.readFile(path.join(exchange, id, 'response.json'), 'utf8'));
    assert.deepEqual(Object.keys(response).sort(), ['failed', 'id', 'protocol', 'requestSha256']);
    assert.equal(response.failed, true);
    assert.deepEqual(await fs.readdir(options['output-root']), []);
  } finally {
    controller.abort();
    await serving;
  }
});
