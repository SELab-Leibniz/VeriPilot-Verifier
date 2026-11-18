import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { serveArktsWorkerJobs, submitArktsWorkerJob } from '../scripts/bench/arkts-worker-exchange.mjs';
import {
  assertFrozenCampaignHarness, checkWorkerGrade, createPairedPlan, executePairedCampaign, gradePairedWithRetry,
  pairedCampaignComparison, pairedCampaignSummary, pairedNativeOpenSpecEvidence, pairedReviewerArguments, pairedTrialSchedule, pairedWindowAvailable,
  preflightPairedBaseCache, scorePairedCandidate, verifyCalibration, verifyPairedGradeRetry, verifyPairedPlan, verifyPublicPairedPlan,
} from '../scripts/run-arkts-paired-campaign.mjs';

const cases = [
  ...Array.from({ length: 10 }, (_, index) => `security_tool_${index + 1}`),
  'soduku-harmony_11', 'happyword_12', 'happyword_13',
];

test('passes the native OpenSpec approval flag only to the ON release runner', () => {
  const legacy = { 'reviewer-model': 'fixture', 'rc-config-overrides': '/fixture/policy.json' };
  const optedIn = { ...legacy, 'native-openspec-approval': true };
  const legacyArguments = ['--reviewer-model=fixture', '--rc-config-overrides=/fixture/policy.json'];
  assert.deepEqual(pairedReviewerArguments('off', optedIn), []);
  assert.deepEqual(pairedReviewerArguments('on', legacy), legacyArguments);
  assert.deepEqual(pairedReviewerArguments('on', optedIn), [...legacyArguments, '--native-openspec-approval']);
  const strict = { ...optedIn, 'openspec-requirement-inventory': '/fixture/operator-only.json',
    'openspec-requirement-inventory-sha256': 'c'.repeat(64) };
  assert.deepEqual(pairedReviewerArguments('off', strict), []);
  assert.deepEqual(pairedReviewerArguments('on', strict), [...legacyArguments,
    '--openspec-requirement-inventory=/fixture/operator-only.json', `--openspec-requirement-inventory-sha256=${'c'.repeat(64)}`,
    '--native-openspec-approval']);
  assert.equal(optedIn['native-openspec-approval'], true);
});

test('records native approval and the exact original Apply verdict independently', () => {
  assert.deepEqual(pairedNativeOpenSpecEvidence(undefined), {});
  assert.deepEqual(pairedNativeOpenSpecEvidence({ applyChecklistPreserved: true }), {});
  const target = { changeName: 'fixture', proposalRunId: 'proposal', applyRunId: 'apply' };
  const approval = { ...target, status: 'ARMED', approvedRevision: 'approved' };
  const verdict = { status: 'OBSERVED', occurrenceId: 'stop', reviewStatus: 'NO_DEVIATION_FOUND',
    plan: { ...target, status: 'PRESERVED', approvedRevision: 'approved', currentRevision: 'current',
      differences: [], taskCount: 3, completedTaskCount: 3 } };
  assert.deepEqual(pairedNativeOpenSpecEvidence({
    nativeApplyApproval: { ...approval, sessionKey: 'agent:main:fixture' }, nativeApplyVerdict: verdict,
  }), { nativeApplyApproval: approval, nativeApplyVerdict: verdict });
  const inventoryPin = { inventorySha256: 'a'.repeat(64), requiredAtomCount: 3 };
  const inventoryReceipt = { ...inventoryPin, status: 'OBSERVED', finalRunId: 'repair', occurrenceId: 'repair-stop',
    evaluationId: 'review', reviewStatus: 'UNVERIFIED' };
  assert.deepEqual(pairedNativeOpenSpecEvidence({ nativeApplyApproval: { ...approval, ...inventoryPin, requiredAtoms: ['private'] },
    nativeApplyVerdict: { ...verdict, inventory: { ...inventoryReceipt, requiredAtoms: ['private'] } } }),
  { nativeApplyApproval: { ...approval, ...inventoryPin }, nativeApplyVerdict: { ...verdict, inventory: inventoryReceipt } });
  const continuations = { status: 'OBSERVED', planRestorations: 1, codeRepairs: 1 };
  assert.deepEqual(pairedNativeOpenSpecEvidence({ nativeApplyVerdict: { ...verdict,
    continuations: { ...continuations, steps: [{ privateData: 'not projected' }] } } }),
  { nativeApplyVerdict: { ...verdict, continuations } });
  assert.deepEqual(pairedNativeOpenSpecEvidence({ nativeApplyVerdict: { ...verdict,
    continuations: { status: 'UNVERIFIED', planRestorations: 1, codeRepairs: 1 } } }), { nativeApplyVerdict: verdict });
  const unverified = { ...target, status: 'UNVERIFIED', step: 'arm' };
  assert.deepEqual(pairedNativeOpenSpecEvidence({ nativeApplyApproval: unverified }), { nativeApplyApproval: unverified });
  assert.deepEqual(pairedNativeOpenSpecEvidence({ nativeApplyVerdict: { status: 'NOT_OBSERVED' } }),
    { nativeApplyVerdict: { status: 'NOT_OBSERVED' } });
});

test('reports independent toolchain and model prerequisites without campaign inputs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-environment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../scripts/run-arkts-paired-campaign.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [entry, '--check-environment', `--tool-root=${root}`, `--java-home=${root}`],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.state, 'ENVIRONMENT_CHECK_NO_MODEL');
  assert.equal(report.toolchain.state, 'TOOLCHAIN_UNAVAILABLE');
  assert.equal(report.modelProfile.state, 'PROFILE_MISSING');
  assert.deepEqual(await fs.readdir(root), []);
});

