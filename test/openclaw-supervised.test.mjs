import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createSupervisedHarness, completionStatus } from "../lib/openclaw/supervised.mjs";
import { withController, controllerDirectory, privateJson, isPersistedWorker } from "../lib/openclaw/controller-store.mjs";
import { ensureTask, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { runInternalExecution } from "../lib/openclaw/internal-context.mjs";
import { createEvidenceLedger } from "../lib/openclaw/evidence.mjs";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-supervised-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const params = { sessionId: randomUUID(), runId: randomUUID(), agentId: "main", workspaceDir: root,
    sessionFile: path.join(root, ".native", "parent.jsonl"), provider: "test", modelId: "test",
    model: { api: "anthropic-messages" }, prompt: "Create result.txt with VERIFIED.", timeoutMs: 10000 };
  const state = {}, workers = new Map(), handles = new Map(), progress = [];
  let rounds = 0, assessments = 0, begins = 0;
  const runtime = { isWorker: (id) => workers.has(id),
    async beginSupervised(_params, signal) { begins++; state.signal = signal; return state; },
    bindWorker(id) { workers.set(id, {}); return { close() { workers.get(id).closed = true; } }; },
    async acceptRequirement() {},
    async assessSupervised(_state, request) {
      assessments++;
      if (options.assess) {
        const result = await options.assess({ state, request, root, assessments });
        if (result) return result;
      }
      const task = await ensureTask({ projectRoot: root, sessionId: params.sessionId });
      const content = await fs.readFile(path.join(root, "result.txt"), "utf8");
      const passed = content === "VERIFIED";
      await withTaskState({ projectRoot: root, taskId: task.taskId }, (taskState) => {
        taskState.status = passed ? "COMPLETED" : "ACTIVE";
        taskState.verification = { status: passed ? "PASS" : "DEVIATION" };
        if (!passed) taskState.stop.correctionAttempts++;
      });
      return { decision: passed ? "allow" : "block", report: { status: passed ? "PASS" : "DEVIATION" },
        review: { stopClassification: "TASK_COMPLETE" }, ...(passed ? {} : { feedback: "Replace DRAFT with VERIFIED." }) };
    } };
  const sdk = {
    onRunActivity: () => () => {}, reportProgress: () => {},
    workerPolicy: (params, key) => ({ config: params.config, sandboxSessionKey: key }),
    nativeHarness: () => ({ runAttempt: async () => ({ native: true }) }),
    acquireSessionWriteLock: async () => ({ release: async () => {} }),
    async appendSessionTranscriptMessage({ transcriptPath, message }) {
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.appendFile(transcriptPath, JSON.stringify({ type: "message", id: randomUUID(), message }) + "\n");
    },
    setActiveEmbeddedRun(id, handle) { handles.set(id, handle); }, clearActiveEmbeddedRun(id) { handles.delete(id); },
    abortAgentHarnessRun() {}, emitAgentEvent(event) { progress.push(event); },
    queueAcknowledged: async () => ({ queued: true, deliveredAtMs: Date.now() }),
    workerRecorder: (message, target) => {
      let persisted = false;
      return { resolveMessage: async () => message, hasPersisted: () => persisted,
        persistApproved: async () => { await sdk.appendSessionTranscriptMessage({ ...target, message }); persisted = true; } };
    },
  };
  const api = { id: "runtime-corrector", pluginConfig: {}, config: {}, runtime: { agent: {
    async runEmbeddedAgent(child) {
      rounds++;
      assert.equal(isPersistedWorker(root, child.sessionId), true, "worker identity must be durable before native dispatch");
      assert.equal(child.agentHarnessRuntimeOverride, "openclaw");
      assert.notEqual(child.sessionId, params.sessionId);
      assert.notEqual(child.runId, params.runId);
      assert.equal(child.sandboxSessionKey, child.sessionKey, "native subscription identity must remain private");
      assert.equal(child.replyOperation, undefined);
      assert.equal(child.deferTerminalLifecycle, false);
      assert.equal(child.deferTerminalLifecycleEnd, false);
      if (options.worker) return options.worker({ child, rounds, root, handles, params });
      if (rounds > 1) assert.equal(child.inputProvenance.kind, "internal_system");
      await fs.writeFile(path.join(root, "result.txt"), rounds === 1 ? "DRAFT" : "VERIFIED");
      return { payloads: [{ text: "Task completed." }], meta: {} };
    } } } };
  const harness = createSupervisedHarness(api, runtime, { compatibility: async () => sdk, evidence: options.evidence });
  return { root, params, harness, api, runtime, handles, progress, sdk,
    counts: () => ({ rounds, assessments, begins }) };
}

