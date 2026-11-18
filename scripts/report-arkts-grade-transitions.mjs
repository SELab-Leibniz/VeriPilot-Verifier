#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { digest } from './bench/arkts-dataset.mjs';
import { compareArktsCandidateGrades } from './bench/simplify-arkts-inputs.mjs';
import { archivedPairedCandidateScore } from './run-arkts-paired-campaign.mjs';
import { readArktsPairedGradeTransitionPlan } from './summarize-arkts-paired-cohort.mjs';

const workerJobName = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const arms = ['off', 'on'];
const gradeGroups = ['f2p', 'p2p'];
const outcomes = ['GAIN_ONLY', 'LOSS_ONLY', 'GAIN_AND_LOSS', 'UNCHANGED'];
const contains = (root, file) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
};

async function readRegularFile(root, directory, name) {
  const file = path.join(root, directory, name);
  try {
    const resolved = await fs.realpath(file);
    if (resolved !== file || !contains(root, resolved) || !(await fs.lstat(file)).isFile()) return null;
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertCampaignUnchanged(plan) {
  const [execution, summary] = await Promise.all(['execution.json', 'summary.json'].map(name => readRegularFile(plan.root, '', name)));
  const active = await fs.lstat(path.join(plan.root, '.campaign-lock')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  assert(!active && execution && summary && digest(execution) === plan.executionSha256 && digest(summary) === plan.terminalSummarySha256,
    'Campaign changed while comparing independent grades.');
}

async function indexWorkerGrades(root, required) {
  const grades = new Map();
  if (!root || !required.size) return grades;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !workerJobName.test(entry.name)) continue;
    const directory = path.join(entry.name, 'grading');
    const grade = await readRegularFile(root, directory, 'results.json');
    if (!grade) continue;
    const sha256 = digest(grade);
    if (!required.has(sha256)) continue;
    if (!grades.has(sha256)) grades.set(sha256, []);
    grades.get(sha256).push(directory);
  }
  return grades;
}

async function readPinnedGrade(root, directories, arm) {
  for (const directory of directories) {
    const [grade, coverage, patch] = await Promise.all(['results.json', 'candidate-coverage.log', 'candidate.patch']
      .map(name => readRegularFile(root, directory, name)));
    if (grade && coverage && patch && digest(grade) === arm.gradeSha256 && digest(coverage) === arm.coverageSha256
      && digest(patch) === arm.input.candidateSha256) return grade;
  }
  return null;
}

function exactTransitions(pair, gradeBytes) {
  const grades = {};
  for (const arm of arms) {
    grades[arm] = JSON.parse(gradeBytes[arm]);
    assert.deepEqual(archivedPairedCandidateScore(grades[arm], pair[arm].input, grades[arm].calibrationDirectory), pair[arm].score);
  }
  const identity = ({ candidateSha256: _candidate, ...fields }) => fields;
  assert.deepEqual(identity(pair.off.input), identity(pair.on.input));
  const compared = compareArktsCandidateGrades(grades.off, grades.on,
    { beforePatchSha256: pair.off.input.candidateSha256, afterPatchSha256: pair.on.input.candidateSha256 });
  const result = Object.fromEntries(gradeGroups.map(group => {
    const { total, gains, losses, unchanged } = compared[group];
    assert.equal(pair.on.score[group].passed - pair.off.score[group].passed, gains - losses);
    return [group, { total, gains, losses, unchanged }];
  }));
  const gains = gradeGroups.some(group => result[group].gains > 0), losses = gradeGroups.some(group => result[group].losses > 0);
  const outcome = gains ? (losses ? 'GAIN_AND_LOSS' : 'GAIN_ONLY') : (losses ? 'LOSS_ONLY' : 'UNCHANGED');
  return { outcome, ...result };
}

const measured = value => Number.isSafeInteger(value) && value >= 0;
const pairedCost = (off, on) => measured(off) && measured(on) ? { off, on, delta: on - off } : null;

function measuredCost(rows, metric) {
  const pairs = rows.map(row => row.cost[metric]).filter(Boolean);
  const totals = pairs.reduce((sum, pair) => ({ off: sum.off + pair.off, on: sum.on + pair.on }), { off: 0, on: 0 });
  return { measuredPairs: pairs.length, missingPairs: rows.length - pairs.length,
    ...((pairs.length && pairedCost(totals.off, totals.on)) || { off: null, on: null, delta: null }) };
}

function outcomeSummary(rows) {
  return Object.fromEntries(outcomes.map(outcome => {
    const withOutcome = rows.filter(row => row.outcome === outcome);
    return [outcome, { pairs: withOutcome.length,
      cost: Object.fromEntries(['providerRequests', 'elapsedMs', 'totalTokens'].map(metric => [metric, measuredCost(withOutcome, metric)])) }];
  }));
}

export async function reportArktsGradeTransitions({ directory, planSha256, release, graderOutput }) {
  const plan = await readArktsPairedGradeTransitionPlan({ directory, planSha256, release });
  const workerRoot = graderOutput && await fs.realpath(graderOutput);
  if (workerRoot) assert(!contains(plan.root, workerRoot) && !contains(workerRoot, plan.root),
    'Private worker output must be separate from the campaign archive.');
  const needed = new Set(plan.pairs.flatMap(pair => arms.map(arm => pair[arm]).filter(arm => !arm.localGradeDirectory).map(arm => arm.gradeSha256)));
  const remote = await indexWorkerGrades(workerRoot, needed);
  const pairs = [];
  for (const pair of plan.pairs) {
    const identity = { id: pair.id, repetition: pair.repetition };
    const gradeBytes = Object.fromEntries(await Promise.all(arms.map(async name => {
      const arm = pair[name];
      return [name, arm.localGradeDirectory ? await readPinnedGrade(plan.root, [arm.localGradeDirectory], arm)
        : await readPinnedGrade(workerRoot, remote.get(arm.gradeSha256) ?? [], arm)];
    })));
    const unavailableArms = arms.filter(arm => !gradeBytes[arm]);
    if (unavailableArms.length) {
      pairs.push({ ...identity, status: 'UNAVAILABLE', reason: 'PINNED_GRADE_ARTIFACTS_UNAVAILABLE', unavailableArms });
      continue;
    }
    try {
      pairs.push({ ...identity, status: 'COMPARED', ...exactTransitions(pair, gradeBytes),
        cost: { providerRequests: pairedCost(pair.off.providerRequests, pair.on.providerRequests),
          elapsedMs: pairedCost(pair.off.elapsedMs, pair.on.elapsedMs), totalTokens: pairedCost(pair.off.tokens?.total, pair.on.tokens?.total) } });
    } catch {
      // A native result or parser error can contain private test names.
      pairs.push({ ...identity, status: 'UNAVAILABLE', reason: 'INDEPENDENT_GRADES_NOT_COMPARABLE' });
    }
  }
  const compared = pairs.filter(pair => pair.status === 'COMPARED');
  const tasks = Object.fromEntries(Object.entries(plan.taskPairs).map(([id, plannedPairs]) => {
    const verified = compared.filter(pair => pair.id === id);
    const matchedScoredPairs = pairs.filter(pair => pair.id === id).length;
    return [id, { plannedPairs, settledPairs: plan.settledTaskPairs[id], matchedScoredPairs, comparedPairs: verified.length, outcomes: outcomeSummary(verified) }];
  }));
  await assertCampaignUnchanged(plan);
  return { kind: 'arkts-private-grade-transitions-v1', release: { sourceCommit: release.sourceCommit, packageSha256: release.packageSha256 },
    planSha256: plan.planSha256, executionSha256: plan.executionSha256, terminalSummarySha256: plan.terminalSummarySha256,
    shardStatus: plan.shardStatus, plannedPairs: plan.plannedPairs, settledPairs: plan.settledPairs,
    matchedScoredPairs: plan.pairs.length, comparedPairs: compared.length,
    unavailableMatchedPairs: pairs.length - compared.length, protectedTestLossPairs: compared.filter(pair => pair.p2p.losses > 0).length,
    outcomes: outcomeSummary(compared), tasks, pairs };
}

const required = ['directory', 'plan-sha256', 'release'];
const usage = 'node scripts/report-arkts-grade-transitions.mjs --directory=DIR --plan-sha256=SHA --release=FILE [--grader-output=PRIVATE_DIR]';

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, ...Object.fromEntries([...required, 'grader-output']
    .map(name => [name, { type: 'string' }])) } });
  if (values.help) { console.log(usage); return; }
  assert(required.every(name => values[name]), usage);
  const report = await reportArktsGradeTransitions({ directory: values.directory, planSha256: values['plan-sha256'],
    release: JSON.parse(await fs.readFile(values.release)), graderOutput: values['grader-output'] });
  console.log(JSON.stringify(report, null, 2));
  if (report.unavailableMatchedPairs) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch(() => { console.error('Unable to verify the terminal campaign or read its private grade archive.'); process.exitCode = 1; });
