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
  assert(chain.record.deadlineAt > Date.now(), "repair has an independent watchdog, not the expired review window");
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

async function nativeFixture(t, verdict = "PASS", { startProtocol = false, waitMode = "until_pass", finalizeReviewWaitMs = 0, maxCorrections = 3, compatibility = async () => ({ emitAgentEvent() {}, markDiagnosticSessionProgress() {} }), reviewWait } = {}) {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "native-new-stop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
  maxCorrectionsPerFlow: ${maxCorrections}
  maxCorrectionsPerSession: ${maxCorrections}
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
    await reviewWait?.();
    return runStopTaskGroup(input, { runTask: async options => {
      for (const member of options.tasks) await options.onItemResult(await observedTaskResult({ ...options, task: member }, { file: "project/app.py", verdict: currentVerdict }));
      return { completed: true };
    } });
  };
  factory.supportsStopGroups = true;
  const warnings = [];
  const starts = new Set(), dispatches = [], aborts = [];
  const sharedState = {};
  const api = { id: "runtime-corrector", config: {}, pluginConfig: { finalizeReviewWaitMs }, logger: { warn: text => warnings.push(text) }, runtime: {
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
  const projectScopes = admittedProjectScopes(api);
  const runtime = createOpenClawRuntime(api, { pluginRoot: path.resolve("."), reviewerFactory: factory,
    nativeHooks: true, sharedState, projectScopes, compatibility,
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
  return { root, ctx, task, start, stop, calls, warnings, store, sharedState, runtime, transcript, dispatches, aborts, api, projectScopes,
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

test('an unpublished native assessment closes honestly with a reason and an actual MA notice',async t=>{
  let release,started;const ready=new Promise(resolve=>{started=resolve;});
  const f=await nativeFixture(t,'PASS',{reviewWait:async()=>{started();await new Promise(resolve=>{release=resolve;});}});
  const notices=[];f.api.runtime.gateway={request:async(method,params)=>{notices.push({method,params});return {id:'notice'};}};
  await f.start();
  await f.runtime.beforeTool({toolName:'read',toolCallId:'read-source',params:{path:'app.py'}},f.ctx);
  const stopping=f.stop();await ready;
  await fs.writeFile(path.join(f.root,'app.py'),'def convert(value): return int(value) + 1\n');release();
  await stopping;await f.runtime.waitForNativeReviews({drain:true,settle:true});
  const task=await findTask({projectRoot:f.root,sessionId:'session'});
  assert.equal(task.status,'STOPPED_UNVERIFIED');assert.equal(task.verification.status,'UNVERIFIED');
  assert.equal(task.verification.reasonCode,'STOP_ASSESSMENT_EVIDENCECHANGED');
  assert.equal((await f.store.inspect('session')).used,0);
  assert.equal(notices.filter(value=>value.method==='chat.inject').length,1);
  assert.match(notices.find(value=>value.method==='chat.inject').params.message,/UNVERIFIED.*STOP_ASSESSMENT_EVIDENCECHANGED/su);
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

async function enterContinuation(f, parentId = "answer") {
  const request = f.dispatches[0], runId = request.idempotencyKey;
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "feedback", parentId,
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

async function armFinalize(f) {
  await f.start();
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "written", params: { path: "app.py" } }, f.ctx);
  return { sessionId: "session", runId: f.ctx.runId, lastAssistantMessage: "Implementation complete." };
}

async function settlePrepared(f) {
  await f.sharedState.states.get("main:session").nativePreparingStop;
  return f.runtime.waitForNativeReviews({ drain: true, settle: true });
}

for (const race of [false, true]) test(`an old failed terminal cannot cancel a new run${race ? " admitted during the scope read" : " already admitted"}`, async t => {
  const f = await nativeFixture(t), event = await armFinalize(f);
  const state = f.sharedState.states.get("main:session");
  state.nativeFinalizeHandledRun = event.runId;
  let ending, release, entered;
  if (race) {
    const arrived = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const resolveScope = f.projectScopes.resolve;
    let first = true;
    f.projectScopes.resolve = async (...args) => {
      if (first) { first = false; entered(); await pending; }
      return resolveScope(...args);
    };
    ending = f.runtime.agentEnd({ ...event, success: false }, f.ctx);
    await arrived;
  }
  const ctx = { ...f.ctx, runId: "new-business-run" };
  await f.runtime.prompt({ prompt: "A new task." }, ctx);
  const controller = state.reviewController;
  const chain = createNativeStopChains(f.sharedState.stopWaitChains, f.sharedState.stopWaitRunOwners)
    .begin({ state, runId: ctx.runId, taskId: f.task.taskId, budgetMs: 5000 });
  t.after(() => chain.cancel("TEST_FINISHED"));
  if (race) { release(); await ending; }
  else await f.runtime.agentEnd({ ...event, success: false }, f.ctx);
  assert.equal(state.nativeRunId, ctx.runId);
  assert.equal(state.reviewController, controller);
  assert.equal(controller.signal.aborted, false);
  assert.equal(chain.pending, true);
  assert.notEqual(state.nativeEndedRun, event.runId);
});

test("a late handoff rejection cannot expire a newer run's waiting chain", async t => {
  const f = await nativeFixture(t), event = await armFinalize(f);
  const state = f.sharedState.states.get("main:session");
  state.nativeFinalizeHandledRun = event.runId;
  let reject;
  state.nativePendingStop = { runId: event.runId, handoff: new Promise((_, fail) => { reject = fail; }) };
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  const ctx = { ...f.ctx, runId: "new-business-run" };
  await f.runtime.prompt({ prompt: "A new task." }, ctx);
  const controller = state.reviewController;
  const chain = createNativeStopChains(f.sharedState.stopWaitChains, f.sharedState.stopWaitRunOwners)
    .begin({ state, runId: ctx.runId, taskId: f.task.taskId, budgetMs: 5000 });
  t.after(() => chain.cancel("TEST_FINISHED"));
  reject(new Error("old handoff failed"));
  await pause(20);
  assert.equal(controller.signal.aborted, false);
  assert.equal(chain.pending, true);
});

test("a terminal awaiting its receipt cannot abort a replacement controller with the same run ID", async t => {
  const f = await nativeFixture(t), event = await armFinalize(f);
  const state = f.sharedState.states.get("main:session");
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.sharedState.stopStartProtocol.findRun = async () => { entered(); await pending; return null; };
  const ending = f.runtime.agentEnd({ ...event, success: false }, f.ctx);
  await arrived;
  const controller = new AbortController();
  state.reviewController = controller; state.abortSignal = controller.signal;
  const chain = createNativeStopChains(f.sharedState.stopWaitChains, f.sharedState.stopWaitRunOwners)
    .begin({ state, runId: event.runId, taskId: f.task.taskId, budgetMs: 5000 });
  t.after(() => chain.cancel("TEST_FINISHED"));
  release(); await ending;
  assert.equal(controller.signal.aborted, false);
  assert.equal(chain.pending, true);
});

for (const fault of ["missing", "throw", "hang", "heartbeat"]) test(`host keepalive ${fault} releases the waiter as UNVERIFIED`, async t => {
  const later = fault === "heartbeat";
  let finish, fail = !later;
  const blocked = new Promise(resolve => { finish = resolve; });
  const f = await nativeFixture(t, "PASS", { reviewWait: () => blocked, compatibility: async () => ({
    emitAgentEvent() {}, markDiagnosticSessionProgress: fault === "missing" ? undefined : () => {
      if (!fail) return;
      if (fault === "hang") return new Promise(() => {});
      throw new Error("watchdog unavailable");
    },
  }) });
  const event = await armFinalize(f);
  await f.runtime.beforeFinalize(event, f.ctx);
  await f.sharedState.states.get("main:session").nativePreparingStop;
  if (later) t.mock.timers.enable({ apis: ["setInterval"] });
  const hostAbort = new AbortController();
  const waiting = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {
    ...f.ctx, runId: "ordinary-waiter", abortSignal: hostAbort.signal,
  });
  if (later) { await pause(20); fail = true; t.mock.timers.tick(30000); }
  try {
    const released = await Promise.race([waiting.then(() => true), pause(1500).then(() => false)]);
    assert.equal(released, true, "keepalive loss must not leave the host waiting for the review deadline");
    assert.equal(hostAbort.signal.aborted, false);
    const chain = [...f.sharedState.stopWaitChains.values()][0];
    assert.equal(chain.pending, false);
    assert.equal(chain.record.reviewStatus, "UNVERIFIED");
    assert.equal(chain.record.reasonCode, "RC_STOP_KEEPALIVE_UNAVAILABLE");
  } finally { finish(); }
  const records = await settlePrepared(f);
  assert.equal(records.at(-1).reviewStatus, "UNVERIFIED", "late PASS cannot reopen the failed chain");
  assert.equal(records.at(-1).reasonCode, "RC_STOP_KEEPALIVE_UNAVAILABLE");
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "session" })).verification.status, "UNVERIFIED");
  assert.equal(f.dispatches.length, 0);
});

test("a virtual clock keeps queued input waiting beyond five minutes until the current review passes", async t => {
  const events = [], activity = [];
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const f = await nativeFixture(t, "PASS", { compatibility: async () => ({
    emitAgentEvent: event => events.push({ ...event, at: Date.now() }),
    markDiagnosticSessionProgress: () => { activity.push(Date.now()); ready(); },
  }) });
  await f.start();
  const state = f.sharedState.states.get("main:session");
  state.nativeRunId = f.ctx.runId;
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  const chain = createNativeStopChains(f.sharedState.stopWaitChains, f.sharedState.stopWaitRunOwners)
    .begin({ state, runId: f.ctx.runId, taskId: f.task.taskId, budgetMs: 400000 });
  let released = false;
  const hostAbort = new AbortController();
  const waiting = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {
    ...f.ctx, runId: "virtual-clock-waiter", abortSignal: hostAbort.signal,
  }).then(() => { released = true; });
  try {
    await started;
    await new Promise(setImmediate);
    for (let tick = 0; tick < 11; tick++) {
      t.mock.timers.tick(30000);
      await new Promise(setImmediate);
      assert.equal(released, false);
      assert.equal(chain.pending, true);
    }
    assert.equal(activity.length, 12);
    assert.equal(activity.at(-1) - activity[0], 330000);
    assert.equal(hostAbort.signal.aborted, false);
    assert(events.every(event => event.stream === "tool"));
    chain.assessed({ runId: f.ctx.runId, reviewStatus: "PASS" });
    await waiting;
    assert.equal(chain.record.reviewStatus, "PASS");
  } finally { chain.cancel("TEST_FINISHED"); t.mock.timers.reset(); }
});