test("supervisor withholds a failed candidate, corrects and then publishes only the verified result", async (t) => {
  const f = await fixture(t);
  const result = await f.harness.runAttempt(f.params);
  assert.equal(await fs.readFile(path.join(f.root, "result.txt"), "utf8"), "VERIFIED");
  assert.deepEqual(f.counts(), { rounds: 2, assessments: 2, begins: 1 });
  const history = (await fs.readFile(f.params.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(history.map((entry) => entry.message.role), ["user", "assistant"]);
  assert.equal(result.lastAssistant.content[0].text, "Task completed.");
  assert.equal(result.replayMetadata.replaySafe, false);
  assert.equal(f.handles.size, 0);
  assert.equal(f.progress.filter((event) => event.stream === "assistant" && event.data.phase !== "final").length, 4);
  assert.equal(f.progress.at(-1).data.phase, "end");
  assert.equal(f.progress.filter((event) => event.data.phase === "final").length, 1);
  await f.harness.runAttempt(f.params);
  assert.equal(f.counts().rounds, 2, "duplicate notification must reuse the receipt");
});

test("concurrent duplicate controllers share one execution and internal reviews cannot create controllers", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.harness.runAttempt(f.params), f.harness.runAttempt(f.params)]);
  assert.equal(f.counts().begins, 1);
  assert.deepEqual(results[0], results[1]);
  await runInternalExecution("review", () => assert.rejects(f.harness.runAttempt(f.params), /cannot create/u));
  await assert.rejects(f.harness.runAttempt({ ...f.params, inputProvenance: { kind: "internal_system" } }), /genuine user/u);
});

