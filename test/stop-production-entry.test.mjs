import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { ensureTask, taskDirectory, withTaskState, findTask, startCorrectionEpoch, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { stopFeedbackCurrent } from '../lib/runtime-v2/production-stop.mjs';
import { matchesEvidence } from '../lib/runtime-v2/evidence-state.mjs';

async function fixture(t, { verdict = "PASS", stop = {}, baselineFailure = null, expectedFile = null, startProtocol = null, classification, artifacts = [] } = {}) {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "stop-entry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "app.py"), "def convert(value): return int(value)\n");
  const transcript = path.join(root, "host-transcript.jsonl");
  await fs.writeFile(transcript, [
    { type: "user", uuid: "user-1", message: { role: "user", content: "Implement both frozen conversion obligations." } },
    { type: "assistant", uuid: "assistant-1", message: { id: "assistant-1", role: "assistant", content: "Implementation complete." } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const task = await ensureTask({ projectRoot: root, sessionId: "session" });
  const truth = { taskId: task.taskId, version: 1, digest: "frozen", claims: (expectedFile ? ['A'] : ["A", "B"]).map(id => ({ claimId: id,
    revisionId: `${id}@1`, category: "requirements", text: expectedFile ? `Deliver ${expectedFile}.` : `Frozen original conversion obligation ${id}`, authority: "USER_EXPLICIT",
    severity: "HARD", status: "ACTIVE", applicability: "CURRENT_TASK", applicabilityKind: "CURRENT_TASK", verificationTarget: expectedFile ? 'ARTIFACT' : "IMPLEMENTATION",
    ...(expectedFile ? { expectedFiles: [expectedFile] } : {}) })) };
  const truthPath = path.join(taskDirectory(root, task.taskId), "ground-truth/current.json");
  await fs.mkdir(path.dirname(truthPath), { recursive: true });
  await fs.writeFile(truthPath, JSON.stringify(truth));
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.groundTruth.version = 1; state.groundTruth.digest = "frozen"; });
  const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, "0")}`, i === (expectedFile ? 11 : 15)]));
  const document = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
    implementationCorrection: { enabled: false, platform: null },
    stopCorrection: { enabled: true, metrics, ...stop } };
  const runtimeV2 = compileRuntimeV2Config(document);
  const calls = [];
  const reviewerFactory = async input => {
    calls.push(input.role === "ground-truth-extractor" ? "baseline" : input.request.reviewScope.kind);
    if (input.role === "ground-truth-extractor") {
      if (baselineFailure) throw Object.assign(new Error(baselineFailure.message), {code:baselineFailure.code,reviewerRuntimeFailure:true});
      return { result: { summary: "Frozen requirements unchanged.", taskClassification: "NO_CHANGE", operations: [] }, close: async () => {} };
    }
    assert.equal(input.request.reviewScope.kind, "workspace-stop");
    return scriptedWorkspaceReview(input, { file: path.join(root, expectedFile ?? "app.py"), verdict, classification });
  };
  reviewerFactory.supportsReviewCollection = true;
  const directory = path.join(root, "stable-host-state");
  const options = { projectRoot: root, plan: { runtimeV2, artifacts, configuredArtifacts: artifacts }, reviewerFactory,
    stopHost: { directory, ...(startProtocol ? { startProtocol } : {}) } };
  const event = (hook, extras = {}) => handleRuntimeV2Event({ ...options, input: { session_id: "session", cwd: root,
    transcript_path: transcript, hook_event_name: hook, last_assistant_message: "Implementation complete.", ...extras } });
  return { root, directory, task, calls, event, document, runtimeV2, reviewerFactory, transcript };
}

test('proposal review followed by coding runs the complete production Stop under the same user flow and remaining quota', async t => {
  for (const deviationOnly of [true, false]) await t.test(deviationOnly ? 'no deviation at proposal' : 'empty proposal scope stays unverified', async t => {
    const classification = { stopClassification: 'STAGE_COMPLETE', stage: 'proposal' };
    const f = await fixture(t, { classification, stop: { deviationOnly }, startProtocol: { version: 1 },
      artifacts: [{ name: 'proposal', stage: 'proposal', metrics: [] }],
      verdict: () => classification.stopClassification === 'STAGE_COMPLETE' ? null : 'DEVIATION' });
    // A workflow with both a document delivery and production obligations.
    const truthPath = path.join(taskDirectory(f.root, f.task.taskId), 'ground-truth/current.json');
    const truth = JSON.parse(await fs.readFile(truthPath, 'utf8'));
    truth.claims.push({ ...truth.claims[0], claimId: 'proposal', revisionId: 'proposal@1', text: 'Deliver the requested proposal.', verificationTarget: 'ARTIFACT' });
    await fs.writeFile(truthPath, JSON.stringify(truth));
    await f.event('SessionStart', { source: 'startup' });
    const store = createStopCorrectionStore({ directory: f.directory }), flowId = sha256(['session', 'user-1']);
    // One earlier actual repair start must remain charged across the phase boundary.
    await store.beginStop({ sessionId: 'session', flowId, stopId: 'prior-repair', sourceInput: { origin: 'HUMAN', id: 'user-1' }, config: f.runtimeV2.stopCorrection });
    await store.bindReviewScope({ sessionId: 'session', stopId: 'prior-repair', scopeId: `${path.resolve(f.root)}:${f.task.taskId}`, classification });
    await store.settleReview({ sessionId: 'session', stopId: 'prior-repair', status: 'DEVIATION', currentDeviations: [{ objectId: 'prior', reason: 'Earlier repair.' }] });
    const prior = await store.reserveFeedback({ sessionId: 'session', stopId: 'prior-repair', packageId: 'prior', basisCurrent: async () => true });
    await store.observeStart({ sessionId: 'session', admissionId: prior.id, executionId: 'prior-run', observationId: 'prior-start', startedAt: Date.now() });
    await store.observeEnd({ sessionId: 'session', admissionId: prior.id, executionId: 'prior-run', endedAt: Date.now() });
    const proposal = await f.event('Stop');
    assert.equal(proposal.stop.status, deviationOnly ? 'NO_DEVIATION_FOUND' : 'UNVERIFIED', JSON.stringify(proposal.stop));
    if (!deviationOnly) assert.equal(proposal.stop.reasonCode, 'STOP_STAGE_METRICS_UNDECLARED');
    assert.equal(proposal.stop.review.stopClassification, 'STAGE_COMPLETE');
    const afterProposal = await store.inspect('session');
    assert.equal(afterProposal.flows[flowId].closedAt, undefined);
    assert.equal(afterProposal.stops['prior-repair'].control, deviationOnly ? 'ALLOW' : 'WAIT_REPAIR');
    assert.equal(afterProposal.stops['prior-repair'].reviewStatus, 'DEVIATION');
    assert.equal(afterProposal.admissions[prior.id].accounting, 'USED');
    classification.stopClassification = 'TASK_COMPLETE'; classification.stage = null;
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
    await fs.appendFile(f.transcript, JSON.stringify({ type: 'assistant', uuid: 'coding-done', message: { id: 'coding-done', role: 'assistant', content: 'Coding complete.' } }) + '\n');
    const coding = await f.event('Stop', { last_assistant_message: 'Coding complete.' });
    assert.equal(coding.stop.status, 'DEVIATION', JSON.stringify(coding.stop));
    assert.equal(coding.decision, 'block');
    assert.equal(coding.stop.review.stopClassification, 'TASK_COMPLETE');
    assert.equal(coding.stop.review.metricObjectJudgements.length, 2);
    assert.equal(coding.stop.review.collection.complete, true);
    assert.equal(f.calls.filter(call => call === 'workspace-stop').length, 2);
    const ledger = await store.inspect('session'), recorded = ledger.stops[coding.stop.stopCorrection.stopId];
    assert.equal(Object.keys(ledger.flows).length, 1);
    assert.equal(recorded.flowId, flowId);
    assert.equal(recorded.capacity.sessionUsed, 1);
    assert.equal(recorded.capacity.flowUsed, 1);
    assert.equal(recorded.capacity.sessionLimit, 3);
    assert.equal(recorded.capacity.flowLimit, 3);
    assert.equal(ledger.used, 1);
    assert.equal(ledger.flows[flowId].used, 1);
    assert.equal(ledger.admissions[coding.stop.admission.id].accounting, 'RESERVED');
  });
});

test('deviation-only Stop allows an empty scan and keeps existing repair feedback for cited deviations', async t => {
  for (const { enabled, verdict, status, decision } of [
    { enabled: false, verdict: () => null, status: 'UNVERIFIED', decision: 'allow' },
    { enabled: true, verdict: () => null, status: 'NO_DEVIATION_FOUND', decision: 'allow' },
    { enabled: true, verdict: (item, index) => index === 0 ? 'DEVIATION' : null, status: 'DEVIATION', decision: 'block' },
  ]) await t.test(`${enabled}: ${status}`, async subtest => {
    const f = await fixture(subtest, { verdict, stop: { deviationOnly: enabled }, startProtocol: { version: 1 } });
    validateProjectConfig(f.document, 'config.yaml');
    await f.event('SessionStart', { source: 'startup' });
    const result = await f.event('Stop');
    assert.equal(result.stop.status, status, result.stop.reasonCode);
    assert.equal(result.decision, decision);
    if (!enabled) return;
    assert.equal(result.stop.report.status, status);
    assert.equal(result.stop.review.collection.complete, true);
    assert.equal(result.stop.review.collection.totalObjects, 2);
    assert.equal(result.stop.review.metricObjectJudgements.length, decision === 'block' ? 1 : 0);
    const task = await findTask({ projectRoot: f.root, sessionId: 'session' });
    assert.equal(task.verification.status, status);
    const ledger = await createStopCorrectionStore({ directory: f.directory }).inspect('session');
    const recorded = ledger.stops[result.stop.stopCorrection.stopId];
    assert.equal(recorded.reviewStatus, status);
    if (decision === 'block') {
      assert.match(result.stop.feedback, /\[runtime-corrector:stop-feedback\]/u);
      assert(result.stop.admission);
      assert.equal((await stopFeedbackCurrent({ directory: f.directory, sessionId: 'session', projectRoot: f.root,
        taskId: f.task.taskId, deviations: recorded.currentDeviations })).length, 1);
    } else {
      assert.equal(result.stop.feedback, null);
      assert.equal(result.stop.admission, null);
      assert.equal(result.stop.verificationIncomplete, false);
    }
  });
});

test('missing output enters the production correction gate, then creation invalidates old feedback and a new Stop reviews the delivered file', async t => {
  const f = await fixture(t, { expectedFile: 'docs/report.md' });
  await f.event('SessionStart', { source: 'startup' });
  const event = stopId => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2: f.runtimeV2, artifacts: [] }, reviewerFactory: f.reviewerFactory,
    stopHost: { directory: f.directory, startProtocol: { version: 1 }, stopId },
    input: { session_id: 'session', cwd: f.root, transcript_path: f.transcript, hook_event_name: 'Stop', last_assistant_message: 'Task complete.' } });
  const first = await event('missing-output');
  assert.equal(first.stop.status, 'DEVIATION', JSON.stringify(first.stop));
  assert.equal(first.decision, 'block');
  assert.match(first.stop.feedback, /docs\/report.md/);
  assert(first.stop.admission);
  const store = createStopCorrectionStore({ directory: f.directory });
  const ledger = await store.inspect('session'), deviations = ledger.stops['missing-output'].currentDeviations;
  const feedback = () => stopFeedbackCurrent({ directory: f.directory, sessionId: 'session', projectRoot: f.root, taskId: f.task.taskId, deviations });
  assert.equal((await feedback()).length, 1);
  const prior = (await findTask({ projectRoot: f.root, sessionId: 'session' })).verification.evidence;
  assert.equal(await matchesEvidence(prior), true, 'Confirmed absence is valid evidence, not an unreadable dependency');
  await store.delivery({ sessionId: 'session', admissionId: first.stop.admission.id, status: 'DELIVERED' });
  await store.observeStart({ sessionId: 'session', admissionId: first.stop.admission.id, executionId: 'repair-output', observationId: 'repair-start', startedAt: Date.now() });
  await fs.mkdir(path.join(f.root, 'docs'));
  await fs.writeFile(path.join(f.root, 'docs/report.md'), 'The requested complete report.\n');
  await store.observeEnd({ sessionId: 'session', admissionId: first.stop.admission.id, executionId: 'repair-output', endedAt: Date.now() });
  assert.deepEqual(await feedback(), []);
  assert.equal(await matchesEvidence(prior), false);
  await fs.appendFile(f.transcript, JSON.stringify({ type: 'assistant', uuid: 'assistant-2', message: { id: 'assistant-2', role: 'assistant', content: 'The required file has been delivered.' } }) + '\n');
  const second = await event('output-delivered');
  assert.equal(second.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(second.stop));
  assert.equal(second.stop.admission, null);
  assert.equal((await store.inspect('session')).used, 1, 'Only the actual business start consumes correction quota');
});

test("project config accepts the v1.1 fields and compiles one canonical new Stop policy", async t => {
  const f = await fixture(t, { stop: { maxCorrectionsPerSession: 0, maxCorrectionsPerFlow: 0, reviewGroupSize: 1,
    assessmentTimeoutMs: 1200000, feedbackReserveMs: 180000 } });
  validateProjectConfig(f.document, "config.yaml");
  assert.equal(f.runtimeV2.stopCorrection.maxCorrectionsPerSession, 0);
  assert.equal(f.runtimeV2.stopCorrection.maxCorrectionsPerFlow, 0);
  assert.equal(f.runtimeV2.stopCorrection.reviewGroupSize, 1);
  assert.equal(Object.hasOwn(f.runtimeV2.stopCorrection, "maxCorrectionsPerEpoch"), false);
  assert.throws(() => validateProjectConfig({ ...f.document, stopCorrection: { ...f.document.stopCorrection, maxCorrectionsPerEpoch: 3 } }, "config.yaml"), /conflicts/);
});

test("the production Stop entry dispatches a real workspace task adapter and never increments usage while reviewing", async t => {
  const f = await fixture(t);
  await f.event("SessionStart", { source: "startup" });
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "NO_DEVIATION_FOUND", JSON.stringify(result.stop));
  assert.equal(result.decision, "allow");
  assert.equal(f.calls.filter(value => value === "workspace-stop").length, 1);
  assert.equal(result.stop.review.metricObjectJudgements.length, 2);
  assert.equal((await createStopCorrectionStore({ directory: f.directory }).inspect("session")).used, 0);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "session" })).stop.correctionAttempts, 0);
});

test('pending onboarding obligations invalidate an otherwise reusable completed Stop', async t => {
  const f = await fixture(t);
  await f.event('SessionStart', { source: 'startup' });
  assert.equal((await f.event('Stop')).stop.status, 'NO_DEVIATION_FOUND');
  const reviews = f.calls.filter(value => value === 'workspace-stop').length;
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => {
    state.groundTruth.onboardingPending = [{ status: 'UNVERIFIED', operationId: 'unwritten-output',
      operation: { operation: 'ADD', text: 'Deliver docs/guide.md.', expectedFiles: ['wrong.md'] } }];
  });
  const replay = await f.event('Stop');
  assert.equal(replay.stop.status, 'UNVERIFIED');
  assert.equal(replay.stop.reasonCode, 'STOP_REVIEW_STALE');
  assert.equal(f.calls.filter(value => value === 'workspace-stop').length, reviews);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: 'session' })).verification.status, 'UNVERIFIED');
});

test('pending onboarding obligations still run the Stop review, are listed separately and cap its PASS', async t => {
  const f = await fixture(t);
  await f.event('SessionStart', { source: 'startup' });
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => {
    state.groundTruth.onboardingPending = [{ status: 'UNVERIFIED', operationId: 'unwritten-output', reasonCode: 'GROUND_TRUTH_EXPECTED_FILES_INVALID',
      operation: { operation: 'ADD', text: 'Deliver docs/guide.md.', expectedFiles: ['wrong.md'] } }];
  });
  const result = await f.event('Stop');
  assert.equal(f.calls.filter(value => value === 'workspace-stop').length, 1);
  assert.equal(result.stop.status, 'UNVERIFIED', JSON.stringify(result.stop));
  assert.equal(result.stop.reasonCode, 'ONBOARDING_OPERATIONS_UNVERIFIED');
  assert.equal(result.decision, 'allow');
  assert.equal(result.stop.review.metricObjectJudgements.length, 2, 'the completed review remains visible');
  assert.deepEqual(result.stop.unverifiedObligations, [{ operationId: 'unwritten-output', status: 'UNVERIFIED',
    reasonCode: 'GROUND_TRUTH_EXPECTED_FILES_INVALID', text: 'Deliver docs/guide.md.' }]);
  assert.match(result.feedback, /unwritten-output \[GROUND_TRUTH_EXPECTED_FILES_INVALID\]: Deliver docs\/guide\.md\./u);
  const task = await findTask({ projectRoot: f.root, sessionId: 'session' });
  assert.equal(task.verification.status, 'UNVERIFIED'); assert.equal(task.verification.reasonCode, 'ONBOARDING_OPERATIONS_UNVERIFIED');
  assert.notEqual(task.status, 'COMPLETED');
  const replay = await f.event('Stop');
  assert.equal(replay.stop.status, 'UNVERIFIED');
  assert.equal(f.calls.filter(value => value === 'workspace-stop').length, 1, 'the capped review cannot be replayed as PASS');
});

test('unverified script document coverage rejects an older PASS and caps a fresh review to UNVERIFIED', async t => {
  const f = await fixture(t);
  await f.event('SessionStart', { source: 'startup' });
  assert.equal((await f.event('Stop')).stop.status, 'NO_DEVIATION_FOUND');
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => {
    state.documentCoverage = { status: 'UNVERIFIED', unverified: ['DOCUMENT_DECLARATION_UNRESOLVED'] };
  });
  const replay = await f.event('Stop');
  assert.equal(replay.stop.status, 'UNVERIFIED'); assert.equal(replay.stop.reasonCode, 'STOP_REVIEW_STALE');
  assert.equal(f.calls.filter(value => value === 'workspace-stop').length, 1);
  await fs.appendFile(f.transcript, [
    { type: 'user', uuid: 'user-2', message: { role: 'user', content: 'Regenerate the documents with the script.' } },
    { type: 'assistant', uuid: 'assistant-2', message: { id: 'assistant-2', role: 'assistant', content: 'The documents are complete.' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const fresh = await f.event('Stop', { last_assistant_message: 'The documents are complete.' });
  assert.equal(f.calls.filter(value => value === 'workspace-stop').length, 2, 'the review still runs');
  assert.equal(fresh.stop.status, 'UNVERIFIED', JSON.stringify(fresh.stop));
  assert.equal(fresh.stop.reasonCode, 'DOCUMENT_EXECUTION_UNVERIFIED');
  assert.deepEqual(fresh.stop.unverifiedBasis, ['DOCUMENT_EXECUTION_UNVERIFIED']);
  assert.match(fresh.feedback, /UNVERIFIED \(DOCUMENT_EXECUTION_UNVERIFIED\)/u);
  const task = await findTask({ projectRoot: f.root, sessionId: 'session' });
  assert.equal(task.verification.status, 'UNVERIFIED'); assert.equal(task.verification.reasonCode, 'DOCUMENT_EXECUTION_UNVERIFIED');
});

test("a failed baseline remains UNVERIFIED and delivers a checker notice without corrective admission",async t=>{
  const f=await fixture(t,{baselineFailure:{code:"REVIEWER_RUN_FAILED",message:"No callable tools"}});
  await f.event("SessionStart",{source:"startup"});
  const result=await f.event("Stop");
  assert.equal(result.stop.status,"UNVERIFIED");
  assert.equal(result.stop.reasonCode,"REVIEWER_RUN_FAILED");
  assert.match(result.stop.feedback,/UNVERIFIED/);
  assert.match(result.stop.feedback,/REVIEWER_RUN_FAILED/);
  assert.doesNotMatch(result.stop.feedback,/NO_CURRENT_DEVIATION/);
  assert.equal(result.stop.admission,undefined);
  assert(!f.calls.includes("workspace-stop"));
  assert.equal((await createStopCorrectionStore({directory:f.directory}).inspect("session")).used,0);
  const task=await findTask({projectRoot:f.root,sessionId:"session"});
  assert.equal(task.status,"STOPPED_UNVERIFIED");
  assert.equal(task.stop.infrastructureTotalFailures,3);assert.equal(f.calls.filter(call=>call==='baseline').length,3);
  assert.equal(task.verification.status,"UNVERIFIED");
});

test("Stop reviews a published implementation subset without accepting an unresolved refresh", async t => {
  const f = await fixture(t, { baselineFailure: { code: "BASELINE_COVERAGE_UNVERIFIED", message: "Unresolved new source" } });
  await f.event("SessionStart", { source: "startup" });
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "UNVERIFIED");
  assert.equal(result.stop.admission, undefined);
  const diagnostic = result.stop.partialImplementation;
  assert.equal(diagnostic.basis, "PREVIOUS_PUBLISHED_BASELINE", JSON.stringify(result.stop));
  assert.deepEqual(diagnostic.items.map(row => row.judgement), ["PASS", "PASS"]);
  const task = await findTask({ projectRoot: f.root, sessionId: "session" });
  assert.equal(task.groundTruth.version, 1);
  assert.equal(task.verification.status, "UNVERIFIED");
  await assert.rejects(fs.stat(path.join(taskDirectory(f.root, f.task.taskId), "metrics/population.json")), { code: "ENOENT" });
  assert.equal((await createStopCorrectionStore({ directory: f.directory }).inspect("session")).used, 0);
});

test("production entry checks zero budget before onboarding, baseline, classifier or group work", async t => {
  const f = await fixture(t, { stop: { maxCorrectionsPerFlow: 0 } });
  await f.event("SessionStart", { source: "startup" });
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "UNVERIFIED",'a budget-skipped review never presents a completed verification');
  assert.deepEqual(f.calls, []);
  assert.equal(result.stop.reasonCode, "FLOW_CORRECTION_LIMIT");
  assert.equal((await findTask({projectRoot:f.root,sessionId:'session'})).verification.status,'UNVERIFIED');
});

test("existing-session migration is explicit and performs no automatic model work", async t => {
  const f = await fixture(t);
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "UNVERIFIED");
  assert.equal(result.stop.reasonCode, "STOP_SESSION_MIGRATION_REQUIRED");
  assert.deepEqual(f.calls, []);
});

test("disabled Stop duties need neither historical quota initialization nor model work", async t => {
  const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, "0")}`, false]));
  const f = await fixture(t, { stop: { metrics } });
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "DISABLED");
  assert.deepEqual(f.calls, []);
  assert.equal(await createStopCorrectionStore({ directory: f.directory }).inspect("session"), null);
});

