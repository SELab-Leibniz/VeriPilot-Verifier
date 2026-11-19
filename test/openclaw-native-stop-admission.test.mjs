import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { readMaterialBasis } from "../lib/openclaw/material-basis.mjs";
import { createOpenClawReviewerFactory } from "./helpers/legacy-openclaw-reviewer.mjs";
import { runInternalExecution } from "../lib/openclaw/internal-context.mjs";
import { createNativeStopFixture, basic, deferred, pause, until, within } from "./support/openclaw-native-stop-fixture.mjs";

const { lifecycle, findTask, withTaskState, readReport } = createNativeStopFixture();

test("an old post-run review waiting on background work cannot replace a newer host controller", async t => {
  const f = await lifecycle(t, { waitMode: "until_pass", postRunTerminal: async () => ({ status: "ok" }) });
  const finish = deferred(t), oldController = f.state.reviewController;
  f.state.hotReviewWork = { controller: oldController, promise: finish.promise };
  await f.runtime.postRuns.candidate(f.post(), { runId: f.ctx.runId, text: "Old candidate.", reviewBudgetMs: 10000 });
  await until(() => f.post().phase === "REVIEWING", "old post-run review waiting");
  f.api.config.plugins = { entries: { autopilot: { enabled: true } } };
  const request = f.api.runtime.gateway.request;
  f.api.runtime.gateway.request = (method, ...args) => method === "autopilot.status" ? { projection: { status: "running" } } : request(method, ...args);
  const next = { ...f.ctx, runId: "newer-host-run" };
  await f.runtime.prompt({ prompt: "New trusted host run." }, next);
  const current = f.state.reviewController;
  assert.notEqual(current, oldController); finish.resolve(); await f.runtime.postRuns.drain();
  assert.equal(f.state.reviewController, current); assert.equal(f.state.nativeRunId, next.runId); assert.equal(current.signal.aborted, false);
});

test("a queued business turn waits before replacing the old run, while UI status never enters model history", async t => {
  const started = deferred(t), finish = deferred(t), events = [];
  const f = await lifecycle(t, { review: async () => { started.resolve(); await finish.promise; },
    compatibility: async () => ({ emitAgentEvent: event => events.push(event) }) });
  const source = path.join(f.root, "native.jsonl"), original = await fs.readFile(source, "utf8");
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Original delivery." } }, f.ctx);
  await within(started.promise, "started signal");
  const oldController = f.state.reviewController;
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  const nextContext = { ...f.ctx, runId: "next-run" };
  const prompt = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, nextContext)
    .then(() => f.runtime.prompt({ prompt: "Next business task" }, nextContext));
  await pause(30);
  assert.equal(passed, false);
  assert.equal(f.state.nativeRunId, f.ctx.runId);
  assert.equal(oldController.signal.aborted, false);
  assert(events.some(event => event.stream === "tool" && event.runId === "next-run"
    && event.data.partialResult?.views[0].text.includes("后续任务暂缓")));
  assert(!events.some(event => event.stream === "assistant"));
  finish.resolve();
  await Promise.all([next, prompt]);
  const [record] = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(record.reviewStatus, "NO_DEVIATION_FOUND");
  assert.equal(f.state.nativeRunId, "next-run");
  assert.equal(await fs.readFile(source, "utf8"), original, "status is UI-only, not a host user/assistant message");
});

test("Stop deadline releases a hung backend and ignores its late PASS/commit even when cancellation cleanup hangs", async t => {
  const params = await basic(t), manager = createNativeStopReviews(), started = deferred(t), finish = deferred(t);
  let commit, reviewSignal;
  await manager.schedule({ ...params, budgetMs: 100, onCancel: () => new Promise(() => {}),
    run: async input => { commit = input.commit; reviewSignal = input.signal; started.resolve(); await finish.promise; return { reviewStatus: "PASS" }; } });
  await within(started.promise, "started signal");
  const [job] = manager.pending(params);
  const result = await job.released;
  assert.equal(result.reviewStatus, "UNVERIFIED");
  assert.equal(result.reasonCode, "REVIEW_DEADLINE_EXPIRED");
  assert.equal(reviewSignal.aborted, true);
  assert.equal(manager.pending(params).length, 0);
  await assert.rejects(commit({ reviewStatus: "PASS" }), { code: "RC_STOP_REVIEW_STALE" });
  finish.resolve();
  assert.equal((await manager.wait())[0].reviewStatus, "UNVERIFIED");
  await pause(10);
  const base = path.join(params.projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
  assert.equal(JSON.parse(await fs.readFile(file)).reviewStatus, "UNVERIFIED");
});

test("reset releases waiting tasks immediately and another session is never held by the gate", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { review: async () => { started.resolve(); await finish.promise; } });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(started.promise, "started signal");
  await f.runtime.beforeDispatch({ sessionKey: "agent:main:another-session" }, {});
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  await pause(10);
  assert.equal(passed, false);
  await f.runtime.reset({}, f.ctx);
  await next;
  assert.equal((await within(f.runtime.waitForNativeReviews(), "native review settlement"))[0].reviewStatus, "CANCELLED");
  assert.equal(f.hostAbort.signal.aborted, false);
  finish.resolve();
  await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
});

test("a cancelled incoming task does not replace or cancel the pending review", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { review: async () => { started.resolve(); await finish.promise; } });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(started.promise, "started signal");
  const abort = new AbortController();
  const nextContext = { ...f.ctx, runId: "cancelled-next", abortSignal: abort.signal };
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, nextContext).then(() => f.runtime.prompt({}, nextContext));
  await pause(10); abort.abort(); await next;
  assert.equal(f.state.nativeRunId, f.ctx.runId);
  assert.equal(f.state.reviewController.signal.aborted, false);
  finish.resolve();
  assert.equal((await within(f.runtime.waitForNativeReviews(), "native review settlement"))[0].reviewStatus, "NO_DEVIATION_FOUND");
});

