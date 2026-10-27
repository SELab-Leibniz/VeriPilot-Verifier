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

async function nativeFixture(t, verdict = "PASS", { startProtocol = false, waitMode = "until_pass", finalizeReviewWaitMs = 0, maxCorrections = 3,
  flowLimit = maxCorrections, sessionLimit = maxCorrections, enabled = true, metricEnabled = true, gatewayRequest,
  compatibility = async () => ({ emitAgentEvent() {}, markDiagnosticSessionProgress() {} }), reviewWait, terminal = async (_identity, runId) => ({ runId, status: "ok" }) } = {}) {
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
  enabled: ${enabled}
  assessmentTimeoutMs: 10000
  feedbackReserveMs: 1000
  waitMode: ${waitMode}
  maxCorrectionsPerFlow: ${flowLimit}
  maxCorrectionsPerSession: ${sessionLimit}
  metrics:
${Array.from({ length: 16 }, (_, i) => `    M${String(i + 1).padStart(2, "0")}: ${metricEnabled && i === 15}`).join("\n")}
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
    ...(startProtocol || gatewayRequest ? { gateway: { request: gatewayRequest ?? (async (method, params) => { aborts.push({ method, params }); return { aborted: true }; }) } } : {}),
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

async function enterContinuation(f, parentId = "answer", index = 0) {
  const request = f.dispatches[index], runId = request.idempotencyKey;
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: index ? `feedback-${index + 1}` : "feedback", parentId,
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

for (const scenario of [
  { name: "PASS", verdict: "PASS", status: "PASS", options: { startProtocol: true } },
  { name: "Stop disabled", status: "DISABLED", options: { enabled: false } },
  { name: "all metrics disabled", status: "DISABLED", options: { metricEnabled: false } },
  { name: "session quota exhausted", reason: "SESSION_CORRECTION_LIMIT", status: "UNVERIFIED", options: { startProtocol: true, sessionLimit: 0 } },
  { name: "flow quota exhausted", reason: "FLOW_CORRECTION_LIMIT", status: "UNVERIFIED", options: { startProtocol: true, flowLimit: 0 } },
  { name: "unsupported start protocol", reason: "HOST_START_PROTOCOL_UNSUPPORTED", status: "DEVIATION", options: {} },
  { name: "business run failed", reason: "HOST_RUN_NOT_COMPLETED", status: "UNVERIFIED", terminalStatus: "error", options: {} },
]) test(`production release: ${scenario.name} blocks pending input, then starts its two user turns in order`, async t => {
  let release;
  const terminal = new Promise(resolve => { release = resolve; }), sent = [], acknowledgements = [];
  const f = await nativeFixture(t, scenario.verdict ?? "DEVIATION", { ...scenario.options,
    terminal: async (_id, runId) => runId === "business-run" ? terminal : { runId, status: "ok" },
    gatewayRequest: async (method, params) => {
      if (method === "chat.send") { sent.push(params); return { runId: params.idempotencyKey }; }
      return { aborted: true };
    } });
  await f.start(); await f.runtime.beforeTool({ toolName: "write", toolCallId: "written", params: { path: "app.py" } }, f.ctx);
  const payload = { text: "Original finished reply." };
  assert.equal(await f.runtime.reply({ kind: "final", sessionKey: f.ctx.sessionKey, runId: f.ctx.runId, payload }, f.ctx), undefined);
  const record = f.runtime.postRuns.byId(f.runtime.postRuns.list().sessions[0].id);
  for (const [index, text] of ["next one", "next two"].entries()) {
    const claimed = await f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey, ctx: {
      SessionKey: f.ctx.sessionKey, MessageSid: `queued-${index}`, RawBody: text,
      GatewayClientScopes: ["operator.write"], InputProvenance: { kind: "external_user" },
    } }, { dispatcher: { sendFinalReply: reply => { acknowledgements.push(reply); return true; }, getQueuedCounts: () => ({ final: 1 }) },
      recordProcessed() {}, markIdle() {} });
    assert.equal(claimed.handled, true);
  }
  assert.equal(acknowledgements.length, 2); assert.equal(sent.length, 0);
  assert.equal((await f.runtime.beforeAgentRun({ prompt: "Bypass the task queue" }, { ...f.ctx, runId: "bypass" })).outcome, "block");
  release({ runId: f.ctx.runId, status: scenario.terminalStatus ?? "ok" });
  await settlePrepared(f);
  assert.deepEqual(sent.map(request => request.message), ["next one"], JSON.stringify({ scenario, warnings: f.warnings }));
  const current = f.runtime.postRuns.byId(record.id);
  assert.equal(current.reviewStatus, scenario.status);
  if (scenario.reason) assert.equal(current.reason, scenario.reason, JSON.stringify({ current, warnings: f.warnings }));
  assert.equal(f.dispatches.length, 0); assert.equal(payload.text, "Original finished reply.");
  // Execute the queued task through the real public run gate and final hook.
  const ctx = { ...f.ctx, runId: sent[0].idempotencyKey };
  await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: "next-human", parentId: "answer",
    message: { role: "user", content: sent[0].message } }) + "\n");
  await f.runtime.prompt({ prompt: sent[0].message }, ctx);
  assert.notEqual((await f.runtime.beforeAgentRun({ prompt: sent[0].message, messages: [] }, ctx))?.outcome, "block");
  assert.equal(sent.length, 1, "the second task remains blocked during the first task's execution");
  await f.runtime.agentEnd({ runId: ctx.runId, success: true, messages: [{ role: "assistant", content: "First queued task finished." }] }, ctx);
  await settlePrepared(f);
  assert.deepEqual(sent.map(request => request.message), ["next one", "next two"]);
  assert.equal(f.runtime.postRuns.byId(record.id).pending.length, 0);
});