test("a host without a trustworthy start fence is explicitly unsupported for automatic correction and cannot spend quota", async t => {
  const f = await fixture(t, { verdict: "DEVIATION" });
  await f.event("SessionStart", { source: "startup" });
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "DEVIATION");
  assert.equal(result.stop.reasonCode, "HOST_START_PROTOCOL_UNSUPPORTED");
  assert.equal(result.decision, "allow");
  assert.equal(result.stop.admission, null);
  const state = await createStopCorrectionStore({ directory: f.directory }).inspect("session");
  assert.equal(state.used, 0);
  assert.equal(Object.keys(state.admissions).length, 0);
  assert.equal(Object.values(state.stops)[0].currentDeviations.length, 2);
});

test("a requirement epoch change preserves actual session and flow usage at the production entry", async t => {
  const f = await fixture(t);
  await f.event("SessionStart", { source: "startup" });
  const store = createStopCorrectionStore({ directory: f.directory });
  const flowId = sha256(["session", "user-1"]);
  await store.beginStop({ sessionId: "session", flowId, stopId: "prior-stop", sourceInput: { origin: "HUMAN", id: "user-1" }, config: f.runtimeV2.stopCorrection });
  await store.settleReview({ sessionId: "session", stopId: "prior-stop", status: "DEVIATION", currentDeviations: [{ objectId: "M16:A", basisKey: "prior" }] });
  const admission = await store.reserveFeedback({ sessionId: "session", stopId: "prior-stop", packageId: "prior-package", basisCurrent: async () => true });
  await store.observeStart({ sessionId: "session", admissionId: admission.id, executionId: "trusted-prior-execution", observationId: "trusted-start-event", startedAt: Date.now() });
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => { state.stop.correctionAttempts = 1; });
  await startCorrectionEpoch({ projectRoot: f.root, taskId: f.task.taskId, reason: "HARD_REQUIREMENT_CHANGED" });
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "session" })).stop.correctionAttempts, 1);
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "NO_DEVIATION_FOUND");
  const state = await store.inspect("session");
  assert.equal(state.used, 1);
  assert.equal(state.flows[flowId].used, 1);
  assert.equal(state.stops["prior-stop"].control, "ALLOW");
});

