import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { targetVersion } from '../lib/hosts/openclaw.mjs';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { arktsInstrumentRuntime } from '../scripts/bench/arkts-instrument-results.mjs';
import { arktsPublicAcceptanceIdentity, writeArktsQualifiedProbeDescriptor } from '../scripts/bench/arkts-public-acceptance.mjs';
import { serveArktsWorkerJobs } from '../scripts/bench/arkts-worker-exchange.mjs';
import { tokenSplit } from '../scripts/bench/release-evidence.mjs';
import { gradeArktsCorrectionCheckpoints, summarizeArktsCorrectionCheckpointScores } from '../scripts/grade-arkts-correction-checkpoints.mjs';
import { reportArktsGradeTransitions } from '../scripts/report-arkts-grade-transitions.mjs';
import { createPairedPlan, executePairedCampaign, gradePairedWithRetry } from '../scripts/run-arkts-paired-campaign.mjs';
import { readArktsPairedGradeTransitionPlan, reportArktsReviewRequests, summarizeArktsPairedCohort } from '../scripts/summarize-arkts-paired-cohort.mjs';

const pcTasks = Array.from({ length: 10 }, (_, index) => `security_tool_${index + 1}`);
const phoneTasks = ['soduku-harmony_11', 'happyword_12', 'happyword_13'];
const release = { sourceCommit: 'a'.repeat(40), packageSha256: digest('runtime package') };
const endpoint = digest('provider identity');
const workflow = { mode: 'official-openspec', cliVersion: '1.4.1',
  files: { workflow: digest('OpenSpec workflow'), cli: digest('OpenSpec entry'), cliManifest: digest('OpenSpec manifest') } };
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const read = async file => JSON.parse(await fs.readFile(file));
const fileSha256 = async file => digest(await fs.readFile(file));
const testPatch = 'private fixture tests';
const f2pId = 'entry::Test::expected', p2pId = 'entry::Test::retained';
const otherP2pId = 'entry::Test::other retained';

async function fixture(t, { swapProtectedCases } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-cohort-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataset = path.join(root, 'dataset');
  await fs.mkdir(dataset);
  await Promise.all([...pcTasks, ...phoneTasks].map(id => write(path.join(dataset, `${id}.json`), {
    instance_id: id, repo: 'test/example', base_commit: 'b'.repeat(40),
    problem_statement: 'Preserve stable display order.', hints_text: '',
    patch: 'private fixture patch', patch_sha256: digest('private fixture patch'),
    test_patch: testPatch, test_patch_sha256: digest(testPatch),
    FAIL_TO_PASS: [f2pId], PASS_TO_PASS: id === swapProtectedCases ? [p2pId, otherP2pId] : [p2pId],
  })));
  async function frozenPlan(name, selectedCases) {
    const directory = path.join(root, name);
    const plan = await createPairedPlan(directory, dataset, 3, undefined, { selectedCases });
    return { directory, plan, planSha256: digest(await fs.readFile(path.join(directory, 'plan.json'))) };
  }
  const [master, pc, phones] = await Promise.all([frozenPlan('master'), frozenPlan('pc', pcTasks), frozenPlan('phones', phoneTasks)]);
  return { master, pc, phones, release, frozenPlan };
}

async function attachCorrectionFixture(directory, result, patch, acceptanceCheck) {
  const sessionId = 'session-1', sessionKey = 'agent:main:arkts-fixture', projectRoot = '/prepared-project';
  const preparedHead = 'd'.repeat(40), sourceRun = 'original-apply', stopId = 'original-apply:check-1';
  const evaluationId = 'stop-before', finalRun = result.nativeStopVerification.runId;
  const terminal = runId => ({ runId, requestedRunId: runId, source: 'agent.wait', status: 'ok' });
  const firstNative = { runId: sourceRun, occurrenceId: stopId, evaluationId, status: 'SETTLED', reviewStatus: 'DEVIATION', settledAt: 5500 };
  const before = 'before repair', transcript = JSON.stringify({ type: 'session', id: sessionId }) + '\n';
  const frozen = { preparedHead, patchSha256: digest(patch), workspacePatchSha256: digest(patch), sessionSha256: digest(transcript) };
  const startedAt = 6000;
  const deadlineAt = 9000;
  const ledger = { schemaVersion: 'runtime-corrector.stop-correction-session.v1', sessionId,
    stops: { [stopId]: { id: stopId, scope: projectRoot, flowId: 'flow', reviewStatus: 'DEVIATION', admissionId: 'repair' } },
    admissions: { repair: { id: 'repair', flowId: 'flow', stopId, accounting: 'USED', startStatus: 'STARTED', deliveryStatus: 'DELIVERED',
      executionId: finalRun, createdAt: 5600, deadlineAt, startedAt, observedAt: 6010, lateConfirmation: false, endedAt: 7000,
      hostRequest: { runId: finalRun, sessionKey, projectRoot, assessmentId: evaluationId,
        sourceRecordId: stopId, source: { runId: sourceRun, deadlineAt }, createdAt: 5700, gate: { at: 5900 } } } },
    events: [{ type: 'STOP_REVIEW_SETTLED', stopId, status: 'DEVIATION', observedAt: 5500 },
      { type: 'CONTINUATION_STARTED', admissionId: 'repair', executionId: finalRun, valid: true, lateConfirmation: false, startedAt, observedAt: 6010 }] };
  const checkpoint = { runId: sourceRun, sessionId, preparedHead, stopReason: 'before_agent_finalize', event: 'agent_end', success: true,
    paths: ['entry/src/app.ets'], patchSha256: digest(before), capturedAt: new Date(4000).toISOString(), completedAt: new Date(4500).toISOString() };
  const ledgerRoot = path.join(directory, 'native-host/state/runtime-corrector-stop-sessions/sessions');
  const checkpointRoot = path.join(directory, 'checkpoints/original');
  await Promise.all([fs.mkdir(ledgerRoot, { recursive: true }), fs.mkdir(checkpointRoot, { recursive: true })]);
  await Promise.all([
    write(path.join(directory, 'manifest.json'), { rcEnabled: true, projectRoot, publicInputSha256: result.publicInputSha256,
      preparedHead, preparedTree: result.preparedTree, ...release,
      publicAcceptanceSha256: result.publicAcceptancePin && arktsPublicAcceptanceIdentity(result.publicInputSha256, result.publicAcceptancePin) }),
    write(path.join(directory, 'workflow-messages.json'), { workflow }),
    write(path.join(directory, 'freeze/freeze.json'), frozen), fs.writeFile(path.join(directory, 'freeze/workspace.patch'), patch),
    fs.writeFile(path.join(directory, 'freeze/session.jsonl'), transcript), write(path.join(ledgerRoot, digest(sessionId) + '.json'), ledger),
    write(path.join(checkpointRoot, 'checkpoint.json'), checkpoint), fs.writeFile(path.join(checkpointRoot, 'candidate.patch'), before),
  ]);
  Object.assign(result, { sessionId, sessionKey, projectRoot, frozen });
  result.openSpec.proposal = { readyToApply: true };
  result.nativeStopRecords.unshift(firstNative);
  result.turns[0] = { stage: 'codeing', runId: sourceRun, finalRunId: finalRun, startedAt: 3000, settled: true,
    originalTerminal: terminal(sourceRun), terminal: terminal(finalRun) };
  result.stopReviews.unshift({ runId: stopId, evaluationId, lifecycle: 'SETTLED', status: 'DEVIATION', startedAt: 5000,
    ...(acceptanceCheck ? { publicAcceptanceCheck: { ...acceptanceCheck, status: 'FAIL', workspaceDigest: digest('before workspace'),
      snapshotSha256: digest('before snapshot'), checks: [{ ...acceptanceCheck.checks[0], status: 'FAIL' }, ...acceptanceCheck.checks.slice(1)] } } : {}) });
}

const fixtureWorkerJob = (output, ordinal) => path.join(output, `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`);

