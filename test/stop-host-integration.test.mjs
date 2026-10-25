import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOpenClawRuntime } from "../lib/openclaw/runtime.mjs";
import { createNativeStopChains } from "../lib/openclaw/native-stop-chain.mjs";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";
import { ensureTask, taskDirectory, withTaskState, findTask } from "../lib/runtime-v2/task-store.mjs";
import { runStopTaskGroup } from "../lib/runtime-v2/stop-task-group.mjs";
import { readReport } from "../lib/openclaw/report.mjs";
import { admittedProjectScopes } from "./support/openclaw-project-scope.mjs";
import { observedTaskResult } from "./helpers/observed-review.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("native queue acknowledgement cannot suspend the admission deadline", async () => {
  const state = { projectRoot: "project", sessionId: "session", sessionKey: "key" };
  const chains = createNativeStopChains();
  const chain = chains.begin({ state, runId: "first", taskId: "task", budgetMs: 80 });
  chain.link("first", { runId: "child", taskId: "task" });
  chain.assessed({ runId: "first", reviewStatus: "DEVIATION", followupStatus: "ADMITTED" });
  assert.equal(chain.record.phase, "WAIT_START");
  assert.equal((await chain.released).reasonCode, "STOP_WAIT_DEADLINE_EXPIRED");
});

test("native repair outlives its first review window and the next Stop gets a fresh window", async t => {
  const state = { projectRoot: "project", sessionId: "session", sessionKey: "key" };
  const chains = createNativeStopChains();
  const chain = chains.begin({ state, runId: "first", taskId: "task", budgetMs: 100 });
  t.after(() => chain.cancel("TEST_FINISHED"));
  chain.link("first", { runId: "child", taskId: "task" });
  chain.observeStart("child");
  chain.assessed({ runId: "first", reviewStatus: "DEVIATION", followupStatus: "ADMITTED" });
  await pause(150);
  assert.equal(chain.pending, true);
  assert.equal(chain.record.deadlineAt, null);
  assert.equal(chain.record.phase, "CORRECTING");
  assert.equal(chains.begin({ state, runId: "child", taskId: "task", budgetMs: 200 }), chain);
  assert.equal(chain.record.phase, "REVIEWING");
  assert(chain.record.deadlineAt > Date.now() + 100);
  chain.assessed({ runId: "child", reviewStatus: "PASS", evaluationId: "child-pass" });
  assert.equal((await chain.released).evaluationId, "child-pass");
  assert.equal(chain.pending, false);
  chain.observeStart("child");
  assert.equal(chain.pending, false, "late observations cannot reopen a released wait");
});

