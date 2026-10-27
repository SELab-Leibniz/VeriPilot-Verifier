import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOpenClawRuntime } from "../lib/openclaw/runtime.mjs";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";
import { ensureTask, taskDirectory, withTaskState, findTask } from "../lib/runtime-v2/task-store.mjs";
import { runStopTaskGroup } from "../lib/runtime-v2/stop-task-group.mjs";
import { readReport } from "../lib/openclaw/report.mjs";
import { admittedProjectScopes } from "./support/openclaw-project-scope.mjs";
import { observedTaskResult } from "./helpers/observed-review.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function nativeFixture(t, verdict = "PASS", { startProtocol = false, waitMode = "until_pass", finalizeReviewWaitMs = 0, maxCorrections = 3, compatibility = async () => ({ emitAgentEvent() {}, markDiagnosticSessionProgress() {} }), reviewWait, terminal = async (_identity, runId) => ({ runId, status: "ok" }) } = {}) {
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
    nativeHooks: true, sharedState, projectScopes, compatibility, postRunTerminal: terminal,
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
  assert.equal(f.runtime.postRuns.list().sessions.at(-1).phase, "IDLE");
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
  assert.equal(f.runtime.postRuns.list().sessions.at(-1).phase, "CORRECTING");
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
  f.emitStart({ runId, ts: Date.now() });
  await f.sharedState.stopStartProtocol.drain();
  assert.equal((await f.store.inspect("session")).used, 1, "a host protocol violation is still an actual execution");
  assert(f.aborts.some(call => call.method === "chat.abort" && call.params.runId === runId));
  assert(f.aborts.every(call => call.params.runId && call.params.preserveSideRuns === true));

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

test("until_pass never revises an original run even with a nonzero finalize window; review waits for host terminal", async t => {
  let finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true, finalizeReviewWaitMs: 2000, terminal: () => terminal });
  const event = await armFinalize(f);
  const raw = await fs.readFile(f.transcript, "utf8");
  assert.equal(await f.runtime.beforeFinalize(event, f.ctx), undefined);
  await f.runtime.agentEnd({ ...event, success: true }, f.ctx);
  await pause(30);
  assert.equal(f.calls.filter(x => x === "stop-group").length, 0);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.runtime.postRuns.list().sessions[0].phase, "FINALIZING");
  finish({ runId: f.ctx.runId, status: "ok" });
  await settlePrepared(f);
  assert.equal(f.dispatches.length, 1);
  assert.equal(await fs.readFile(f.transcript, "utf8"), raw);
  assert.equal((await f.store.inspect("session")).used, 0);
});

test("a queued user dispatch ends promptly and retains edited work until the corrective run passes", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start(); await f.stop();
  const sent = [], acks = [];
  const original = f.api.runtime.gateway.request;
  f.api.runtime.gateway.request = async (method, params) => {
    if (method === "chat.send") { sent.push(params); return { runId: params.idempotencyKey }; }
    return original(method, params);
  };
  const claimed = await f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey, ctx: {
    SessionKey: f.ctx.sessionKey, MessageSid: "later-user", RawBody: "Next user work.",
    GatewayClientScopes: ["operator.write"], InputProvenance: { kind: "external_user" },
  } }, { dispatcher: { sendFinalReply: reply => { acks.push(reply); return true; }, getQueuedCounts: () => ({ final: 1 }) },
    recordProcessed: () => {}, markIdle: () => {} });
  assert.equal(claimed.handled, true); assert.equal(acks.length, 1); assert.equal(sent.length, 0);
  const record = f.runtime.postRuns.byId(f.runtime.postRuns.list().sessions[0].id), task = record.pending[0];
  await f.runtime.postRuns.mutate(record, { id: task.id, revision: task.revision, text: "Edited next work." });
  // A public input gate protects callers that bypass the outer claiming hook.
  assert.equal((await f.runtime.beforeAgentRun({ prompt: "Bypass" }, { ...f.ctx, runId: "foreign" })).outcome, "block");
  const { ctx, gate } = await enterContinuation(f); assert.equal(gate.outcome, "pass");
  f.emitStart({ runId: ctx.runId, ts: Date.now() }); await f.sharedState.stopStartProtocol.drain();
  f.setVerdict("PASS");
  await fs.writeFile(path.join(f.root, "app.py"), "def convert(value): return int(str(value))\n");
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "repaired", parentId: "feedback",
    message: { role: "assistant", content: "Repaired." } }) + "\n");
  await f.runtime.agentEnd({ runId: ctx.runId, success: true, messages: [{ role: "assistant", content: "Repaired." }] }, ctx);
  await settlePrepared(f);
  assert.equal(sent.length, 1); assert.equal(sent[0].message, "Edited next work.");
  assert.match(sent[0].idempotencyKey, /^rc-user-/u);
  assert.equal(f.runtime.postRuns.byId(record.id).pending.length, 0);
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

  await pause(20); // Flush the independently observed rejection callback.
  assert.equal(f.dispatches.length, 0);
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
  await settlePrepared(f);
  assert.equal(f.dispatches.length, 1);
  const ledger = await f.store.inspect("session");
  assert.equal(Object.values(ledger.admissions)[0].deliveryStatus, "UNKNOWN");
  assert.equal(ledger.used, 0);
  assert.equal(f.runtime.postRuns.list().sessions[0].phase, "WAIT_CORRECTION");
});

test("Gateway shutdown preserves pending tasks and recovery reconciles the corrective run first", async t => {
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true });
  await f.start(); await f.stop();
  const original = f.runtime.postRuns.byId(f.runtime.postRuns.list().sessions[0].id);
  await f.runtime.postRuns.defer(original, { sourceId: "later", text: "Preserve across Gateway restart" });
  await f.runtime.dispose();
  assert.notEqual(f.runtime.postRuns.byId(original.id).phase, "CLOSED");
  const observed = [];
  const recovered = createOpenClawRuntime(f.api, { pluginRoot: path.resolve("."), nativeHooks: true,
    projectScopes: f.projectScopes, sharedState: {}, postRunTerminal: async (_identity, runId) => {
      observed.push(runId); return { runId, status: "timeout" };
    } });
  try {
    await recovered.postRunReady; await recovered.postRuns.drain();
    const record = recovered.postRuns.byId(original.id);
    assert.equal(record.pending[0].text, "Preserve across Gateway restart");
    assert.equal(record.reason, "HOST_RUN_RECONCILIATION_REQUIRED");
    assert.deepEqual(observed, [original.correctionRunId]);
    assert.equal(f.dispatches.length, 1);
  } finally { await recovered.dispose(); }
});