test("explicit read-only verification ignores exhausted automatic quota and creates no business admission", async t => {
  const f = await fixture(t, { stop: { maxCorrectionsPerFlow: 0 } });
  const task = await findTask({ projectRoot: f.root, sessionId: "session" });
  const input = { session_id: "session", cwd: f.root, transcript_path: path.join(f.root, "host-transcript.jsonl"), hook_event_name: "Stop", last_assistant_message: "Implementation complete." };
  const result = await handleRuntimeV2Event({ projectRoot: f.root, input, plan: { runtimeV2: f.runtimeV2, artifacts: [] },
    reviewerFactory: f.reviewerFactory, stopHost: { directory: f.directory },
    assessmentContext: { mode: "verify_only", assessmentId: "read-only-zero-quota", guard: decisionGuard(task) } });
  assert.equal(result.stop?.status, "NO_DEVIATION_FOUND", JSON.stringify(result));
  assert.equal(f.calls.filter(value => value === "workspace-stop").length, 1);
  assert.equal(await createStopCorrectionStore({ directory: f.directory }).inspect("session"), null);
});

test('production Stop forwards configured original Skill roots to its single reviewer', async t => {
  const f = await fixture(t), custom = path.join(path.dirname(f.root), 'external-original-skills');
  const runtimeV2 = compileRuntimeV2Config({ ...f.document, dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: false, skillRoots: [custom] } });
  let calls = 0;
  const result = await handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] },
    reviewerFactory: async input => { calls++; assert.equal(input.request.reviewScope.kind, 'workspace-stop');
      assert.deepEqual(input.skillRoots, [custom]); return f.reviewerFactory(input); },
    assessmentContext: { mode: 'verify_only', assessmentId: 'configured-original-skill-root' },
    input: { session_id: 'session', cwd: f.root, transcript_path: path.join(f.root, 'host-transcript.jsonl'), hook_event_name: 'Stop' } });
  assert.equal(result.stop.status, 'NO_DEVIATION_FOUND'); assert.equal(calls, 1);
});