async function nativeFixture(t, verdict = "PASS", { startProtocol = false, waitMode = "until_pass" } = {}) {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "native-new-stop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, ".runtime-corrector");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.yaml"), `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  panel:
    size: 0
implementationCorrection:
  enabled: false
  platform: null
stopCorrection:
  enabled: true
  assessmentTimeoutMs: 10000
  feedbackReserveMs: 1000
  waitMode: ${waitMode}
  metrics:
${Array.from({ length: 16 }, (_, i) => `    M${String(i + 1).padStart(2, "0")}: ${i === 15}`).join("\n")}
`);
  await fs.writeFile(path.join(root, "app.py"), "def convert(value): return int(value)\n");
  const transcript = path.join(root, "host.jsonl");
  await fs.writeFile(transcript, [
    { type: "session", id: "session" },
    { type: "message", id: "human", parentId: null, message: { role: "user", content: "Implement both conversion obligations." } },
    { type: "message", id: "answer", parentId: "human", message: { role: "assistant", content: "Implementation complete." } },
  ].map(JSON.stringify).join("\n") + "\n");
  const task = await ensureTask({ projectRoot: root, sessionId: "session" });
  const truth = { taskId: task.taskId, version: 1, digest: "frozen", claims: ["A", "B"].map(id => ({ claimId: id,
    revisionId: `${id}@1`, category: "requirements", text: `Frozen original conversion obligation ${id}`, authority: "USER_EXPLICIT",
    severity: "HARD", status: "ACTIVE", applicability: "CURRENT_TASK", applicabilityKind: "CURRENT_TASK", verificationTarget: "IMPLEMENTATION" })) };
  const truthFile = path.join(taskDirectory(root, task.taskId), "ground-truth/current.json");
  await fs.mkdir(path.dirname(truthFile), { recursive: true });
  await fs.writeFile(truthFile, JSON.stringify(truth));
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => {
    state.groundTruth.version = 1; state.groundTruth.digest = truth.digest;
    state.correctionBarrier.turnActivated = true;
  });
  const calls = [];
  let currentVerdict = verdict;
  const factory = async input => {
    calls.push(input.role === "ground-truth-extractor" ? "baseline" : input.request.reviewScope.kind);
    if (input.role === "ground-truth-extractor") return { result: { summary: "Unchanged.", taskClassification: "NO_CHANGE", operations: [] }, close() {} };
    if (input.request.reviewScope.kind === "classification") return { result: { summary: "Done.", stopClassification: "TASK_COMPLETE", stage: null, findings: [], metricObjectJudgements: [] }, close() {} };
    assert.equal(input.request.reviewScope.kind, "stop-group");
    return runStopTaskGroup(input, { runTask: async options => {
      for (const member of options.tasks) await options.onItemResult(await observedTaskResult({ ...options, task: member }, { file: "project/app.py", verdict: currentVerdict }));
      return { completed: true };
    } });
  };
  factory.supportsStopGroups = true;
  const warnings = [];
  const starts = new Set(), dispatches = [], aborts = [];
  const sharedState = {};
  const api = { id: "runtime-corrector", config: {}, pluginConfig: {}, logger: { warn: text => warnings.push(text) }, runtime: {
    state: { resolveStateDir: () => path.join(root, "host-state") },
    agent: { session: { getSessionEntry: async () => ({ sessionId: "session", sessionFile: transcript }),
      resolveStorePath: () => path.join(root, "sessions.json"), resolveSessionFilePath: () => transcript,
      runWithWorkAdmission: async (params, run) => run(params.signal) } },
    ...(startProtocol ? { gateway: { request: async (method, params) => { aborts.push({ method, params }); return { aborted: true }; } } } : {}),
    subagent: { run: async request => {
      assert(startProtocol, "No old-protocol business continuation is allowed");
      dispatches.push(request); return { runId: request.idempotencyKey, status: "accepted" };
    } },
  } };
  const runtime = createOpenClawRuntime(api, { pluginRoot: path.resolve("."), reviewerFactory: factory,
    nativeHooks: true, sharedState, projectScopes: admittedProjectScopes(api), compatibility: async () => ({}),
    ...(startProtocol ? { stopStartCompatibility: async () => ({ version: 1,
      onStart: callback => { starts.add(callback); return () => starts.delete(callback); }, drain: async () => {}, diagnosticsEnabled: () => true }) } : {}) });
  t.after(() => runtime.dispose());
  const ctx = { agentId: "main", sessionId: "session", sessionKey: "agent:main:test", workspaceDir: root, runId: "business-run" };
  const start = async fields => runtime.sessionStart({ sessionId: "session", ...fields }, ctx);
  const stop = async () => {
    await runtime.beforeTool({ toolName: "write", toolCallId: "written", params: { path: "app.py" } }, ctx);
    await runtime.reply({ kind: "final", sessionKey: ctx.sessionKey, runId: ctx.runId, payload: { text: "Implementation complete." } }, ctx);
    return (await runtime.waitForNativeReviews({ drain: true }))[0];
  };
  const store = createStopCorrectionStore({ directory: path.join(root, "host-state/runtime-corrector-stop-sessions") });
  return { root, ctx, task, start, stop, calls, warnings, store, sharedState, runtime, transcript, dispatches, aborts, api,
    setVerdict: value => { currentVerdict = value; }, emitStart: (event, metadata = { trusted: true }) => {
      for (const callback of starts) callback({ type: "model.call.started", sessionId: "session", sessionKey: ctx.sessionKey, agentId: "main", seq: 1, ...event }, metadata);
    } };
}

