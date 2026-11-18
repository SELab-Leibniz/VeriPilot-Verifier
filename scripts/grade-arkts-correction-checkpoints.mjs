import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { digest } from './bench/arkts-dataset.mjs';
import { submitArktsWorkerJob } from './bench/arkts-worker-exchange.mjs';
import { checkWorkerGrade, gradePairedWithRetry } from './run-arkts-paired-campaign.mjs';
import { readArktsCorrectionGradingPlan } from './summarize-arkts-paired-cohort.mjs';

const sha256 = /^[a-f0-9]{64}$/u;
const contains = (root, file) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
};
const disjoint = (left, right) => !contains(left, right) && !contains(right, left);
const jsonBytes = data => Buffer.from(JSON.stringify(data, null, 2) + '\n');

async function readPinned(root, file, expected) {
  const real = await fs.realpath(file);
  assert(real !== root && contains(root, real) && (await fs.lstat(file)).isFile(), 'Expected a regular correction evidence file in the shard');
  const content = await fs.readFile(real);
  assert.equal(digest(content), expected, 'Correction evidence changed after verification');
  return content;
}

async function negotiate(exchange, candidates, release, deadline, signal) {
  const tasks = new Map();
  for (const { beforeInput: { id, baseCommit, datasetSha256 } } of candidates) tasks.set(id, { id, baseCommit, datasetSha256 });
  signal.throwIfAborted();
  const timeoutMs = Math.min(120_000, deadline - Date.now());
  assert(timeoutMs > 0, 'Diagnostic grading deadline elapsed before worker calibration');
  const receipt = await submitArktsWorkerJob(exchange, 'calibration', { releaseCommit: release.sourceCommit, tasks: [...tasks.values()] }, { timeoutMs, signal });
  for (const { beforeInput, calibration, totals } of candidates) {
    assert.equal(receipt.toolchain?.sha256, beforeInput.toolchainSha256, 'Diagnostic grader differs from the frozen toolchain');
    assert.deepEqual(receipt.calibration?.[beforeInput.id], calibration, 'Diagnostic grader differs from the frozen calibration');
    assert.deepEqual(receipt.gradeTotals?.[beforeInput.id], totals, 'Diagnostic grader differs from the frozen test totals');
  }
}

async function readDiagnosticPatch(plan, { slot, businessResultSha256, before, beforeInput, after }) {
  const trial = path.join(plan.root, 'trials', slot.id, `r${slot.repetition}`, slot.arm);
  const business = path.join(trial, 'business');
  const archive = [[path.join(plan.root, 'summary.json'), plan.terminalSummarySha256],
    [path.join(plan.root, 'execution.json'), plan.executionSha256], [path.join(business, 'result.json'), businessResultSha256],
    [path.join(business, 'freeze/candidate.patch'), after.patchSha256],
    [path.join(trial, 'grading-evidence.json'), after.gradingEvidenceSha256]];
  await Promise.all(archive.map(([file, expected]) => readPinned(plan.root, file, expected)));
  return readPinned(plan.root, before.file, beforeInput.candidateSha256);
}

async function gradeBefore({ plan, candidate, exchange, directory, deadline, signal }) {
  const { slot, businessResultSha256, beforeInput, totals, firstRepair } = candidate;
  const binding = { patchSha256: beforeInput.candidateSha256, businessResultSha256, calibrationSha256: beforeInput.calibrationSha256 };
  const result = await gradePairedWithRetry({ directory, binding, deadline, signal, readCandidate: () => readDiagnosticPatch(plan, candidate),
    async evaluate({ patch, deadline, retry }) {
      const timeoutMs = deadline - Date.now();
      if (signal.aborted || timeoutMs <= 0) return { score: null, gradingFailure: 'DIAGNOSTIC_WINDOW_UNAVAILABLE' };
      let receipt;
      try {
        receipt = await submitArktsWorkerJob(exchange, 'grade', beforeInput, { timeoutMs, signal,
          prepare: job => fs.writeFile(path.join(job, 'candidate.patch'), patch, { flag: 'wx', mode: 0o600 }) });
      } catch {
        return { score: null, gradingFailure: signal.aborted ? 'DIAGNOSTIC_CANCELLED' : 'DIAGNOSTIC_WORKER_UNAVAILABLE' };
      }
      const checked = checkWorkerGrade(receipt, beforeInput, totals);
      if (!checked.score) return checked;
      assert([receipt.gradeSha256, receipt.coverageSha256].every(hash => sha256.test(hash ?? '')), 'Checkpoint grade lacks its evaluator evidence hashes');
      const evidence = jsonBytes({ version: 1, slot, phase: 'before-first-repair', planSha256: plan.planSha256,
        terminalSummarySha256: plan.terminalSummarySha256, businessResultSha256, firstRepair, input: beforeInput,
        attempt: retry ? 2 : 1, execution: checked.gradingExecution, score: checked.score,
        gradeSha256: receipt.gradeSha256, coverageSha256: receipt.coverageSha256 });
      await fs.writeFile(path.join(directory, 'grading-evidence.json'), evidence, { flag: 'wx', mode: 0o600 });
      return { ...checked, gradingEvidenceSha256: digest(evidence) };
    } });
  return { ...result, patchSha256: binding.patchSha256 };
}