async function sealFixtureGrade(directory, { slot, task, identity, businessResultSha256, gradingExecution, score, patch, workerJob }) {
  const calibration = identity.calibration[task.id];
  const input = { id: task.id, baseCommit: task.baseCommit, datasetSha256: task.datasetSha256, candidateSha256: digest(patch),
    calibrationSha256: calibration.sha256, toolchainSha256: identity.toolchain.sha256, releaseCommit: release.sourceCommit,
    phaseTimeoutMs: 600_000 };
  const coverage = Buffer.from('private fixture native coverage');
  const group = (passed, failed) => ({ expected: passed.length + failed.length, passed, failed,
    testErrors: [], missing: [], ambiguous: [], ignored: [] });
  const [retained, lost] = slot.arm === 'off' ? [p2pId, otherP2pId] : [otherP2pId, p2pId];
  const p2p = score.p2p.total === 2 ? group([retained], [lost]) : group([p2pId], []);
  const calibrationDirectory = workerJob ? path.join(path.dirname(workerJob), 'calibrations', slot.id) : calibration.root;
  const grade = { kind: 'hidden-test-candidate-grade', instanceId: task.id, baseCommit: input.baseCommit,
    candidateSha256: input.candidateSha256, calibrationDirectory,
    environment: { datasetDigest: input.datasetSha256, testPatchSha256: digest(testPatch), toolchain: identity.toolchain,
      ...(!identity.gradingExchange && { runtime: arktsInstrumentRuntime }) },
    results: [{ phase: 'candidate', instanceId: task.id, complete: true, executed: true, runtimeErrors: [], resolved: score.resolved,
      execution: { code: gradingExecution.exitCode, freshReport: true, compileSucceeded: true, timedOut: false,
        suiteSha256: digest('instrument suite'), runnerSha256: digest('instrument runner') },
      f2p: score.f2p.passed ? group([f2pId], []) : group([], [f2pId]), p2p }],
  };
  const gradeBytes = JSON.stringify(grade, null, 2) + '\n';
  if (!identity.gradingExchange || workerJob) {
    const grading = path.join(workerJob ?? directory, 'grading');
    await fs.mkdir(grading, { recursive: Boolean(workerJob) });
    await Promise.all([fs.writeFile(path.join(grading, 'results.json'), gradeBytes),
      fs.writeFile(path.join(grading, 'candidate.patch'), patch), fs.writeFile(path.join(grading, 'candidate-coverage.log'), coverage)]);
  }
  if (workerJob) await Promise.all([write(path.join(workerJob, 'execution.json'), { input, ...gradingExecution, tail: 'private fixture process output' }),
    fs.writeFile(path.join(workerJob, 'candidate.patch'), patch)]);
  const file = path.join(directory, 'grading-evidence.json');
  await write(file, { version: 1, slot, attempt: 1, businessResultSha256, input, execution: gradingExecution, score,
    gradeSha256: digest(gradeBytes), coverageSha256: digest(coverage) });
  return fileSha256(file);
}

async function editFirstObservation(root) {
  const terminal = path.join(root, 'summary.json');
  const summary = await read(terminal);
  const [first, ...remaining] = summary.observations;
  const { id, repetition, arm } = first;
  const trial = path.join(root, 'trials', id, `r${repetition}`, arm);
  const observation = path.join(root, 'observations', `${id}-r${repetition}-${arm}.result.json`);
  return { first, trial, async update(row) {
    const changed = { ...summary, observations: [row, ...remaining] };
    await Promise.all([write(terminal, changed), write(observation, row),
      write(path.join(root, 'invocations', String(summary.invocation), 'summary.json'), changed)]);
  } };
}

async function finishShard(shard, { pairs, maxPairs, throwOnSlot, mismatchedTree = false, policy = 'same RC policy', acceptance,
  ungraded = false, interruptAfterRepairStart = false, rewriteChecklist = false, legacyGrades = false,
  incompleteTokens = false, bothResolved = false, qualified = false, swapProtectedCases, graderOutput } = {}) {
  const { plan, directory, planSha256 } = shard;
  const pc = plan.tasks.length === 10;
  const toolchainSha256 = digest(pc ? 'Windows Local Test' : 'Mac phone Instrument Test');
  const buildToolchain = pc ? { sha256: digest('Mac controller build route') } : undefined;
  const publicAcceptance = acceptance && Object.fromEntries(plan.tasks.filter(task => task.id === (qualified ? pcTasks[0] : phoneTasks[0]))
    .map(task => [task.id, arktsPublicAcceptanceIdentity(task.publicSha256, acceptance)]));
  const identity = {
    planSha256, releaseArgs: { 'source-commit': release.sourceCommit, 'package-sha256': release.packageSha256 },
    policySha256: digest(policy), reviewerOptions: {}, workflow,
    modelProfile: { state: 'PROFILE_CONFIGURED', modelRef: `custom/${plan.model}`, endpointSha256: endpoint, api: 'openai-completions' },
    providerProfilePin: digest(pc ? 'controller PC config' : 'controller phone config'),
    common: pc ? { 'public-test-toolchain-sha256': toolchainSha256 }
      : { 'instrument-config': '/phone-route.json', 'instrument-toolchain-sha256': toolchainSha256 },
    ...(pc ? { gradingExchange: '/grading-exchange', buildToolchain,
      gradeTotals: Object.fromEntries(plan.tasks.map(task => [task.id, { f2p: 1, p2p: task.id === swapProtectedCases ? 2 : 1 }])) } : {}),
    toolchain: { sha256: toolchainSha256 }, ...(acceptance && { publicAcceptance }),
    ...(qualified && { qualifiedPublicAcceptance: { reportSha256:digest('qualified report'), probeManifestSha256:digest('probe manifest'),
      positiveManifestSha256:digest('positive manifest'), toolchainSha256, cases:publicAcceptance } }),
    ...(!legacyGrades && { gradingEvidenceVersion: 1 }),
    calibration: Object.fromEntries(plan.tasks.map(task => [task.id, { sha256: digest(task.id),
      ...(!pc && { root: path.join(directory, 'calibrations', task.id) }), logs: { base: digest('base'), gold: digest('gold') } }])),
  };
  let timestamp = 1_700_000_000_000;
  let dispatched = 0;
  return executePairedCampaign({ output: directory, plan, identity, maxPairs, signal: new AbortController().signal, now: () => timestamp,
    deadline: timestamp + plan.pairEnvelopeMs + ((pairs ?? plan.schedule.length / 2) - 1) * 200, recheck: async () => {},
    async dispatch(slot) {
      timestamp += 100;
      if (++dispatched === throwOnSlot) throw new Error('fixture dispatch interruption');
      const task = plan.tasks.find(row => row.id === slot.id);
      const preparedTree = mismatchedTree && slot.arm === 'on' ? 'd'.repeat(40) : 'c'.repeat(40);
      const directoryForRun = path.join(directory, 'trials', slot.id, `r${slot.repetition}`, slot.arm, 'business');
      const patchIdentity = graderOutput ? `${slot.id} r${slot.repetition} ${slot.arm}` : slot.arm;
      const patch = Buffer.from(`sealed candidate ${patchIdentity}`), patchSha256 = digest(patch);
      await fs.mkdir(path.join(directoryForRun, 'freeze'), { recursive: true });
      await fs.writeFile(path.join(directoryForRun, 'freeze', 'candidate.patch'), patch);
      const resultFile = path.join(directoryForRun, 'result.json');
      const acceptanceSha256 = publicAcceptance?.[task.id];
      const incomplete = ungraded && acceptanceSha256 && slot.arm === 'on' && slot.repetition === 1;
      const interrupted = interruptAfterRepairStart && task.id === phoneTasks[0] && slot.arm === 'on' && slot.repetition === 1;
      const rewritten = rewriteChecklist && slot.arm === 'on';
      const corrector = slot.arm === 'on';
      const incompleteStopTokens = incompleteTokens && slot.id === plan.tasks[0].id && slot.repetition === 1 && corrector;
      const idle = { observedCalls: 0, completeCalls: 0, tokens: null };
      const documentCost = { usage: corrector ? { observedCalls: 1, completeCalls: 1, tokens: 30 } : idle };
      const stopCost = { usage: corrector ? { observedCalls: incompleteStopTokens ? 2 : 1, completeCalls: 1, tokens: 40 } : idle };
      const businessCalls = incomplete || interrupted ? 2 : 1;
      const businessUsage = { observedCalls: businessCalls, completeCalls: businessCalls, tokens: corrector ? 120 : 100 };
      const modelRequests = documentCost.usage.observedCalls + stopCost.usage.observedCalls + businessCalls;
      const elapsedMs = corrector ? 1200 : 1000;
      const usage = interrupted ? null : tokenSplit({ documentCost, stopCost, businessUsage });
      const native = { runId: 'apply', occurrenceId: 'apply:check-1', evaluationId: 'stop-1', status: 'SETTLED',
        reviewStatus: slot.repetition === 3 ? 'UNVERIFIED' : 'NO_DEVIATION_FOUND' };
      const publicAcceptanceCheck = slot.repetition === 3 ? { sha256: acceptance?.sha256, status: 'INCOMPLETE', checks: [] } : {
        sha256: acceptance?.sha256, status: 'PASS', checks: acceptance?.testIds.map(id => ({ id, status: 'PASS' })),
        workspaceDigest: digest('workspace'), snapshotSha256: digest('build snapshot'),
      };
      const result = { state: 'finished', reason: null, frameworkError: false, packageSha256: release.packageSha256,
        instance: { id: slot.id, datasetDigest: task.datasetSha256, baseCommit: task.baseCommit }, publicInputSha256: task.publicSha256, preparedTree,
        gateway: { hostVersion: targetVersion }, providerIdentity: { modelRef: identity.modelProfile.modelRef, endpointSha256: endpoint },
        frozen: { patchSha256 }, rcEnabled: corrector, businessNatural: true, openSpec: { codeing: { applyComplete: true } },
        ...(!legacyGrades && { modelRequests, elapsedMs, ...(usage && { documentCost, stopCost, businessUsage, tokenSplit: usage }) }),
        ...(acceptanceSha256 && { publicAcceptancePin: acceptance }),
        ...((acceptanceSha256 && slot.arm === 'on' || interrupted) && { nativeStopSettled: true, nativeStopVerification: native, nativeStopRecords: [native],
          turns: [{ stage: 'codeing', runId: 'apply', finalRunId: 'apply' }], stopReviews: [{ lifecycle: 'SETTLED',
            runId: native.occurrenceId, evaluationId: slot.repetition === 2 ? 'stale-evaluation' : native.evaluationId,
            status: native.reviewStatus, publicAcceptanceCheck }] }),
      };
      if (qualified && acceptanceSha256) {
        result.projectRoot = path.join(directoryForRun, 'project');
        const publicTask = await read(path.join(directory,'public', `${task.id}.json`));
        await writeArktsQualifiedProbeDescriptor(path.dirname(directoryForRun), publicTask,
          task.publicSha256, { ...acceptance, probeBytes:Buffer.from('qualified probe'), identitySha256:acceptanceSha256 });
        await write(path.join(directoryForRun, 'manifest.json'), { rcEnabled:corrector, publicInputSha256:result.publicInputSha256,
          projectRoot:result.projectRoot, preparedTree, ...release, publicAcceptanceSha256:acceptanceSha256 });
        await write(path.join(directoryForRun, 'workflow-messages.json'), { workflow });
      }
      if (!qualified && acceptanceSha256 && slot.arm === 'on' && slot.repetition === 1 || interrupted)
        await attachCorrectionFixture(directoryForRun, result, patch, interrupted ? null : publicAcceptanceCheck);
      if (incomplete) {
        result.businessNatural = false;
        result.openSpec.codeing.applyComplete = false;
        result.reason = 'OPENSPEC_APPLY_INCOMPLETE';
        if (qualified) result.frozen = null;
      }
      if (interrupted) {
        Object.assign(result, { state: 'framework-error', frameworkError: true, businessNatural: false, reason: 'PROFILE_REQUEST_LIMIT',
          frozen: null, nativeStopSettled: false, nativeStopVerification: null });
        result.nativeStopRecords.pop();
        result.stopReviews.pop();
        const ledgerFile = path.join(directoryForRun, 'native-host/state/runtime-corrector-stop-sessions/sessions', digest(result.sessionId) + '.json');
        const ledger = await read(ledgerFile);
        delete ledger.admissions.repair.endedAt;
        await write(ledgerFile, ledger);
      }
      if (rewritten) {
        const checkpoint = (description, done) => ({ changeName: 'benchmark-change', planVerified: true,
          readyToApply: !done, applyComplete: done, apply: { exitCode: 0, value: { changeName: 'benchmark-change',
            progress: { total: 1, complete: Number(done), remaining: Number(!done) }, tasks: [{ id: '1', description, done }] } } });
        result.openSpec = { proposal: checkpoint('Run the existing checks.', false), codeing: checkpoint('Report the current state.', true),
          applyChecklistPreserved: true };
      }
      await write(resultFile, result);
      const businessResultSha256 = await fileSha256(resultFile);
      const completed = { interrupted: false, outputComplete: true };
      if (incomplete || interrupted) return { ...slot, execution: { exitCode: interrupted ? 1 : 0, ...completed },
        business: result.state, businessCompleted: false,
        completionReason: result.reason, score: null, providerRequests: modelRequests, elapsedMs, usage,
        businessResultSha256 };
      const featurePassed = corrector || bothResolved;
      const swapsProtectedCases = slot.id === swapProtectedCases;
      const resolved = featurePassed && !swapsProtectedCases;
      const score = { f2p: { total: 1, passed: Number(featurePassed) }, p2p: { total: swapsProtectedCases ? 2 : 1, passed: 1 }, resolved };
      const gradingExecution = { exitCode: resolved ? 0 : 1, reason: 'closed', durationMs: 10, ...completed };
      const gradingEvidenceSha256 = legacyGrades ? undefined : await sealFixtureGrade(path.dirname(directoryForRun), {
        slot, task, identity, businessResultSha256, gradingExecution, score, patch,
        workerJob: graderOutput ? fixtureWorkerJob(graderOutput, dispatched) : undefined,
      });
      return { ...slot, execution: { exitCode: 0, ...completed }, gradingExecution,
        business: 'finished', businessCompleted: true, score, patchSha256, providerRequests: modelRequests, elapsedMs, usage, businessResultSha256,
        ...(gradingEvidenceSha256 && { gradingEvidenceSha256 }),
        comparisonIdentity: { ...release, workflow, hostVersion: targetVersion, modelRef: identity.modelProfile.modelRef,
          endpoint, publicInputSha256: task.publicSha256, preparedTree, toolchainSha256,
          ...(acceptanceSha256 && { publicAcceptanceSha256: acceptanceSha256 }),
          ...(buildToolchain ? { buildToolchainSha256: buildToolchain.sha256 } : {}) },
      };
    },
  });
}