test('live execution requires a model profile before checking the environment', () => {
  const entry = fileURLToPath(new URL('../scripts/run-arkts-paired-campaign.mjs', import.meta.url));
  const supplied = ['output', 'release', 'host-root', 'workflow-root', 'tool-root', 'java-home', 'cache', 'workspace-root',
    'json5-package', 'dataset', 'calibrations', 'grade-workspace-root'];
  const run = spawnSync(process.execPath, [entry, '--live', ...supplied.map(key => `--${key}=unused`)],
    { encoding:'utf8', windowsHide:true, timeout:15_000 });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /node scripts\/run-arkts-paired-campaign\.mjs --plan/u);
});

test('the campaign pair cap requires a positive decimal integer in live mode', () => {
  const entry = fileURLToPath(new URL('../scripts/run-arkts-paired-campaign.mjs', import.meta.url));
  for (const [mode, limit] of [
    ['preflight', '1'], ['live', '0'], ['live', '-1'], ['live', '1.5'], ['live', '1e1'], ['live', '01'], ['live', '9007199254740992'],
  ]) {
    const run = spawnSync(process.execPath, [entry, `--${mode}`, `--max-pairs=${limit}`],
      { encoding:'utf8', windowsHide:true, timeout:15_000 });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /--max-pairs requires a positive decimal integer in --live mode/u);
  }
});

async function fixtureCommit(directory) {
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet');
  await fs.mkdir(path.join(directory, 'scripts'));
  await fs.writeFile(path.join(directory, 'scripts', 'harness.mjs'), '// pinned harness\n');
  git('add', 'scripts/harness.mjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'fixture');
  return { git, commit: git('rev-parse', 'HEAD') };
}

test('freezes all 13 task IDs and 78 slots and exports only hash-bound public projections', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-paired-plan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataset = path.join(directory, 'dataset'), output = path.join(directory, 'plan');
  await fs.mkdir(dataset);
  for (const id of cases) {
    const task = {
      instance_id: id, repo: 'test/example', base_commit: 'a'.repeat(40),
      problem_statement: 'Keep local collection ordering.', hints_text: '',
      patch: 'private gold', patch_sha256: digest('private gold'),
      test_patch: 'private test', test_patch_sha256: digest('private test'),
      FAIL_TO_PASS: ['entry::Test::mustImprove'], PASS_TO_PASS: ['entry::Test::unchanged'],
    };
    await fs.writeFile(path.join(dataset, `${id}.json`), JSON.stringify(task));
  }
  const plan = await createPairedPlan(output, dataset, 3);
  assert.equal(plan.model, 'deepseek-flash');
  assert.deepEqual(plan.tasks.map(row => row.id), cases);
  assert.equal(plan.schedule.length, 78);
  assert.equal(new Set(plan.schedule.map(row => `${row.id}/${row.repetition}/${row.arm}`)).size, 78);
  assert.deepEqual(plan.schedule.slice(0, 4).map(row => row.arm), ['off', 'on', 'on', 'off']);
  assert.deepEqual(plan.schedule.slice(26, 28).map(row => row.arm), ['on', 'off']);
  const now = 1_234_567;
  const fullPair = 2 * (plan.trialWallMs + plan.businessCloseMs + plan.gradeWallMs);
  assert.equal(plan.pairEnvelopeMs, fullPair);
  assert.equal(pairedWindowAvailable(now + fullPair - 1, now), false);
  assert.equal(pairedWindowAvailable(now + fullPair, now), true);
  for (const id of cases) {
    const view = JSON.parse(await fs.readFile(path.join(output, 'public', `${id}.json`), 'utf8'));
    assert.deepEqual(Object.keys(view), ['instance_id', 'repo', 'base_commit', 'problem_statement', 'hints_text']);
    assert.equal(view.instance_id, id);
  }
  const verified = await verifyPairedPlan(output, dataset);
  assert.deepEqual(verified.plan, plan);
  const pilotOutput = path.join(directory, 'pilot');
  const pilot = await createPairedPlan(pilotOutput, dataset, 1, ['happyword_12']);
  assert.deepEqual(pilot.tasks.map(task => task.id), ['happyword_12']);
  assert.equal(pilot.kind, 'arkts-openclaw-openspec-instrument-pilot-v1');
  assert.equal(pilot.trialWallMs, 30 * 60_000);
  assert.deepEqual(pilot.schedule.map(slot => slot.arm), ['off', 'on']);
  assert.deepEqual((await verifyPairedPlan(pilotOutput, dataset)).plan, pilot);
  await assert.rejects(verifyPublicPairedPlan(pilotOutput, digest(await fs.readFile(path.join(pilotOutput, 'plan.json')))),
    /pilot plans require their local device routes/u);
  const subsetOutput = path.join(directory, 'subset');
  const subset = await createPairedPlan(subsetOutput, dataset, 1, undefined,
    { selectedCases: ['security_tool_10', 'security_tool_1'] });
  assert.deepEqual(subset.tasks.map(task => task.id), ['security_tool_1', 'security_tool_10']);
  assert.deepEqual(await fs.readdir(path.join(subsetOutput, 'public')).then(files => files.sort()), ['security_tool_1.json', 'security_tool_10.json']);
  assert.equal(subset.kind, 'arkts-openclaw-openspec-subset-v1');
  assert.equal(subset.trialWallMs, plan.trialWallMs);
  assert.deepEqual(subset.schedule.map(slot => slot.arm), ['off', 'on', 'on', 'off']);
  const subsetVerification = await verifyPairedPlan(subsetOutput, dataset);
  assert.deepEqual(subsetVerification.plan, subset);
  const legacy = { ...subset, model: 'deepseek-v4-flash' };
  const legacyBytes = JSON.stringify(legacy);
  await fs.writeFile(path.join(subsetOutput, 'plan.json'), legacyBytes);
  assert.deepEqual((await verifyPublicPairedPlan(subsetOutput, digest(legacyBytes))).plan, legacy);
  await assert.rejects(createPairedPlan(path.join(directory, 'duplicate'), dataset, 1, undefined,
    { selectedCases: ['security_tool_1', 'security_tool_1'] }), /distinct subset/u);
  await assert.rejects(createPairedPlan(path.join(directory, 'both'), dataset, 1, ['happyword_12'],
    { selectedCases: ['security_tool_1'] }), /Choose either/u);
  const incompleteFullPlan = { ...subset, kind: plan.kind };
  await fs.writeFile(path.join(subsetOutput, 'plan.json'), JSON.stringify(incompleteFullPlan));
  await assert.rejects(verifyPublicPairedPlan(subsetOutput, digest(JSON.stringify(incompleteFullPlan))), /omits or reorders/u);
  await fs.writeFile(path.join(subsetOutput, 'plan.json'), JSON.stringify(subset, null, 2) + '\n');
  await fs.rm(dataset, { recursive: true });
  const publicVerification = await verifyPublicPairedPlan(output, verified.planSha256);
  assert.deepEqual(publicVerification.plan, plan);
  assert(publicVerification.inputs.every(({ task }) => task.test_patch === undefined && task.FAIL_TO_PASS === undefined));
  const publicSubset = await verifyPublicPairedPlan(subsetOutput, subsetVerification.planSha256);
  assert.deepEqual(publicSubset.plan, subset);
  assert.deepEqual(publicSubset.inputs.map(({ task }) => task.instance_id), ['security_tool_1', 'security_tool_10']);
  await assert.rejects(verifyPublicPairedPlan(output, '0'.repeat(64)), /frozen digest/u);
  await fs.appendFile(path.join(output, 'public', 'security_tool_1.json'), ' ');
  await assert.rejects(verifyPublicPairedPlan(output, verified.planSha256), /Public input changed: security_tool_1/);
});

