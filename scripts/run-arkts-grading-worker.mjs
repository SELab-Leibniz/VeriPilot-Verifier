import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withTaskResourceLock } from '../lib/runtime-v2/task-store.mjs';
import { renameWithRetry } from '../lib/runtime-v2/utils.mjs';
import { digest, loadArktsTask } from './bench/arkts-dataset.mjs';
import { arktsInstrumentRoute, captureArktsInstrumentIdentity, loadArktsInstrumentConfig } from './bench/arkts-instrument-runtime.mjs';
import { arktsRunProfile } from './bench/arkts-run-profile.mjs';
import { captureArktsToolchainIdentity } from './bench/arkts-toolchain-identity.mjs';
import { serveArktsWorkerJobs } from './bench/arkts-worker-exchange.mjs';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { shortArktsWorkspace } from './bench/short-workspace.mjs';
import { archivedPairedCandidateScore, assertFrozenCampaignHarness, calibrationPins, preflightPairedBaseCache, scorePairedCandidate,
  verifyCalibration } from './run-arkts-paired-campaign.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const evaluator = fileURLToPath(new URL('./calibrate-arkts-bench.mjs', import.meta.url));
const required = ['exchange', 'dataset', 'calibrations', 'tool-root', 'java-home', 'cache', 'workspace-root', 'json5-package', 'output-root'];
const taskFields = ['id', 'baseCommit', 'datasetSha256'];
const gradeFields = ['releaseCommit', ...taskFields, 'candidateSha256', 'toolchainSha256', 'calibrationSha256', 'phaseTimeoutMs'];
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const disjoint = (one, two) => !within(one, two) && !within(two, one);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function privateOutputPath(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    const parent = path.dirname(file);
    if (error.code !== 'ENOENT' || parent === file) throw error;
    return path.join(await privateOutputPath(parent), path.basename(file));
  }
}

function exactFields(input, fields) {
  assert(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === fields.length && fields.every(field => Object.hasOwn(input, field)), 'Invalid ArkTS worker request fields');
}

async function readTask(dataset, input) {
  const { id, baseCommit, datasetSha256 } = input;
  assert(typeof id === 'string' && /^[a-z0-9_-]+$/u.test(id) && commit(baseCommit) && sha256(datasetSha256), 'Invalid ArkTS worker task identity');
  const { task, datasetDigest } = await loadArktsTask(dataset, id);
  assert(task.base_commit === baseCommit && datasetDigest === datasetSha256, `Private dataset differs from the request for ${id}`);
  return { id, task, datasetDigest };
}

function calibrationReceipt({ sha256, logs }) {
  return { sha256, logs: { base: logs.base, gold: logs.gold } };
}

async function readCalibrationPins(file, releaseCommit) {
  const stat = await fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  assert(stat.isFile(), 'ArkTS calibration pins must be a regular file');
  const release = await readJson(file);
  assert(release?.version === 1 && release.releaseCommit === releaseCommit && sha256(release.toolchainSha256)
    && Array.isArray(release.cases) && new Set(release.cases.map(task => task?.id)).size === release.cases.length
    && release.cases.every(task => typeof task?.id === 'string' && /^[a-z0-9_-]+$/u.test(task.id)
      && commit(task.baseCommit) && sha256(task.datasetSha256)
      && [task.calibration?.sha256, task.calibration?.logs?.base, task.calibration?.logs?.gold].every(sha256)),
  'Invalid persisted ArkTS calibration pins');
  return release;
}

async function writeCalibrationPins(file, pins, signal) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(pins) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, file, { beforeAttempt: () => signal?.throwIfAborted() });
  } finally {
    await fs.rm(temporary, { force:true });
  }
}

export function createArktsGradingCalibrationRegistry(outputRoot) {
  const releaseFile = releaseCommit => {
    assert(commit(releaseCommit), 'Invalid ArkTS worker release commit');
    return path.join(outputRoot, `.arkts-calibration-${releaseCommit}.json`);
  };
  return {
    async record(releaseCommit, toolchainSha256, inputs, calibrations, signal) {
      const file = releaseFile(releaseCommit);
      await withTaskResourceLock({ projectRoot:outputRoot, taskId:releaseCommit, resource:'arkts-calibration', reclaimDeadOwner:true }, async () => {
        signal?.throwIfAborted();
        const previous = await readCalibrationPins(file, releaseCommit);
        const existing = previous?.toolchainSha256 === toolchainSha256 ? previous.cases : [];
        const cases = new Map(existing.map(task => [task.id, task]));
        for (const { id, task, datasetDigest } of inputs) {
          cases.set(id, { id, baseCommit:task.base_commit, datasetSha256:datasetDigest,
            calibration:calibrationReceipt(calibrations[id]) });
        }
        await writeCalibrationPins(file, { version:1, releaseCommit, toolchainSha256, cases:[...cases.values()] }, signal);
      });
    },
    async require({ releaseCommit, id, baseCommit, datasetSha256, toolchainSha256, calibrationSha256 }) {
      const release = await readCalibrationPins(releaseFile(releaseCommit), releaseCommit);
      const task = release?.cases.find(task => task.id === id);
      assert(task && release.toolchainSha256 === toolchainSha256 && task.baseCommit === baseCommit
        && task.datasetSha256 === datasetSha256 && task.calibration.sha256 === calibrationSha256,
      'ArkTS worker must verify matching calibrations before grading');
      return task.calibration;
    },
  };
}