async function correctionGradingFixture(t, { pairs } = {}) {
  const { phones } = await fixture(t);
  const root = path.dirname(phones.directory);
  const exchange = path.join(root, 'diagnostic-grading-exchange');
  await fs.mkdir(exchange);
  const acceptance = { sha256: digest('probe bytes'), testIds: ['public.requested'],
    requirementBindings: [{ testId: 'public.requested', quote: 'Preserve stable display order.' }] };
  await finishShard(phones, { pairs, acceptance });
  const slot = { id: phoneTasks[0], repetition: 1, arm: 'on' };
  const task = phones.plan.tasks.find(task => task.id === slot.id);
  const trial = path.join(phones.directory, 'trials', slot.id, 'r1', 'on');
  const checkpoint = path.join(trial, 'business/checkpoints/original/candidate.patch');
  const finalReceipt = path.join(trial, 'grading-evidence.json');
  const execution = await read(path.join(phones.directory, 'execution.json'));
  const options = { directory: phones.directory, planSha256: phones.planSha256, release, exchange,
    output: path.join(root, 'diagnostic-grades'), deadline: Date.now() + 60 * 60_000 };
  return { options, slot, task, checkpoint, finalReceipt, execution };
}

function correctionGradingWorker({ options, slot, execution }, onGrade = async () => {}) {
  const controller = new AbortController();
  const requests = [], errors = [];
  const { sha256, logs } = execution.calibration[slot.id];
  const score = { f2p: { total: 1, passed: 0 }, p2p: { total: 1, passed: 1 }, resolved: false };
  const gradeSha256 = digest('independent pre-repair grade'), coverageSha256 = digest('independent pre-repair coverage');
  const serving = serveArktsWorkerJobs(options.exchange, async (action, input, { directory }) => {
    requests.push({ action, input });
    if (action === 'calibration') return { toolchain: { sha256: execution.toolchain.sha256 },
      calibration: { [slot.id]: { sha256, logs } }, gradeTotals: { [slot.id]: { f2p: 1, p2p: 1 } } };
    assert.equal(action, 'grade');
    requests.at(-1).patch = await fs.readFile(path.join(directory, 'candidate.patch'));
    await onGrade();
    return { input, score, gradeSha256, coverageSha256,
      execution: { exitCode: 1, interrupted: false, outputComplete: true, reason: 'closed', durationMs: 10 } };
  }, { signal: controller.signal, pollMs: 5, onError: error => errors.push(error) });
  return { requests, errors, score, gradeSha256, coverageSha256, async close() {
    controller.abort();
    await serving;
  } };
}

test('reports partial checkpoint gains and losses separately from resolution, preserving missing comparisons', () => {
  const slot = repetition => ({ id: phoneTasks[0], repetition, arm: 'on' });
  const grade = (f2p, p2p) => ({ score: { resolved: false, f2p: { passed: f2p, total: 10 }, p2p: { passed: p2p, total: 288 } } });
  const before = grade(1, 288), improved = grade(8, 288), regressed = grade(8, 287);
  const candidates = [{ slot: slot(1), before, after: improved }, { slot: slot(2), before: improved, after: regressed },
    { slot: slot(3), status: 'SCORED_IDENTICAL', before: improved, after: improved },
    { slot: slot(4), status: 'UNSCORED', before: { score: null }, after: improved }];
  const skipped = [{ slot: slot(5), reason: 'FINAL_GRADE_UNVERIFIED' }];
  const { comparison, scoreChanges } = summarizeArktsCorrectionCheckpointScores(candidates, skipped);
  assert.deepEqual(comparison, { improved: 0, regressed: 0, bothResolved: 0, neitherResolved: 3, unscored: 1 });
  assert.deepEqual(scoreChanges, { measured: 3, missing: 2, f2p: { higher: 1, lower: 0, equal: 2 },
    p2p: { higher: 0, lower: 1, equal: 2 }, checkpoints: [
      { slot: slot(1), f2p: { total: 10, beforePassed: 1, afterPassed: 8, delta: 7 },
        p2p: { total: 288, beforePassed: 288, afterPassed: 288, delta: 0 } },
      { slot: slot(2), f2p: { total: 10, beforePassed: 8, afterPassed: 8, delta: 0 },
        p2p: { total: 288, beforePassed: 288, afterPassed: 287, delta: -1 } },
      { slot: slot(3), f2p: { total: 10, beforePassed: 8, afterPassed: 8, delta: 0 },
        p2p: { total: 288, beforePassed: 288, afterPassed: 288, delta: 0 } },
    ] });
  const mismatched = structuredClone(candidates[0]);
  mismatched.after.score.f2p.total++;
  assert.throws(() => summarizeArktsCorrectionCheckpointScores([mismatched], []), /grade totals differ/u);
});