test("original revision is charged only on a later trusted call and rechecked under a new Stop identity", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true, finalizeReviewWaitMs: 2000, maxCorrections: 1 });
  const event = await armFinalize(f);
  await f.runtime.finalize(event, { ...f.ctx, runtimeCorrectorIndependentStop: true });
  const decision = await f.runtime.beforeFinalize(event, f.ctx);
  assert.equal(decision?.action, "revise", JSON.stringify(f.warnings));
  assert.equal(f.dispatches.length, 0);
  assert.equal((await f.store.inspect("session")).used, 0);
  f.emitStart({ runId: f.ctx.runId, ts: Date.now(), seq: 100, callId: "revision-first-call" });
  await f.sharedState.stopStartProtocol.drain();
  f.emitStart({ runId: f.ctx.runId, ts: Date.now(), seq: 101, callId: "revision-tool-roundtrip" });
  await f.sharedState.stopStartProtocol.drain();
  assert.equal((await f.store.inspect("session")).used, 1);
  f.setVerdict("PASS");
  await fs.writeFile(path.join(f.root, "app.py"), "def convert(value): return int(str(value))\n");
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "revised-final", parentId: "answer",
    message: { role: "assistant", content: event.lastAssistantMessage } }) + "\n");
  await f.runtime.beforeFinalize(event, f.ctx);
  const records = await settlePrepared(f);
  assert.equal(records.at(-1).reviewStatus, "PASS", JSON.stringify({ records, warnings: f.warnings }));
  assert.equal(new Set(records.map(record => record.occurrenceId)).size, 2);
  assert.equal((await f.store.inspect("session")).used, 1, "final verification gets no extra repair allowance");
  assert.equal(f.dispatches.length, 0);
});