test("a late release from an old corrective receipt cannot end the next user run", async t => {
  const sent = [];
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true, gatewayRequest: async (method, params) => {
    if (method === "chat.send") { sent.push(params); return { runId: params.idempotencyKey }; } return { aborted: true };
  } });
  await f.start(); await f.stop();
  const record = f.runtime.postRuns.byId(f.runtime.postRuns.list().sessions[0].id);
  const oldStopId = record.correctionStopId;
  await f.runtime.postRuns.defer(record, { text: "first" }); await f.runtime.postRuns.defer(record, { text: "second" });
  await f.runtime.postRuns.release(record, "CORRECTION_CANCELLED");
  assert.equal(sent.length, 1);
  const state = f.sharedState.states.get("main:session");
  await f.runtime.postRuns.started(record, sent[0].idempotencyKey);
  await f.sharedState.stopStartProtocol.cancel({ state, stopId: oldStopId, reason: "LATE_OLD_CANCELLATION" });
  // Flush the fire-and-forget release callbacks as well as review work.
  await f.runtime.postRuns.dispose();
  assert.equal(sent.length, 1); assert.equal(f.runtime.postRuns.byId(record.id).phase, "RUNNING");
});

for (const limit of [1, 3]) test(`production correction loop with limit ${limit} preserves queued work until PASS or quota release`, async t => {
  const sent = [];
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true, maxCorrections: limit,
    gatewayRequest: async (method, params) => {
      if (method === "chat.send") { sent.push(params); return { runId: params.idempotencyKey }; } return { aborted: true };
    } });
  await f.start(); await f.stop();
  const record = f.runtime.postRuns.byId(f.runtime.postRuns.list().sessions[0].id);
  const task = await f.runtime.postRuns.defer(record, { text: "first queued work" });
  await f.runtime.postRuns.defer(record, { text: "second queued work" });
  const rounds = limit === 1 ? 1 : 2;
  let parentId = "answer";
  for (let i = 0; i < rounds; i++) {
    assert.equal(f.runtime.postRuns.byId(record.id).phase, "WAIT_CORRECTION"); assert.equal(sent.length, 0);
    const { ctx, gate } = await enterContinuation(f, parentId, i); assert.equal(gate.outcome, "pass");
    f.emitStart({ runId: ctx.runId, ts: Date.now(), seq: i + 1 }); await f.sharedState.stopStartProtocol.drain();
    assert.equal(f.runtime.postRuns.byId(record.id).phase, "CORRECTING"); assert.equal(sent.length, 0);
    await f.runtime.postRuns.mutate(record, { id: task.id, revision: i + 1, text: `edited after repair ${i + 1}` });
    f.setVerdict(limit === 3 && i === 1 ? "PASS" : "DEVIATION");
    await fs.writeFile(path.join(f.root, "app.py"), `def convert(value): return int(str(value)) + ${i}\n`);
    parentId = `repair-answer-${i}`;
    await fs.appendFile(f.transcript, JSON.stringify({ type: "message", id: parentId, parentId: i ? `feedback-${i + 1}` : "feedback",
      message: { role: "assistant", content: "Repair finished normally." } }) + "\n");
    await f.runtime.agentEnd({ runId: ctx.runId, success: true, messages: [{ role: "assistant", content: "Repair finished normally." }] }, ctx);
    await settlePrepared(f);
    assert.equal((await f.store.inspect("session")).used, i + 1);
  }
  const current = f.runtime.postRuns.byId(record.id);
  assert.deepEqual(sent.map(request => request.message), [`edited after repair ${rounds}`]);
  assert.deepEqual(current.pending.map(task => task.text), ["second queued work"]);
  assert.equal(f.dispatches.length, rounds); assert.equal(new Set(f.dispatches.map(request => request.idempotencyKey)).size, rounds);
  if (limit === 3) assert.equal(current.reviewStatus, "PASS");
  else { assert.notEqual(current.reviewStatus, "PASS"); assert.equal(current.reason, "CORRECTION_BUDGET_EXHAUSTED"); }
});