test('independently grades the authentic pre-repair checkpoint and leaves the formal pair untouched', async t => {
  const data = await correctionGradingFixture(t);
  const { options, slot, task, checkpoint, finalReceipt, execution } = data;
  const beforeBytes = await fs.readFile(checkpoint);
  const after = await read(finalReceipt);
  const formalFiles = [finalReceipt, path.join(options.directory, 'summary.json'), path.join(options.directory, 'execution.json'),
    path.join(options.directory, 'observations', `${slot.id}-r1-on.result.json`)];
  const formalHashes = await Promise.all(formalFiles.map(fileSha256));
  const worker = correctionGradingWorker(data);
  try {
    const report = await gradeArktsCorrectionCheckpoints({ ...options, signal: AbortSignal.timeout(10_000) });
    assert.deepEqual(await read(path.join(options.output, 'report.json')), report);
    assert.equal(report.formalPairsAdded, 0);
    assert.equal(report.modelRequests, 0);
    assert.deepEqual(report.comparison, { improved: 1, regressed: 0, bothResolved: 0, neitherResolved: 0, unscored: 0 });
    assert.deepEqual(report.scoreChanges, { measured: 1, missing: 0, f2p: { higher: 1, lower: 0, equal: 0 },
      p2p: { higher: 0, lower: 0, equal: 1 }, checkpoints: [{ slot, f2p: { total: 1, beforePassed: 0, afterPassed: 1, delta: 1 },
        p2p: { total: 1, beforePassed: 1, afterPassed: 1, delta: 0 } }] });
    assert.equal(report.candidates.length, 1);
    const [row] = report.candidates;
    assert.deepEqual(row.slot, slot);
    assert.equal(row.status, 'SCORED');
    assert.equal(row.firstRepair.runId, 'apply');
    assert.equal(row.before.patchSha256, digest(beforeBytes));
    assert.deepEqual(row.before.score, worker.score);
    assert.equal(row.after.patchSha256, after.input.candidateSha256);
    assert.deepEqual(row.after.score, after.score);
    assert.equal(row.after.gradingEvidenceSha256, formalHashes[0]);
    assert.deepEqual(worker.requests.map(request => request.action), ['calibration', 'grade']);
    const taskPin = { id: task.id, baseCommit: task.baseCommit, datasetSha256: task.datasetSha256 };
    assert.deepEqual(worker.requests[0].input, { releaseCommit: release.sourceCommit, tasks: [taskPin] });
    assert.deepEqual(worker.requests[1].input, { ...taskPin, releaseCommit: release.sourceCommit,
      candidateSha256: digest(beforeBytes), calibrationSha256: execution.calibration[slot.id].sha256,
      toolchainSha256: execution.toolchain.sha256, phaseTimeoutMs: 600_000 });
    assert.deepEqual(worker.requests[1].patch, beforeBytes);
    assert.deepEqual(worker.errors, []);
    const evidenceFile = path.join(options.output, 'trials', slot.id, 'r1', 'grading-evidence.json');
    const evidence = await read(evidenceFile);
    assert.equal(await fileSha256(evidenceFile), row.before.gradingEvidenceSha256);
    assert.deepEqual(evidence.input, worker.requests[1].input);
    assert.equal(evidence.gradeSha256, worker.gradeSha256);
    assert.equal(evidence.coverageSha256, worker.coverageSha256);
    assert.deepEqual(evidence.score, worker.score);
    assert.doesNotMatch(JSON.stringify({ report, evidence }), /entry::Test::|private fixture native coverage|before repair/u);
    assert.deepEqual(await Promise.all(formalFiles.map(fileSha256)), formalHashes);
  } finally {
    await worker.close();
  }
});

test('skips a mutated pre-repair checkpoint before sending work to the grader', async t => {
  const data = await correctionGradingFixture(t);
  await fs.appendFile(data.checkpoint, '\nchanged checkpoint bytes');
  const worker = correctionGradingWorker(data);
  try {
    const report = await gradeArktsCorrectionCheckpoints({ ...data.options, signal: AbortSignal.timeout(10_000) });
    assert.deepEqual(report.candidates, []);
    assert.deepEqual(report.skipped, [{ slot: data.slot, reason: 'PRE_STOP_PATCH_UNVERIFIED' }]);
    assert.deepEqual(report.scoreChanges, { measured: 0, missing: 1, f2p: { higher: 0, lower: 0, equal: 0 },
      p2p: { higher: 0, lower: 0, equal: 0 }, checkpoints: [] });
    assert.deepEqual(worker.requests, []);
    assert.deepEqual(await fs.readdir(data.options.exchange), []);
  } finally {
    await worker.close();
  }
});

test('refuses to publish a comparison when the final grade changes during pre-repair grading', async t => {
  const data = await correctionGradingFixture(t);
  const worker = correctionGradingWorker(data, () => fs.appendFile(data.finalReceipt, '\n'));
  try {
    await assert.rejects(gradeArktsCorrectionCheckpoints({ ...data.options, signal: AbortSignal.timeout(10_000) }),
      /Correction evidence changed after verification/u);
    assert.deepEqual(worker.requests.map(request => request.action), ['calibration', 'grade']);
    await assert.rejects(fs.stat(path.join(data.options.output, 'report.json')), { code: 'ENOENT' });
  } finally {
    await worker.close();
  }
});

test('reports a settled window pause while checkpoint regrading still requires a completed shard', async t => {
  const { options, slot } = await correctionGradingFixture(t, { pairs: 1 });
  const summary = await read(path.join(options.directory, 'summary.json'));
  assert.equal(summary.status, 'INSUFFICIENT_PAIR_WINDOW');
  await assert.rejects(gradeArktsCorrectionCheckpoints({ ...options, signal: AbortSignal.timeout(5_000) }),
    /terminal|completed|settled|paused|pair window/iu);
  const report = await reportArktsGradeTransitions(options);
  assert.equal(report.shardStatus, 'INSUFFICIENT_PAIR_WINDOW');
  assert.equal(report.plannedPairs, 9);
  assert.equal(report.settledPairs, 1);
  assert.equal(report.matchedScoredPairs, 1);
  assert.equal(report.comparedPairs, 1);
  assert.equal(report.pairs[0].id, slot.id);
  assert.deepEqual(await fs.readdir(options.exchange), []);
});

test('reports only sealed native public checks with exact slot and occurrence provenance', async t => {
  const inputs = await fixture(t);
  const pin = { sha256: digest('probe bytes'), testIds: ['public.requested', 'public.retained'],
    requirementBindings: [{ testId: 'public.requested', quote: 'Preserve stable display order.' }] };
  await finishShard(inputs.phones, { acceptance: pin });
  const report = await summarizeArktsPairedCohort(inputs);
  const trial = (repetition, arm) => report.trials.find(row => row.id === phoneTasks[0] && row.repetition === repetition && row.arm === arm);
  assert.deepEqual(trial(1, 'off').publicAcceptance, { status: 'CORRECTOR_DISABLED' });
  assert.deepEqual(trial(1, 'on').publicAcceptance, { status: 'RECORDED', probeSha256: pin.sha256,
    beforeFirstCorrection: { runId: 'original-apply', occurrenceId: 'original-apply:check-1', evaluationId: 'stop-before', reviewStatus: 'DEVIATION',
      status: 'FAIL', checks: [{ id: pin.testIds[0], status: 'FAIL' }, { id: pin.testIds[1], status: 'PASS' }],
      workspaceDigest: digest('before workspace'), snapshotSha256: digest('before snapshot') },
    finalStop: { runId: 'apply', occurrenceId: 'apply:check-1', evaluationId: 'stop-1', reviewStatus: 'NO_DEVIATION_FOUND',
      status: 'PASS', checks: pin.testIds.map(id => ({ id, status: 'PASS' })),
      workspaceDigest: digest('workspace'), snapshotSha256: digest('build snapshot') } });
  assert.deepEqual(trial(2, 'on').publicAcceptance, { status: 'NOT_RECORDED', probeSha256: pin.sha256,
    beforeFirstCorrection: null, finalStop: null });
  assert.deepEqual(trial(3, 'on').publicAcceptance.finalStop, { runId: 'apply', occurrenceId: 'apply:check-1', evaluationId: 'stop-1',
    reviewStatus: 'UNVERIFIED', status: 'INCOMPLETE', checks: [] });
  const file = path.join(inputs.phones.directory, 'trials', phoneTasks[0], 'r1', 'on', 'business', 'result.json');
  const result = await read(file);
  result.stopReviews[0].publicAcceptanceCheck.checks[0].status = 'PASS';
  await write(file, result);
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Business receipt bytes differ from the durable result/u);
});