test("declined original revision hands off once after terminal notification while ordinary input stays waiting", async t => {
  const events = [], f = await nativeFixture(t, "DEVIATION", { startProtocol: true, finalizeReviewWaitMs: 2000,
    compatibility: async () => ({ emitAgentEvent: event => events.push(event), markDiagnosticSessionProgress() {} }) });
  const event = await armFinalize(f);
  await f.runtime.finalize(event, { ...f.ctx, runtimeCorrectorIndependentStop: true });
  assert.equal((await f.runtime.beforeFinalize(event, f.ctx))?.action, "revise");
  let entered = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, { ...f.ctx, runId: "ordinary-next" }).then(() => { entered = true; });
  await pause(20);
  assert.equal(entered, false);
  assert.equal(f.dispatches.length, 0);
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  for (let i = 0; !f.dispatches.length && i < 150; i++) await pause(20);
  assert.equal(f.dispatches.length, 1, JSON.stringify(f.warnings));
  assert.equal(entered, false);
  const { ctx, gate } = await enterContinuation(f);
  assert.equal(gate.outcome, "pass");
  f.emitStart({ runId: ctx.runId, ts: Date.now() });
  await f.sharedState.stopStartProtocol.drain();
  assert.equal((await f.store.inspect("session")).used, 1);
  f.setVerdict("PASS");
  await fs.writeFile(path.join(f.root, "app.py"), "def convert(value): return int(str(value))\n");
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "fallback-repaired", parentId: "feedback",
    message: { role: "assistant", content: "Repaired." } }) + "\n");
  await f.runtime.agentEnd({ runId: ctx.runId, success: true, messages: [{ role: "assistant", content: "Repaired." }] }, ctx);
  await next;
  assert.equal(f.dispatches.length, 1);
  assert(events.some(event => event.runId === "ordinary-next" && event.stream === "tool"));
  assert(!events.some(event => event.stream === "assistant"));
});