test("supervised context usage comes from the last model call, separate from cumulative billing", async (t) => {
  const lastCallUsage = { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0,
    total: 5200, contextUsage: { state: "available", promptTokens: 5000, totalTokens: 5200 } };
  const f = await fixture(t, { worker: async () => ({ payloads: [{ text: "Answer" }], meta: { agentMeta: {
    usage: { input: 100000, output: 20000, cacheRead: 300000, total: 420000 }, lastCallUsage } } }),
    assess: async () => ({ reason: "STOP_BARRIER_NOT_REQUIRED" }) });
  const result = await f.harness.runAttempt(f.params);
  assert.equal(result.attemptUsage.total, 420000);
  assert.deepEqual(result.promptCache.lastCallUsage, lastCallUsage);
  assert.equal(result.lastAssistant.usage.totalTokens, 5200);
  const history = (await fs.readFile(f.params.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(history.at(-1).message.usage.cacheRead, 4000);
});

test("ambiguous restart stops without dispatch; later stale parent runs reuse their own receipts", async (t) => {
  const f = await fixture(t);
  const file = path.join(controllerDirectory(f.root, f.params.sessionId), "control.json");
  await privateJson(file, { runId: "interrupted", generation: "old", phase: "EXECUTING" });
  const stopped = await f.harness.runAttempt(f.params);
  assert.match(stopped.lastAssistant.content[0].text, /无法确认/u);
  assert.equal(f.counts().rounds, 0);
  assert.match((await f.harness.runAttempt(f.params)).lastAssistant.content[0].text, /无法确认/u);
  assert.equal(f.counts().rounds, 0, "a duplicate recovery notification must never authorize dispatch");
  const args = { projectRoot: f.root, sessionId: "receipts", runId: "first" };
  assert.deepEqual(await withController(args, async () => ({ status: "VERIFIED", text: "one" })), { status: "VERIFIED", text: "one" });
  // Simulate a fully published first controller before the next user turn.
  const firstPath = path.join(controllerDirectory(f.root, "receipts"), "control.json");
  const first = JSON.parse(await fs.readFile(firstPath));
  await privateJson(firstPath, { ...first, phase: "DELIVERED" });
  await withController({ ...args, runId: "second" }, async () => ({ text: "two" }));
  assert.equal((await withController(args, () => assert.fail("replayed old controller"))).text, "one");
});

test("cancellation during verification prevents candidate delivery and further execution", async (t) => {
  const parent = new AbortController();
  const f = await fixture(t, { assess: async ({ state }) => {
    parent.abort(); assert.equal(state.signal.aborted, true);
    return { decision: "allow", reason: "STOP_BARRIER_NOT_REQUIRED" };
  } });
  const result = await f.harness.runAttempt({ ...f.params, abortSignal: parent.signal });
  assert.equal(result.aborted, true);
  assert.equal(f.counts().rounds, 1);
  assert.doesNotMatch(await fs.readFile(f.params.sessionFile, "utf8"), /Task completed/u);
});

test("a superseded native result cannot overwrite the current core task with a failure", async (t) => {
  let taskId;
  const f = await fixture(t, { worker: async ({ root, params }) => {
    const task = await ensureTask({ projectRoot: root, sessionId: params.sessionId });
    taskId = task.taskId;
    await withTaskState({ projectRoot: root, taskId }, (current) => {
      current.status = "ACTIVE";
      current.verification = { status: "PENDING", reason: "new-controller" };
    });
    await privateJson(path.join(controllerDirectory(root, params.sessionId), "control.json"),
      { generation: "replacement", phase: "EXECUTING" });
    return { payloads: [{ text: "Old candidate." }], meta: {} };
  } });
  const result = await f.harness.runAttempt(f.params);
  assert.match(result.lastAssistant.content[0].text, /尚未验证/u);
  const task = JSON.parse(await fs.readFile(path.join(f.root, ".runtime-correction", "tasks", taskId, "task.json")));
  assert.equal(task.status, "ACTIVE");
  assert.deepEqual(task.verification, { status: "PENDING", reason: "new-controller" });
  assert.equal(f.counts().assessments, 0);
});

test("artifact changes after assessment cannot be delivered as verified", async (t) => {
  let checks = 0;
  const f = await fixture(t, { evidence: async () => ++checks <= 2 ? "first" : "changed" });
  const result = await f.harness.runAttempt(f.params);
  assert.match(result.lastAssistant.content[0].text, /尚未验证/u);
});

test("disabled supervised execution uses the native hook adapter", async (t) => {
  const f = await fixture(t);
  f.api.pluginConfig.supervisedExecution = false;
  assert.deepEqual(await f.harness.runAttempt(f.params), { native: true });
  assert.equal(f.counts().rounds, 0);
});

test("completion requires core TASK_COMPLETE, PASS and current task completion together", () => {
  const pass = { decision: "allow", review: { stopClassification: "TASK_COMPLETE" }, report: { status: "PASS" } };
  const task = { status: "COMPLETED", verification: { status: "PASS" } };
  assert.equal(completionStatus(pass, task), "VERIFIED");
  assert.equal(completionStatus(pass, { ...task, status: "ACTIVE" }), "UNVERIFIED");
  assert.equal(completionStatus({ ...pass, shadowMode: true }, task), "UNVERIFIED");
  assert.equal(completionStatus({ ...pass, correctionBudgetExhausted: true }, task), "BUDGET_EXHAUSTED");
  assert.equal(completionStatus({ decision: "allow", review: { stopClassification: "WAITING_FOR_USER" } }, task), "WAITING_FOR_USER");
});

test("a genuine requirement during assessment cancels that assessment and is durably received before the next turn", async (t) => {
  let started;
  const reviewing = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { assess: async ({ request, assessments }) => {
    if (assessments !== 1) return;
    started();
    await new Promise((_, reject) => request.abortSignal.addEventListener("abort", () => reject(request.abortSignal.reason), { once: true }));
  } });
  const running = f.harness.runAttempt(f.params);
  await reviewing;
  let persisted = false;
  await f.handles.get(f.params.sessionId).queueMessage("Keep the filename result.txt.", { userTurnTranscriptRecorder: {
    resolveMessage: async () => ({ role: "user", content: "Keep the filename result.txt.", provenance: { kind: "external_user" } }),
    persistApproved: async () => { persisted = true; }, hasPersisted: () => persisted,
  } });
  assert.equal(persisted, true);
  const result = await running;
  assert.equal(result.lastAssistant.content[0].text, "Task completed.");
  assert.equal(f.counts().rounds, 2);
});

test("infrastructure assessment retries never run the worker again or consume a correction turn", async (t) => {
  const f = await fixture(t, { assess: async ({ assessments }) => ({
    decision: assessments <= 2 ? "block" : "allow", status: "UNVERIFIED", feedback: "review service unavailable",
    verificationUnavailable: assessments > 2,
  }) });
  const result = await f.harness.runAttempt(f.params);
  assert.deepEqual(f.counts(), { rounds: 1, assessments: 3, begins: 1 });
  assert.match(result.lastAssistant.content[0].text, /尚未验证/u);
});

test("a worker cannot create a child controller, but its next ordinary verification still runs", async (t) => {
  const f = await fixture(t, { worker: async ({ child, root }) => {
    await assert.rejects(f.harness.runAttempt({ ...f.params, sessionId: "nested" }), /cannot create/u);
    await fs.writeFile(path.join(root, "result.txt"), "VERIFIED");
    return { payloads: [{ text: "Done" }], meta: {} };
  } });
  assert.equal((await f.harness.runAttempt(f.params)).lastAssistant.content[0].text, "Done");
  assert.equal(f.counts().assessments, 1);
});

test("a stale generation cannot overwrite newer controller state", async (t) => {
  const f = await fixture(t);
  await withController({ projectRoot: f.root, sessionId: "stale", runId: "stale" }, async (store) => {
    await privateJson(path.join(store.directory, "control.json"), { generation: "replacement", phase: "EXECUTING" });
    await assert.rejects(store.save({ phase: "DELIVERED" }), /Superseded/u);
    assert.equal(await store.current(), false);
    return { status: "UNVERIFIED" };
  });
});

test("two sessions retain independent controllers in the same workspace", async (t) => {
  const f = await fixture(t, { assess: async () => ({ reason: "STOP_BARRIER_NOT_REQUIRED" }), evidence: async () => "stable",
    worker: async () => ({ payloads: [{ text: "Hello" }], meta: {} }) });
  const results = await Promise.all([f.harness.runAttempt(f.params), f.harness.runAttempt({ ...f.params, sessionId: randomUUID(),
    runId: randomUUID(), sessionFile: path.join(f.root, ".native", "second.jsonl") })]);
  assert.deepEqual(results.map((result) => result.lastAssistant.content[0].text), ["Hello", "Hello"]);
  assert.equal(f.counts().begins, 2);
  assert.equal(f.handles.size, 0);
});

test("evidence follows reviewed and modified files without invalidating unrelated concurrent work", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "one.txt"), "VERIFIED");
  await fs.writeFile(path.join(f.root, "two.txt"), "DRAFT");
  const ledger = createEvidenceLedger(f.root);
  await ledger.capture([path.join(f.root, "one.txt")]);
  await fs.writeFile(path.join(f.root, "two.txt"), "VERIFIED");
  assert.equal(await ledger.matches(), true);
  await ledger.observeTool("read", { path: "two.txt" });
  await fs.writeFile(path.join(f.root, "two.txt"), "DRAFT");
  assert.equal(await ledger.matches(), false);
  await ledger.observeTool("read", { path: "two.txt" });
  await fs.writeFile(path.join(f.root, "two.txt"), "VERIFIED");
  assert.equal(await ledger.matches(), false, "unstable evidence cannot be repaired by restoring bytes after the review");
});