test('verifies a qualified probe pin in the corrector-off arm as well as corrector-on', async t => {
  const inputs = await fixture(t);
  const testId = 'entry::Public::target';
  const pin = { sha256:digest('qualified probe'), testIds:[testId],
    requirementBindings:[{ testId, quote:'Preserve stable display order.' }] };
  await finishShard(inputs.pc, { pairs:1, acceptance:pin, qualified:true });
  const report = await summarizeArktsPairedCohort(inputs);
  const { qualifiedPublicAcceptance } = report.shards.pc;
  assert.equal(qualifiedPublicAcceptance.reportSha256, digest('qualified report'));
  const off = report.trials.find(row => row.id === pcTasks[0] && row.repetition === 1 && row.arm === 'off');
  assert.deepEqual(off.publicAcceptance, { status:'CORRECTOR_DISABLED' });
  const on = report.trials.find(row => row.id === pcTasks[0] && row.repetition === 1 && row.arm === 'on');
  assert.equal(on.publicAcceptance.finalStop.status, 'PASS');
  const { first, trial, update } = await editFirstObservation(inputs.pc.directory);
  assert.equal(first.arm, 'off');
  const probe = path.join(trial, 'public-acceptance', 'probe.ets');
  const originalProbe = await fs.readFile(probe);
  await fs.appendFile(probe, '\n// changed');
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Qualified public probe differs from its trusted digest/u);
  await fs.writeFile(probe, originalProbe);
  const file = path.join(trial, 'business', 'result.json');
  const evidence = path.join(trial, 'grading-evidence.json');
  const result = await read(file);
  await write(file, { ...result, publicAcceptancePin: { ...pin, requirementBindings:[] } });
  const businessResultSha256 = await fileSha256(file);
  await write(evidence, { ...await read(evidence), businessResultSha256 });
  await update({ ...first, businessResultSha256, gradingEvidenceSha256:await fileSha256(evidence) });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Public acceptance descriptor differs from its campaign pin/u);
});

test('retains costs for a qualified trial without a frozen candidate', async t => {
  const inputs = await fixture(t);
  const pin = { sha256:digest('qualified probe'), testIds:['entry::Public::target'], requirementBindings:[] };
  await finishShard(inputs.pc, { pairs:1, acceptance:pin, qualified:true, ungraded:true });
  const report = await summarizeArktsPairedCohort(inputs);
  const on = report.trials.find(row => row.id === pcTasks[0] && row.repetition === 1 && row.arm === 'on');
  assert.equal(on.status, 'UNSCORED');
  assert.equal(on.providerRequests, 4);
  assert.deepEqual(on.publicAcceptance, { status:'NOT_RECORDED', probeSha256:pin.sha256 });
});

test('retains Stop evidence and cost for a sealed ungraded Apply without supplying a grade', async t => {
  const inputs = await fixture(t);
  const pin = { sha256: digest('probe bytes'), testIds: ['public.requested', 'public.retained'] };
  await finishShard(inputs.phones, { acceptance: pin, ungraded: true });
  const report = await summarizeArktsPairedCohort(inputs);
  const row = report.trials.find(slot => slot.id === phoneTasks[0] && slot.repetition === 1 && slot.arm === 'on');
  assert.equal(row.status, 'UNSCORED');
  assert.equal(row.score, null);
  assert.equal(row.completionReason, 'OPENSPEC_APPLY_INCOMPLETE');
  assert.equal(row.businessCompleted, false);
  assert.equal(row.providerRequests, 4);
  assert.equal(row.elapsedMs, 1200);
  assert.equal(row.publicAcceptance.beforeFirstCorrection.status, 'FAIL');
  assert.equal(row.publicAcceptance.finalStop.status, 'PASS');
  assert.equal(row.verifiedRepairStarts.length, 1);
  assert.equal(report.comparison.matchedScoredPairs, 8);
  assert.equal(report.comparison.bothAttemptedPairsMissingGrade, 1);
  assert.deepEqual(report.comparison.tokenUsage.matched.total, { pairs: 8, off: 800, on: 1520 });
  assert.deepEqual(report.comparison.tokenUsage.attempted.total, { pairs: 9, off: 900, on: 1710 });
  assert.equal(report.arms.on.passAt1, null);
  const transition = await readArktsPairedGradeTransitionPlan({ ...inputs.phones, release });
  assert.equal(transition.plannedPairs, 9);
  assert.equal(transition.pairs.length, 8);
  assert(!transition.pairs.some(pair => pair.id === row.id && pair.repetition === row.repetition));

  const business = path.join(inputs.phones.directory, 'trials', phoneTasks[0], 'r1', 'on', 'business');
  const workflowFile = path.join(business, 'workflow-messages.json');
  await write(workflowFile, { workflow: { ...workflow, cliVersion: '0.0.0' } });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Business manifest or workflow differs from the campaign/u);
  await write(workflowFile, { workflow });
  await fs.writeFile(path.join(business, 'freeze/candidate.patch'), 'not the frozen candidate');
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Ungraded public acceptance differs from its frozen candidate/u);
  await fs.rm(path.join(business, 'result.json'));
  const missing = await summarizeArktsPairedCohort(inputs);
  const missingRow = missing.trials.find(slot => slot.id === row.id && slot.repetition === row.repetition && slot.arm === row.arm);
  assert.equal(missingRow.businessCompleted, null);
  assert.equal(missingRow.completionReason, null);
  assert.equal(missingRow.providerRequests, null);
  assert.equal(missing.comparison.workflow.unavailable, 1);
});

test('records the native start of an interrupted repair on an unprobed task', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.phones, { interruptAfterRepairStart: true });
  const report = await summarizeArktsPairedCohort(inputs);
  const row = report.trials.find(slot => slot.id === phoneTasks[0] && slot.repetition === 1 && slot.arm === 'on');
  assert.equal(row.status, 'UNSCORED');
  assert.equal(row.score, null);
  assert.equal(row.completionReason, 'PROFILE_REQUEST_LIMIT');
  assert.equal(row.providerRequests, 4);
  assert.equal(row.tokens, undefined);
  assert.equal(row.publicAcceptance, undefined);
  assert.deepEqual(row.verifiedRepairStarts, [{ runId: 'apply', sourceRunId: 'original-apply', occurrenceId: 'original-apply:check-1',
    evaluationId: 'stop-before', startedAt: 6000 }]);
  assert.equal(report.comparison.matchedScoredPairs, 0);
  assert.equal(report.arms.on.passAt1, null);
});

test('rejects a graded slot that claims to preserve changed OpenSpec checklist entries', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.phones, { rewriteChecklist: true });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Scored slot changed its approved OpenSpec checklist/u);
});

test('plans, reads pending shards and merges all 78 sealed slots in master order', async t => {
  const inputs = await fixture(t);
  const pending = await summarizeArktsPairedCohort(inputs);
  assert.equal(pending.status, 'PLAN_ONLY');
  assert.equal(pending.comparison.unstartedPairs, 39);
  assert.equal(pending.arms.on.passAt1, null);
  await finishShard(inputs.phones);
  const partial = await summarizeArktsPairedCohort(inputs);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.shards.pc.status, 'PLAN_ONLY');
  assert.equal(partial.comparison.matchedScoredPairs, 9);
  assert.equal(partial.comparison.unstartedPairs, 30);
  assert.equal(partial.arms.on.passAt1, null);
  await finishShard(inputs.pc);
  const report = await summarizeArktsPairedCohort(inputs);
  assert.equal(report.status, 'COMPLETE');
  assert.equal(report.comparison.matchedScoredPairs, 39);
  assert.equal(report.comparison.transitions.improved, 39);
  assert.deepEqual(report.trials.map(({ id, repetition, arm }) => ({ id, repetition, arm })), inputs.master.plan.schedule);
  assert(report.trials.every(row => row.status === 'SCORED'));
  assert.equal(report.arms.off.passAt1, 0);
  assert.equal(report.arms.on.passAt1, 1);
  assert.doesNotMatch(JSON.stringify(report), /entry::Test::(?:expected|retained)|private fixture native coverage/u);
});