test('checks every exact preseeded Git base and reports both missing task slots together', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { git, commit } = await fixtureCommit(directory);
  const cacheRoot = path.join(directory, 'cache');
  await fs.mkdir(cacheRoot);
  git('clone', '--quiet', '--bare', '.', path.join(cacheRoot, 'test--example.git'));
  const inputs = cases.map(id => ({ id, task: { repo: 'test/example', base_commit: commit } }));
  const checked = await preflightPairedBaseCache(inputs, cacheRoot, { gitExecutable: 'git' });
  assert.deepEqual(checked.map(row => row.id), cases);
  assert(checked.every(row => row.available && row.baseCommit === commit));
  inputs[11].task.base_commit = '1'.repeat(40);
  inputs[12].task.base_commit = '2'.repeat(40);
  await assert.rejects(preflightPairedBaseCache(inputs, cacheRoot, { gitExecutable: 'git' }),
    /Exact base commits missing from the preseeded cache: happyword_12, happyword_13/u);
});

test('requires calibration on the currently measured toolchain', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-calibration-pin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { id: 'case', datasetDigest: 'original-dataset',
    task: { instance_id: 'case', base_commit: 'a'.repeat(40), test_patch_sha256: 'b'.repeat(64) } };
  const result = path.join(root, 'results.json');
  const receipt = { instanceId: input.id, baseCommit: input.task.base_commit,
    environment: { datasetDigest: input.datasetDigest, testPatchSha256: input.task.test_patch_sha256 } };
  await fs.writeFile(result, JSON.stringify(receipt));
  await assert.rejects(verifyCalibration(input, root, undefined, 'active'), /Rerun with --pin-toolchain/u);
  receipt.environment.toolchain = { sha256: 'other-installation' };
  await fs.writeFile(result, JSON.stringify(receipt));
  await assert.rejects(verifyCalibration(input, root, undefined, 'active'), /Calibration toolchain differs/u);
  receipt.environment.toolchain.sha256 = 'active';
  await fs.writeFile(result, JSON.stringify(receipt));
  await assert.rejects(verifyCalibration(input, root, undefined, 'active'), /Missing base execution receipt/u);
  for (const changed of [
    { ...receipt, baseCommit: 'c'.repeat(40) },
    { ...receipt, environment: { ...receipt.environment, testPatchSha256: 'd'.repeat(64) } },
  ]) {
    await fs.writeFile(result, JSON.stringify(changed));
    await assert.rejects(verifyCalibration(input, root, undefined, 'active'), /Calibration identity mismatch/u);
  }
});

test('live harness pin rejects a different HEAD and changes to tracked executable inputs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-harness-pin-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { commit } = await fixtureCommit(directory);
  await assertFrozenCampaignHarness(directory, commit);
  await assert.rejects(assertFrozenCampaignHarness(directory, '1'.repeat(40)), /HEAD must match/u);
  await fs.writeFile(path.join(directory, 'scripts', 'untracked-output.json'), '{}');
  await assertFrozenCampaignHarness(directory, commit);
  await fs.appendFile(path.join(directory, 'scripts', 'harness.mjs'), '// post-freeze change\n');
  await assert.rejects(assertFrozenCampaignHarness(directory, commit), /changes to tracked harness inputs/u);
});