test("parent events are awaited in order, so a late progress callback cannot revive a finished run", async (t) => {
  const f = await fixture(t);
  const events = [];
  await f.harness.runAttempt({ ...f.params, onAgentEvent: async (event) => {
    await new Promise((resolve) => setTimeout(resolve, event.stream === "assistant" ? 10 : 1));
    if (event.stream !== "item") events.push(event.data.phase ?? "progress");
  } });
  assert.deepEqual(events, ["start", "progress", "progress", "progress", "progress", "final", "end"]);
});

test("unfixed work stops at the core budget; a waiting question is delivered without claiming success", async (t) => {
  const f = await fixture(t, { assess: async ({ assessments }) => ({ decision: assessments < 3 ? "block" : "allow",
    correctionBudgetExhausted: assessments === 3, feedback: "The file is still wrong." }) });
  const result = await f.harness.runAttempt(f.params);
  assert.equal(f.counts().rounds, 3);
  assert.match(result.lastAssistant.content[0].text, /次数已用尽/u);
  const waiting = await fixture(t, { assess: async () => ({ decision: "allow", review: { stopClassification: "WAITING_FOR_USER" } }),
    worker: async () => ({ payloads: [{ text: "Which destination should I use?" }], meta: {} }) });
  const question = await waiting.harness.runAttempt(waiting.params);
  assert.match(question.lastAssistant.content[0].text, /自动执行已暂停/u);
  assert.match(question.lastAssistant.content[0].text, /Which destination/u);
  assert.equal(waiting.counts().rounds, 1);
});