export async function createArktsGradingWorker(options) {
  const roots = Object.fromEntries(required.map(key => [key, path.resolve(options[key])]));
  const exchange = await fs.realpath(roots.exchange);
  assert((await fs.stat(exchange)).isDirectory(), '--exchange must be an existing shared job directory');
  for (const key of required.filter(key => key !== 'exchange')) {
    roots[key] = await (key === 'workspace-root' || key === 'output-root' ? privateOutputPath(roots[key]) : fs.realpath(roots[key]));
    assert(disjoint(exchange, roots[key]), `--${key} must be outside the shared exchange`);
  }
  const { dataset, calibrations, cache, 'tool-root': toolRoot, 'java-home': javaHome, 'workspace-root': workspaceRoot,
    'json5-package': json5Package, 'output-root': outputRoot } = roots;
  const instrumentFile = options['instrument-config'] && await fs.realpath(options['instrument-config']);
  if (instrumentFile) assert(disjoint(exchange, instrumentFile), '--instrument-config must be outside the shared exchange');
  const instrument = instrumentFile && await loadArktsInstrumentConfig(instrumentFile);
  const measureToolchain = signal => instrument ? captureArktsInstrumentIdentity({ config:instrument, toolRoot, javaHome, signal })
    : captureArktsToolchainIdentity({ toolRoot, javaHome });
  assert(disjoint(outputRoot, workspaceRoot), 'Use separate private output and grading worktree roots');
  createRequire(json5Package).resolve('json5');
  shortArktsWorkspace(outputRoot, 'grd', sourceRoot, workspaceRoot);
  for (const root of [outputRoot, workspaceRoot]) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const negotiated = createArktsGradingCalibrationRegistry(outputRoot);

  const handle = async (action, input, { id: jobId, directory, deadline, signal }) => {
    assert(action === 'calibration' || action === 'grade', 'Unknown ArkTS grading action');
    exactFields(input, action === 'calibration' ? ['releaseCommit', 'tasks'] : gradeFields);
    assert(commit(input.releaseCommit), 'Invalid ArkTS worker release commit');
    await assertFrozenCampaignHarness(sourceRoot, input.releaseCommit);
    if (action === 'calibration') {
      assert(Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 13, 'Invalid ArkTS calibration task set');
      for (const item of input.tasks) exactFields(item, taskFields);
      const inputs = await Promise.all(input.tasks.map(item => readTask(dataset, item)));
      assert(new Set(inputs.map(item => item.id)).size === inputs.length, 'Duplicate ArkTS calibration task');
      if (instrument) for (const { id } of inputs) arktsInstrumentRoute(instrument, id);
      const toolchain = await measureToolchain(signal);
      await preflightPairedBaseCache(inputs, cache);
      const pins = await calibrationPins(calibrations, inputs, toolchain.sha256);
      for (const pin of Object.values(pins))
        assert(disjoint(exchange, await fs.realpath(pin.root)), 'Calibration receipts must stay outside the shared exchange');
      await assertFrozenCampaignHarness(sourceRoot, input.releaseCommit);
      signal.throwIfAborted();
      const calibration = Object.fromEntries(Object.entries(pins).map(([id, pin]) => [id, calibrationReceipt(pin)]));
      const gradeTotals = Object.fromEntries(inputs.map(({ id, task }) => [id, { f2p: task.FAIL_TO_PASS.length, p2p: task.PASS_TO_PASS.length }]));
      await negotiated.record(input.releaseCommit, toolchain.sha256, inputs, calibration, signal);
      signal.throwIfAborted();
      return { toolchain, calibration, gradeTotals };
    }

    assert([input.candidateSha256, input.toolchainSha256, input.calibrationSha256].every(sha256), 'Invalid ArkTS grading hash');
    assert(Number.isSafeInteger(input.phaseTimeoutMs), 'Invalid ArkTS grading phase duration');
    arktsRunProfile(input.phaseTimeoutMs);
    const control = await negotiated.require(input);
    const task = await readTask(dataset, input);
    const toolchain = await measureToolchain(signal);
    assert.equal(toolchain.sha256, input.toolchainSha256, 'ArkTS grading toolchain changed');
    await preflightPairedBaseCache([task], cache);
    const selected = (await calibrationPins(calibrations, [task], toolchain.sha256))[task.id];
    const calibrationRoot = await fs.realpath(selected.root);
    assert(disjoint(exchange, calibrationRoot), 'Calibration receipts must stay outside the shared exchange');
    assert.deepEqual(calibrationReceipt(selected), control, 'ArkTS grading calibration changed');
    assert.equal(await fs.realpath(directory), path.join(exchange, jobId), 'Invalid ArkTS worker job directory');
    const candidate = path.join(directory, 'candidate.patch');
    assert((await fs.lstat(candidate)).isFile(), 'ArkTS candidate must be a regular file');
    const patch = await fs.readFile(candidate);
    assert.equal(digest(patch), input.candidateSha256, 'ArkTS candidate hash does not match the request');
    signal.throwIfAborted();
    assert(deadline > Date.now(), 'ArkTS grading deadline elapsed before launch');

    const job = path.join(outputRoot, jobId);
    await fs.mkdir(job, { mode: 0o700 });
    const sealedFile = path.join(job, 'candidate.patch');
    await fs.writeFile(sealedFile, patch, { mode: 0o600, flag: 'wx' });
    const output = path.join(job, 'grading');
    const argv = Object.entries({ dataset, cache, output, case: task.id, 'tool-root': toolRoot, 'java-home': javaHome,
      'workspace-root': workspaceRoot, 'json5-package': json5Package, 'toolchain-sha256': toolchain.sha256,
      'calibration-dir': calibrationRoot, candidate: sealedFile, 'candidate-sha256': input.candidateSha256,
      'phase-timeout-ms': input.phaseTimeoutMs, ...(instrumentFile ? { 'instrument-config':instrumentFile } : {}) }).map(([key, value]) => `--${key}=${value}`);
    const { exitCode, interrupted, reason, outputComplete, durationMs, tail } = await runBoundedProcess(process.execPath,
      [evaluator, ...argv], { cwd: sourceRoot, signal, timeoutMs: Math.max(1, deadline - Date.now()), exitDrainMs: 3000, processGroup: true });
    const execution = { exitCode, interrupted, reason, outputComplete, durationMs };
    await fs.writeFile(path.join(job, 'execution.json'), JSON.stringify({ input, ...execution, tail }) + '\n', { mode: 0o600, flag: 'wx' });
    if (interrupted || !outputComplete) return { input, execution, score: null };

    const gradeBytes = await fs.readFile(path.join(output, 'results.json')).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!gradeBytes) return { input, execution, score: null,
      ...(exitCode === 0 && reason === 'closed' ? { gradingFailure: 'GRADE_RECEIPT_MISSING' } : {}) };
    const grade = JSON.parse(gradeBytes);
    assert.equal(grade.baseCommit, input.baseCommit, 'ArkTS grade base differs from the request');
    assert.equal(grade.environment?.toolchain?.sha256, toolchain.sha256, 'ArkTS grade toolchain differs from the request');
    assert.equal(grade.environment?.testPatchSha256, task.task.test_patch_sha256, 'ArkTS grade used different evaluator tests');
    assert.equal(digest(await fs.readFile(path.join(output, 'candidate.patch'))), input.candidateSha256, 'ArkTS evaluator sealed different candidate bytes');
    assert.deepEqual(calibrationReceipt(await verifyCalibration(task, calibrationRoot, selected.sha256, toolchain.sha256)), control,
      'ArkTS grading calibration changed during grading');
    await assertFrozenCampaignHarness(sourceRoot, input.releaseCommit);
    const score = scorePairedCandidate(grade, input.candidateSha256, task);
    if (!score) return { input, execution, score };
    assert.deepEqual(archivedPairedCandidateScore(grade, input, calibrationRoot), score);
    const coverage = await fs.readFile(path.join(output, 'candidate-coverage.log'));
    return { input, execution, score, gradeSha256: digest(gradeBytes), coverageSha256: digest(coverage) };
  };
  return { exchange, handle };
}

const usage = `node scripts/run-arkts-grading-worker.mjs
  --exchange=<existing shared job directory> --dataset=<private evaluator task directory>
  --calibrations=<private case directories or JSON mapping> --cache=<private preseeded bare repos>
  --tool-root=<Huawei CLT> --java-home=<JBR> --json5-package=<resolving package.json>
  --workspace-root=<private short worktree parent> --output-root=<private receipt directory>
  [--instrument-config=<worker-local macOS Instrument Test routes>]

Run on a qualified grader with the campaign's frozen source checkout. The shared directory must
be writable only by the trusted controller and grader. Requests carry exact task hashes and
candidate bytes. The grader publishes calibration and evidence hashes with aggregate scores.`;

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    ...[...required, 'instrument-config'].map(key => [key, { type: 'string' }]), ['help', { type: 'boolean' }],
  ]) });
  if (values.help) { console.log(usage); return; }
  assert(required.every(key => values[key]), usage);
  const { exchange, handle } = await createArktsGradingWorker(values);
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  console.log('ArkTS grading worker is ready for calibration and grade requests.');
  await serveArktsWorkerJobs(exchange, handle, { signal: controller.signal });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