test('accepts only an executed candidate grade bound to the same dataset, task, and patch', () => {
  const input = { id: 'security_tool_1', datasetDigest: 'dataset', task: { FAIL_TO_PASS: ['f'], PASS_TO_PASS: ['p'] } };
  const group = passed => ({ expected: 1, passed, failed: [], testErrors: [] });
  const candidate = {
    kind: 'hidden-test-candidate-grade', instanceId: input.id,
    environment: { datasetDigest: input.datasetDigest }, candidateSha256: 'patch',
    results: [{ phase: 'candidate', executed: true, f2p: group(['f']), p2p: group(['p']) }],
  };
  assert.deepEqual(scorePairedCandidate(candidate, 'patch', input), {
    f2p: { passed: 1, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: true,
  });
  assert.equal(scorePairedCandidate(candidate, 'different', input), null);
  assert.equal(scorePairedCandidate(candidate, 'patch', { ...input, datasetDigest: 'different' }), null);
  assert.equal(scorePairedCandidate({ ...candidate, kind: 'evaluator-calibration-no-agent' }, 'patch', input), null);
  candidate.results[0].executed = false;
  assert.equal(scorePairedCandidate(candidate, 'patch', input), null);
});

test('matches aggregate worker grades to the exact request and expected dataset denominators', () => {
  const totals = { f2p: 1, p2p: 1 };
  const expected = { id: 'case', candidateSha256: 'sealed' };
  const execution = { exitCode: 1, interrupted: false, outputComplete: true };
  const score = { f2p: { passed: 0, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: false };
  const receipt = { input: expected, execution, score };
  assert.deepEqual(checkWorkerGrade(receipt, expected, totals), { gradingExecution: execution, score });
  assert.throws(() => checkWorkerGrade(receipt, { ...expected, candidateSha256: 'other' }, totals), /sealed request/u);
  assert.throws(() => checkWorkerGrade({ ...receipt, execution: { ...execution, interrupted: true } }, expected, totals), /Incomplete worker execution/u);
  assert.throws(() => checkWorkerGrade({ ...receipt, score: { ...score, resolved: true } }, expected, totals), /Invalid worker resolution/u);
  assert.throws(() => checkWorkerGrade({ ...receipt, score: { ...score, f2p: { passed: 2, total: 2 } } }, expected, totals), /Invalid worker score totals/u);
  const missing = { input: expected, execution: { ...execution, exitCode: 0, reason: 'closed' }, score: null,
    gradingFailure: 'GRADE_RECEIPT_MISSING' };
  assert.equal(checkWorkerGrade(missing, expected, totals).gradingFailure, 'GRADE_RECEIPT_MISSING');
  assert.throws(() => checkWorkerGrade({ ...missing, execution: { ...missing.execution, exitCode: 1 } }, expected, totals), /Invalid missing worker grade/u);
});

test('separates measured, matched, missing, and incomplete trial denominators', () => {
  const schedule = pairedTrialSchedule(['case'], 5);
  const score = { f2p: { passed: 2, total: 2 }, p2p: { passed: 2, total: 2 }, resolved: true };
  const comparisonIdentity = { preparedTree: 'stable', toolchain: 'pinned' };
  const finished = { business: 'finished', execution: { exitCode: 0, outputComplete: true, interrupted: false } };
  const usage = (document, stop, other) => ({ rc: { document: { requests: document }, stop: { requests: stop } },
    business: { requests: other } });
  const observations = [
    { ...schedule[0], ...finished, score, comparisonIdentity, businessCompleted: true, providerRequests: 15, elapsedMs: 1000, usage: usage(0, 0, 15) },
    { ...schedule[1], ...finished, score, comparisonIdentity: { toolchain: 'pinned', preparedTree: 'stable' },
      businessCompleted: true, providerRequests: 33, elapsedMs: 3200, usage: usage(10, 7, 16) },
    { ...schedule[2], score, comparisonIdentity: { preparedTree: 'other' } },
    { ...schedule[3], score, comparisonIdentity },
    { ...schedule[4], ...finished, score: null, businessCompleted: false, completionReason: 'OPENSPEC_APPLY_INCOMPLETE',
      providerRequests: 19, usage: usage(0, 0, 19), tokens: { document: 0, stop: 0, other: null, total: null } },
    { ...schedule[5], ...finished, score, comparisonIdentity, businessCompleted: true, providerRequests: 9, usage: usage(2, 2, 2) },
    { ...schedule[6], score: null, businessCompleted: false, providerRequests: 101, elapsedMs: 9000 },
  ];
  const summary = pairedCampaignSummary(schedule, observations);
  assert.equal(summary.off.passAt1, null);
  assert.equal(summary.off.unscored, 1);
  assert.equal(summary.on.notAttempted, 1);
  assert.equal(summary.on.scored, 3);
  assert.equal(summary.on.matchedPairs, 1);
  assert.deepEqual(summary.off.workflow, { completed: 1, incomplete: 1, unavailable: 1,
    incompleteReasons: { OPENSPEC_APPLY_INCOMPLETE: 1 } });
  assert.deepEqual(summary.on.matchedMetrics.f2p, { passed: 2, total: 2 });
  assert.deepEqual(summary.on.scoredMetrics.f2p, { passed: 6, total: 6 });
  assert.deepEqual(summary.on.observedUsage.providerRequests, { measuredTrials: 3, missingTrials: 1, sum: 143 });
  assert.deepEqual(summary.on.observedUsage.elapsedMs, { measuredTrials: 2, missingTrials: 2, sum: 12200 });
  assert.deepEqual(summary.on.observedUsage.requestsByPhase.other, { measuredTrials: 1, missingTrials: 3, sum: 16 });
  assert.deepEqual(summary.off.observedUsage.tokens.document, { measuredTrials: 1, missingTrials: 2, sum: 0 });
  assert.deepEqual(summary.off.observedUsage.tokens.total, { measuredTrials: 0, missingTrials: 3, sum: null });
  const breakdown = { document: { pairs: 1, off: 0, on: 10 }, stop: { pairs: 1, off: 0, on: 7 }, other: { pairs: 1, off: 15, on: 16 } };
  const missingTokens = Object.fromEntries(['document', 'stop', 'other', 'total'].map(key => [key, { pairs:0, off:null, on:null }]));
  assert.deepEqual(pairedCampaignComparison(schedule, observations), {
    plannedPairs: 5, matchedScoredPairs: 1, bothAttemptedPairsMissingGrade: 1, scoredIdentityMismatches: 1,
    partiallyObservedPairs: 1, unstartedPairs: 1,
    transitions: { improved: 0, regressed: 0, bothResolved: 1, neitherResolved: 0 },
    scoreChanges: { f2p: { higher: 0, lower: 0, equal: 1 }, p2p: { higher: 0, lower: 0, equal: 1 },
      pairs: [{ id: 'case', repetition: 1, f2p: { total: 2, offPassed: 2, onPassed: 2, delta: 0 },
        p2p: { total: 2, offPassed: 2, onPassed: 2, delta: 0 } }] },
    workflow: { bothCompleted: 1, onlyOffCompleted: 0, onlyOnCompleted: 1, neitherCompleted: 0, unavailable: 1 },
    matchedUsage: { providerRequests: { pairs: 1, off: 15, on: 33 }, elapsedMs: { pairs: 1, off: 1000, on: 3200 } },
    attemptedUsage: { providerRequests: { pairs: 2, off: 34, on: 42 }, elapsedMs: { pairs: 1, off: 1000, on: 3200 } },
    bothResolvedUsage: { providerRequests: { pairs: 1, off: 15, on: 33 }, elapsedMs: { pairs: 1, off: 1000, on: 3200 } },
    requestBreakdown: { matched: breakdown, bothResolved: breakdown, attempted: breakdown },
    tokenUsage: { matched: missingTokens, bothResolved: missingTokens, attempted: missingTokens },
  });
  assert.throws(() => pairedCampaignComparison(schedule, [...observations, observations[0]]), /unique planned trial/u);
});

test('both workflow summaries distinguish missing or interrupted business results from settled incomplete Apply', () => {
  const schedule = pairedTrialSchedule(['no-result', 'interrupted', 'apply-incomplete'], 1);
  const finished = { business: 'finished', businessCompleted: true, execution: { exitCode: 0, outputComplete: true, interrupted: false } };
  const on = {
    'no-result': { business: 'no-result', businessCompleted: false, completionReason: null,
      execution: { exitCode: 1, outputComplete: true, interrupted: false } },
    interrupted: { ...finished, execution: { ...finished.execution, interrupted: true } },
    'apply-incomplete': { ...finished, businessCompleted: false, completionReason: 'OPENSPEC_APPLY_INCOMPLETE' },
  };
  const observations = schedule.map(slot => ({ ...slot, score: null, ...(slot.arm === 'off' ? finished : on[slot.id]) }));
  const summary = pairedCampaignSummary(schedule, observations);
  assert.deepEqual(summary.off.workflow, { completed: 3, incomplete: 0, unavailable: 0, incompleteReasons: {} });
  assert.deepEqual(summary.on.workflow, { completed: 0, incomplete: 1, unavailable: 2,
    incompleteReasons: { OPENSPEC_APPLY_INCOMPLETE: 1 } });
  assert.deepEqual(pairedCampaignComparison(schedule, observations).workflow,
    { bothCompleted: 0, onlyOffCompleted: 1, onlyOnCompleted: 0, neitherCompleted: 0, unavailable: 2 });
});

test('shows partial grade changes even when neither arm resolves the task', () => {
  const schedule = pairedTrialSchedule(['case'], 3);
  const comparisonIdentity = { preparedTree: 'same', toolchainSha256: 'same' };
  const score = (f2p, p2p, f2pTotal = 10) => ({
    f2p: { passed: f2p, total: f2pTotal }, p2p: { passed: p2p, total: 288 }, resolved: false,
  });
  const byRepeat = [
    { off: score(8, 288), on: score(1, 287) },
    { off: score(1, 287), on: score(2, 287) },
    { off: score(1, 287), on: score(2, 287, 9) },
  ];
  const observations = schedule.map(slot => ({ ...slot, comparisonIdentity, score: byRepeat[slot.repetition - 1][slot.arm] }));
  const report = pairedCampaignComparison(schedule, observations);
  assert.deepEqual(report.transitions, { improved: 0, regressed: 0, bothResolved: 0, neitherResolved: 2 });
  assert.equal(report.scoredIdentityMismatches, 1);
  assert.deepEqual(report.scoreChanges, {
    f2p: { higher: 1, lower: 1, equal: 0 }, p2p: { higher: 0, lower: 1, equal: 1 },
    pairs: [
      { id: 'case', repetition: 1, f2p: { total: 10, offPassed: 8, onPassed: 1, delta: -7 },
        p2p: { total: 288, offPassed: 288, onPassed: 287, delta: -1 } },
      { id: 'case', repetition: 2, f2p: { total: 10, offPassed: 1, onPassed: 2, delta: 1 },
        p2p: { total: 288, offPassed: 287, onPassed: 287, delta: 0 } },
    ],
  });
});

test('resumes the exact remaining schedule after a settled pair-window stop', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-resume-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const schedule = pairedTrialSchedule(['first', 'second'], 1);
  const identity = { planSha256: 'frozen-plan', providerProfilePin: 'original' };
  const signal = new AbortController().signal;
  const dispatched = [];
  const score = { f2p: { passed: 1, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: true };
  const envelope = 19_280_000;
  let time = 1_000_000;
  const options = { output, plan: { schedule }, identity, signal, now: () => time,
    deadline: time + envelope, recheck: async () => {},
    dispatch: async trial => {
      dispatched.push(trial);
      time += 500;
      return { ...trial, execution: { exitCode: 0, interrupted: false, outputComplete: true }, score,
        comparisonIdentity: { preparedTree: trial.id }, business: 'finished' };
    },
  };
  const first = await executePairedCampaign(options);
  assert.equal(first.status, 'INSUFFICIENT_PAIR_WINDOW');
  assert.deepEqual(dispatched, schedule.slice(0, 2));
  const firstSummary = path.join(output, 'invocations', '1', 'summary.json');
  const original = await fs.readFile(firstSummary);
  const resume = { ...options, resume: true, deadline: time + envelope };
  await assert.rejects(executePairedCampaign({ ...resume, identity: { ...identity, providerProfilePin: 'changed' } }), /frozen campaign identity/);
  const extra = path.join(output, 'observations', 'second-r1-on.started.json');
  await fs.writeFile(extra, JSON.stringify(schedule[2]));
  await assert.rejects(executePairedCampaign(resume), /Incomplete or out-of-order receipts/);
  await fs.rm(extra);
  assert.deepEqual(dispatched, schedule.slice(0, 2));
  const second = await executePairedCampaign(resume);
  assert.equal(second.status, 'COMPLETE');
  assert.equal(second.invocation, 2);
  assert.deepEqual(dispatched, schedule);
  assert.deepEqual(second.observations.slice(0, 2), first.observations);
  assert.deepEqual(await fs.readFile(firstSummary), original);
  const latest = JSON.parse(await fs.readFile(path.join(output, 'summary.json')));
  assert.deepEqual(latest, second);
  await assert.rejects(executePairedCampaign(resume), /Resume requires a settled pause/);
});

test('caps a live invocation at whole pairs and resumes with an independent cap', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-pair-cap-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const schedule = pairedTrialSchedule(['first', 'second', 'third'], 1);
  const dispatched = [];
  const identity = { planSha256: 'frozen-plan', providerProfilePin: 'original' };
  const score = { f2p: { passed: 1, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: true };
  const options = { output, plan: { schedule }, identity, signal: new AbortController().signal,
    deadline: 1_000_000_000, now: () => 1_000_000, recheck: async () => {},
    async dispatch(trial) {
      dispatched.push(trial);
      return { ...trial, business: 'finished', businessCompleted: true, comparisonIdentity: { preparedTree: trial.id }, score,
        execution: { exitCode: 0, interrupted: false, outputComplete: true } };
    },
  };
  for (const maxPairs of [0, 1.5, '1', 4]) await assert.rejects(executePairedCampaign({ ...options, maxPairs }), /--max-pairs must be a positive integer/u);
  assert.deepEqual(await fs.readdir(output), []);

  const limited = await executePairedCampaign({ ...options, maxPairs: 1 });
  assert.equal(limited.status, 'PAIR_LIMIT_REACHED');
  assert.equal(limited.comparison.matchedScoredPairs, 1);
  assert.equal(limited.comparison.unstartedPairs, 2);
  assert.deepEqual(dispatched, schedule.slice(0, 2));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'execution.json'))), identity);
  const firstInvocation = path.join(output, 'invocations', '1');
  const firstStart = path.join(firstInvocation, 'start.json');
  const startBytes = await fs.readFile(firstStart);
  const firstStartReceipt = JSON.parse(startBytes);
  assert.equal(firstStartReceipt.startSlot, 0);
  assert.equal(firstStartReceipt.maxPairs, 1);
  const firstSummary = await fs.readFile(path.join(firstInvocation, 'summary.json'));

  const resume = { ...options, resume: true, maxPairs: 2 };
  const next = schedule[2];
  const extraClaim = path.join(output, 'observations', `${next.id}-r${next.repetition}-${next.arm}.started.json`);
  await fs.writeFile(extraClaim, JSON.stringify(next), { flag: 'wx' });
  await assert.rejects(executePairedCampaign(resume), /Incomplete or out-of-order receipts/u);
  await fs.rm(extraClaim);
  await fs.writeFile(firstStart, JSON.stringify({ ...firstStartReceipt, maxPairs: 2 }));
  await assert.rejects(executePairedCampaign(resume), /Previous pair limit differs from the settled trial receipts/u);
  await fs.writeFile(firstStart, startBytes);
  assert.deepEqual(dispatched, schedule.slice(0, 2));

  const completed = await executePairedCampaign(resume);
  assert.equal(completed.status, 'COMPLETE');
  assert.equal(completed.invocation, 2);
  assert.deepEqual(dispatched, schedule);
  assert.deepEqual(completed.observations.slice(0, 2), limited.observations);
  const secondStart = JSON.parse(await fs.readFile(path.join(output, 'invocations', '2', 'start.json')));
  assert.equal(secondStart.startSlot, 2);
  assert.equal(secondStart.maxPairs, 2);
  assert.deepEqual(await fs.readFile(path.join(firstInvocation, 'summary.json')), firstSummary);
});

