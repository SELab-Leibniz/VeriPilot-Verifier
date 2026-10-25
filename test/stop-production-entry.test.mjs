import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { ensureTask, taskDirectory, withTaskState, findTask, startCorrectionEpoch, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";
import { runStopTaskGroup } from "../lib/runtime-v2/stop-task-group.mjs";
import { observedTaskResult } from "./helpers/observed-review.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t, { verdict = "PASS", stop = {} } = {}) {
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
  const truth = { taskId: task.taskId, version: 1, digest: "frozen", claims: ["A", "B"].map(id => ({ claimId: id,
    revisionId: `${id}@1`, category: "requirements", text: `Frozen original conversion obligation ${id}`, authority: "USER_EXPLICIT",
    severity: "HARD", status: "ACTIVE", applicability: "CURRENT_TASK", applicabilityKind: "CURRENT_TASK", verificationTarget: "IMPLEMENTATION" })) };
  const truthPath = path.join(taskDirectory(root, task.taskId), "ground-truth/current.json");
  await fs.mkdir(path.dirname(truthPath), { recursive: true });
  await fs.writeFile(truthPath, JSON.stringify(truth));
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.groundTruth.version = 1; state.groundTruth.digest = "frozen"; });
  const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, "0")}`, i === 15]));
  const document = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
    implementationCorrection: { enabled: false, platform: null },
    stopCorrection: { enabled: true, metrics, ...stop } };
  const runtimeV2 = compileRuntimeV2Config(document);
  const calls = [];
  const reviewerFactory = async input => {
    calls.push(input.role === "ground-truth-extractor" ? "baseline" : input.request.reviewScope.kind);
    if (input.role === "ground-truth-extractor") return { result: { summary: "Frozen requirements unchanged.", taskClassification: "NO_CHANGE", operations: [] }, close: async () => {} };
    if (input.request.reviewScope.kind === "classification") return { result: { summary: "Declared completion.", stopClassification: "TASK_COMPLETE", stage: null, findings: [], metricObjectJudgements: [] }, close: async () => {} };
    assert.equal(input.request.reviewScope.kind, "stop-group");
    return runStopTaskGroup(input, { runTask: async options => {
      for (const task of options.tasks) await options.onItemResult(await observedTaskResult({ ...options, task }, { file: "project/app.py", verdict }));
      return { completed: true };
    } });
  };
  reviewerFactory.supportsReviewCollection = true;
  reviewerFactory.supportsStopGroups = true;
  const directory = path.join(root, "stable-host-state");
  const options = { projectRoot: root, plan: { runtimeV2, artifacts: [] }, reviewerFactory, stopHost: { directory } };
  const event = (hook, extras = {}) => handleRuntimeV2Event({ ...options, input: { session_id: "session", cwd: root,
    transcript_path: transcript, hook_event_name: hook, last_assistant_message: "Implementation complete.", ...extras } });
  return { root, directory, task, calls, event, document, runtimeV2, reviewerFactory };
}

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

test("the production Stop entry dispatches a real composite SDK adapter and never increments usage while reviewing", async t => {
  const f = await fixture(t);
  await f.event("SessionStart", { source: "startup" });
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "PASS", JSON.stringify(result.stop));
  assert.equal(result.decision, "allow");
  assert.equal(f.calls.filter(value => value === "stop-group").length, 1);
  assert.equal(result.stop.review.metricObjectJudgements.length, 2);
  assert.equal((await createStopCorrectionStore({ directory: f.directory }).inspect("session")).used, 0);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "session" })).stop.correctionAttempts, 0);
});

test("production entry checks zero budget before onboarding, baseline, classifier or group work", async t => {
  const f = await fixture(t, { stop: { maxCorrectionsPerFlow: 0 } });
  await f.event("SessionStart", { source: "startup" });
  const result = await f.event("Stop");
  assert.equal(result.stop.status, "SKIPPED");
  assert.deepEqual(f.calls, []);
  assert.equal(result.stop.reasonCode, "FLOW_CORRECTION_LIMIT");
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
  assert.equal(result.stop.status, "PASS");
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
  assert.equal(result.stop?.status, "PASS", JSON.stringify(result));
  assert.equal(f.calls.filter(value => value === "stop-group").length, 1);
  assert.equal(await createStopCorrectionStore({ directory: f.directory }).inspect("session"), null);
});