for (const stop of ["reset", "dispose", "disable"]) test(`${stop} cancels the active native worker without another round`, async (t) => {
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const f = await fixture(t, { worker: async ({ child }) => {
    ready();
    await new Promise((_, reject) => child.abortSignal.addEventListener("abort", () => reject(child.abortSignal.reason), { once: true }));
  } });
  const running = f.harness.runAttempt(f.params);
  await started;
  if (stop === "disable") f.api.pluginConfig.supervisedExecution = false;
  else await f.harness[stop](stop === "reset" ? { sessionId: f.params.sessionId } : undefined);
  assert.equal((await running).aborted, true);
  assert.equal(f.counts().rounds, 1);
  assert.equal(f.counts().assessments, 0);
});

test("another process cannot dispatch while a controller owns the same parent session", async (t) => {
  const f = await fixture(t);
  const args = { projectRoot: f.root, sessionId: f.params.sessionId, runId: "other-process" };
  const script = `import {withController} from ${JSON.stringify(new URL("../lib/openclaw/controller-store.mjs", import.meta.url).href)};
    await withController(${JSON.stringify(args)},async()=>{process.stdout.write('LOCKED\\n');await new Promise(r=>process.stdin.once('data',r));return {status:'UNVERIFIED'};});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", () => reject(new Error("lock owner exited early"))); });
  const blocked = await f.harness.runAttempt(f.params);
  assert.match(blocked.lastAssistant.content[0].text, /尚未验证/u);
  assert.equal(blocked.replayMetadata.replaySafe, false);
  assert.equal(f.counts().rounds, 0);
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end("done\n");
  await exit;
});

test("only owned native work and review activity renews parent liveness, never stale callbacks", async (t) => {
  let listener, removed = false;
  const reported = [];
  const f = await fixture(t, { worker: async ({ child, root }) => {
    listener({ type: "run.progress", runId: child.runId });
    listener({ type: "run.progress", runId: "another-task" });
    await fs.writeFile(path.join(root, "result.txt"), "VERIFIED");
    return { payloads: [{ text: "Done" }], meta: {} };
  }, assess: async ({ state }) => {
    state.onReviewRunStart("review-run");
    listener({ type: "model.call.completed", runId: "review-run" });
    state.onReviewRunEnd("review-run");
    listener({ type: "run.progress", runId: "review-run" });
  } });
  f.sdk.onRunActivity = (handler) => { listener = handler; return () => { removed = true; }; };
  f.sdk.reportProgress = (params, reason) => {
    assert.equal(params.sessionId, f.params.sessionId);
    reported.push(reason);
    listener({ type: "run.progress", runId: params.runId });
  };
  await f.harness.runAttempt(f.params);
  assert.equal(reported.filter((reason) => reason === "runtime-corrector:run.progress").length, 1);
  assert.equal(reported.filter((reason) => reason === "runtime-corrector:model.call.completed").length, 1);
  assert.equal(removed, true);
  const count = reported.length;
  listener({ type: "run.progress", runId: "review-run" });
  assert.equal(reported.length, count);
});

test("real review activity keeps an awaiting native worker alive without reflecting its own progress", async (t) => {
  let listener, state, childRunId;
  const reported = [];
  const f = await fixture(t, { worker: async ({ child }) => {
    childRunId = child.runId;
    state.onReviewRunStart("tool-review");
    listener({ type: "run.progress", runId: "tool-review" });
    state.onReviewRunEnd("tool-review");
    listener({ type: "run.progress", runId: "tool-review" });
    return { payloads: [{ text: "Done" }], meta: {} };
  }, assess: async () => ({ reason: "STOP_BARRIER_NOT_REQUIRED" }) });
  const begin = f.runtime.beginSupervised;
  f.runtime.beginSupervised = async (...args) => { state = await begin(...args); return state; };
  f.sdk.onRunActivity = (handler) => { listener = handler; return () => {}; };
  f.sdk.reportProgress = (params, reason) => {
    reported.push({ runId: params.runId, reason });
    listener({ type: "run.progress", runId: params.runId, reason });
  };
  await f.harness.runAttempt(f.params);
  assert.deepEqual(reported.filter((event) => event.runId === childRunId),
    [{ runId: childRunId, reason: "runtime-corrector:review:run.progress" }]);
  assert.equal(reported.filter((event) => event.reason === "runtime-corrector:run.progress").length, 1);
});

test("a host-ended worker aborts pending review work but remains unverified instead of user-cancelled", async (t) => {
  let workSignal;
  const f = await fixture(t, { worker: async ({ child }) => {
    workSignal = child.abortSignal;
    throw new Error("native watchdog ended the worker");
  } });
  const result = await f.harness.runAttempt(f.params);
  assert.equal(workSignal.aborted, true);
  assert.equal(result.aborted, false);
  assert.match(result.lastAssistant.content[0].text, /尚未验证/u);
  assert.equal(f.counts().assessments, 0);
});

test("long native sessions retain a bounded transcript lock and respect explicit operator settings", async () => {
  const { withNativeSessionLockBudget } = await import("../lib/openclaw/native-config.mjs");
  const config = { session: { writeLock: { staleMs: 10000 } } };
  assert.equal(withNativeSessionLockBudget(config, 900000).session.writeLock.maxHoldMs, 905000);
  assert.equal(config.session.writeLock.maxHoldMs, undefined);
  const explicit = { session: { writeLock: { maxHoldMs: 120000 } } };
  assert.equal(withNativeSessionLockBudget(explicit, 900000), explicit);
});