test("zero finalize window returns immediately and slow review falls back only after the original ends", async t => {
  let finish;
  const review = new Promise(resolve => { finish = resolve; });
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true, reviewWait: () => review });
  const event = await armFinalize(f), start = Date.now();
  assert.equal(await f.runtime.beforeFinalize(event, f.ctx), undefined);
  assert(Date.now() - start < 300);
  await f.sharedState.states.get("main:session").nativePreparingStop;
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  assert.equal(f.dispatches.length, 0);
  finish();
  await settlePrepared(f);
  assert.equal(f.dispatches.length, 1, JSON.stringify(f.warnings));
  assert.equal((await f.store.inspect("session")).used, 0);
});

test("ordinary input survives a damaged RC ledger, while an already queued RC continuation is denied", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start(); await f.stop();
  const childRunId = f.dispatches[0].idempotencyKey;
  await fs.writeFile(f.store.fileFor("session"), "{ damaged RC ledger");
  assert.equal(await f.runtime.beforeAgentRun({ prompt: "ordinary task" }, { ...f.ctx, runId: "ordinary" }), undefined);
  assert.equal((await f.runtime.beforeAgentRun({ prompt: "RC continuation" }, { ...f.ctx, runId: childRunId })).outcome, "block");
  assert.equal((await f.runtime.beforeAgentRun({ prompt: "Unverifiable old RC continuation" },
    { ...f.ctx, runId: `rc-stop-${"f".repeat(64)}` })).outcome, "block");
});

test("an input already inside the host queue ends RC waiting instead of waiting for a repair behind it", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start(); await f.stop();
  const chain = [...f.sharedState.stopWaitChains.values()][0];
  await f.runtime.beforeModelResolve({}, { ...f.ctx, runId: "bypassed-outer-gate" });
  assert.equal(chain.pending, false);
  assert.equal(chain.record.reasonCode, "RC_QUEUE_ENTRY_BYPASSED");
  assert(!f.aborts.some(call => call.params.runId === f.ctx.runId || call.params.runId === "bypassed-outer-gate"));
});