test('plans exact local and worker grade transitions without exposing private results', async t => {
  const inputs = await fixture(t);
  await Promise.all([finishShard(inputs.pc), finishShard(inputs.phones, { incompleteTokens: true })]);

  for (const shard of [inputs.pc, inputs.phones]) {
    const transition = await readArktsPairedGradeTransitionPlan({ ...shard, release });
    assert.equal(transition.root, await fs.realpath(shard.directory));
    assert.equal(transition.planSha256, shard.planSha256);
    assert.equal(transition.executionSha256, await fileSha256(path.join(shard.directory, 'execution.json')));
    assert.equal(transition.terminalSummarySha256, await fileSha256(path.join(shard.directory, 'summary.json')));
    assert.equal(transition.shardStatus, 'COMPLETE');
    assert.equal(transition.plannedPairs, shard.plan.schedule.length / 2);
    assert.equal(transition.settledPairs, transition.plannedPairs);
    assert.deepEqual(transition.taskPairs, Object.fromEntries(shard.plan.tasks.map(({ id }) => [id, 3])));
    assert.deepEqual(transition.settledTaskPairs, transition.taskPairs);
    assert.deepEqual(transition.pairs.map(({ id, repetition }) => ({ id, repetition })),
      shard.plan.schedule.filter(slot => slot.arm === 'off').map(({ id, repetition }) => ({ id, repetition })));

    const { id, repetition, off, on } = transition.pairs[0];
    const worker = shard === inputs.pc;
    for (const [arm, ref] of Object.entries({ off, on })) {
      const trial = path.join('trials', id, `r${repetition}`, arm);
      const evidence = path.join(shard.directory, trial, 'grading-evidence.json');
      const { input, gradeSha256, coverageSha256, score } = await read(evidence);
      const corrector = arm === 'on';
      const providerRequests = corrector ? 3 + Number(!worker) : 1;
      const tokens = corrector ? { document: 30, stop: worker ? 40 : null, other: 120, total: worker ? 190 : null }
        : { document: 0, stop: 0, other: 100, total: 100 };
      assert.deepEqual(ref, { input, gradeSha256, coverageSha256, score, gradingEvidenceSha256: await fileSha256(evidence),
        localGradeDirectory: worker ? null : path.join(trial, 'grading'),
        providerRequests, elapsedMs: corrector ? 1200 : 1000, tokens });
    }
    assert.doesNotMatch(JSON.stringify(transition), /entry::Test::(?:expected|retained)|private fixture native coverage/u);
  }
});

test('reports the first capped worker pair and refuses active, unsealed, or mid-pair shards', async t => {
  const { pc } = await fixture(t);
  const graderOutput = path.join(path.dirname(pc.directory), 'paused-private-grades');
  const options = { ...pc, release, graderOutput };
  await assert.rejects(reportArktsGradeTransitions(options), /complete shard or a nonempty whole-pair pause/u);
  const summary = await finishShard(pc, { maxPairs: 1, graderOutput });
  assert.equal(summary.status, 'PAIR_LIMIT_REACHED');
  const currentFile = path.join(pc.directory, 'summary.json');
  const invocationFile = path.join(pc.directory, 'invocations', '1', 'summary.json');
  const files = [currentFile, invocationFile, path.join(pc.directory, 'execution.json')];
  const hashes = await Promise.all(files.map(fileSha256));
  const report = await reportArktsGradeTransitions(options);
  assert.equal(report.shardStatus, 'PAIR_LIMIT_REACHED');
  assert.equal(report.plannedPairs, 30);
  assert.equal(report.settledPairs, 1);
  assert.equal(report.matchedScoredPairs, 1);
  assert.equal(report.comparedPairs, 1);
  assert.equal(report.unavailableMatchedPairs, 0);
  assert.deepEqual(report.pairs.map(({ id, repetition, outcome }) => ({ id, repetition, outcome })),
    [{ id: pcTasks[0], repetition: 1, outcome: 'GAIN_ONLY' }]);
  for (const [index, id] of pcTasks.entries()) {
    const { outcomes: _outcomes, ...counts } = report.tasks[id];
    const settled = Number(index === 0);
    assert.deepEqual(counts, { plannedPairs: 3, settledPairs: settled, matchedScoredPairs: settled, comparedPairs: settled });
  }
  assert.doesNotMatch(JSON.stringify(report), /entry::Test::|paused-private-grades|private fixture native coverage/u);
  assert.deepEqual(await Promise.all(files.map(fileSha256)), hashes);

  const lock = path.join(pc.directory, '.campaign-lock');
  await fs.mkdir(lock);
  await assert.rejects(reportArktsGradeTransitions(options), /running or has an unsettled campaign lock/u);
  await fs.rmdir(lock);
  const firstResult = path.join(pc.directory, 'observations', `${pcTasks[0]}-r1-off.result.json`);
  const firstBytes = await fs.readFile(firstResult);
  await fs.rm(firstResult);
  await assert.rejects(reportArktsGradeTransitions(options), /Missing durable result/u);
  await fs.writeFile(firstResult, firstBytes);
  const partial = { ...summary, status: 'INSUFFICIENT_PAIR_WINDOW', observations: summary.observations.slice(0, 1) };
  await Promise.all([write(currentFile, partial), write(invocationFile, partial)]);
  await assert.rejects(reportArktsGradeTransitions(options), /Window-paused shard ends inside a pair/u);
});

test('counts settled incomplete Apply separately and refuses missing business evidence or an empty pause', async t => {
  const { pc, phones } = await fixture(t);
  await finishShard(pc, { pairs: 0 });
  await assert.rejects(reportArktsGradeTransitions({ ...pc, release }), /nonempty whole-pair pause/u);

  const acceptance = { sha256: digest('probe bytes'), testIds: ['public.requested'],
    requirementBindings: [{ testId: 'public.requested', quote: 'Preserve stable display order.' }] };
  await finishShard(phones, { pairs: 2, acceptance, ungraded: true });
  const options = { ...phones, release };
  const report = await reportArktsGradeTransitions(options);
  assert.equal(report.shardStatus, 'INSUFFICIENT_PAIR_WINDOW');
  assert.equal(report.settledPairs, 2);
  assert.equal(report.matchedScoredPairs, 1);
  assert.equal(report.comparedPairs, 1);
  assert.equal(report.tasks[phoneTasks[0]].settledPairs, 1);
  assert.equal(report.tasks[phoneTasks[0]].matchedScoredPairs, 0);
  assert.equal(report.tasks[phoneTasks[1]].comparedPairs, 1);
  const business = path.join(phones.directory, 'trials', phoneTasks[0], 'r1', 'on', 'business', 'result.json');
  await fs.rm(business);
  await assert.rejects(reportArktsGradeTransitions(options), /Unsealed or unsettled trial in paused shard/u);
});

test('attributes attempted-arm requests from durable receipts independently of grade archives', async t => {
  const { phones } = await fixture(t);
  const options = { ...phones, release };
  assert.equal((await reportArktsReviewRequests(options)).status, 'PLAN_ONLY');
  await finishShard(phones, { maxPairs: 1, ungraded: true });
  const off = path.join(phones.directory, 'trials', phoneTasks[0], 'r1', 'off');
  await fs.rm(path.join(off, 'grading'), { recursive: true, force: true });
  await fs.rm(path.join(off, 'grading-evidence.json'), { force: true });
  const report = await reportArktsReviewRequests(options);
  assert.equal(report.status, 'PAIR_LIMIT_REACHED');
  assert.equal(report.plannedTrials, 18);
  assert.equal(report.trials.length, 2);
  assert(report.trials.every(row => row.status === 'UNAVAILABLE'
    && row.providerRequests > 0 && row.unknownRequests === row.providerRequests && row.observedTimingRequests === null));
  assert.doesNotMatch(JSON.stringify(report), /entry::Test::|private fixture/u);
  const lock = path.join(phones.directory, '.campaign-lock');
  await fs.mkdir(lock);
  await assert.rejects(reportArktsReviewRequests(options), /running or has an unsettled campaign lock/u);
  await fs.rmdir(lock);
  await fs.appendFile(path.join(off, 'business/result.json'), ' ');
  await assert.rejects(reportArktsReviewRequests(options), /Business receipt bytes differ/u);
});