async function cancelledCampaign(t, { cancelAfter, missingGrade = false }) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-cancelled-resume-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const schedule = pairedTrialSchedule(['first', 'second'], 1);
  const identity = { planSha256: 'frozen-cancellation-plan' };
  const controller = new AbortController();
  const dispatched = [];
  const score = { f2p: { passed: 1, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: true };
  const options = { output, plan: { schedule }, identity, signal: controller.signal, deadline: 1_000_000_000,
    now: () => 1_000_000, recheck: async () => {},
    dispatch: async trial => {
      dispatched.push(trial);
      const cancelled = dispatched.length === cancelAfter;
      if (cancelled) controller.abort();
      return { ...trial, execution: { exitCode: 0, interrupted: false, outputComplete: true },
        score: cancelled && missingGrade ? null : score, business: 'finished', businessCompleted: true,
        comparisonIdentity: { preparedTree: trial.id } };
    } };
  const first = await executePairedCampaign(options);
  assert.equal(first.status, 'CANCELLED');
  assert.deepEqual(dispatched, schedule.slice(0, cancelAfter));
  return { first, output, schedule, dispatched, resume: { ...options, resume: true, signal: new AbortController().signal } };
}

test('resumes a cleanly cancelled campaign from the verified whole-pair prefix without repeating claims', async t => {
  const { first, output, schedule, dispatched, resume } = await cancelledCampaign(t, { cancelAfter: 2 });
  assert.equal(first.comparison.matchedScoredPairs, 1);
  assert.equal(first.comparison.unstartedPairs, 1);
  const priorReceipt = path.join(output, 'invocations', '1', 'summary.json');
  const original = await fs.readFile(priorReceipt);
  const next = schedule[2];
  const extra = path.join(output, 'observations', `${next.id}-r${next.repetition}-${next.arm}.started.json`);
  await fs.writeFile(extra, JSON.stringify(next), { flag: 'wx' });
  await assert.rejects(executePairedCampaign(resume), /Incomplete or out-of-order receipts/u);
  await fs.rm(extra);
  assert.deepEqual(dispatched, schedule.slice(0, 2));

  const resumed = await executePairedCampaign(resume);
  assert.equal(resumed.status, 'COMPLETE');
  assert.equal(resumed.invocation, 2);
  assert.deepEqual(dispatched, schedule);
  assert.deepEqual(resumed.observations.slice(0, 2), first.observations);
  assert.deepEqual(await fs.readFile(priorReceipt), original);
});