for (const nextMessage of ["Next independent task.", "Change the previous task: convert to float instead of int."])
test(`queued input is deferred until the flow ends: ${nextMessage}`, async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true, reviewWait: () => blocked });
  const event = await armFinalize(f);
  await f.runtime.beforeFinalize(event, f.ctx);
  await f.sharedState.states.get("main:session").nativePreparingStop;
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "queued-user", parentId: "answer",
    message: { role: "user", content: nextMessage } }) + "\n");
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  finish(); await settlePrepared(f);
  assert.equal(f.dispatches.length, 1, JSON.stringify(f.warnings));
  const { ctx, gate } = await enterContinuation(f, "queued-user");
  assert.equal(gate.outcome, "pass");
  f.emitStart({ runId: ctx.runId, ts: Date.now() });
  await f.sharedState.stopStartProtocol.drain();
  assert.equal((await f.store.inspect("session")).used, 1);
  assert.equal(Object.keys((await f.store.inspect("session")).flows).length, 1);
  const state = f.sharedState.states.get("main:session");
  const raw = (await fs.readFile(f.transcript, "utf8")).trim().split(/\r?\n/u).map(JSON.parse);
  const projected = await state.projectNativeRecords(raw);
  assert(!projected.some(record => record.id === "queued-user"));
  assert(projected.find(record => record.id === "feedback").isMeta);
  [...f.sharedState.stopWaitChains.values()][0].cancel("TEST_FINISHED");
  const after = await state.projectNativeRecords(raw);
  assert.equal(after.find(record => record.id === "queued-user").isMeta, undefined);
  assert.equal(after.find(record => record.id === "feedback").isMeta, true);
});

test("a changed original requirement invalidates feedback before native continuation admission", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start(); await f.stop();
  const text = await fs.readFile(f.transcript, "utf8");
  await fs.writeFile(f.transcript, text.replace("Implement both conversion obligations.", "Implement a different conversion obligation."));
  assert.equal((await enterContinuation(f)).gate.outcome, "block");
  assert.equal((await f.store.inspect("session")).used, 0);
});

test("a hung RC admission returns control to an ordinary host tool without aborting the host", async t => {
  const f = await nativeFixture(t);
  await f.start();
  f.api.pluginConfig.hookTimeoutMs = 2000;
  f.api.runtime.agent.session.runWithWorkAdmission = () => new Promise(() => {});
  const hostAbort = new AbortController(), startedAt = Date.now();
  assert.equal(await f.runtime.beforeTool({ toolName: "write", toolCallId: "hung", params: { path: "app.py" } },
    { ...f.ctx, abortSignal: hostAbort.signal }), undefined);
  assert(Date.now() - startedAt < 1800);
  assert.equal(hostAbort.signal.aborted, false);
});

test("RC configuration read failure cannot escape a host tool hook or reject ordinary input", async t => {
  const f = await nativeFixture(t);
  await f.start();
  f.api.runtime.config = { current() { throw new Error("configuration unavailable"); } };
  assert.equal(await f.runtime.beforeTool({ toolName: "write", params: { path: "app.py" } }, f.ctx), undefined);
  assert.equal(await f.runtime.beforeAgentRun({ prompt: "ordinary task" }, f.ctx), undefined);
});

test("a failed background registration and broken logger cannot reject the original finalize hook", async t => {
  const f = await nativeFixture(t), event = await armFinalize(f);
  await fs.writeFile(path.join(f.root, ".runtime-corrector/config.yaml"), "version: 2\nstopCorrection:\n  enabled: invalid-boolean\n");
  f.api.logger.warn = () => { throw new Error("logger unavailable"); };
  assert.equal(await f.runtime.beforeFinalize(event, f.ctx), undefined);
  await f.sharedState.states.get("main:session").nativePreparingStop.catch(() => {});
  await pause(20); // Flush the independently observed rejection callback.
  assert.equal(f.dispatches.length, 0);
});

test("a prompt that bypasses the outer dispatch hook cannot wait inside the session lane", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start(); await f.stop();
  const chain = [...f.sharedState.stopWaitChains.values()][0];
  await f.runtime.prompt({ prompt: "An already admitted ordinary task." }, { ...f.ctx, runId: "direct-prompt" });
  assert.equal(chain.pending, false);
  assert.equal(chain.record.reasonCode, "RC_QUEUE_ENTRY_BYPASSED");
});

test("hung review releases queued input and fences a late PASS even when the reviewer ignores cancellation", async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const f = await nativeFixture(t, "PASS", { reviewWait: () => blocked });
  const event = await armFinalize(f);
  f.api.pluginConfig.hookTimeoutMs = 2000;
  await f.runtime.beforeFinalize(event, f.ctx);
  await f.sharedState.states.get("main:session").nativePreparingStop;
  await f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, { ...f.ctx, runId: "next-ordinary" });
  const chain = [...f.sharedState.stopWaitChains.values()][0];
  assert.equal(chain.pending, false);
  assert.notEqual(chain.record.reviewStatus, "PASS");
  finish(); await settlePrepared(f);
  assert.notEqual(chain.record.reviewStatus, "PASS");
  assert.equal(f.dispatches.length, 0);
});