test("native reply runs the new groups and publishes a fresh PASS with independently checked source hashes", async t => {
  const f = await nativeFixture(t);
  await f.start();
  const record = await f.stop();
  assert.equal(record.reviewStatus, "PASS", JSON.stringify({ record, warnings: f.warnings }));
  assert.equal(f.calls.filter(kind => kind === "stop-group").length, 1);
  const binding = { workspaceDir: f.root, sessionId: f.ctx.sessionId, sessionKey: f.ctx.sessionKey };
  assert.equal((await readReport(binding)).verification, "PASS");
  await fs.writeFile(path.join(f.root, "app.py"), "def convert(value): return 0\n");
  assert.equal((await readReport(binding)).verification, "STALE");
  assert.equal((await f.store.inspect("session")).used, 0);
});

test("native unsupported start bridge releases its chain with the confirmed deviation and no legacy dispatch", async t => {
  const f = await nativeFixture(t, "DEVIATION");
  await f.start();
  const record = await f.stop();
  assert.equal(record.reviewStatus, "DEVIATION", JSON.stringify({ record, warnings: f.warnings }));
  assert.equal(record.reasonCode, "HOST_START_PROTOCOL_UNSUPPORTED");
  assert.equal([...f.sharedState.stopWaitChains.values()][0].pending, false);
  assert.equal((await f.store.inspect("session")).used, 0);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "session" })).stop.correctionAttempts, 0);
});

test("native resumed SessionStart never declares an unrecorded historical session new", async t => {
  const f = await nativeFixture(t);
  await f.start({ resumedFrom: "existing-session" });
  assert.equal(await f.store.inspect("session"), null);
});

test("MA first input gate can verify empty full host history when sessions.create omitted session_start", async t => {
  const f = await nativeFixture(t);
  f.api.runtime.version = "2026.7.1-2";
  await fs.writeFile(f.transcript, [
    { type: "session", id: "session", timestamp: new Date().toISOString() },
    { type: "model_change", id: "model", parentId: null, provider: "controlled", modelId: "test" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "off" },
    { type: "custom", id: "snapshot", parentId: "thinking", customType: "model-snapshot", data: {} },
  ].map(JSON.stringify).join("\n") + "\n");
  await f.runtime.beforeAgentRun({ prompt: "First controlled business input.", messages: [] }, f.ctx);
  const ledger = await f.store.inspect("session");
  assert.equal(ledger.initialization.kind, "VERIFIED_HISTORY");
  assert.equal(ledger.initialization.evidence.kind, "EMPTY_HOST_EXECUTION_HISTORY");
  assert.equal(ledger.used, 0);
});

test("MA input gate cannot initialize unknown history from an existing transcript or an empty task counter", async t => {
  const f = await nativeFixture(t);
  f.api.runtime.version = "2026.7.1-2";
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "another-human", parentId: "answer",
    message: { role: "user", content: "A later task in an existing session." } }) + "\n");
  await f.runtime.beforeAgentRun({ prompt: "Resume existing business.", messages: [] }, f.ctx);
  assert.equal(await f.store.inspect("session"), null);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "session" })).stop.correctionAttempts, 0);
});

async function enterContinuation(f) {
  const request = f.dispatches[0], runId = request.idempotencyKey;
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "feedback", parentId: "answer",
    message: { role: "user", content: request.message, idempotencyKey: runId } }) + "\n");
  const ctx = { ...f.ctx, runId };
  const prepared = await f.runtime.prompt({ prompt: request.message }, ctx);
  const gate = await f.runtime.beforeAgentRun({ prompt: `${prepared?.prependContext ?? ""}\n${request.message}`, messages: [] }, ctx);
  return { ctx, gate, prepared };
}