test('rejects cancellation resume for a partial pair, interrupted grading, or a consumed schedule', async t => {
  for (const [label, options, reason] of [
    ['partial pair', { cancelAfter: 1 }, /exact prefix of whole pairs/u],
    ['completed business without a grade', { cancelAfter: 2, missingGrade: true }, /lacks a settled business or grade outcome/u],
    ['no unstarted pairs', { cancelAfter: 4 }, /no unstarted pairs/u],
  ]) await t.test(label, async t => {
    const { schedule, dispatched, resume } = await cancelledCampaign(t, options);
    await assert.rejects(executePairedCampaign(resume), reason);
    assert.deepEqual(dispatched, schedule.slice(0, options.cancelAfter));
  });
});

test('a concurrent launcher cannot claim slots from the running invocation', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-concurrent-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const schedule = pairedTrialSchedule(['only'], 1);
  let entered, release;
  const enteredTrial = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const options = { output, plan: { schedule }, identity: { planSha256: 'frozen' },
    signal: new AbortController().signal, deadline: Date.now() + 20_000_000,
    recheck: async () => {}, dispatch: async trial => {
      calls += 1;
      entered();
      await hold;
      return { ...trial, execution: { exitCode: 0, outputComplete: true }, score: null };
    },
  };
  const first = executePairedCampaign(options);
  try {
    await enteredTrial;
    await assert.rejects(executePairedCampaign({ ...options, resume: true }), /Timed out waiting for/);
    assert.equal(calls, 1);
  } finally {
    release();
    await first;
  }
  assert.equal(calls, 2);
});

