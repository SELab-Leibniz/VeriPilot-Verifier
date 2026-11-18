import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { readArktsCorrectionEvidence } from './bench/arkts-correction-evidence.mjs';
import { arktsAgentInput, assertArktsCalibrationBasis, digest, loadArktsTask, validateArktsAgentInput } from './bench/arkts-dataset.mjs';
import { inspectArktsModelProfile } from './bench/arkts-model-profile.mjs';
import { arktsAcceptancePolicy, arktsPublicAcceptanceIdentity, loadArktsPublicAcceptance, writeArktsQualifiedProbeDescriptor } from './bench/arkts-public-acceptance.mjs';
import { loadArktsQualifiedAcceptance } from './bench/arkts-qualified-acceptance.mjs';
import { loadRcConfigOverrides } from './bench/rc-config-overrides.mjs';
import { captureArktsToolchainIdentity } from './bench/arkts-toolchain-identity.mjs';
import { ArktsWorkerJobError, submitArktsWorkerJob } from './bench/arkts-worker-exchange.mjs';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { withFileLock } from './bench/file-lock.mjs';
import { gradeArkts, parseHypium } from './bench/hypium-results.mjs';
import { arktsInstrumentRuntime, parseArktsInstrumentResults } from './bench/arkts-instrument-results.mjs';
import { loadOriginalBasisWorkflow } from './bench/original-basis-workflow.mjs';
import { loadOpenSpecRequirementInventory, validateOpenSpecRequirementInventoryCase } from './bench/openspec-requirement-inventory.mjs';
import { shortArktsWorkspace } from './bench/short-workspace.mjs';
import { arktsHiddenReward, sealedCandidateGrade } from './bench/simplify-arkts-inputs.mjs';
import { atomicWriteJson } from '../lib/runtime-v2/utils.mjs';
import { targetVersion as openClawVersion } from '../lib/hosts/openclaw.mjs';
import { deepseekCodingModel, deepseekModel, deepseekReviewerModel } from './helpers/simplify-native-evaluation.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ...Array.from({ length: 10 }, (_, index) => `security_tool_${index + 1}`),
  'soduku-harmony_11', 'happyword_12', 'happyword_13',
];
const arms = ['off', 'on'];
const gradeGroups = ['f2p', 'p2p'];
const usageFields = ['providerRequests', 'elapsedMs'];
const requestPhases = ['document', 'stop', 'other'];
const tokenGroups = [...requestPhases, 'total'];
const qualificationFlags = ['qualification-report', 'qualification-report-sha256', 'probe-manifest', 'probe-manifest-sha256',
  'positive-manifest', 'positive-manifest-sha256'];
const defaultReviewerModel = businessModel => businessModel === deepseekCodingModel ? deepseekReviewerModel : businessModel;
const trialWallMs = 120 * 60_000;
const pilotWallMs = 30 * 60_000;
const businessCloseMs = 10_000;
const gradePhaseMs = 10 * 60_000;
const gradeWallMs = 4 * gradePhaseMs + 30_000;
const gradeRetryReserveMs = 2 * gradePhaseMs + 30_000;
const pairEnvelopeMs = 2 * (trialWallMs + businessCloseMs + gradeWallMs);
const runGit = promisify(execFile);
const harnessPaths = ['scripts', 'lib', 'packaging', 'config', '.runtime-corrector-default', 'package.json', 'package-lock.json',
  'docs/original-basis-release-inputs.json'];
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeNew = (file, value) => fs.writeFile(file, jsonBytes(value), { flag: 'wx' });
const maybeJson = file => readJson(file).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function pairedTrialSchedule(caseIds, repetitions) {
  assert(Number.isSafeInteger(repetitions) && repetitions > 0, 'Repetitions must be a positive integer');
  return Array.from({ length: repetitions }, (_, index) =>
    caseIds.flatMap((id, offset) => ((index + offset) % 2 ? ['on', 'off'] : arms)
      .map(arm => ({ id, repetition: index + 1, arm }))))
    .flat();
}

export function pairedWindowAvailable(deadline, now, envelope = pairEnvelopeMs) {
  return deadline - now >= envelope;
}

async function campaignInputs(dataset, ids = cases) {
  return Promise.all(ids.map(async id => {
    const { task, datasetDigest } = await loadArktsTask(dataset, id);
    return { id, task, datasetDigest, publicBytes: jsonBytes(arktsAgentInput(task)) };
  }));
}

function describePlan(inputs, repetitions, kind, model) {
  return planWithTaskPins(inputs.map(({ id, task, datasetDigest, publicBytes }) => ({
    id, baseCommit: task.base_commit, datasetSha256: datasetDigest, publicSha256: digest(publicBytes),
  })), repetitions, kind, model);
}

const campaignKind = 'arkts-openclaw-openspec-pairs-v1';
const pilotKind = 'arkts-openclaw-openspec-instrument-pilot-v1';
const subsetKind = 'arkts-openclaw-openspec-subset-v1';

function orderedCaseSubset(selected) {
  assert(Array.isArray(selected) && selected.length > 0 && selected.length < cases.length
    && new Set(selected).size === selected.length && selected.every(id => cases.includes(id)), 'Specify a distinct subset of benchmark cases');
  return cases.filter(id => selected.includes(id));
}

function plannedCaseIds(plan) {
  if (plan.kind === campaignKind) return cases;
  assert(plan.kind === subsetKind || plan.kind === pilotKind, 'Unknown paired campaign plan kind');
  return orderedCaseSubset(plan.tasks?.map(row => row.id));
}

function planWithTaskPins(tasks, repetitions, kind, model = deepseekCodingModel) {
  assert([deepseekCodingModel, deepseekModel].includes(model), 'Unknown paired campaign model');
  const wall = kind === pilotKind ? pilotWallMs : trialWallMs;
  return {
    kind,
    repetitions,
    model,
    trialWallMs: wall,
    businessCloseMs,
    gradePhaseMs,
    gradeWallMs,
    pairEnvelopeMs: 2 * (wall + businessCloseMs + gradeWallMs),
    tasks,
    schedule: pairedTrialSchedule(tasks.map(row => row.id), repetitions),
  };
}

export async function createPairedPlan(output, dataset, repetitions, pilotCases, { selectedCases } = {}) {
  assert(!pilotCases || !selectedCases, 'Choose either an Instrument Test pilot or a benchmark subset');
  const selected = pilotCases ?? selectedCases;
  const kind = pilotCases ? pilotKind : selectedCases ? subsetKind : campaignKind;
  const inputs = await campaignInputs(dataset, selected ? orderedCaseSubset(selected) : cases);
  const plan = describePlan(inputs, repetitions, kind);
  const publicRoot = path.join(output, 'public');
  await fs.mkdir(output);
  await fs.mkdir(publicRoot);
  for (const { id, publicBytes } of inputs)
    await fs.writeFile(path.join(publicRoot, `${id}.json`), publicBytes, { flag: 'wx' });
  await writeNew(path.join(output, 'plan.json'), plan);
  return plan;
}

export async function verifyPairedPlan(output, dataset) {
  const planBytes = await fs.readFile(path.join(output, 'plan.json'));
  const plan = JSON.parse(planBytes);
  const inputs = await campaignInputs(dataset, plannedCaseIds(plan));
  assert.deepEqual(plan, describePlan(inputs, plan.repetitions, plan.kind, plan.model), 'The frozen schedule or dataset changed');
  for (const { id, publicBytes } of inputs) {
    const publicFile = path.join(output, 'public', `${id}.json`);
    assert((await fs.readFile(publicFile)).equals(publicBytes), `Public input changed: ${id}`);
  }
  return { plan, planSha256: digest(planBytes), inputs };
}

export async function verifyPublicPairedPlan(output, expectedSha256) {
  const planBytes = await fs.readFile(path.join(output, 'plan.json'));
  const planSha256 = digest(planBytes);
  assert.equal(planSha256, expectedSha256, 'Public campaign plan differs from its frozen digest');
  const plan = JSON.parse(planBytes);
  assert.notEqual(plan.kind, pilotKind, 'Instrument Test pilot plans require their local device routes');
  assert.deepEqual(plan.tasks?.map(row => row.id), plannedCaseIds(plan), 'Public campaign omits or reorders a task');
  const tasks = plan.tasks.map(({ id, baseCommit, datasetSha256, publicSha256 }) => {
    assert.match(baseCommit, /^[a-f0-9]{40}$/u);
    for (const sha of [datasetSha256, publicSha256]) assert.match(sha, /^[a-f0-9]{64}$/u);
    return { id, baseCommit, datasetSha256, publicSha256 };
  });
  assert.deepEqual(plan, planWithTaskPins(tasks, plan.repetitions, plan.kind, plan.model), 'Public campaign schedule differs from the paired protocol');
  const inputs = await Promise.all(tasks.map(async ({ id, baseCommit, datasetSha256, publicSha256 }) => {
    const publicBytes = await fs.readFile(path.join(output, 'public', `${id}.json`));
    assert.equal(digest(publicBytes), publicSha256, `Public input changed: ${id}`);
    const task = validateArktsAgentInput(JSON.parse(publicBytes), id);
    assert.equal(task.base_commit, baseCommit, `Public task base changed: ${id}`);
    return { id, task, datasetDigest: datasetSha256, publicBytes };
  }));
  return { plan, planSha256, inputs };
}