test('reports same-count protected test swaps with costs grouped by exact outcome', async t => {
  const [id] = phoneTasks;
  const inputs = await fixture(t, { swapProtectedCases: id });
  await finishShard(inputs.phones, { swapProtectedCases: id, bothResolved: true, incompleteTokens: true });
  const options = { ...inputs.phones, release };
  const plan = await readArktsPairedGradeTransitionPlan(options);
  const first = plan.pairs.find(pair => pair.id === id && pair.repetition === 1);
  assert.deepEqual(first.off.score, first.on.score);
  assert.deepEqual(first.off.score.p2p, { passed: 1, total: 2 });

  const report = await reportArktsGradeTransitions(options);
  assert.equal(report.plannedPairs, 9);
  assert.equal(report.matchedScoredPairs, 9);
  assert.equal(report.comparedPairs, 9);
  assert.equal(report.unavailableMatchedPairs, 0);
  assert.equal(report.protectedTestLossPairs, 3);
  const mixed = report.pairs.filter(pair => pair.outcome === 'GAIN_AND_LOSS');
  assert.equal(mixed.length, 3);
  assert.deepEqual(mixed.map(pair => pair.repetition), [1, 2, 3]);
  for (const pair of mixed) {
    assert.equal(pair.id, id);
    assert.equal(pair.status, 'COMPARED');
    assert.deepEqual(pair.f2p, { total: 1, gains: 0, losses: 0, unchanged: 1 });
    assert.deepEqual(pair.p2p, { total: 2, gains: 1, losses: 1, unchanged: 0 });
  }
  assert.deepEqual(mixed[0].cost, { providerRequests: { off: 1, on: 4, delta: 3 }, elapsedMs: { off: 1000, on: 1200, delta: 200 },
    totalTokens: null });
  assert.deepEqual(report.outcomes.GAIN_AND_LOSS, { pairs: 3, cost: {
    providerRequests: { measuredPairs: 3, missingPairs: 0, off: 3, on: 10, delta: 7 },
    elapsedMs: { measuredPairs: 3, missingPairs: 0, off: 3000, on: 3600, delta: 600 },
    totalTokens: { measuredPairs: 2, missingPairs: 1, off: 200, on: 380, delta: 180 },
  } });
  assert.equal(report.outcomes.UNCHANGED.pairs, 6);
  const { outcomes, ...counts } = report.tasks[id];
  assert.deepEqual(counts, { plannedPairs: 3, settledPairs: 3, matchedScoredPairs: 3, comparedPairs: 3 });
  assert.deepEqual(outcomes.GAIN_AND_LOSS, report.outcomes.GAIN_AND_LOSS);
  assert.equal(outcomes.UNCHANGED.pairs, 0);
  assert.doesNotMatch(JSON.stringify(report), /entry::Test::|private fixture native coverage/u);
});

test('resolves worker grades from a private archive and excludes tampered artifacts', async t => {
  const { pc } = await fixture(t);
  const graderOutput = path.join(path.dirname(pc.directory), 'private-worker-output');
  await finishShard(pc, { graderOutput });
  const options = { ...pc, release, graderOutput };
  const report = await reportArktsGradeTransitions(options);
  assert.equal(report.comparedPairs, 30);
  assert.equal(report.outcomes.GAIN_ONLY.pairs, 30);
  assert.equal(report.protectedTestLossPairs, 0);
  assert.equal(report.unavailableMatchedPairs, 0);

  const unlocated = await reportArktsGradeTransitions({ ...options, graderOutput: undefined });
  assert.equal(unlocated.comparedPairs, 0);
  assert.equal(unlocated.unavailableMatchedPairs, 30);
  assert.deepEqual(unlocated.pairs[0].unavailableArms, ['off', 'on']);
  await assert.rejects(reportArktsGradeTransitions({ ...options, graderOutput: pc.directory }), /separate from the campaign archive/u);

  const { id, repetition, arm } = pc.plan.schedule[0];
  const archiveFile = path.join(fixtureWorkerJob(graderOutput, 1), 'grading', 'candidate-coverage.log');
  await fs.appendFile(archiveFile, '\n');
  const tampered = await reportArktsGradeTransitions(options);
  assert.equal(tampered.comparedPairs, 29);
  assert.equal(tampered.unavailableMatchedPairs, 1);
  assert.equal(tampered.outcomes.GAIN_ONLY.pairs, 29);
  assert.deepEqual(tampered.pairs.filter(pair => pair.status === 'UNAVAILABLE'), [
    { id, repetition, status: 'UNAVAILABLE', reason: 'PINNED_GRADE_ARTIFACTS_UNAVAILABLE', unavailableArms: [arm] },
  ]);
  assert.doesNotMatch(JSON.stringify(tampered), /entry::Test::|private-worker-output|private fixture (?:native coverage|process output)/u);
});

test('counts token usage only for the phases with complete sealed measurements in both arms', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.phones, { pairs: 2, incompleteTokens: true, bothResolved: true });
  const report = await summarizeArktsPairedCohort(inputs);
  assert.equal(report.comparison.matchedScoredPairs, 2);
  assert.equal(report.comparison.transitions.bothResolved, 2);
  const totals = {
    document: { pairs: 2, off: 0, on: 60 },
    stop: { pairs: 1, off: 0, on: 40 },
    other: { pairs: 2, off: 200, on: 240 },
    total: { pairs: 1, off: 100, on: 190 },
  };
  assert.deepEqual(report.comparison.tokenUsage, { matched: totals, bothResolved: totals, attempted: totals });
  assert.deepEqual(report.arms.on.observedUsage.tokens.stop, { measuredTrials: 1, missingTrials: 1, sum: 40 });
  assert.deepEqual(report.arms.off.observedUsage.tokens.stop, { measuredTrials: 2, missingTrials: 0, sum: 0 });
  const trial = (id, arm) => report.trials.find(row => row.id === id && row.repetition === 1 && row.arm === arm);
  assert.deepEqual(trial(phoneTasks[1], 'on').tokens, { document: 30, stop: 40, other: 120, total: 190 });
  assert.deepEqual(trial(phoneTasks[1], 'off').tokens, { document: 0, stop: 0, other: 100, total: 100 });
  const partial = trial(phoneTasks[0], 'on').tokens;
  assert.deepEqual([partial.document, partial.stop ?? null, partial.other, partial.total ?? null], [30, null, 120, null]);
});

test('rejects usage and completion reasons rewritten in all observation copies', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.phones, { pairs: 1 });
  const { first, update } = await editFirstObservation(inputs.phones.directory);
  for (const change of [
    { providerRequests: first.providerRequests + 1 },
    { elapsedMs: first.elapsedMs + 1 },
    { usage: { ...first.usage, business: { ...first.usage.business, tokens: first.usage.business.tokens + 1 } } },
    { completionReason: 'PROVIDER_SCOPE_UNAVAILABLE' },
    { tokens: { document: 0, stop: 0, other: 501, total: 501 } },
  ]) {
    await update({ ...first, ...change });
    await assert.rejects(summarizeArktsPairedCohort(inputs), /Observed .* differs? from the sealed business result/u);
  }
  await update(first);
  const verified = await summarizeArktsPairedCohort(inputs);
  assert.equal(verified.comparison.matchedScoredPairs, 1);
});

test('cohort reports a recovered grade only with both immutable attempt receipts', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.phones);
  const { first, trial, update } = await editFirstObservation(inputs.phones.directory);
  const readCandidate = () => fs.readFile(path.join(trial, 'business/freeze/candidate.patch'));
  const binding = { patchSha256: first.patchSha256, businessResultSha256: first.businessResultSha256,
    comparisonIdentity: first.comparisonIdentity, calibrationSha256: digest(first.id) };
  await fs.rename(path.join(trial, 'grading'), path.join(trial, 'grading-retry'));
  const evidenceFile = path.join(trial, 'grading-evidence.json');
  const evidence = await read(evidenceFile);
  await write(evidenceFile, { ...evidence, attempt: 2 });
  const gradingEvidenceSha256 = await fileSha256(evidenceFile);
  const recovered = await gradePairedWithRetry({ directory: trial, binding, signal: new AbortController().signal,
    deadline: 2_430_000, now: () => 0, readCandidate, evaluate: async ({ retry }) => retry
      ? { gradingExecution: first.gradingExecution, score: first.score, gradingEvidenceSha256 }
      : { gradingExecution: { ...first.gradingExecution, exitCode: 0, reason: 'closed' }, score: null, gradingFailure: 'GRADE_RECEIPT_MISSING' } });
  assert(recovered.gradingRetry);
  const row = { ...first, ...recovered };
  await update(row);
  const verified = await summarizeArktsPairedCohort(inputs);
  assert.equal(verified.comparison.matchedScoredPairs, 9);
  const observation = verified.trials.find(trial => trial.id === first.id && trial.repetition === first.repetition && trial.arm === first.arm);
  assert.equal(observation.gradingRetried, true);
  const plan = await readArktsPairedGradeTransitionPlan({ ...inputs.phones, release });
  const pair = plan.pairs.find(pair => pair.id === first.id && pair.repetition === first.repetition);
  assert.equal(pair[first.arm].localGradeDirectory, path.join(path.relative(plan.root, await fs.realpath(trial)), 'grading-retry'));
  assert.equal(pair[first.arm].gradingEvidenceSha256, gradingEvidenceSha256);
  const secondAttempt = path.join(trial, 'grading-attempt-2.json');
  const secondBytes = await fs.readFile(secondAttempt);
  const second = JSON.parse(secondBytes);
  await write(evidenceFile, evidence);
  const wrongEvidenceSha256 = await fileSha256(evidenceFile);
  await write(secondAttempt, { ...second, outcome: { ...second.outcome, gradingEvidenceSha256: wrongEvidenceSha256 } });
  await update({ ...row, gradingEvidenceSha256: wrongEvidenceSha256,
    gradingRetry: { ...row.gradingRetry, secondSha256: await fileSha256(secondAttempt) } });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Independent grading evidence differs/u);
  await write(evidenceFile, { ...evidence, attempt: 2 });
  await fs.writeFile(secondAttempt, secondBytes);
  await update(row);
  await fs.appendFile(secondAttempt, '\n');
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Grading attempt receipt changed/u);
});