export function summarizeArktsCorrectionCheckpointScores(candidates, skipped) {
  const comparison = { improved: 0, regressed: 0, bothResolved: 0, neitherResolved: 0, unscored: 0 };
  const groups = ['f2p', 'p2p'];
  const directions = Object.fromEntries(groups.map(group => [group, { higher: 0, lower: 0, equal: 0 }]));
  const checkpoints = [];
  for (const { slot, before, after } of candidates) {
    if (!before.score) {
      comparison.unscored++;
      continue;
    }
    if (before.score.resolved) comparison[after.score.resolved ? 'bothResolved' : 'regressed']++;
    else comparison[after.score.resolved ? 'improved' : 'neitherResolved']++;
    const changes = Object.fromEntries(groups.map(group => {
      const { total, passed: beforePassed } = before.score[group];
      const { passed: afterPassed } = after.score[group];
      assert.equal(after.score[group].total, total, 'Correction checkpoint grade totals differ');
      const delta = afterPassed - beforePassed;
      directions[group][delta > 0 ? 'higher' : delta < 0 ? 'lower' : 'equal']++;
      return [group, { total, beforePassed, afterPassed, delta }];
    }));
    checkpoints.push({ slot, ...changes });
  }
  return { comparison, scoreChanges: { measured: checkpoints.length, missing: comparison.unscored + skipped.length,
    ...directions, checkpoints } };
}

export async function gradeArktsCorrectionCheckpoints({ directory, planSha256, release, exchange, output, deadline,
  signal = new AbortController().signal }) {
  assert(Number.isSafeInteger(deadline) && deadline > Date.now(), 'Set a future absolute diagnostic deadline in Unix milliseconds');
  const plan = await readArktsCorrectionGradingPlan({ directory, planSha256, release });
  const worker = await fs.realpath(exchange);
  const outputPath = path.resolve(output);
  const target = path.join(await fs.realpath(path.dirname(outputPath)), path.basename(outputPath));
  assert(disjoint(plan.root, worker) && disjoint(plan.root, target) && disjoint(worker, target),
    'Use separate campaign, private grading exchange and diagnostic output directories');
  await fs.mkdir(target, { mode: 0o700 });
  const needsGrading = plan.candidates.filter(({ before, after }) => before.sha256 !== after.patchSha256);
  if (needsGrading.length) await negotiate(worker, needsGrading, release, deadline, signal);
  const candidates = [];
  for (const candidate of plan.candidates) {
    const { slot, businessResultSha256, before, after, firstRepair, repairCount } = candidate;
    const identity = { slot, businessResultSha256, firstRepair, repairCount, after };
    if (before.sha256 === after.patchSha256) {
      await readDiagnosticPatch(plan, candidate);
      candidates.push({ ...identity, status: 'SCORED_IDENTICAL', before: { ...after } });
      continue;
    }
    const grading = path.join(target, 'trials', slot.id, `r${slot.repetition}`);
    await fs.mkdir(grading, { recursive: true, mode: 0o700 });
    const result = await gradeBefore({ plan, candidate, exchange: worker, directory: grading,
      deadline: Math.min(deadline, Date.now() + plan.gradeWallMs), signal });
    candidates.push({ ...identity, status: result.score ? 'SCORED' : 'UNSCORED', before: result });
  }
  const { comparison, scoreChanges } = summarizeArktsCorrectionCheckpointScores(candidates, plan.skipped);
  const report = { kind: 'arkts-correction-checkpoint-grades-v1', planSha256: plan.planSha256,
    executionSha256: plan.executionSha256, terminalSummarySha256: plan.terminalSummarySha256,
    release: { sourceCommit: release.sourceCommit, packageSha256: release.packageSha256 },
    candidates, skipped: plan.skipped, comparison, scoreChanges, formalPairsAdded: 0, modelRequests: 0 };
  await fs.writeFile(path.join(target, 'report.json'), jsonBytes(report), { flag: 'wx', mode: 0o600 });
  return report;
}

const options = ['directory', 'plan-sha256', 'release', 'exchange', 'output', 'deadline-at'];
const usage = 'node scripts/grade-arkts-correction-checkpoints.mjs ' + options.map(name => `--${name}=VALUE`).join(' ');

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, ...Object.fromEntries(options.map(name => [name, { type: 'string' }])) } });
  if (values.help) { console.log(usage); return; }
  assert(options.every(name => values[name]), usage);
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  const report = await gradeArktsCorrectionCheckpoints({ directory: values.directory, planSha256: values['plan-sha256'],
    release: JSON.parse(await fs.readFile(values.release)), exchange: values.exchange, output: values.output,
    deadline: Number(values['deadline-at']), signal: controller.signal });
  console.log(JSON.stringify({ output: path.join(path.resolve(values.output), 'report.json'),
    comparison: report.comparison, scoreChanges: report.scoreChanges, skipped: report.skipped.length }));
  if (report.comparison.unscored || report.skipped.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