test("an outer queued task outlives the per-phase hook budget across repair and its new review", async t => {
  const f = await nativeFixture(t);
  await f.start();
  f.api.pluginConfig.hookTimeoutMs = 1400; // A phase budget, formerly a 400 ms caller cutoff.
  const state = f.sharedState.states.get("main:session");
  state.nativeRunId = f.ctx.runId;
  const manager = createNativeStopChains(f.sharedState.stopWaitChains, f.sharedState.stopWaitRunOwners);
  const chain = manager.begin({ state, runId: f.ctx.runId, taskId: f.task.taskId, budgetMs: 1500, repairBudgetMs: 3000 });
  t.after(() => chain.cancel("TEST_FINISHED"));
  let entered = false;
  const waiting = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, { ...f.ctx, runId: "queued-across-phases" })
    .then(() => { entered = true; });
  chain.link(f.ctx.runId, { taskId: f.task.taskId, runId: "real-repair" });
  chain.observeStart("real-repair");
  await pause(650);
  assert.equal(entered, false);
  assert.equal(chain.pending, true);
  manager.begin({ state, runId: "real-repair", taskId: f.task.taskId, budgetMs: 1500 });
  await pause(650);
  assert.equal(entered, false);
  assert.equal(chain.pending, true);
  chain.assessed({ runId: "real-repair", reviewStatus: "PASS" });
  await waiting;
  assert.equal(entered, true);
  assert.equal(chain.record.reviewStatus, "PASS");
});

test("an uncertain native acknowledgement is not resubmitted on duplicate terminal events", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  const accept = f.api.runtime.subagent.run;
  f.api.runtime.subagent.run = async request => { await accept(request); throw new Error("acknowledgement lost"); };
  const event = await armFinalize(f);
  await f.runtime.beforeFinalize(event, f.ctx);
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  await settlePrepared(f);
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  await pause(30);
  assert.equal(f.dispatches.length, 1);
  const ledger = await f.store.inspect("session");
  assert.equal(Object.values(ledger.admissions)[0].deliveryStatus, "UNKNOWN");
  assert.equal(ledger.used, 0);
  assert.equal([...f.sharedState.stopWaitChains.values()][0].pending, true);
});

test("real-time waiting gate emits UI heartbeats beyond five minutes without transcript writes", {
  skip: process.env.RC_LONG_WAIT_TEST !== "1", timeout: 335000,
}, async t => {
  const events = [], f = await nativeFixture(t, "PASS", { compatibility: async () => ({
    emitAgentEvent: event => events.push({ ...event, observedAt: Date.now() }),
    markDiagnosticSessionProgress() {},
  }) });
  await f.start();
  const state = f.sharedState.states.get("main:session");
  state.nativeRunId = f.ctx.runId;
  const manager = createNativeStopChains(f.sharedState.stopWaitChains, f.sharedState.stopWaitRunOwners);
  const chain = manager.begin({ state, runId: f.ctx.runId, taskId: f.task.taskId, budgetMs: 1000, repairBudgetMs: 325000 });
  chain.link(f.ctx.runId, { taskId: f.task.taskId, runId: "long-repair" });
  chain.observeStart("long-repair");
  const before = await fs.readFile(f.transcript, "utf8");
  let released = false;
  const waiter = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, { ...f.ctx, runId: "long-waiter" }).then(() => { released = true; });
  await pause(310000);
  assert.equal(released, false);
  chain.assessed({ runId: "long-repair", reviewStatus: "PASS" });
  await waiter;
  const updates = events.filter(event => event.stream === "tool" && event.data.phase === "update");
  assert(updates.length >= 11, `only ${updates.length} UI updates`);
  assert(updates.at(-1).observedAt - updates[0].observedAt >= 300000);
  assert(!events.some(event => event.stream === "assistant"));
  assert.equal(await fs.readFile(f.transcript, "utf8"), before);
});