test("MatrixAssistant start protocol counts the observed execution once and a subsequent grouped PASS releases the whole chain", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start();
  const first = await f.stop();
  assert.equal(first.reviewStatus, "DEVIATION", JSON.stringify({ first, warnings: f.warnings }));
  assert.equal(f.dispatches.length, 1);
  assert.equal((await f.store.inspect("session")).used, 0, "API acceptance is only a reservation");
  assert(!f.dispatches[0].message.includes("M16:"), "native user message contains no stale counterevidence");
  const { ctx, gate, prepared } = await enterContinuation(f);
  assert.match(prepared.prependContext, /M16:/);
  assert.equal(gate.outcome, "pass");
  assert.equal((await f.store.inspect("session")).used, 0, "delivery and gate approval are not execution");
  const actualStart = Date.now();
  f.emitStart({ runId: ctx.runId, ts: actualStart });
  f.emitStart({ runId: ctx.runId, ts: actualStart + 1, seq: 2 });
  await f.sharedState.stopStartProtocol.drain();
  assert.equal((await f.store.inspect("session")).used, 1);
  assert.equal([...f.sharedState.stopWaitChains.values()][0].record.phase, "CORRECTING");
  f.setVerdict("PASS");
  await fs.writeFile(path.join(f.root, "app.py"), "def convert(value): return int(str(value))\n");
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "repaired", parentId: "feedback",
    message: { role: "assistant", content: "Implementation complete." } }) + "\n");
  await f.runtime.agentEnd({ runId: ctx.runId, success: true, messages: [{ role: "assistant", content: "Implementation complete." }] }, ctx);
  const records = await f.runtime.waitForNativeReviews({ drain: true });
  assert.equal(records.at(-1).reviewStatus, "PASS", JSON.stringify({ records, warnings: f.warnings }));
  const ledger = await f.store.inspect("session");
  assert.equal(ledger.used, 1);
  assert.equal(Object.keys(ledger.flows).length, 1, "plugin feedback must not mint a human-input flow");
  assert(Object.values(ledger.stops).every(stop => stop.releasedAt !== undefined));
  assert.equal(f.dispatches.length, 1);
});

test("untrusted model events cannot charge a queued native continuation and expiry blocks its later gate", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start(); await f.stop();
  const runId = f.dispatches[0].idempotencyKey;
  f.emitStart({ runId, ts: Date.now() }, { trusted: false });
  await f.sharedState.stopStartProtocol.drain();
  assert.equal((await f.store.inspect("session")).used, 0);
  const ledger = await f.store.inspect("session"), stop = Object.values(ledger.stops)[0];
  await f.store.expireStop({ sessionId: "session", stopId: stop.id, force: true, reasonCode: "TEST_START_DEADLINE" });
  const { gate } = await enterContinuation(f);
  assert.equal(gate.outcome, "block");
  assert.equal((await f.store.inspect("session")).used, 0);
  const chains = createNativeStopChains(f.sharedState.stopWaitChains, f.sharedState.stopWaitRunOwners);
  const currentState = f.sharedState.states.get("main:session");
  const unrelated = chains.begin({ state: currentState, runId: "new-independent-run", taskId: f.task.taskId, budgetMs: 30000 });
  t.after(() => unrelated.cancel("TEST_FINISHED"));
  f.emitStart({ runId, ts: Date.now() });
  await f.sharedState.stopStartProtocol.drain();
  assert.equal((await f.store.inspect("session")).used, 1, "a host protocol violation is still an actual execution");
  assert(f.aborts.some(call => call.method === "chat.abort" && call.params.runId === runId));
  assert(f.aborts.every(call => call.params.runId && call.params.preserveSideRuns === true));
  assert.equal(unrelated.pending, true, "a late old start must not cancel a new independent waiting chain");
});

test("assessment waits for checked feedback delivery rather than API queue acceptance", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true, waitMode: "assessment" });
  await f.start();
  let settled = false;
  const stopping = f.stop().then(record => { settled = true; return record; });
  for (let tries = 0; !f.dispatches.length && tries < 100; tries++) await pause(20);
  assert.equal(f.dispatches.length, 1);
  await pause(50);
  assert.equal(settled, false);
  await enterContinuation(f);
  const record = await stopping;
  assert.equal(record.reviewStatus, "DEVIATION");
  const ledger = await f.store.inspect("session");
  assert.equal(Object.values(ledger.stops)[0].releaseReason, "ASSESSMENT_DELIVERED");
  assert.equal(ledger.used, 0);
});