test('an incomplete independent grade stops further model dispatches', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-missing-grade-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const schedule = pairedTrialSchedule(['first', 'second'], 1);
  const report = await executePairedCampaign({ output, plan: { schedule }, identity: { planSha256: 'frozen' },
    maxPairs: 1, signal: new AbortController().signal, deadline: Date.now() + 30_000_000,
    recheck: async () => {}, dispatch: async trial => ({ ...trial, score: null,
      execution: { exitCode: 0, outputComplete: true }, gradingFailure: 'GRADE_RECEIPT_MISSING' }),
  });
  assert.equal(report.status, 'NEEDS_ATTENTION');
  assert.deepEqual(report.observations.map(({ id, repetition, arm }) => ({ id, repetition, arm })), schedule.slice(0, 1));
  assert.equal(report.arms.off.unscored, 1);
  assert.equal(report.arms.on.notAttempted, 2);
});

const closedGrade = { exitCode: 0, interrupted: false, outputComplete: true, reason: 'closed' };
const missingGrade = { gradingExecution: closedGrade, score: null, gradingFailure: 'GRADE_RECEIPT_MISSING' };
const failedGrade = { gradingExecution: { ...closedGrade, exitCode: 1 },
  score: { f2p: { passed: 1, total: 2 }, p2p: { passed: 3, total: 3 }, resolved: false } };
const gradeBinding = { patchSha256: digest('frozen patch'), businessResultSha256: digest('business result'),
  comparisonIdentity: { sourceCommit: 'same candidate', toolchainSha256: digest('toolchain') }, calibrationSha256: digest('calibration') };

test('retains completed business costs when a worker cannot independently grade the candidate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-rejected-grade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'campaign'), exchange = path.join(root, 'exchange');
  await Promise.all([fs.mkdir(output), fs.mkdir(exchange)]);
  const worker = new AbortController();
  const workerErrors = [];
  let submissions = 0;
  const service = serveArktsWorkerJobs(exchange, async (action, input, { directory }) => {
    submissions++;
    assert.equal(action, 'grade');
    assert.deepEqual(input, gradeBinding);
    assert.equal(digest(await fs.readFile(path.join(directory, 'candidate.patch'))), gradeBinding.patchSha256);
    throw new Error('Private evaluator unavailable');
  }, { signal: worker.signal, pollMs: 5, onError: message => workerErrors.push(message) });
  const signal = new AbortController().signal;
  const schedule = pairedTrialSchedule(['first', 'second'], 1);
  const grade = async () => gradePairedWithRetry({ directory: root, binding: gradeBinding, deadline: Date.now() + 2_500_000, signal,
    readCandidate: async () => Buffer.from('frozen patch'),
    evaluate: ({ patch }) => submitArktsWorkerJob(exchange, 'grade', gradeBinding, { timeoutMs: 5000, signal, pollMs: 5,
      prepare: directory => fs.writeFile(path.join(directory, 'candidate.patch'), patch, { flag: 'wx' }) }) });
  try {
    const report = await executePairedCampaign({ output, plan: { schedule }, identity: { planSha256: 'frozen' },
      deadline: Date.now() + 30_000_000, signal, recheck: async () => {},
      dispatch: async trial => ({ ...trial, execution: closedGrade, business: 'finished', businessCompleted: true,
        providerRequests: 12, elapsedMs: 1000, ...gradeBinding, ...await grade() }) });
    assert.equal(report.status, 'NEEDS_ATTENTION');
    assert.equal(submissions, 1);
    assert.equal(workerErrors.length, 1);
    assert.match(workerErrors[0], /Private evaluator unavailable/u);
    assert.equal(report.observations.length, 1);
    const [row] = report.observations;
    assert.equal(row.score, null);
    assert.equal(row.gradingFailure, 'GRADE_WORKER_REJECTED');
    assert.equal(row.gradingExecution.reason, 'worker-rejected');
    assert.equal(row.businessResultSha256, gradeBinding.businessResultSha256);
    assert.deepEqual(report.arms.off.observedUsage.providerRequests, { measuredTrials: 1, missingTrials: 0, sum: 12 });
    assert.equal(report.comparison.matchedScoredPairs, 0);
    const durable = await fs.readFile(path.join(output, 'observations', 'first-r1-off.result.json'), 'utf8');
    assert.deepEqual(JSON.parse(durable), row);
  } finally {
    worker.abort();
    await service;
  }

  const expired = await gradePairedWithRetry({ directory: root, binding: gradeBinding, deadline: Date.now() + 2000, signal,
    readCandidate: async () => Buffer.from('frozen patch'),
    evaluate: () => submitArktsWorkerJob(exchange, 'grade', gradeBinding, { timeoutMs: 150, signal, pollMs: 5 }) });
  assert.equal(expired.score, null);
  assert.equal(expired.gradingFailure, 'GRADE_WORKER_DEADLINE');
  assert.equal(expired.gradingExecution.reason, 'worker-deadline');
  const cancelled = new AbortController();
  const stopped = await gradePairedWithRetry({ directory: root, binding: gradeBinding, deadline: Date.now() + 2000, signal: cancelled.signal,
    readCandidate: async () => Buffer.from('frozen patch'),
    async evaluate() { cancelled.abort(); cancelled.signal.throwIfAborted(); } });
  assert.equal(stopped.score, null);
  assert.equal(stopped.gradingFailure, 'GRADE_WORKER_CANCELLED');
  await assert.rejects(gradePairedWithRetry({ directory: root, binding: gradeBinding, deadline: Date.now() + 2000, signal,
    readCandidate: async () => Buffer.from('frozen patch'),
    async evaluate() { throw new Error('Worker grade differs from its sealed request'); } }), /differs from its sealed request/u);
});