test("aborting a corrective run holds user tasks until its host terminal, then releases only the first", async t => {
  let release;
  const terminal = new Promise(resolve => { release = resolve; }), sent = [];
  const f = await nativeFixture(t, "DEVIATION", { startProtocol: true,
    terminal: async (_identity, runId) => runId.startsWith("rc-stop-") ? terminal : { runId, status: "ok" },
    gatewayRequest: async (method, params) => {
      if (method === "chat.send") { sent.push(params); return { runId: params.idempotencyKey }; } return { aborted: true };
    } });
  await f.start(); await f.stop();
  const record = f.runtime.postRuns.byId(f.runtime.postRuns.list().sessions[0].id);
  await f.runtime.postRuns.defer(record, { text: "first" }); await f.runtime.postRuns.defer(record, { text: "second" });
  const { ctx, gate } = await enterContinuation(f); assert.equal(gate.outcome, "pass");
  f.emitStart({ runId: ctx.runId, ts: Date.now() }); await f.sharedState.stopStartProtocol.drain();
  await f.runtime.agentEnd({ runId: ctx.runId, success: false, aborted: true }, ctx);
  assert.equal(f.runtime.postRuns.byId(record.id).phase, "FINALIZING"); assert.equal(sent.length, 0);
  release({ runId: ctx.runId, status: "error" }); await settlePrepared(f);
  assert.deepEqual(sent.map(request => request.message), ["first"]);
  assert.equal(f.runtime.postRuns.byId(record.id).reviewStatus, "UNVERIFIED");
  await f.runtime.agentEnd({ runId: ctx.runId, success: true, messages: [{ role: "assistant", content: "Late success" }] }, ctx);
  await settlePrepared(f); assert.equal(sent.length, 1);
  assert.equal(f.runtime.postRuns.byId(record.id).pending[0].text, "second");
});