test('program device verification does not build an unused whole-repository source inventory', async t => {
  const f = await fixture(t);
  const runtimeV2 = compileRuntimeV2Config({ ...f.document, dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    implementationCorrection: { enabled: true, platform: null },
    stopCorrection: { enabled: true, metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, '0')}`, i === 11])) } });
  const originalRead = fs.readdir; let rootScans = 0, deviceCalls = 0;
  fs.readdir = async (directory, ...args) => {
    if (path.resolve(directory) === f.root) { rootScans++; throw new Error('An unused source inventory must not walk the project root.'); }
    return originalRead(directory, ...args);
  };
  t.after(() => { fs.readdir = originalRead; });
  const result = await handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] },
    reviewerFactory: async input => {
      assert.equal(input.request.reviewScope.kind, 'workspace-stop');
      await input.onScope({ stopClassification: 'TASK_COMPLETE', stage: null });
      return { result: { summary: 'No execution proof in this controlled test.', stopClassification: 'TASK_COMPLETE', stage: null,
        findings: [], metricObjectJudgements: Object.values(input.request.population.metrics).flat().map(object => ({ objectId: object.objectId,
          judgement: 'UNVERIFIED', reason: 'This fixture checks program preparation only.', evidence: [] })) }, close() {} };
    },
    deviceVerifier: async input => { deviceCalls++; assert.equal(input.manifestDigest, undefined);
      return { build: { status: 'skipped' }, smoke: { status: 'skipped' }, findings: [] }; },
    assessmentContext: { mode: 'verify_only', assessmentId: 'no-unused-inventory' },
    input: { session_id: 'session', cwd: f.root, transcript_path: path.join(f.root, 'host-transcript.jsonl'), hook_event_name: 'Stop' } });
  assert.equal(rootScans, 0); assert.equal(deviceCalls, 1);
  assert.equal(result.stop.status, 'UNVERIFIED');
  assert.equal(result.stop.correctionAttempt, 0);
});