export async function preflightPairedBaseCache(inputs, cacheRoot, {
  gitExecutable = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git',
} = {}) {
  const checked = await Promise.all(inputs.map(async ({ id, task }) => {
    const cache = path.join(cacheRoot, task.repo.replace('/', '--') + '.git');
    try {
      const { stdout } = await runGit(gitExecutable, [
        '--git-dir', cache, 'rev-parse', '--verify', `${task.base_commit}^{commit}`,
      ], { windowsHide: true, timeout: 30_000, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
      return { id, baseCommit: task.base_commit, cache, available: stdout.trim() === task.base_commit };
    } catch {
      return { id, baseCommit: task.base_commit, cache, available: false };
    }
  }));
  const missing = checked.filter(row => !row.available);
  assert(!missing.length, `Exact base commits missing from the preseeded cache: ${missing.map(row => row.id).join(', ')}`);
  return checked;
}

export async function assertFrozenCampaignHarness(root, releaseCommit) {
  const git = args => runGit('git', ['-C', root, ...args], {
    windowsHide: true, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).then(result => result.stdout.trim());
  const head = await git(['rev-parse', '--verify', 'HEAD']);
  assert.equal(head, releaseCommit, 'Campaign checkout HEAD must match the frozen RC source commit');
  const dirty = await git(['status', '--porcelain=v1', '--untracked-files=no', '--', ...harnessPaths]);
  assert(!dirty, 'Campaign checkout contains changes to tracked harness inputs');
}

export async function verifyCalibration(input, root, expectedSha256, toolchainSha256) {
  const bytes = await fs.readFile(path.join(root, 'results.json'));
  const record = JSON.parse(bytes);
  const sha256 = digest(bytes);
  assert(!expectedSha256 || sha256 === expectedSha256, `Calibration changed: ${input.id}`);
  assertArktsCalibrationBasis(record, input.task, input.datasetDigest);
  assert.equal(record.environment.toolchain?.sha256, toolchainSha256,
    `Calibration toolchain differs from the active toolchain for ${input.id}. Rerun with --pin-toolchain.`);
  const logs = {};
  const instrument = record.environment.runtime === arktsInstrumentRuntime;
  const parse = instrument ? parseArktsInstrumentResults : parseHypium;
  const fingerprints = [];
  for (const phase of ['base', 'gold']) {
    const row = record.results?.find(value => value.phase === phase);
    assert(row?.execution, `Missing ${phase} execution receipt: ${input.id}`);
    const raw = await fs.readFile(path.join(root, `${phase}-coverage.log`));
    const parsed = parse(raw.toString('utf8'));
    if (instrument) {
      const expectedIds = [...input.task.FAIL_TO_PASS, ...input.task.PASS_TO_PASS].sort();
      assert.deepEqual(Object.keys(parsed.statuses).sort(), expectedIds, `Different Instrument Test case IDs: ${input.id} ${phase}`);
      const { device, runnerSha256, suiteSha256, runtime, appBuildMode } = row.execution;
      assert.equal(runtime, arktsInstrumentRuntime, 'Instrument Test calibration lacks a native execution receipt');
      assert.deepEqual(device, record.environment.device, 'Instrument Test calibration device changed');
      assert.equal(appBuildMode, record.environment.appBuildMode, 'Instrument Test app build mode changed');
      for (const hash of [runnerSha256, suiteSha256]) assert.match(hash ?? '', /^[a-f0-9]{64}$/u);
      fingerprints.push([suiteSha256, runnerSha256]);
    }
    const checked = gradeArkts(input.task, parsed, row.execution);
    assert(phase === 'base' ? checked.validFailToPassBase : checked.resolved,
      `Invalid ${phase} calibration: ${input.id}`);
    logs[phase] = digest(raw);
  }
  if (instrument) assert.deepEqual(fingerprints[0], fingerprints[1], 'Instrument Test base and gold used different suites or runners');
  return { root, sha256, logs };
}

export async function calibrationPins(location, inputs, toolchainSha256) {
  const directory = (await fs.stat(location)).isDirectory();
  const configured = directory ? null : await readJson(location);
  const entries = await Promise.all(inputs.map(async input => {
    const entry = configured?.[input.id];
    assert(directory || typeof entry?.root === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256),
      `Calibration mapping requires root and sha256 for ${input.id}`);
    const root = directory ? path.join(location, input.id) : path.resolve(path.dirname(location), entry.root);
    return [input.id, await verifyCalibration(input, root, entry?.sha256, toolchainSha256)];
  }));
  return Object.fromEntries(entries);
}

export function scorePairedCandidate(grade, patchSha256, input) {
  if (grade?.kind !== 'hidden-test-candidate-grade') return null;
  const reward = arktsHiddenReward(grade, patchSha256, input.id, input.datasetDigest);
  if (!reward) return null;
  assert.equal(reward.f2p_total, input.task.FAIL_TO_PASS.length);
  assert.equal(reward.p2p_total, input.task.PASS_TO_PASS.length);
  return {
    f2p: { passed: reward.f2p_passed, total: reward.f2p_total },
    p2p: { passed: reward.p2p_passed, total: reward.p2p_total },
    resolved: reward.f2p_passed === reward.f2p_total && reward.p2p_passed === reward.p2p_total,
  };
}

export function pairedGradeInput(task, candidateSha256, calibrationSha256, toolchainSha256, releaseCommit) {
  return { id: task.id, baseCommit: task.baseCommit, datasetSha256: task.datasetSha256, candidateSha256,
    calibrationSha256, toolchainSha256, releaseCommit, phaseTimeoutMs: gradePhaseMs };
}

export function archivedPairedCandidateScore(grade, input, calibrationRoot) {
  const result = sealedCandidateGrade(grade, input.candidateSha256);
  assert(grade.instanceId === input.id && grade.baseCommit === input.baseCommit && grade.environment.datasetDigest === input.datasetSha256
    && grade.environment.toolchain.sha256 === input.toolchainSha256 && grade.calibrationDirectory === calibrationRoot,
  'Archived grade differs from the task, calibration or toolchain');
  const counts = Object.fromEntries(gradeGroups.map(key => [key, { passed: result[key].passed.length, total: result[key].expected }]));
  const score = { ...counts, resolved: gradeGroups.every(key => counts[key].passed === counts[key].total) };
  assert(validPairedScore(score) && score.resolved === result.resolved, 'Invalid archived candidate grade totals');
  return score;
}

const pairKey = row => `${row.id}/r${row.repetition}`;

export function validPairedScore(score) {
  return gradeGroups.every(group => {
    const { passed, total } = score?.[group] ?? {};
    return Number.isSafeInteger(passed) && Number.isSafeInteger(total) && passed >= 0 && passed <= total;
  }) && score.resolved === gradeGroups.every(group => score[group].passed === score[group].total);
}

function matchingScoredArms({ off, on }) {
  return Boolean(validPairedScore(off?.score) && validPairedScore(on?.score) && off.comparisonIdentity && on.comparisonIdentity
    && isDeepStrictEqual(off.comparisonIdentity, on.comparisonIdentity)
    && gradeGroups.every(group => off.score[group].total === on.score[group].total));
}

function pairedObservations(schedule, observations) {
  const pairs = new Map(schedule.filter(row => row.arm === 'off').map(row => [pairKey(row), {}]));
  for (const row of observations) {
    const pair = pairs.get(pairKey(row));
    assert(pair && arms.includes(row.arm) && !Object.hasOwn(pair, row.arm), 'Observation does not identify a unique planned trial');
    pair[row.arm] = row;
  }
  return [...pairs.values()];
}

const measuredUsage = value => Number.isSafeInteger(value) && value >= 0;

function pairedUsage(population, read) {
  const measured = population.map(({ off, on }) => [read(off), read(on)])
    .filter(pair => pair.every(measuredUsage));
  return { pairs: measured.length, off: measured.length ? measured.reduce((sum, [off]) => sum + off, 0) : null,
    on: measured.length ? measured.reduce((sum, [, on]) => sum + on, 0) : null };
}

function requestBreakdown(row) {
  const { rc, business } = row.usage ?? {};
  const document = rc?.document?.requests, stop = rc?.stop?.requests, other = business?.requests;
  if (![document, stop, other, row.providerRequests].every(measuredUsage) || document + stop + other !== row.providerRequests) return null;
  return { document, stop, other };
}

function observedArmUsage(rows) {
  const aggregate = read => {
    const values = rows.map(read).filter(measuredUsage);
    return { measuredTrials: values.length, missingTrials: rows.length - values.length,
      sum: values.length ? values.reduce((sum, value) => sum + value, 0) : null };
  };
  return {
    ...Object.fromEntries(usageFields.map(field => [field, aggregate(row => row[field])])),
    requestsByPhase: Object.fromEntries(requestPhases.map(phase => [phase, aggregate(row => requestBreakdown(row)?.[phase])])),
    tokens: Object.fromEntries(tokenGroups.map(group => [group, aggregate(row => row.tokens?.[group])])),
  };
}

export function pairedBusinessTokens(result) {
  const split = result?.tokenSplit;
  const requests = requestBreakdown({ usage:split, providerRequests:result?.modelRequests });
  if (!requests) return null;
  const tokens = (source, projection, phase) => {
    const expected = requests[phase];
    if (source?.observedCalls !== expected || source.completeCalls !== expected || source.unexpectedUsageRecords > 0
      || source.tokens !== projection.tokens) return null;
    if (expected === 0 && (source.tokens === null || source.tokens === 0)) return 0;
    return measuredUsage(source.tokens) && source.tokens > 0 ? source.tokens : null;
  };
  const document = tokens(result.documentCost?.usage, split.rc.document, 'document');
  const stop = tokens(result.stopCost?.usage, split.rc.stop, 'stop');
  const other = tokens(result.businessUsage, split.business, 'other');
  const total = [document, stop, other].every(measuredUsage) && measuredUsage(document + stop + other) ? document + stop + other : null;
  return { document, stop, other, total };
}

function pairedScoreChanges(matched) {
  const counts = Object.fromEntries(gradeGroups.map(group => [group, { higher: 0, lower: 0, equal: 0 }]));
  const pairs = matched.map(({ off, on }) => {
    const metrics = Object.fromEntries(gradeGroups.map(group => {
      const { passed: offPassed, total } = off.score[group], onPassed = on.score[group].passed;
      const delta = onPassed - offPassed;
      counts[group][delta > 0 ? 'higher' : delta < 0 ? 'lower' : 'equal']++;
      return [group, { total, offPassed, onPassed, delta }];
    }));
    return { id: off.id, repetition: off.repetition, ...metrics };
  });
  return { ...counts, pairs };
}

const hasSettledBusinessWorkflow = row => row.business === 'finished' && row.execution?.exitCode === 0
  && row.execution.outputComplete === true && row.execution.interrupted === false
  && typeof row.businessCompleted === 'boolean';

export function pairedCampaignComparison(schedule, observations) {
  const pairs = pairedObservations(schedule, observations);
  const completed = pairs.filter(({ off, on }) => off && on);
  const scored = completed.filter(({ off, on }) => off.score && on.score);
  const matched = scored.filter(matchingScoredArms);
  const transitions = { improved: 0, regressed: 0, bothResolved: 0, neitherResolved: 0 };
  for (const { off, on } of matched) {
    if (off.score.resolved) transitions[on.score.resolved ? 'bothResolved' : 'regressed']++;
    else transitions[on.score.resolved ? 'improved' : 'neitherResolved']++;
  }
  const workflow = { bothCompleted: 0, onlyOffCompleted: 0, onlyOnCompleted: 0, neitherCompleted: 0, unavailable: 0 };
  for (const { off, on } of completed) {
    if (![off, on].every(hasSettledBusinessWorkflow)) workflow.unavailable++;
    else if (off.businessCompleted) workflow[on.businessCompleted ? 'bothCompleted' : 'onlyOffCompleted']++;
    else workflow[on.businessCompleted ? 'onlyOnCompleted' : 'neitherCompleted']++;
  }
  const usage = population => Object.fromEntries(usageFields.map(field =>
    [field, pairedUsage(population, row => row[field])]));
  const resolved = matched.filter(({ off, on }) => off.score.resolved && on.score.resolved);
  const requestUsage = population => Object.fromEntries(requestPhases.map(group =>
    [group, pairedUsage(population, row => requestBreakdown(row)?.[group])]));
  const tokenUsage = population => Object.fromEntries(tokenGroups.map(group =>
    [group, pairedUsage(population, row => row.tokens?.[group])]));
  return {
    plannedPairs: pairs.length, matchedScoredPairs: matched.length,
    bothAttemptedPairsMissingGrade: completed.length - scored.length,
    scoredIdentityMismatches: scored.length - matched.length,
    partiallyObservedPairs: pairs.filter(({ off, on }) => Boolean(off) !== Boolean(on)).length,
    unstartedPairs: pairs.filter(({ off, on }) => !off && !on).length,
    transitions, scoreChanges: pairedScoreChanges(matched), workflow,
    matchedUsage: usage(matched), attemptedUsage: usage(completed),
    bothResolvedUsage: usage(resolved),
    requestBreakdown: { matched: requestUsage(matched), bothResolved: requestUsage(resolved), attempted: requestUsage(completed) },
    tokenUsage: { matched: tokenUsage(matched), bothResolved: tokenUsage(resolved), attempted: tokenUsage(completed) },
  };
}

export function pairedCampaignSummary(schedule, observations) {
  const paired = pairedObservations(schedule, observations);
  const metrics = rows => Object.fromEntries(gradeGroups.map(kind => [kind, rows.reduce((total, { score }) => ({
    passed: total.passed + score[kind].passed, total: total.total + score[kind].total,
  }), { passed: 0, total: 0 })]));
  return Object.fromEntries(arms.map(arm => {
    const planned = schedule.filter(row => row.arm === arm).length;
    const attempted = observations.filter(row => row.arm === arm);
    const scored = attempted.filter(row => row.score);
    const matched = paired.filter(matchingScoredArms).map(pair => pair[arm]);
    const resolved = scored.filter(row => row.score.resolved).length;
    const workflowSettled = attempted.filter(hasSettledBusinessWorkflow);
    const workflowIncomplete = workflowSettled.filter(row => row.businessCompleted === false);
    const completionReasons = new Map();
    for (const row of workflowIncomplete) {
      const reason = row.completionReason ?? 'NOT_RECORDED';
      completionReasons.set(reason, (completionReasons.get(reason) ?? 0) + 1);
    }
    return [arm, {
      planned, attempted: attempted.length, scored: scored.length, resolved,
      workflow: { completed: workflowSettled.length - workflowIncomplete.length,
        incomplete: workflowIncomplete.length, unavailable: attempted.length - workflowSettled.length,
        incompleteReasons: Object.fromEntries(completionReasons) },
      observedUsage: observedArmUsage(attempted),
      notAttempted: planned - attempted.length, unscored: attempted.length - scored.length,
      passAt1: scored.length === planned ? resolved / planned : null,
      resolvedPerScoredTrial: scored.length ? resolved / scored.length : null,
      scoredMetrics: metrics(scored), matchedPairs: matched.length,
      matchedMetrics: metrics(matched),
    }];
  }));
}

const slotName = ({ id, repetition, arm }) => `${id}-r${repetition}-${arm}`;
const trialUnsettled = row => row.execution?.exitCode !== 0 || row.execution.interrupted || !row.execution.outputComplete
  || row.gradingExecution && (row.gradingExecution.interrupted || !row.gradingExecution.outputComplete)
  || row.gradingFailure || ['rate-limited', 'framework-error'].includes(row.business);

async function readSettledPrefix(directory, schedule) {
  const receipts = new Set(await fs.readdir(directory));
  const observations = [];
  for (const [index, trial] of schedule.entries()) {
    const stem = slotName(trial), started = `${stem}.started.json`, result = `${stem}.result.json`;
    const hasStart = receipts.delete(started), hasResult = receipts.delete(result);
    if (!hasStart && !hasResult) continue;
    assert(hasStart && hasResult && observations.length === index, `Incomplete or out-of-order receipts for ${stem}`);
    assert.deepEqual(await readJson(path.join(directory, started)), trial, `Claim identity changed for ${stem}`);
    const row = await readJson(path.join(directory, result));
    assert.deepEqual({ id: row.id, repetition: row.repetition, arm: row.arm }, trial, `Result identity changed for ${stem}`);
    assert(!trialUnsettled(row), `Unsettled execution for ${stem}`);
    observations.push(row);
  }
  assert(receipts.size === 0 && observations.length % 2 === 0, 'Campaign receipts must be an exact prefix of whole pairs');
  return observations;
}

function assertPairLimit(maxPairs, schedule) {
  assert(maxPairs === undefined || Number.isSafeInteger(maxPairs) && maxPairs > 0 && maxPairs <= schedule.length / 2,
    '--max-pairs must be a positive integer no greater than the number of planned pairs');
}

export async function executePairedCampaign({ output, plan, identity, deadline, resume, maxPairs, signal, recheck, dispatch, now = Date.now }) {
  assertPairLimit(maxPairs, plan.schedule);
  const root = path.join(output, 'invocations');
  const receipts = path.join(output, 'observations');
  const execution = path.join(output, 'execution.json');
  return withFileLock(path.join(output, '.campaign-lock'), async () => {
    let observations = [], number = 1;
    if (resume) {
      assert.deepEqual(await readJson(execution), identity, 'Resume inputs differ from the frozen campaign identity');
      const runs = (await fs.readdir(root)).sort((a, b) => Number(a) - Number(b));
      assert(runs.length && runs.every((run, index) => run === String(index + 1)), 'Campaign invocation history is incomplete');
      number = runs.length + 1;
      const previousInvocation = path.join(root, runs.at(-1));
      const prior = await readJson(path.join(previousInvocation, 'summary.json'));
      assert.equal(prior.planSha256, identity.planSha256, 'Previous receipt belongs to another plan');
      assert(['INSUFFICIENT_PAIR_WINDOW', 'PAIR_LIMIT_REACHED', 'CANCELLED'].includes(prior.status),
        'Resume requires a settled pause or cancellation between whole pairs');
      observations = await readSettledPrefix(receipts, plan.schedule);
      assert.deepEqual(observations, prior.observations, 'Prior observations differ from the settled trial receipts');
      if (prior.status === 'PAIR_LIMIT_REACHED') {
        const start = await readJson(path.join(previousInvocation, 'start.json'));
        assert(Number.isSafeInteger(start.startSlot) && start.startSlot >= 0 && start.startSlot % 2 === 0
          && Number.isSafeInteger(start.maxPairs) && start.maxPairs > 0
          && observations.length - start.startSlot === 2 * start.maxPairs && observations.length < plan.schedule.length,
        'Previous pair limit differs from the settled trial receipts');
      }
      if (prior.status === 'CANCELLED') {
        assert(observations.length < plan.schedule.length, 'Cancelled campaign has no unstarted pairs');
        assert(observations.every(row => row.score === null ? row.businessCompleted === false
          : row.businessCompleted === true && validPairedScore(row.score)), 'Cancelled campaign lacks a settled business or grade outcome');
      }
    } else {
      await writeNew(execution, identity);
      await fs.mkdir(receipts);
      await fs.mkdir(root);
    }
    const invocation = path.join(root, String(number));
    await fs.mkdir(invocation);
    const startSlot = observations.length;
    const endSlot = maxPairs === undefined ? plan.schedule.length : Math.min(plan.schedule.length, startSlot + 2 * maxPairs);
    await writeNew(path.join(invocation, 'start.json'), { deadline, startedAt: new Date(now()).toISOString(), startSlot, maxPairs });
    let pendingTrial, problem, halted = false;
    try {
      for (let index = startSlot; index < endSlot && !halted && !signal.aborted; index += 2) {
        if (!pairedWindowAvailable(deadline, now(), plan.pairEnvelopeMs)) break;
        for (const [offset, trial] of plan.schedule.slice(index, index + 2).entries()) {
          if (signal.aborted) break;
          await recheck();
          if (signal.aborted || offset === 0 && !pairedWindowAvailable(deadline, now(), plan.pairEnvelopeMs)) break;
          const slot = path.join(receipts, slotName(trial));
          await writeNew(`${slot}.started.json`, trial);
          pendingTrial = trial;
          const row = await dispatch(trial);
          await recheck();
          await writeNew(`${slot}.result.json`, row);
          observations.push(row);
          pendingTrial = null;
          if (trialUnsettled(row)) {
            halted = true;
            break;
          }
        }
      }
    } catch (error) {
      problem = error;
      if (pendingTrial) observations.push({ ...pendingTrial, score: null, business: 'campaign-error' });
    }
    const summary = pairedCampaignSummary(plan.schedule, observations);
    const pauseStatus = observations.length === endSlot ? 'PAIR_LIMIT_REACHED' : 'INSUFFICIENT_PAIR_WINDOW';
    const status = problem ? 'ERROR' : signal.aborted ? 'CANCELLED'
      : halted ? 'NEEDS_ATTENTION'
      : observations.length < plan.schedule.length ? pauseStatus
      : arms.every(arm => summary[arm].matchedPairs === summary[arm].planned) ? 'COMPLETE' : 'COMPLETE_WITH_UNMATCHED_TRIALS';
    const scope = plan.kind === pilotKind ? 'INSTRUMENT_PILOT' : plan.kind === subsetKind ? 'BENCHMARK_SUBSET' : null;
    const report = { planSha256: identity.planSha256, invocation: number, status, arms: summary,
      comparison: pairedCampaignComparison(plan.schedule, observations), observations,
      ...(scope ? { scope, tasks: plan.tasks.map(task => task.id) } : {}) };
    await writeNew(path.join(invocation, 'summary.json'), report);
    await atomicWriteJson(path.join(output, 'summary.json'), report);
    if (problem) throw problem;
    return report;
  }, { timeoutMs: 1000 });
}

const flag = (name, value) => `--${name}=${value}`;
const flags = values => Object.entries(values).map(([name, value]) => flag(name, value));

export function pairedReviewerArguments(arm, reviewerOptions) {
  if (arm !== 'on') return [];
  const { 'native-openspec-approval': nativeApproval, ...options } = reviewerOptions;
  return [...flags(options), ...(nativeApproval === true ? ['--native-openspec-approval'] : [])];
}

export function pairedNativeOpenSpecEvidence(openSpec) {
  const { nativeApplyApproval: approval, nativeApplyVerdict: verdict } = openSpec ?? {};
  const { plan, inventory } = verdict ?? {};
  return {
    ...(approval && { nativeApplyApproval: {
      status: approval.status, changeName: approval.changeName, proposalRunId: approval.proposalRunId, applyRunId: approval.applyRunId,
      ...(approval.approvedRevision !== undefined ? { approvedRevision: approval.approvedRevision } : {}),
      ...(approval.step !== undefined ? { step: approval.step } : {}),
      ...(approval.inventorySha256 !== undefined
        ? { inventorySha256: approval.inventorySha256, requiredAtomCount: approval.requiredAtomCount } : {}),
    } }),
    ...(verdict && { nativeApplyVerdict: {
      status: verdict.status,
      ...(plan && { occurrenceId: verdict.occurrenceId, reviewStatus: verdict.reviewStatus, plan: {
        status: plan.status, changeName: plan.changeName, proposalRunId: plan.proposalRunId, applyRunId: plan.applyRunId,
        approvedRevision: plan.approvedRevision, differences: plan.differences,
        ...(plan.currentRevision !== undefined ? { currentRevision: plan.currentRevision } : {}),
        ...(plan.taskCount !== undefined ? { taskCount: plan.taskCount, completedTaskCount: plan.completedTaskCount } : {}),
        ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
      } }),
      ...(inventory ? { inventory: { status: inventory.status, finalRunId: inventory.finalRunId,
        ...(inventory.status === 'OBSERVED' ? { occurrenceId: inventory.occurrenceId, evaluationId: inventory.evaluationId,
          inventorySha256: inventory.inventorySha256, requiredAtomCount: inventory.requiredAtomCount,
          reviewStatus: inventory.reviewStatus } : {}) } } : {}),
      ...(verdict.continuations?.status === 'OBSERVED' ? { continuations: { status: 'OBSERVED',
        planRestorations: verdict.continuations.planRestorations, codeRepairs: verdict.continuations.codeRepairs } } : {}),
    } }),
  };
}

async function command(name, args, timeoutMs, signal) {
  const { exitCode, interrupted, reason, outputComplete, durationMs } = await runBoundedProcess(process.execPath, [path.join(sourceRoot, 'scripts', name), ...args],
    { cwd: sourceRoot, timeoutMs, signal, exitDrainMs: 3000 });
  // Child errors can carry a provider response or private evaluator context.
  return { exitCode, interrupted, reason, outputComplete, durationMs };
}

export function checkWorkerGrade(result, expected, totals) {
  assert.deepEqual(result?.input, expected, 'Worker grade differs from its sealed request');
  const { execution, score } = result;
  assert(typeof execution?.interrupted === 'boolean' && typeof execution?.outputComplete === 'boolean'
    && (execution.exitCode === null || Number.isInteger(execution.exitCode)), 'Invalid worker execution receipt');
  const missing = result.gradingFailure === 'GRADE_RECEIPT_MISSING';
  if (result.gradingFailure !== undefined) assert(missing && score === null && cleanGradeExit(execution), 'Invalid missing worker grade receipt');
  if (score !== null) {
    assert(!execution.interrupted && execution.outputComplete, 'Incomplete worker execution cannot be scored');
    for (const [key, total] of Object.entries(totals)) {
      assert(score?.[key]?.total === total && Number.isInteger(score[key].passed)
        && score[key].passed >= 0 && score[key].passed <= total, 'Invalid worker score totals');
    }
    assert.equal(score.resolved, score.f2p.passed === score.f2p.total && score.p2p.passed === score.p2p.total, 'Invalid worker resolution');
    assert.equal(execution.exitCode, score.resolved ? 0 : 1, 'Worker grade exit status differs from its score');
  }
  return { gradingExecution: execution, score, ...(score ? {} : { gradingFailure: missing ? 'GRADE_RECEIPT_MISSING' : 'GRADE_INCOMPLETE' }) };
}

const cleanGradeExit = execution => execution?.exitCode === 0 && execution.reason === 'closed'
  && execution.interrupted === false && execution.outputComplete === true;
const retryableGrade = ({ score, gradingExecution: execution, gradingFailure }) => score === null && (
  gradingFailure === 'GRADE_RECEIPT_MISSING' && cleanGradeExit(execution)
  || execution?.reason === 'EAGAIN' && execution.exitCode === null && execution.interrupted === true && execution.outputComplete === false);
const gradeAttemptName = number => `grading-attempt-${number}.json`;

export async function gradePairedWithRetry({ directory, binding, deadline, signal, readCandidate, evaluate, now = Date.now }) {
  const attempt = async (patch, retry) => {
    try { return await evaluate({ patch, deadline, retry }); }
    catch (error) {
      const cancelled = signal.aborted && (error === signal.reason || error?.code === 'ABORT_ERR' && error.cause === signal.reason);
      const reason = error instanceof ArktsWorkerJobError ? error.reason : cancelled ? 'cancelled' : null;
      if (!reason) throw error;
      return { score: null, gradingFailure: `GRADE_WORKER_${reason.toUpperCase()}`,
        gradingExecution: { exitCode: null, interrupted: true, outputComplete: false, reason: `worker-${reason}` } };
    }
  };
  const first = await attempt(await readCandidate(), false);
  const patch = await readCandidate();
  if (!retryableGrade(first) || signal.aborted || deadline - now() < gradeRetryReserveMs) return first;
  const save = async (number, outcome) => {
    const bytes = jsonBytes({ number, ...binding, deadline, outcome });
    await fs.writeFile(path.join(directory, gradeAttemptName(number)), bytes, { flag: 'wx' });
    return digest(bytes);
  };
  const firstSha256 = await save(1, first);
  const second = await attempt(patch, true);
  await readCandidate();
  const secondSha256 = await save(2, second);
  return { ...second, gradingRetry: { firstSha256, secondSha256 } };
}

export async function verifyPairedGradeRetry(row, calibrationSha256, readReceipt) {
  if (!row.gradingRetry) return;
  const { firstSha256, secondSha256 } = row.gradingRetry;
  assert([firstSha256, secondSha256, row.patchSha256, row.businessResultSha256, calibrationSha256].every(value => /^[a-f0-9]{64}$/u.test(value ?? '')),
    'Grading retry lacks its frozen evidence hashes');
  const [first, second] = await Promise.all([firstSha256, secondSha256].map(async (hash, index) => {
    const bytes = await readReceipt(gradeAttemptName(index + 1));
    assert.equal(digest(bytes), hash, 'Grading attempt receipt changed');
    const { number, patchSha256, businessResultSha256, comparisonIdentity, calibrationSha256: attemptCalibration, deadline, outcome } = JSON.parse(bytes);
    assert.equal(number, index + 1);
    assert.equal(patchSha256, row.patchSha256);
    assert.equal(businessResultSha256, row.businessResultSha256);
    assert.deepEqual(comparisonIdentity, row.comparisonIdentity);
    assert.equal(attemptCalibration, calibrationSha256);
    assert(Number.isSafeInteger(deadline) && deadline > 0, 'Grading attempt lacks a valid deadline');
    return { deadline, outcome };
  }));
  assert(first.deadline === second.deadline && retryableGrade(first.outcome), 'Grading retry did not follow an eligible first attempt in the same window');
  const { gradingExecution, score, gradingFailure, gradingEvidenceSha256 } = row;
  assert.deepEqual(second.outcome, { gradingExecution, score, ...(gradingFailure ? { gradingFailure } : {}),
    ...(gradingEvidenceSha256 ? { gradingEvidenceSha256 } : {}) }, 'Observation differs from the final grading attempt');
}

async function runTrial({ trial, input, output, common, workflowIdentity, modelProfile, release, reviewerOptions, calibration, calibrationOptions,
  toolchainSha256, buildToolchain, gradingExchange, gradeTotals, businessWallMs, campaignDeadline, signal, publicAcceptanceSha256, qualifiedProbe }) {
  const directory = path.join(output, 'trials', trial.id, `r${trial.repetition}`, trial.arm);
  await fs.mkdir(directory, { recursive: true });
  const business = path.join(directory, 'business');
  const publicFile = path.join(output, 'public', `${trial.id}.json`);
  assert((await fs.readFile(publicFile)).equals(input.publicBytes), `Public input changed: ${trial.id}`);
  const acceptanceDescriptor = qualifiedProbe && await writeArktsQualifiedProbeDescriptor(directory, input.task, digest(input.publicBytes), qualifiedProbe);
  const trialDeadline = Date.now() + businessWallMs;
  const execution = await command('run-release-e2e.mjs', [
    '--live', ...(trial.arm === 'off' ? ['--rc-off'] : []), '--baseline-local-tests',
    ...flags({ ...common, case: trial.id, output: business, 'public-input': publicFile, 'dataset-sha256': input.datasetDigest,
      'public-input-sha256': digest(input.publicBytes), 'deadline-at': trialDeadline, ...release,
      ...(publicAcceptanceSha256 ? { 'public-acceptance-sha256': publicAcceptanceSha256 } : {}),
      ...(acceptanceDescriptor ? { 'public-acceptance-descriptor': acceptanceDescriptor } : {}) }),
    ...pairedReviewerArguments(trial.arm, reviewerOptions),
  ], businessWallMs + businessCloseMs, signal);
  const resultBytes = await fs.readFile(path.join(business, 'result.json'))
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const result = resultBytes && JSON.parse(resultBytes);
  const row = { ...trial, execution, business: result?.state ?? 'no-result', businessCompleted: result?.businessNatural === true,
    completionReason: result?.reason ?? null,
    ...(resultBytes && { businessResultSha256: digest(resultBytes) }),
    ...(result?.requiredChecks ? { requiredChecks: { lint: result.requiredChecks.lint?.status ?? 'NOT_RUN' } } : {}),
    ...(result?.openSpec?.applyTransportRecovery ? { applyTransportRecovery: {
      attempted: Boolean(result.openSpec.applyTransportRecovery.retryRunId), verified: result.openSpec.applyTransportRecovery.verified === true,
    } } : {}),
    ...pairedNativeOpenSpecEvidence(result?.openSpec),
    ...(result?.openSpecRequirementInventorySha256 ? { openSpecRequirementInventorySha256: result.openSpecRequirementInventorySha256 } : {}),
    rc: trial.arm === 'off' ? 'NOT_APPLICABLE' : result?.finalStop?.status ?? null,
    providerRequests: result?.modelRequests ?? null, usage: result?.tokenSplit ?? null, elapsedMs: result?.elapsedMs ?? null,
    ...(result && { tokens: pairedBusinessTokens(result) }),
    score: null };
  if (execution.interrupted || execution.exitCode !== 0 || !execution.outputComplete || result?.frameworkError || signal.aborted) return row;
  if (trial.arm === 'on' && result?.state === 'finished' && result.frozen)
    row.correctionEvidence = await readArktsCorrectionEvidence(business, {
      includeIncompleteWorkflow: true, expectedResultSha256: row.businessResultSha256,
    });
  if (!row.businessCompleted || !hasSettledBusinessWorkflow(row)) return row;
  const candidate = path.join(business, 'freeze', 'candidate.patch');
  const patch = await fs.readFile(candidate);
  const patchSha256 = digest(patch);
  const manifest = await readJson(path.join(business, 'manifest.json'));
  const workflowReceipt = await readJson(path.join(business, 'workflow-messages.json'));
  assert.deepEqual(workflowReceipt.workflow, workflowIdentity, 'Business workflow differs from campaign preflight');
  assert.equal(result.instance?.id, trial.id, 'Business result task differs from its slot');
  assert.equal(result.instance?.datasetDigest, input.datasetDigest, 'Business dataset identity differs from its slot');
  assert.equal(result.rcEnabled, trial.arm === 'on', 'Executed RC arm differs from its slot');
  assert.equal(result.publicInputSha256, digest(input.publicBytes), 'Business input hash differs from its slot');
  assert.equal(result.openSpecRequirementInventorySha256, trial.arm === 'on' ? reviewerOptions['openspec-requirement-inventory-sha256'] : undefined,
    'Business requirement inventory differs from its campaign pin');
  assert.match(result.preparedTree ?? '', /^[a-f0-9]{40}$/u, 'Business result lacks its exact prepared Git tree');
  assert.equal(manifest.packageSha256, release['package-sha256'], 'Business package differs from the frozen release');
  assert.equal(manifest.sourceCommit, release['source-commit'], 'Business harness differs from the frozen release');
  assert.equal(manifest.publicAcceptanceSha256, publicAcceptanceSha256, 'Business public acceptance differs from campaign preflight');
  if (qualifiedProbe) {
    const pin = result.publicAcceptancePin;
    assert(isDeepStrictEqual(pin?.requirementBindings, qualifiedProbe.requirementBindings)
      && arktsPublicAcceptanceIdentity(result.publicInputSha256, pin) === publicAcceptanceSha256,
    'Business did not retain its qualified public probe');
  }
  let lintTools;
  if (manifest.lintRequirement) {
    const lint = result.requiredChecks?.lint;
    assert(lint?.status === 'PASS' && lint.success === true && lint.configSha256 === manifest.lintRequirement.configSha256,
      'The final candidate lacks the original project-required lint check');
    lintTools = Object.fromEntries(['vendorIndexSha256', 'hpauditorIndexSha256', 'hpauditorBinarySha256'].map(key => {
      assert.match(lint.lint?.[key] ?? '', /^[a-f0-9]{64}$/u, 'The final lint check lacks its tool identity');
      return [key, lint.lint[key]];
    }));
  }
  if (common['instrument-config']) assert.equal(manifest.publicInstrumentSha256, toolchainSha256, 'Business test backend differs from the grader');
  assert.equal(result.frozen?.patchSha256, patchSha256, 'Candidate patch changed after freezing');
  const endpoint = result.providerIdentity?.endpointSha256;
  assert.match(endpoint ?? '', /^[a-f0-9]{64}$/u, 'Business result lacks its actual provider endpoint identity');
  assert.equal(result.providerIdentity.modelRef, `custom/${common.model}`, 'Business model differs from the campaign');
  const reviewer = trial.arm === 'on' ? reviewerOptions['reviewer-model'] ?? common.model : null;
  assert.equal(manifest.reviewerModelRef, reviewer ? `custom/${reviewer}` : null, 'Reviewer policy differs from the campaign');
  assert.equal(result.providerIdentity.reviewerModelRef, reviewer && reviewer !== common.model ? `custom/${reviewer}` : undefined,
    'Reviewer provider route differs from the campaign');
  assert.equal(result.providerIdentity.endpointSha256, modelProfile.endpointSha256, 'Business endpoint differs from the campaign profile');
  assert.equal(result.gateway?.hostVersion, openClawVersion, 'Business host differs from the campaign');
  const comparisonIdentity = { preparedTree: result.preparedTree, publicInputSha256: result.publicInputSha256,
    packageSha256: manifest.packageSha256, sourceCommit: manifest.sourceCommit, modelRef: result.providerIdentity.modelRef, endpoint,
    hostVersion: result.gateway?.hostVersion, workflow: workflowIdentity, toolchainSha256,
    ...(publicAcceptanceSha256 ? { publicAcceptanceSha256 } : {}),
    ...(manifest.lintRequirement ? { lintRequirement: manifest.lintRequirement, lintTools } : {}),
    ...(buildToolchain ? { buildToolchainSha256: buildToolchain.sha256 } : {}) };
  const evaluated = { ...row, patchSha256, comparisonIdentity };
  if (signal.aborted) return evaluated;
  const transfer = pairedGradeInput({ id: trial.id, baseCommit: input.task.base_commit, datasetSha256: input.datasetDigest },
    patchSha256, calibration.sha256, toolchainSha256, release['source-commit']);
  const checkCalibration = async () => assert.deepEqual(await verifyCalibration(input, calibration.root, calibration.sha256, toolchainSha256),
    calibration, 'Calibration logs changed during the campaign');
  const saveGradeEvidence = async (outcome, retry, { gradeSha256, coverageSha256 }) => {
    if (!outcome.score) return outcome;
    assert([gradeSha256, coverageSha256].every(hash => /^[a-f0-9]{64}$/u.test(hash ?? '')), 'Scored grade lacks its evaluator evidence hashes');
    const evidence = jsonBytes({ version: 1, slot: trial, attempt: retry ? 2 : 1, businessResultSha256: row.businessResultSha256,
      input: transfer, execution: outcome.gradingExecution, score: outcome.score, gradeSha256, coverageSha256 });
    await fs.writeFile(path.join(directory, 'grading-evidence.json'), evidence, { flag: 'wx' });
    return { ...outcome, gradingEvidenceSha256: digest(evidence) };
  };
  const gradeResult = await gradePairedWithRetry({ directory, deadline: Math.min(Date.now() + gradeWallMs, campaignDeadline), signal,
    binding: { patchSha256, businessResultSha256: row.businessResultSha256, comparisonIdentity, calibrationSha256: calibration.sha256 },
    async readCandidate() {
      const [freshPatch, freshResult] = await Promise.all([fs.readFile(candidate), fs.readFile(path.join(business, 'result.json'))]);
      assert.equal(digest(freshPatch), patchSha256, 'Candidate patch changed after freezing');
      assert.equal(digest(freshResult), row.businessResultSha256, 'Business result changed after freezing');
      return freshPatch;
    },
    async evaluate({ patch: sealedPatch, deadline, retry }) {
      if (!gradingExchange) await checkCalibration();
      const timeoutMs = deadline - Date.now();
      if (signal.aborted || timeoutMs <= 0) return { gradingExecution: { exitCode: null, interrupted: true, outputComplete: false,
        reason: signal.aborted ? 'cancelled-before-launch' : 'deadline-before-launch' }, score: null };
      if (gradingExchange) {
        const receipt = await submitArktsWorkerJob(gradingExchange, 'grade', transfer, { timeoutMs, signal,
          prepare: job => fs.writeFile(path.join(job, 'candidate.patch'), sealedPatch, { flag: 'wx' }) });
        return saveGradeEvidence(checkWorkerGrade(receipt, transfer, gradeTotals), retry, receipt);
      }
      const grading = path.join(directory, retry ? 'grading-retry' : 'grading');
      const gradingExecution = await command('calibrate-arkts-bench.mjs', flags({
        ...calibrationOptions, case: trial.id, candidate, 'candidate-sha256': patchSha256, output: grading,
        'calibration-dir': calibration.root, 'phase-timeout-ms': gradePhaseMs,
      }), timeoutMs, signal);
      const unscored = { gradingExecution, score: null };
      if (gradingExecution.interrupted || !gradingExecution.outputComplete) return unscored;
      const gradeBytes = await fs.readFile(path.join(grading, 'results.json')).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!gradeBytes) return { ...unscored, gradingFailure: 'GRADE_RECEIPT_MISSING' };
      const grade = JSON.parse(gradeBytes);
      assert.equal(grade.baseCommit, input.task.base_commit, 'Candidate grade used a different base');
      assert.equal(grade.environment?.testPatchSha256, input.task.test_patch_sha256, 'Candidate grade used different evaluator tests');
      assert.equal(grade.environment?.toolchain?.sha256, toolchainSha256, 'Candidate grade used a different toolchain');
      const sealed = await fs.readFile(path.join(grading, 'candidate.patch'));
      assert.equal(digest(sealed), patchSha256, 'Sealed evaluator patch differs from the business candidate');
      assert.equal(grade.candidateSha256, patchSha256, 'Evaluator receipt is not bound to its sealed candidate');
      await checkCalibration();
      const score = scorePairedCandidate(grade, patchSha256, input);
      if (!score) return { ...unscored, gradingFailure: 'GRADE_INCOMPLETE' };
      assert.equal(gradingExecution.exitCode, score.resolved ? 0 : 1, 'Candidate grade exit status differs from its score');
      assert.deepEqual(archivedPairedCandidateScore(grade, transfer, calibration.root), score);
      const coverage = await fs.readFile(path.join(grading, 'candidate-coverage.log'));
      return saveGradeEvidence({ gradingExecution, score }, retry, { gradeSha256: digest(gradeBytes), coverageSha256: digest(coverage) });
    },
  });
  return { ...evaluated, ...gradeResult };
}

const usage = `node scripts/run-arkts-paired-campaign.mjs --plan --dataset=<evaluator task JSON directory> --output=<new campaign directory> [--repetitions=3]
  [--cases=<benchmark subset with standard trial windows> | --pilot-cases=<subset of task IDs for a 30-minute Instrument Test pilot>]
node scripts/run-arkts-paired-campaign.mjs --check-environment --tool-root=<Huawei CLT> --java-home=<JBR>
  [--openclaw-profile=<provider profile>] [--reviewer-model=<configured model>]
node scripts/run-arkts-paired-campaign.mjs (--live | --preflight) --output=<planned directory>
  --release=<release.json>
  --host-root=<OpenClaw 2026.7.1-2> --workflow-root=<pinned OpenSpec/SDD> --openclaw-profile=<provider profile>
  --tool-root=<Huawei CLT> --java-home=<JBR> --cache=<preseeded bare repos>
  --workspace-root=<short business worktree parent>
  --json5-package=<file> [--deadline-at=<epoch milliseconds for --live>]
  [--openspec-cli=<official OpenSpec 1.4.1 bin/openspec.js>] [--reviewer-model=deepseek-v4-pro] [--rc-config-overrides=<file>] [--resume]
  Local tests: --dataset=<same dataset> --calibrations=<case directories or JSON mapping> --grade-workspace-root=<short evaluator worktree parent>
  Instrument Test: add --instrument-config=<HDC, cases and app build modes JSON> to local tests and calibration commands
  Separate workers: --plan-sha256=<trusted frozen plan hash> --public-test-exchange=<public test share> --grading-exchange=<private grading share>
  RC on defaults to config/arkts-openspec-correction.json for task-start public regression evidence.
  --native-openspec-approval enables native approval and arming of the first Apply run in the ON arm.
  --openspec-requirement-inventory=<file> --openspec-requirement-inventory-sha256=<hash>
    Use a pinned operator inventory of public production requirements for native ON approval and Stop.
  --public-acceptance adds registered public task checks to both arms and to RC Stop.
  --qualification-report=<native public smoke report> --qualification-report-sha256=<hash>
    --probe-manifest=<file> --probe-manifest-sha256=<hash> --positive-manifest=<file> --positive-manifest-sha256=<hash>
    With --public-acceptance, adds supplemental probes verified on the measured native test route.
  --check-environment checks the native toolchain and profile layout before calibration.
  --preflight checks frozen inputs and measured calibration compatibility without dispatching a trial.
  Omit --openclaw-profile during preflight to check infrastructure before a model profile is available.
  A pair starts only when both full business and grading windows fit before the campaign deadline.
  Admitted arms keep equal windows through settlement, including controller overhead.
  An eligible missing grade or temporary evaluator launch failure receives one retry within the same grading window.
  --max-pairs=<positive integer> caps the number of whole pairs in this live invocation.
  --resume uses the same frozen inputs and a new deadline after a settled pause between pairs.`;
const commonKeys = ['host-root', 'workflow-root', 'openclaw-profile', 'tool-root', 'java-home', 'cache', 'workspace-root', 'json5-package'];

async function campaignToolchain({ toolRoot, javaHome, instrumentConfig }) {
  if (!instrumentConfig) return captureArktsToolchainIdentity({ toolRoot, javaHome });
  const { captureArktsInstrumentIdentity, loadArktsInstrumentConfig } = await import('./bench/arkts-instrument-runtime.mjs');
  return captureArktsInstrumentIdentity({ config: await loadArktsInstrumentConfig(instrumentConfig), toolRoot, javaHome });
}

async function checkEnvironment(args) {
  assert(args['tool-root'] && args['java-home'], usage);
  const [modelProfile, toolchain] = await Promise.all([
    inspectArktsModelProfile({ profilePath: args['openclaw-profile'], model: deepseekCodingModel,
      reviewerModel: args['reviewer-model'] ?? deepseekReviewerModel }),
    campaignToolchain({ toolRoot: args['tool-root'], javaHome: args['java-home'], instrumentConfig: args['instrument-config'] })
      .then(identity => ({ state: 'TOOLCHAIN_VERIFIED', identity }), error => ({ state: 'TOOLCHAIN_UNAVAILABLE', reason: error.message })),
  ]);
  console.log(JSON.stringify({ state: 'ENVIRONMENT_CHECK_NO_MODEL', toolchain, modelProfile }));
  if (toolchain.state !== 'TOOLCHAIN_VERIFIED' || modelProfile.state !== 'PROFILE_CONFIGURED') process.exitCode = 1;
}

async function main() {
  const { values: args } = parseArgs({ options: Object.fromEntries([
    ...['plan', 'live', 'preflight', 'check-environment', 'resume', 'help', 'public-acceptance', 'native-openspec-approval']
      .map(key => [key, { type: 'boolean' }]),
    ...['dataset', 'output', 'repetitions', 'release', 'calibrations', 'deadline-at', 'max-pairs', 'reviewer-model', 'rc-config-overrides', 'plan-sha256',
      'grade-workspace-root', 'openspec-cli', 'public-test-exchange', 'grading-exchange', 'instrument-config', 'cases', 'pilot-cases',
      'openspec-requirement-inventory', 'openspec-requirement-inventory-sha256',
      ...commonKeys, ...qualificationFlags]
      .map(key => [key, { type: 'string' }]),
  ]) });
  if (args.help) { console.log(usage); return; }
  assert([args.plan, args.live, args.preflight, args['check-environment']].filter(Boolean).length === 1 && (!args.resume || args.live), usage);
  const pairLimitArg = args['max-pairs'];
  const maxPairs = pairLimitArg === undefined ? undefined : Number(pairLimitArg);
  assert(pairLimitArg === undefined || args.live && /^[1-9]\d*$/u.test(pairLimitArg) && Number.isSafeInteger(maxPairs),
    '--max-pairs requires a positive decimal integer in --live mode');
  assert(!args['public-acceptance'] || args.live || args.preflight, '--public-acceptance applies to paired execution and preflight');
  assert(!args['native-openspec-approval'] || args.live || args.preflight,
    '--native-openspec-approval applies to paired execution and preflight');
  const inventoryFile = args['openspec-requirement-inventory'], inventorySha256 = args['openspec-requirement-inventory-sha256'];
  assert(inventoryFile === undefined && inventorySha256 === undefined
    || (args.live || args.preflight) && inventoryFile && /^[0-9a-f]{64}$/u.test(inventorySha256 ?? ''),
  'The strict OpenSpec inventory requires a file and SHA-256 pin in live or preflight mode.');
  const qualify = qualificationFlags.some(key => args[key] !== undefined);
  assert(!qualify || args['public-acceptance'] && qualificationFlags.every(key =>
    key.endsWith('-sha256') ? /^[a-f0-9]{64}$/u.test(args[key] ?? '') : Boolean(args[key])),
  'Supplemental probes require --public-acceptance and the native qualification report and both manifests with their SHA-256 pins');
  assert(args.plan || args.cases === undefined && args['pilot-cases'] === undefined, 'Case selection is frozen at planning');
  if (args['check-environment']) return checkEnvironment(args);
  assert(args.output, usage);
  const output = path.resolve(args.output), dataset = args.dataset && path.resolve(args.dataset);
  if (args.plan) {
    assert(dataset, usage);
    const plan = await createPairedPlan(output, dataset, Number(args.repetitions ?? 3), args['pilot-cases']?.split(','),
      { selectedCases: args.cases?.split(',') });
    const planSha256 = digest(await fs.readFile(path.join(output, 'plan.json')));
    console.log(JSON.stringify({ state: 'PLAN_NO_MODEL', kind: plan.kind, tasks: plan.tasks.length, trials: plan.schedule.length, planSha256, output }));
    return;
  }
  const remote = Boolean(args['grading-exchange']);
  const requiredKeys = args.preflight ? commonKeys.filter(key => key !== 'openclaw-profile') : commonKeys;
  assert(!args.repetitions && args.release && requiredKeys.every(key => args[key]) && (remote
    ? args['public-test-exchange'] && /^[a-f0-9]{64}$/u.test(args['plan-sha256'] ?? '') && !dataset && !args.calibrations && !args['grade-workspace-root'] && !args['instrument-config']
    : dataset && args.calibrations && args['grade-workspace-root'] && !args['public-test-exchange'] && !args['plan-sha256']), usage);
  assert(process.platform === 'win32' && process.arch === 'x64' || process.platform === 'darwin' && process.arch === 'arm64',
    'Campaign execution and preflight require the Windows x64 or macOS arm64 Huawei/Hypium toolchain');
  const deadline = Number(args['deadline-at']);
  if (args.live) assert(Number.isSafeInteger(deadline) && deadline > Date.now(), 'Use a future absolute --deadline-at in milliseconds');
  const { plan, planSha256, inputs } = await (remote ? verifyPublicPairedPlan(output, args['plan-sha256']) : verifyPairedPlan(output, dataset));
  const model = plan.model, reviewerModel = args['reviewer-model'] ?? defaultReviewerModel(model);
  const privateInventoryFile = inventoryFile && await fs.realpath(inventoryFile);
  const readRequirementInventory = privateInventoryFile && (async () => {
    const businessRoot = await fs.realpath(args['workspace-root']).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return path.resolve(args['workspace-root']);
    });
    assert(!within(businessRoot, privateInventoryFile), 'Keep the OpenSpec inventory outside business worktrees.');
    const inventory = await loadOpenSpecRequirementInventory(privateInventoryFile, inventorySha256);
    for (const { id, task, publicBytes } of inputs) validateOpenSpecRequirementInventoryCase(inventory.cases.get(id), {
      publicInputSha256: digest(publicBytes), problemStatement: task.problem_statement });
  });
  if (readRequirementInventory) await readRequirementInventory();
  assertPairLimit(maxPairs, plan.schedule);
  assert(plan.kind !== pilotKind || args['instrument-config'], 'The frozen Instrument Test pilot requires its device configuration');
  const release = await readJson(path.resolve(args.release));
  assert(/^[a-f0-9]{40}$/u.test(release.sourceCommit ?? '') && /^[a-f0-9]{64}$/u.test(release.packageSha256 ?? ''),
    'Invalid frozen release metadata');
  await assertFrozenCampaignHarness(sourceRoot, release.sourceCommit);
  const packagePath = path.resolve(path.dirname(path.resolve(args.release)), release.archive);
  assert.equal(digest(await fs.readFile(packagePath)), release.packageSha256, 'Frozen candidate package changed');
  const releaseArgs = { package: packagePath, 'package-sha256': release.packageSha256, 'source-commit': release.sourceCommit };
  const reviewerOptions = {
    ...(args['reviewer-model'] || reviewerModel !== model ? { 'reviewer-model': reviewerModel } : {}),
    ...(args['native-openspec-approval'] || privateInventoryFile ? { 'native-openspec-approval': true } : {}),
    ...(privateInventoryFile ? { 'openspec-requirement-inventory': privateInventoryFile,
      'openspec-requirement-inventory-sha256': inventorySha256 } : {}),
    'rc-config-overrides': args['rc-config-overrides'] ? path.resolve(args['rc-config-overrides'])
      : path.join(sourceRoot, 'config', 'arkts-openspec-correction.json'),
  };
  const common = { ...Object.fromEntries(commonKeys.filter(key => args[key]).map(key => [key, path.resolve(args[key])])),
    ...(args['openspec-cli'] ? { 'openspec-cli': path.resolve(args['openspec-cli']) } : {}), provider: 'host-profile', model };
  const host = await readJson(path.join(common['host-root'], 'package.json'));
  assert(host.name === 'openclaw' && host.version === openClawVersion, `Expected OpenClaw ${openClawVersion}`);
  const workflowPins = await readJson(path.join(sourceRoot, 'docs', 'original-basis-release-inputs.json'));
  const workflow = await loadOriginalBasisWorkflow(common['workflow-root'], common['host-root'], workflowPins.workflow,
    { openspecCli: common['openspec-cli'] });
  createRequire(common['json5-package']).resolve('json5');
  const profilePath = common['openclaw-profile'];
  const modelProfile = await inspectArktsModelProfile({ profilePath, model, reviewerModel });
  if (args.live || profilePath)
    assert.equal(modelProfile.state, 'PROFILE_CONFIGURED', `OpenClaw profile check failed (${modelProfile.state}).`);
  let toolchain, calibration, gradingWorkspaceRoot, calibrationOptions, gradingExchange, buildToolchain, gradeTotals;
  const localBuild = () => captureArktsToolchainIdentity({ toolRoot: common['tool-root'], javaHome: common['java-home'], localTests: false });
  const instrumentConfig = args['instrument-config'] && path.resolve(args['instrument-config']);
  const measureLocalToolchain = () => campaignToolchain({ toolRoot: common['tool-root'], javaHome: common['java-home'], instrumentConfig });
  if (remote) {
    gradingExchange = await fs.realpath(args['grading-exchange']);
    const publicExchange = await fs.realpath(args['public-test-exchange']);
    assert(!within(publicExchange, gradingExchange) && !within(gradingExchange, publicExchange),
      'Use separate public and grading exchange roots');
    for (const exchange of [publicExchange, gradingExchange])
      assert(!within(exchange, common['workspace-root']) && !within(common['workspace-root'], exchange),
        'Keep exchange directories outside business workspaces');
    buildToolchain = await localBuild();
    const taskPins = plan.tasks.map(({ id, baseCommit, datasetSha256 }) => ({ id, baseCommit, datasetSha256 }));
    const [grader, publicRunner] = await Promise.all([
      submitArktsWorkerJob(gradingExchange, 'calibration', { releaseCommit: release.sourceCommit, tasks: taskPins }, { timeoutMs: 120_000 }),
      submitArktsWorkerJob(publicExchange, 'identity', { releaseCommit: release.sourceCommit }, { timeoutMs: 120_000 }),
    ]);
    ({ toolchain, calibration, gradeTotals } = grader);
    assert.match(toolchain?.sha256 ?? '', /^[a-f0-9]{64}$/u, 'Missing grading toolchain identity');
    assert.equal(publicRunner?.toolchainSha256, toolchain.sha256, 'Public tests and hidden grading require the same worker toolchain fingerprint');
    assert.equal(publicRunner.runtime, toolchain.runtime, 'Public tests and hidden grading require the same worker backend');
    assert(toolchain.runtime === undefined || toolchain.runtime === arktsInstrumentRuntime, 'Unknown benchmark worker backend');
    const selected = taskPins.map(task => task.id).sort();
    assert.deepEqual(Object.keys(calibration ?? {}).sort(), selected, 'Grader returned a different set of campaign calibrations');
    assert.deepEqual(Object.keys(gradeTotals ?? {}).sort(), selected, 'Grader returned different campaign test counts');
    for (const totals of Object.values(gradeTotals)) {
      assert.deepEqual(Object.keys(totals).sort(), ['f2p', 'p2p']);
      for (const count of Object.values(totals)) assert(Number.isSafeInteger(count) && count >= 0, 'Invalid grader test count');
    }
    for (const pin of Object.values(calibration)) {
      for (const sha256 of [pin.sha256, pin.logs?.base, pin.logs?.gold]) assert.match(sha256 ?? '', /^[a-f0-9]{64}$/u);
    }
    common['public-test-exchange'] = publicExchange;
    common['public-test-toolchain-sha256'] = toolchain.sha256;
    if (toolchain.runtime) common['public-test-runtime'] = toolchain.runtime;
  } else {
    toolchain = await measureLocalToolchain();
    if (instrumentConfig) {
      assert(inputs.every(({ id }) => Object.hasOwn(toolchain.cases, id)), 'Instrument Test configuration omits a campaign case');
      common['instrument-config'] = instrumentConfig;
      common['instrument-toolchain-sha256'] = toolchain.sha256;
    }
    calibration = await calibrationPins(path.resolve(args.calibrations), inputs, toolchain.sha256);
    gradingWorkspaceRoot = path.resolve(args['grade-workspace-root']);
    assert(path.relative(common['workspace-root'], gradingWorkspaceRoot), 'Use separate business and evaluator worktree roots');
    shortArktsWorkspace(output, 'grd', sourceRoot, gradingWorkspaceRoot);
    calibrationOptions = { dataset, 'workspace-root': gradingWorkspaceRoot, 'toolchain-sha256': toolchain.sha256,
      ...(instrumentConfig ? { 'instrument-config': instrumentConfig } : {}),
      ...Object.fromEntries(['tool-root', 'java-home', 'cache', 'json5-package'].map(key => [key, common[key]])) };
  }
  const cachedBases = await preflightPairedBaseCache(inputs, common.cache);
  shortArktsWorkspace(output, 'biz', sourceRoot, common['workspace-root']);
  const providerProfilePin = profilePath && digest(await fs.readFile(profilePath));
  const policyPath = reviewerOptions['rc-config-overrides'];
  const policySha256 = digest(await fs.readFile(policyPath));
  const readQualification = () => loadArktsQualifiedAcceptance({ reportFile: args['qualification-report'],
    reportSha256: args['qualification-report-sha256'], probeManifest: args['probe-manifest'], probeManifestSha256: args['probe-manifest-sha256'],
    positiveManifest: args['positive-manifest'], positiveManifestSha256: args['positive-manifest-sha256'],
    planSha256, releaseCommit: release.sourceCommit, toolchainSha256: toolchain.sha256, runtime: toolchain.runtime, inputs });
  const qualified = qualify ? await readQualification() : null;
  const qualifiedPublicAcceptance = qualified && { ...qualified.qualification,
    cases: Object.fromEntries([...qualified.checks].map(([id, check]) => [id, check.identitySha256])) };
  let publicAcceptance;
  if (args['public-acceptance']) {
    const entries = await Promise.all(inputs.map(async ({ id, task, publicBytes }) =>
      [id, await loadArktsPublicAcceptance(task, digest(publicBytes))]));
    const selected = [...entries.filter(([, check]) => check), ...(qualified?.checks ?? [])];
    assert(selected.length, 'The selected plan has no public acceptance checks');
    const policy = await loadRcConfigOverrides(policyPath);
    for (const [, check] of selected) arktsAcceptancePolicy(policy, { ...check, probe: check.probe ?? '<qualified-probe>' });
    publicAcceptance = Object.fromEntries(selected.map(([id, check]) => [id, check.identitySha256]));
  }
  if (args.preflight) {
    console.log(JSON.stringify({ state: 'PREFLIGHT_NO_MODEL', planSha256, tasks: plan.tasks.length,
      release: { sourceCommit: release.sourceCommit, packageSha256: release.packageSha256 }, policySha256,
      workflow: workflow.identity, toolchain,
      buildToolchain, modelProfile, publicAcceptance,
      ...(reviewerOptions['native-openspec-approval'] ? { nativeOpenSpecApproval: true } : {}),
      ...(inventorySha256 ? { openSpecRequirementInventorySha256: inventorySha256 } : {}),
      ...(qualifiedPublicAcceptance ? { qualifiedPublicAcceptance } : {}) }));
    return;
  }
  const identity = { planSha256, common, gradingEvidenceVersion: 1,
    ...(remote ? { gradingExchange, buildToolchain, gradeTotals } : { dataset, gradingWorkspaceRoot }), releaseArgs, reviewerOptions, workflow: workflow.identity,
    providerProfilePin, modelProfile, policySha256, toolchain, cachedBases, calibration, ...(publicAcceptance ? { publicAcceptance } : {}),
    ...(qualifiedPublicAcceptance ? { qualifiedPublicAcceptance } : {}) };
  const controller = new AbortController(), cancel = () => controller.abort();
  const inputById = new Map(inputs.map(input => [input.id, input]));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const report = await executePairedCampaign({ output, plan, identity, deadline, resume: args.resume, maxPairs, signal: controller.signal,
      async recheck() {
        await assertFrozenCampaignHarness(sourceRoot, release.sourceCommit);
        assert.equal(digest(await fs.readFile(profilePath)), providerProfilePin, 'Provider profile changed after the first dispatch');
        assert.equal(digest(await fs.readFile(policyPath)), policySha256, 'RC policy changed after the first dispatch');
        if (readRequirementInventory) await readRequirementInventory();
        if (qualify) await readQualification();
        if (buildToolchain) assert.equal((await localBuild()).sha256, buildToolchain.sha256, 'Local build toolchain changed after preflight');
        if (instrumentConfig) assert.equal((await measureLocalToolchain()).sha256, toolchain.sha256, 'Instrument Test device or toolchain changed after preflight');
      },
      dispatch: trial => runTrial({ trial, input: inputById.get(trial.id), output, common, workflowIdentity: workflow.identity, modelProfile, release: releaseArgs, reviewerOptions,
        calibration: calibration[trial.id], calibrationOptions, toolchainSha256: toolchain.sha256, buildToolchain, gradingExchange,
        gradeTotals: gradeTotals?.[trial.id], businessWallMs: plan.trialWallMs, campaignDeadline: deadline, signal: controller.signal,
        publicAcceptanceSha256: publicAcceptance?.[trial.id], qualifiedProbe: qualified?.checks.get(trial.id) }),
    });
    console.log(JSON.stringify({ invocation: report.invocation, status: report.status, scope: report.scope, arms: report.arms }));
    if (!['COMPLETE', 'PAIR_LIMIT_REACHED'].includes(report.status)) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