test("incoming model admission already inside the lane releases immediately and fences an uncooperative review", async t => {
  const started = deferred(t), finish = deferred(t), events = [];
  const f = await lifecycle(t, {
    compatibility: async () => ({ emitAgentEvent: event => events.push(event) }) });
  // Hang at the opaque model dependency, before role-specific preparation can
  // select another review outcome. The lane fence must cover every role.
  f.api.runtime.agent.reviewAdmission=async()=>{started.resolve();await finish.promise;};
  f.api.config.plugins = { entries: { "runtime-corrector": { hooks: { timeouts: { before_model_resolve: 1100 } } } } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(started.promise, "started signal");
  const enteredAt = Date.now();
  await f.runtime.beforeModelResolve({}, { ...f.ctx, runId: "next-after-expiry" });
  assert(Date.now() - enteredAt < 300);
  assert.equal((await within(f.runtime.waitForNativeReviews(), "native review settlement"))[0].reviewStatus, "UNVERIFIED");
  assert(!events.some(event => event.stream === "assistant"));
  finish.resolve();
  await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
  const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.notEqual(task.verification?.status, "PASS");
});

test("new business waits for the deviation feedback admission receipt, not only the assessment", async t => {
  const admitted = deferred(t), dispatching = deferred(t);
  let childRunId;
  const f = await lifecycle(t, { deviation: true });
  f.api.runtime.subagent = { run: async args => {
    childRunId=args.idempotencyKey;
    dispatching.resolve(); await admitted.promise;
    return { runId: args.idempotencyKey };
  } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(dispatching.promise, "dispatching signal");
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  await pause(30);
  assert.equal(passed, false, "committing an assessment must not release a pending dispatch");
  admitted.resolve();await f.runtime.prompt({prompt:'RC feedback'}, {...f.ctx,runId:childRunId});await next;
  const [record] = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(record.reviewStatus, "DEVIATION");
  assert.match(record.followupStatus,/^(?:DELIVERED|STARTED)$/u,'the returned transport snapshot must prove delivery, never just queue acceptance');
  const delivered=await f.sharedState.stopStartProtocol.findRun({state:f.state,runId:childRunId});assert.equal(delivered.admission.deliveryStatus,'DELIVERED');assert(delivered.admission.startedAt);
});

test("a crashed review releases admission as UNVERIFIED without waiting for its deadline", async t => {
  const params = await basic(t), manager = createNativeStopReviews();
  await manager.schedule({ ...params, run: async () => { throw Object.assign(new Error("Checker unavailable"), { code: "CHECKER_DOWN" }); } });
  const [record] = await manager.wait();
  assert.equal(record.reviewStatus, "UNVERIFIED");
  assert.equal(record.reasonCode, "CHECKER_DOWN");
  assert.equal(manager.pending(params).length, 0);
});

test("manual check recovers the exact native tool call while its own correction chain is pending", async t => {
  let childRunId;
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass" });
  t.after(() => f.runtime.dispose());
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(f.runtime.waitForNativeReviews(), "native review settlement");
  const child = { ...f.ctx, runId: childRunId }, { runId, abortSignal, ...factoryContext } = child;
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  const toolCallId = "check-in-correction";
  await f.runtime.beforeTool({ toolName: "runtime_corrector", toolCallId, params: { command: "check", subject: "draft.md" } }, child);
  const checked = await Promise.race([
    f.runtime.manualCheck(factoryContext, "draft.md", { toolCallId, signal: abortSignal }),
    pause(1500).then(() => { throw new Error("Manual check waited on its own Stop chain."); }),
  ]);
  assert.equal(checked.matched, true);
  assert.equal(!["IDLE", "CLOSED"].includes(f.post().phase), true, "A manual check must not release the task gate.");
  await assert.rejects(f.runtime.manualCheck(factoryContext, "draft.md"), /RC_CHECK_INVOCATION_UNAVAILABLE/u);
  await assert.rejects(f.runtime.manualCheck(factoryContext, "draft.md", { toolCallId: "unbound" }), /RC_CHECK_INVOCATION_UNAVAILABLE/u);
  await assert.rejects(f.runtime.manualCheck({ ...factoryContext, sessionId: "foreign" }, "draft.md", { toolCallId }), /RC_CHECK_INVOCATION_UNAVAILABLE/u);
  await assert.rejects(f.runtime.manualCheck(factoryContext, "draft.md", { toolCallId, signal: AbortSignal.abort() }), /RC_CHECK_CANCELLED/u);
  const bindings = f.sharedState.toolBindings.get(toolCallId), original = [...bindings.values()][0];
  bindings.set("ambiguous", { ...original });
  await assert.rejects(f.runtime.manualCheck(factoryContext, "draft.md", { toolCallId }), /RC_CHECK_INVOCATION_UNAVAILABLE/u);
  bindings.delete("ambiguous");
  await f.runtime.postRuns.release(f.post(), "POST_RUN_EXECUTION_TIMEOUT"); await within(f.runtime.waitForNativeReviews(), "native review settlement");
  await assert.rejects(f.runtime.manualCheck(factoryContext, "draft.md", { toolCallId }), /RC_CHECK_(?:INVOCATION_UNAVAILABLE|CANCELLED)/u);
});