test('a settled missing grade retries only the frozen candidate and continues the original campaign', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-retry-grade-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const schedule = pairedTrialSchedule(['first', 'second'], 1);
  const directory = path.join(output, 'grading-attempts');
  await fs.mkdir(directory);
  const now = 123000, deadline = now + 2_430_000;
  const businessRuns = [];
  const gradingRuns = [];
  const signal = new AbortController().signal;
  const readReceipt = name => fs.readFile(path.join(directory, name));
  const report = await executePairedCampaign({ output, plan: { schedule }, identity: { planSha256: 'frozen' }, signal,
    deadline: now + 30_000_000, now: () => now, recheck: async () => {}, async dispatch(trial) {
      businessRuns.push(trial);
      const grade = businessRuns.length > 1 ? failedGrade : await gradePairedWithRetry({ directory, binding: gradeBinding, signal, deadline,
        now: () => now, readCandidate: async () => Buffer.from('frozen patch'), async evaluate(attempt) {
          gradingRuns.push(attempt);
          if (!attempt.retry) return missingGrade;
          const original = JSON.parse(await readReceipt('grading-attempt-1.json'));
          assert.deepEqual(original.outcome, missingGrade, 'the first receipt exists before the second evaluator starts');
          return failedGrade;
        } });
      return { ...trial, ...gradeBinding, execution: closedGrade, business: 'finished', businessCompleted: true, ...grade };
    } });
  assert.deepEqual(businessRuns, schedule);
  assert.deepEqual(gradingRuns.map(({ patch, deadline, retry }) => [digest(patch), deadline, retry]),
    [[gradeBinding.patchSha256, deadline, false], [gradeBinding.patchSha256, deadline, true]]);
  assert.equal(report.status, 'COMPLETE');
  assert.equal(report.comparison.matchedScoredPairs, 2);
  const [recovered] = report.observations;
  await verifyPairedGradeRetry(recovered, gradeBinding.calibrationSha256, readReceipt);
  assert.deepEqual(recovered.score, failedGrade.score, 'an independently measured failing grade remains a grade');
  await assert.rejects(verifyPairedGradeRetry(recovered, digest('other calibration'), readReceipt));
  await assert.rejects(verifyPairedGradeRetry({ ...recovered, score: null }, gradeBinding.calibrationSha256, readReceipt), /differs from the final grading attempt/u);
  await fs.appendFile(path.join(directory, 'grading-attempt-1.json'), '\n');
  await assert.rejects(verifyPairedGradeRetry(recovered, gradeBinding.calibrationSha256, readReceipt), /attempt receipt changed/u);
});

test('grade retry requires a safe failure, intact frozen inputs and time in the original window', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-no-retry-grade-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const deadline = 2_430_000;
  const signal = new AbortController().signal;
  for (const [outcome, now] of [
    [failedGrade, 0],
    [{ ...missingGrade, gradingFailure: 'GRADE_INCOMPLETE' }, 0],
    [{ ...missingGrade, gradingExecution: { ...closedGrade, exitCode: 1 } }, 0],
    [{ score: null, gradingExecution: { interrupted: true, outputComplete: false, exitCode: null, reason: 'deadline' } }, 0],
    [missingGrade, deadline - 1_229_999],
  ]) {
    assert.deepEqual(await gradePairedWithRetry({ directory, binding: gradeBinding, deadline, signal, now: () => now,
      readCandidate: async () => Buffer.from('frozen patch'), async evaluate({ retry }) { assert.equal(retry, false); return outcome; } }), outcome);
  }
  let reads = 0;
  await assert.rejects(gradePairedWithRetry({ directory, binding: gradeBinding, deadline, signal, now: () => 0,
    async readCandidate() {
      if (++reads === 2) throw new Error('Sealed patch changed');
      return Buffer.from('frozen patch');
    }, async evaluate({ retry }) { assert.equal(retry, false); return missingGrade; } }), /Sealed patch changed/u);
  assert.deepEqual(await fs.readdir(directory), []);
  const launchFailure = { score: null, gradingExecution: { interrupted: true, outputComplete: false, exitCode: null, reason: 'EAGAIN' } };
  const repeated = await gradePairedWithRetry({ directory, binding: gradeBinding, deadline, signal, now: () => 0,
    readCandidate: async () => Buffer.from('frozen patch'), evaluate: async () => launchFailure });
  assert.equal(repeated.score, null);
  assert.equal(repeated.gradingExecution.reason, 'EAGAIN');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['grading-attempt-1.json', 'grading-attempt-2.json']);
});