test('rejects valid-looking scores rewritten in all observation copies on either grading route', async t => {
  const inputs = await fixture(t);
  for (const shard of [inputs.phones, inputs.pc]) {
    await finishShard(shard, { pairs: 1 });
    const { first, update } = await editFirstObservation(shard.directory);
    assert.equal(first.arm, 'off');
    const verified = await summarizeArktsPairedCohort(inputs);
    const row = verified.trials.find(row => row.id === first.id && row.arm === 'off');
    assert.equal(row.status, 'SCORED');
    assert.deepEqual(row.gradingEvidence, { status: 'VERIFIED', route: shard === inputs.pc ? 'worker' : 'local',
      sha256: first.gradingEvidenceSha256 });
    await update({ ...first, score: { ...first.score, p2p: { total: 1, passed: 0 } } });
    await assert.rejects(summarizeArktsPairedCohort(inputs), /Independent grading evidence differs/u);
    await update(first);
  }
});

test('rejects changed sealed local grader artifacts and missing grading evidence', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.phones, { pairs: 1 });
  const { first, trial, update } = await editFirstObservation(inputs.phones.directory);
  assert.equal((await summarizeArktsPairedCohort(inputs)).comparison.matchedScoredPairs, 1);
  for (const relative of ['grading/results.json', 'grading/candidate.patch', 'grading/candidate-coverage.log', 'grading-evidence.json']) {
    const file = path.join(trial, relative);
    const original = await fs.readFile(file);
    await fs.appendFile(file, '\n');
    await assert.rejects(summarizeArktsPairedCohort(inputs), /(?:Archived evaluator files|Independent grading evidence) differ/u);
    await fs.writeFile(file, original);
  }
  const evidenceFile = path.join(trial, 'grading-evidence.json');
  const originalEvidence = await fs.readFile(evidenceFile);
  const score = { ...first.score, p2p: { total: 1, passed: 0 } };
  await write(evidenceFile, { ...JSON.parse(originalEvidence), score });
  await update({ ...first, score, gradingEvidenceSha256: await fileSha256(evidenceFile) });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Independent grading evidence differs/u);
  await fs.writeFile(evidenceFile, originalEvidence);
  const withoutEvidence = { ...first };
  delete withoutEvidence.gradingEvidenceSha256;
  await update(withoutEvidence);
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Missing independent grading evidence/u);
});

test('rejects a rehashed worker receipt bound to the wrong candidate, calibration or toolchain', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.pc, { pairs: 1 });
  const { first, trial, update } = await editFirstObservation(inputs.pc.directory);
  assert.equal((await summarizeArktsPairedCohort(inputs)).comparison.matchedScoredPairs, 1);
  const file = path.join(trial, 'grading-evidence.json');
  const evidence = await read(file);
  for (const key of ['candidateSha256', 'calibrationSha256', 'toolchainSha256']) {
    await write(file, { ...evidence, input: { ...evidence.input, [key]: digest(`wrong ${key}`) } });
    await update({ ...first, gradingEvidenceSha256: await fileSha256(file) });
    await assert.rejects(summarizeArktsPairedCohort(inputs), /Independent grading evidence differs/u);
  }
});

test('keeps legacy observations without counting grades that lack evaluator evidence', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.phones, { legacyGrades: true });
  const report = await summarizeArktsPairedCohort(inputs);
  const attempted = report.trials.filter(row => row.status !== 'NOT_STARTED');
  assert.equal(attempted.length, 18);
  assert(attempted.every(row => row.status === 'UNSCORED' && row.score === null
    && row.gradingEvidence?.status === 'LEGACY_UNSEALED_GRADE'
    && row.providerRequests === null && row.elapsedMs === null && row.tokens === undefined));
  assert.equal(report.shards.phones.status, 'COMPLETE_WITH_UNVERIFIED_GRADES');
  assert.equal(report.comparison.matchedScoredPairs, 0);
  assert.deepEqual(report.comparison.attemptedUsage.providerRequests, { pairs: 0, off: null, on: null });
  assert.equal(report.arms.on.passAt1, null);
  const plan = await readArktsPairedGradeTransitionPlan({ ...inputs.phones, release });
  assert.equal(plan.plannedPairs, 9);
  assert.deepEqual(plan.pairs, []);
  const transition = await reportArktsGradeTransitions({ ...inputs.phones, release });
  assert.deepEqual(Object.keys(transition.tasks), phoneTasks);
  for (const task of Object.values(transition.tasks)) {
    assert.equal(task.plannedPairs, 3);
    assert.equal(task.matchedScoredPairs, 0);
    assert.equal(task.comparedPairs, 0);
  }
});

test('preserves a claimed slot with no durable result and rejects altered snapshots', async t => {
  const inputs = await fixture(t);
  await assert.rejects(finishShard(inputs.phones, { throwOnSlot: 2 }), /fixture dispatch interruption/u);
  const partial = await summarizeArktsPairedCohort(inputs);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.shards.phones.status, 'ERROR');
  assert.equal(partial.comparison.bothAttemptedPairsMissingGrade, 1);
  const unsealed = partial.trials.find(row => row.status === 'UNSEALED');
  assert.equal(unsealed.score, null);
  assert.equal(unsealed.tokens, undefined);
  assert.deepEqual(partial.comparison.tokenUsage.attempted.total, { pairs: 0, off: null, on: null });
  assert.deepEqual(partial.arms.off.observedUsage.providerRequests, { measuredTrials: 1, missingTrials: 0, sum: 1 });
  assert.deepEqual(partial.arms.off.observedUsage.tokens.total, { measuredTrials: 1, missingTrials: 0, sum: 100 });
  assert.deepEqual(partial.arms.on.observedUsage.providerRequests, { measuredTrials: 0, missingTrials: 1, sum: null });
  const root = inputs.phones.directory;
  const business = path.join(root, 'trials', 'soduku-harmony_11', 'r1', 'off', 'business', 'result.json');
  const frozen = await read(business);
  for (const changed of [{ ...frozen, packageSha256: digest('wrong package') },
    { ...frozen, instance: { ...frozen.instance, baseCommit: 'e'.repeat(40) } }]) {
    await write(business, changed);
    await assert.rejects(summarizeArktsPairedCohort(inputs), /Business receipt bytes differ from the durable result/u);
  }
  await write(business, frozen);
  const patch = path.join(root, 'trials', 'soduku-harmony_11', 'r1', 'off', 'business', 'freeze', 'candidate.patch');
  const original = await fs.readFile(patch);
  await fs.writeFile(patch, 'altered candidate');
  await assert.rejects(summarizeArktsPairedCohort(inputs), /frozen business output/u);
  await fs.writeFile(patch, original);
  const { first, update } = await editFirstObservation(root);
  const result = path.join(root, 'observations', 'soduku-harmony_11-r1-off.result.json');
  await write(result, { ...first, providerRequests: 42 });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /differs from durable result/u);
  await update({ ...first, gradingExecution: { ...first.gradingExecution, exitCode: 42 } });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /Unsettled business or grading result/u);
  await update(first);
  const summary = path.join(root, 'summary.json');
  await write(summary, { ...await read(summary), status: 'CANCELLED' });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /differs from its terminal invocation/u);
});

test('rejects other releases, policies and assignments even if shard receipts are locally consistent', async t => {
  const inputs = await fixture(t);
  await finishShard(inputs.pc, { pairs: 1 });
  await finishShard(inputs.phones, { pairs: 1, policy: 'different RC policy' });
  await assert.rejects(summarizeArktsPairedCohort(inputs), /reviewer or policy differs/u);
  await assert.rejects(summarizeArktsPairedCohort({ ...inputs, release: { ...release, sourceCommit: 'e'.repeat(40) } }), /Shard release differs/u);
  const falsePC = await inputs.frozenPlan('wrong-route', [...pcTasks.slice(0, 9), phoneTasks[0]]);
  await assert.rejects(summarizeArktsPairedCohort({ ...inputs, pc: falsePC }), /Shard task pins/u);
});

test('fully scored shards with unmatched candidate identities leave passAt1 unavailable', async t => {
  const inputs = await fixture(t);
  await Promise.all([finishShard(inputs.pc), finishShard(inputs.phones, { mismatchedTree: true })]);
  const report = await summarizeArktsPairedCohort(inputs);
  assert.equal(report.status, 'PARTIAL');
  assert.equal(report.shards.phones.status, 'COMPLETE_WITH_UNMATCHED_TRIALS');
  assert.equal(report.comparison.scoredIdentityMismatches, 9);
  assert.equal(report.arms.on.scored, 39);
  assert.equal(report.arms.on.passAt1, null);
  assert.equal(report.shards.phones.arms.on.passAt1, null);
  const transition = await readArktsPairedGradeTransitionPlan({ ...inputs.phones, release });
  assert.equal(transition.plannedPairs, 9);
  assert.deepEqual(transition.pairs, []);
});
