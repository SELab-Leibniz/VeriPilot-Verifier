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

test('late agent_end reconciles a failed hook despite its cancelled reviewer signal', async t => {
  let drained = false;
  const f = await lifecycle(t, { waitMode: 'until_pass',
    postRunTerminal: async (_identity, runId) => drained ? { runId, status: 'ok' } : null });
  const identity = { agentId: f.state.agentId, sessionId: f.state.sessionId, sessionKey: f.state.sessionKey,
    projectRoot: f.state.projectRoot, scopeFingerprint: f.state.projectScope.fingerprint,
    controlRevision: f.state.enabledRevision ?? 0, scopeTaskId: f.state.scopeTaskId };
  f.state.nativeInvalidated = true;
  const controller = f.state.reviewController;
  controller.abort(Object.assign(new Error('failed hook'), { code: 'RC_HOOK_UNAVAILABLE' }));
  await f.runtime.postRuns.release(identity, 'RC_HOOK_UNAVAILABLE');
  assert.equal(f.runtime.postRuns.snapshot(identity).phase, 'RELEASING');
  drained = true;
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await until(() => f.runtime.postRuns.snapshot(identity).phase === 'IDLE', 'late gateway terminal reconciliation');
  const record = f.runtime.postRuns.snapshot(identity);
  assert.equal(record.reviewStatus, 'UNVERIFIED');
  assert.equal(record.reason, 'RC_HOOK_UNAVAILABLE');
  assert.equal(f.state.reviewController, controller);
  assert.equal(controller.signal.aborted, true);
  assert.equal(f.calls(), 0, 'the failed stage cannot restart semantic review');
  assert.equal(f.hostAbort.signal.aborted, false);
  const next = { ...f.ctx, runId: 'next-coding-stage' };
  await f.runtime.prompt({ prompt: 'Continue implementing the same task.' }, next);
  await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'next-write', params: { path: 'draft.md' } }, next);
  await f.state.hotReviewWork?.promise;
  assert.equal(f.state.nativeInvalidated, false);
  assert.notEqual(f.state.reviewController, controller);
  await f.runtime.reply({ kind: 'final', runId: next.runId, sessionKey: next.sessionKey,
    payload: { text: 'Delivered the implementation.' } }, next);
  await f.runtime.waitForNativeReviews({ drain: true });
  const task = await findTask({ projectRoot: f.root, sessionId: 'host' });
  assert.equal(task.verification.status, 'NO_DEVIATION_FOUND');
  assert(f.calls() > 0, 'the next stage must enter a full semantic Stop review');
});

test("terminal registration returns before slow reviews and coalesces duplicate hooks", async t => {
  const params = await basic(t), manager = createNativeStopReviews();
  let finish, started = 0, markStarted;
  const ready = new Promise(resolve => { markStarted = resolve; });
  const run = async () => { started++; markStarted(); await new Promise(resolve => { finish = resolve; }); return { reviewStatus: "PASS" }; };
  const record = await manager.schedule({ ...params, run });
  assert.equal(record.status, "PENDING");
  assert.equal(started, 0);
  await manager.schedule({ ...params, run });
  await Promise.race([ready, manager.wait().then(results => {
    if (!started) assert.fail(`review settled before starting: ${JSON.stringify(results)}`);
  })]);
  assert.equal(started, 1);
  finish(); const results = await manager.wait();
  assert.equal(results[0].status, "SETTLED"); assert.equal(results[0].reviewStatus, "PASS");
  const restarted = createNativeStopReviews();
  await restarted.schedule({ ...params, run });
  await restarted.wait({ drain: true });
  assert.equal(started, 1, "persisted terminal checkpoint must not replay model work");
});
test("two sequential non-Stop native reviewer roles each retain configured time beyond a short Hook window", async t => {
  const params = await basic(t), manager = createNativeStopReviews(), timeouts = [];
  let roleStartedAt;
  const api = { config: { agents: { defaults: { model: { primary: "test/test" } } } }, runtime: { agent: {
    runEmbeddedAgent: async input => { timeouts.push({ timeoutMs: input.runTimeoutOverrideMs, setupMs: Date.now() - roleStartedAt });
      await pause(1200); return { payloads: [{ text: '{"ok":true}' }], meta: {} }; },
  } } };
  const factory = createOpenClawReviewerFactory(api, {});
  await manager.schedule({ ...params, run: async ({ deadlineAt }) => {
    for (const role of ["ground-truth-extractor", "implementation-reviewer"]) {
      roleStartedAt = Date.now();
      const handle = await factory({ projectRoot: params.projectRoot, taskId: "task", role,
        reviewer: { timeoutMs: 4000 }, deadlineAt,
        schema: { type: "object", required: ["ok"], additionalProperties: false, properties: { ok: { type: "boolean" } } }, request: { instructions: ["fixture"] } });
      assert.equal(handle.result.ok, true); await handle.close();
    }
    return { reviewStatus: "PASS" };
  } });
  assert.equal((await manager.wait())[0].reviewStatus, "PASS");
  // Initialization belongs to this role's budget; it is not time spent by the
  // previous role. Counting it preserves the independent-budget assertion.
  assert.equal(timeouts.length, 2);
  assert(timeouts.every(value => value.timeoutMs + value.setupMs >= 3900), JSON.stringify(timeouts));
});
test("cancellation before model admission never performs work or becomes PASS", async t => {
  const params = await basic(t), controller = new AbortController(), manager = createNativeStopReviews();
  let calls = 0;
  await manager.schedule({ ...params, signal: controller.signal, run: async () => { calls++; return { reviewStatus: "PASS" }; } });
  controller.abort("reset"); const results = await manager.wait();
  assert.equal(calls, 0); assert.equal(results[0].reviewStatus, "CANCELLED");
});
test("an abandoned durable receipt becomes unverified without replay", async t => {
  const params = await basic(t), controller = new AbortController(), manager = createNativeStopReviews();
  await manager.schedule({ ...params, signal: controller.signal, run: async () => ({ reviewStatus: "PASS" }) });
  controller.abort(); await manager.wait();
  const base = path.join(params.projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
  const record = JSON.parse(await fs.readFile(file)); record.status = "RUNNING"; await fs.writeFile(file, JSON.stringify(record));
  let calls = 0;
  const restarted = createNativeStopReviews();
  const loaded = await restarted.schedule({ ...params, run: async () => { calls++; } });
  await restarted.wait({ drain: true });
  assert.equal(loaded.reviewStatus, "UNVERIFIED"); assert.equal(loaded.reasonCode, "REVIEW_OWNER_LOST"); assert.equal(calls, 0);
});

test("recovery retains a committed assessment without replaying uncertain continuation work", async t => {
  const params = await basic(t), manager = createNativeStopReviews();
  await manager.schedule({ ...params, run: async ({ commit }) => {
    await commit({ reviewStatus: "DEVIATION", evaluationId: "committed-evaluation" });
    throw Object.assign(new Error("Dispatch lost"), { code: "DISPATCH_UNKNOWN" });
  } });
  const [record] = await manager.wait();
  assert.equal(record.reviewStatus, "DEVIATION"); assert.equal(record.evaluationId, "committed-evaluation");
  const base = path.join(params.projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
  await fs.writeFile(file, JSON.stringify({ ...record, status: "RUNNING" }));
  const restarted = createNativeStopReviews();
  const restored = await restarted.schedule({ ...params, run() { assert.fail("No replay after owner loss"); } });
  await restarted.wait({ drain: true });
  assert.equal(restored.reviewStatus, "DEVIATION"); assert.equal(restored.reasonCode, "REVIEW_OWNER_LOST");
  assert.equal(restored.evaluationId, "committed-evaluation");
});
test("native reply preserves payload and finishes RC terminal work in its independent window", async t => {
  const f = await lifecycle(t), payload = { text: "Delivered.", mediaUrl: "fixture://media" }, original = structuredClone(payload);
  const response = await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload }, f.ctx);
  assert.equal(response, undefined, "RC progress must not rewrite the host's reply payload");
  assert.deepEqual(payload, original); assert.equal(f.calls(), 0);
  const records = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(records[0].budgetMs, 11000);
  assert.equal(records[0].reviewStatus, "NO_DEVIATION_FOUND", JSON.stringify(records));
  assert.equal(f.hostAbort.signal.aborted, false);
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.ok(task.verification.rulesDigest, "Native Stop must retain the project policy binding");
  assert.ok(task.verification.evidence?.fingerprints[path.join(f.root, "draft.md")], "Native Stop must retain its observed source fingerprints");
  const binding = { workspaceDir: f.root, sessionId: "host", sessionKey: f.ctx.sessionKey };
  assert.equal((await readReport(binding)).verification, "NO_DEVIATION_FOUND", "The report must recognize a fresh native acceptance");
  await fs.writeFile(path.join(f.root, "draft.md"), "Changed after review.\n");
  assert.equal((await readReport(binding)).verification, "STALE", "A later source edit must invalidate acceptance");
});
test("all Stop metrics and file quality off settle the native wait as DISABLED without model review or correction", async t => {
  const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, "0")}`, false]));
  const f = await lifecycle(t, { deviation: true, metrics, waitMode: "until_pass" });
  f.api.runtime.subagent = { run: () => assert.fail("Disabled review cannot dispatch a corrective business run.") };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
  assert.equal(record.reviewStatus, "DISABLED"); assert.equal(!["IDLE", "CLOSED"].includes(f.post().phase), false);
  assert.equal(f.calls(), 0);
  const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.equal(task.verification.status, "DISABLED"); assert.equal(task.stop.correctionAttempts, 0);
  assert.equal(f.hostAbort.signal.aborted, false);
});

test("a fresh Gateway rediscovers modified artifacts from the active native transcript before accepting an exec-only continuation", async t => {
  const f = await lifecycle(t);
  await fs.appendFile(path.join(f.root, "native.jsonl"), "\n" + [
    { type: "message", id: "written", parentId: "u", message: { role: "assistant", content: [
      { type: "toolCall", id: "prior-write", name: "write", arguments: { path: "draft.md", content: "A delivered draft.\n" } } ] } },
    { type: "message", id: "write-result", parentId: "written", message: { role: "toolResult", toolCallId: "prior-write", toolName: "write",
      content: [{ type: "text", text: "Wrote draft.md" }], isError: false } },
  ].map(JSON.stringify).join("\n"));
  const runtime = f.restart(), ctx = { ...f.ctx, runId: "after-gateway-restart" };
  await runtime.beforeTool({ toolName: "exec", toolCallId: "check", params: { command: "validate draft.md" } }, ctx);
  await runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "Delivered." } }, ctx);
  const receipts = await runtime.waitForNativeReviews();
  assert.equal(receipts[0].reviewStatus, "NO_DEVIATION_FOUND", JSON.stringify(receipts));
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.ok(task.verification.evidence.fingerprints[path.join(f.root, "draft.md")]);
  const binding = { workspaceDir: f.root, sessionId: "host", sessionKey: ctx.sessionKey };
  assert.equal((await readReport(binding)).verification, "NO_DEVIATION_FOUND");
  await fs.writeFile(path.join(f.root, "draft.md"), "Changed after the restart's review.\n");
  assert.equal((await readReport(binding)).verification, "STALE");
});

test("a terminal review that cannot read its native transcript never inherits an earlier run's PASS", async t => {
  const f = await lifecycle(t);
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  assert.equal((await within(f.runtime.waitForNativeReviews(), "native review settlement"))[0].reviewStatus, "NO_DEVIATION_FOUND");
  const original = await findTask({ projectRoot: f.root, sessionId: "host" });
  const ctx = { ...f.ctx, runId: "unreadable-native-run" };
  await f.runtime.beforeTool({ toolName: "exec", toolCallId: "check", params: { command: "validate draft.md" } }, ctx);
  await fs.appendFile(path.join(f.root, "native.jsonl"), '\n{"torn":');
  await f.runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "Delivered." } }, ctx);
  const receipts = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(receipts.find(record => record.runId === ctx.runId).reviewStatus, "UNVERIFIED");
  assert.equal(receipts.find(record => record.runId === ctx.runId).evaluationId, null);
  const current=await findTask({projectRoot:f.root,sessionId:'host'});
  assert.equal(current.verification.status,'UNVERIFIED');assert.equal(current.status,'STOPPED_UNVERIFIED');
  assert.equal(current.verification.previousVerification.assessmentId,original.verification.assessmentId,'the old PASS remains historical evidence, not the current verdict');
});
test("transient checker faults retry RC review without spending business corrections", async t => {
  const f = await lifecycle(t, { failures: 2 });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const records = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(records[0].reviewStatus, "NO_DEVIATION_FOUND", JSON.stringify(records));
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.stop.correctionAttempts, 0);
  assert.equal(task.stop.infrastructureTotalFailures, 2);
});
test("reset invalidates a queued native Stop without cancelling host settings", async t => {
  const f = await lifecycle(t);
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await f.runtime.reset({}, f.ctx);
  const records = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert(records.every(record => record.reviewStatus === "CANCELLED"), "reset may beat asynchronous registration; no review may pass");
  if (!records.length) assert.equal(f.calls(), 0, "an unregistered cancelled Stop never starts reviewer work");
  assert.equal(f.hostAbort.signal.aborted, false);
  // Release must precede backend cleanup; this controlled fake does finish.
  // Drain it before the fixture removes its temporary project directory.
  await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
});

test("ongoing review cancellation cannot return PASS or mutate host cancellation", async t => {
  const f = await lifecycle(t);
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await until(() => f.calls() > 0, "native review to start");
  await f.runtime.reset({}, f.ctx);
  const records = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(records[0].reviewStatus, "CANCELLED");
  assert.equal(f.hostAbort.signal.aborted, false);
  await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
});

test("confirmed file-quality deviations reach the next normal host prompt without changing their delivery policy", async t => {
  const f = await lifecycle(t, { quality: [{ path: "draft.md", status: "DEVIATION", reason: "The heading omits the subject, so the draft cannot be identified.", evidence: ["draft.md:1"] }] });
  let admissions = 0;
  f.api.runtime.subagent = { run: async () => { admissions++; throw new Error("Quality uncertainty must not admit another business run."); } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
  assert.equal(record.reviewStatus, "DEVIATION");
  assert.match(record.verificationFeedback, /heading omits the subject/);
  assert.equal(admissions, 0);
  await fs.appendFile(path.join(f.root, "native.jsonl"), "\n" + JSON.stringify({ type: "message", id: "next-user", parentId: "u",
    message: { role: "user", content: "Continue the task using the existing requirements." } }) + "\n");
  const response = await f.runtime.prompt({ prompt: "Continue the task using the existing requirements." }, { ...f.ctx, runId: "next-normal-run" });
  assert.match(response?.prependContext ?? "", /heading omits the subject/);
  assert.match(response.prependContext, /历史评审/);
  assert.ok(Buffer.byteLength(response.prependContext, "utf8") <= 8192);
  assert.equal(admissions, 0);
});

test("an unresolved file-quality observation stays local after a completed zero-deviation Stop", async t => {
  const reason = 'The optional visual check cannot be settled with these observations.';
  const f = await lifecycle(t, { quality: [{ path: 'draft.md', status: 'UNVERIFIED', reason, evidence: [] }] });
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: 'Delivered.' } }, f.ctx);
  const [record] = await within(f.runtime.waitForNativeReviews({ drain: true }), 'native review settlement');
  assert.equal(record.reviewStatus, 'NO_DEVIATION_FOUND');
  assert.equal(Boolean(record.verificationFeedback), false);
  const task = await findTask({ projectRoot: f.root, sessionId: 'host' });
  assert.equal(task.stop.infrastructureTotalFailures, 0);
  const response = await f.runtime.prompt({ prompt: 'Continue.' }, { ...f.ctx, runId: 'next-normal-run' });
  assert.doesNotMatch(response?.prependContext ?? '', /optional visual check/);
});
test("permanent checker faults stop at the existing infrastructure ceiling", async t => {
  const f = await lifecycle(t, { failures: 20 });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const records = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(records[0].reviewStatus, "UNVERIFIED");
  assert.equal(task.stop.infrastructureTotalFailures, 3);
  assert.equal(task.stop.correctionAttempts, 0);
  assert.equal(task.status, "STOPPED_UNVERIFIED");
});

test("admission refusal after one checker failure settles without reusing that failure", async t => {
  const f = await lifecycle(t, { failures: 1 });
  let admissions = 0;
  f.api.runtime.agent.reviewAdmission = async () => {
    if (++admissions === 1) return;
    throw Object.assign(new Error("Admission closed"), { code: "GATEWAY_DRAINING" });
  };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(record.reviewStatus, "UNVERIFIED");
  assert.equal(record.reasonCode, "GATEWAY_DRAINING");
  assert.equal(admissions, 2);
  assert.equal(f.calls(), 1);
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.stop.infrastructureTotalFailures, 2,'one checker fault and the subsequent denied private admission are both retained');
  assert.equal(task.stop.correctionAttempts, 0);
});

test("first admission refusal cannot reuse a prior run PASS", async t => {
  const f = await lifecycle(t);
  f.state.nativeAssessment = { outcome: { decision: "allow", status: "PASS" } };
  let admissions = 0;
  f.api.runtime.agent.session.runWithWorkAdmission = async () => {
    admissions++; throw Object.assign(new Error("Forbidden"), { code: "PERMISSION_DENIED" });
  };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(record.reviewStatus, "UNVERIFIED");
  assert.equal(record.reasonCode, "PERMISSION_DENIED");
  assert.equal(admissions, 1);
  assert.equal(f.calls(), 0);
});

test("a continuation starting before admission returns cannot erase the committed previous assessment", async t => {
  const f = await lifecycle(t, { deviation: true });
  let dispatches = 0;
  f.api.runtime.subagent = { run: async args => {
    dispatches++;
    const base = path.join(f.root, ".runtime-correction/openclaw/native-stop-reviews");
    const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
    const committed = JSON.parse(await fs.readFile(file));
    assert.equal(committed.reviewStatus, "DEVIATION");
    assert(committed.evaluationId && committed.assessmentCompletedAt);
    await f.runtime.beforeModelResolve({}, { ...f.ctx, runId: args.idempotencyKey });
    await f.runtime.prompt({ prompt: "Write a draft." }, { ...f.ctx, runId: args.idempotencyKey });
    assert.equal(f.state.nativeAssessment, null, "The new run keeps its own empty assessment");
    return { runId: args.idempotencyKey };
  } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(dispatches, 1, JSON.stringify({ record, warnings: f.warnings, assessment: f.state.nativeAssessment }));
  assert.equal(record.reviewStatus, "DEVIATION");
  assert(record.evaluationId);
});

test("hot tool entry returns while extraction runs independently and result review waits for its guarded publication", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await within(lifecycle(t, { awaitInitialReview: false, hookTimeoutMs: 86400000, panelSize: 1,
    baselineReview: async () => { started.resolve(); await finish.promise; } }), "hot tool admission");
  await within(started.promise, "background extraction").catch(error => {
    error.message += JSON.stringify({ warnings: f.warnings, pending: Boolean(f.state.hotReviewWork),
      task: f.state.scopeTaskId, aborted: f.state.reviewController.signal.aborted }); throw error;
  });
  assert(f.state.hotReviewWork, "the pending model work remains outside the completed hot hook");
  let completed = false;
  const result = f.runtime.toolResult({ toolName: "write", toolCallId: "w", args: { path: "draft.md" },
    result: { content: [{ type: "text", text: "written" }] } }, f.ctx).then(value => { completed = true; return value; });
  await pause(25); assert.equal(completed, false);
  finish.resolve(); await within(result, "ordered result review");
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.groundTruth.version, 1, JSON.stringify(f.warnings));
  assert.equal(f.warnings.some(message => /DECISION_ATTEMPT_CLOSED/u.test(message)), false);
});

test("reset cancels background extraction before it can publish to the old task", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1,
    baselineReview: async () => { started.resolve(); await finish.promise; } });
  await within(started.promise, "background extraction");
  const pending = f.state.hotReviewWork.promise;
  await f.runtime.reset({ sessionId: "host" }, f.ctx);
  finish.resolve(); await within(pending, "cancelled background cleanup");
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.groundTruth.version, 0);
  assert.equal(f.state.reviewController.signal.aborted, true);
});

test("an ordinary read result does not wait for background extraction", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1,
    baselineReview: async () => { started.resolve(); await finish.promise; } });
  await within(started.promise, "background extraction");
  await within(f.runtime.beforeTool({ toolName: "read", toolCallId: "read", params: { path: "draft.md" } }, f.ctx), "read admission");
  await within(f.runtime.toolResult({ toolName: "read", toolCallId: "read", args: { path: "draft.md" },
    result: { content: [{ type: "text", text: "draft contents" }] } }, f.ctx), "ordinary read result");
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "host" })).groundTruth.version, 0);
  finish.resolve();
  await within(f.runtime.waitForBackgroundReviews(), "background drain");
});

test("dispose cancels without waiting for an uncooperative background reviewer and explicit drain settles its metadata", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1,
    baselineReview: async () => { started.resolve(); await finish.promise; } });
  await within(started.promise, "uncooperative background reviewer");
  await within(f.runtime.dispose(), "bounded runtime disposal", 1000);
  let drained = false;
  const draining = f.runtime.waitForBackgroundReviews().then(() => { drained = true; });
  await pause(20); assert.equal(drained, false);
  finish.resolve(); await within(draining, "cancelled background metadata drain");
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.groundTruth.version, 0); assert.equal(f.state.reviewController.signal.aborted, true);
  assert.equal(f.sharedState.hotReviewTasks.size, 0);
});

test("a waiting old tool result cannot enter a replacement run after background extraction settles", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1,
    baselineReview: async () => { started.resolve(); await finish.promise; } });
  await within(started.promise, "old background extraction");
  const oldController = f.state.reviewController;
  const oldResult = f.runtime.toolResult({ toolName: "write", toolCallId: "w", args: { path: "draft.md" },
    result: { content: [{ type: "text", text: "old result" }] } }, f.ctx);
  await pause(25);
  const next = { ...f.ctx, runId: "replacement-business" };
  const nextPrompt = f.runtime.prompt({ prompt: "Continue in the new run." }, next);
  await until(() => f.state.nativeRunId === next.runId, "replacement admission");
  assert.notEqual(f.state.reviewController, oldController);
  finish.resolve(); assert.equal(await within(oldResult, "stale result settlement"), undefined);
  await within(nextPrompt, "replacement prompt"); await f.state.hotReviewWork?.promise;
  assert.equal(f.state.seen.has("post:w"), false);
  assert.equal(f.state.hookRunId, next.runId);
  assert.equal(f.state.nativeNeedsStop, false);
  assert.equal(f.state.reviewController.signal.aborted, false);
});

test("first business overwrite cannot replace the original MATERIAL basis during detached extraction or restart", async t => {
  const started = deferred(t), finish = deferred(t), original = "Keep the original mandatory acceptance gate.\r\n";
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1, materialText: original,
    baselineReview: async () => { started.resolve(); await finish.promise; } });
  await within(started.promise, "material extraction started outside the hot hook");
  assert.equal((await readMaterialBasis(f.root, f.state.materialBasisTaskId)).status, "CAPTURED");
  await fs.writeFile(f.materialFile, "The business exec silently removed the original gate.\n");
  const pending = f.state.hotReviewWork.promise; finish.resolve(); await within(pending, "material freshness failure");
  await f.runtime.toolResult({ toolName: "write", toolCallId: "w", args: { path: "draft.md" },
    result: { content: [{ type: "text", text: "written" }] } }, f.ctx);
  let task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.groundTruth.version, 0); assert.equal(task.verification.status, "UNVERIFIED");
  assert.equal((await readMaterialBasis(f.root, task.taskId)).status, "UNVERIFIED");
  await fs.writeFile(f.materialFile, original);
  const restarted = f.restart(); t.after(() => restarted.dispose());
  await restarted.prompt({ prompt: "Continue the same task after restart." }, { ...f.ctx, runId: "after-material-restart" });
  task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.groundTruth.version, 0); assert.equal(task.verification.status, "UNVERIFIED");
  assert.match(task.materialBasis.reason, /^MATERIAL_BASIS_/u);
});

test("first mutation aliases establish original MATERIAL before execution without a preceding prompt or task", async t => {
  for (const initialToolName of ["PowerShell", "functions.powershell", "write_file", "functions.write_file", "exec_command",
    "functions.exec_command", "edit_file", "functions.notebook_edit", "Skill", "process"]) await t.test(initialToolName, async t => {
    const started = deferred(t), finish = deferred(t), original = "Preserve the original first-tool acceptance gate.\r\n";
    const f = await lifecycle(t, { initialPrompt: false, initialToolName, awaitInitialReview: false,
      panelSize: 1, materialText: original, baselineReview: async () => { started.resolve(); await finish.promise; } });
    const before = await findTask({ projectRoot: f.root, sessionId: "host" });
    assert.equal((await readMaterialBasis(f.root, before.taskId)).status, "CAPTURED", JSON.stringify(f.warnings));
    assert.equal(f.state.nativeNeedsStop, true, "all correction entry tools must arm Stop");
    await within(started.promise, "first-tool detached extraction");
    await fs.writeFile(f.materialFile, "The first mutation replaced the original gate.\n");
    const pending = f.state.hotReviewWork.promise; finish.resolve(); await within(pending, "first-tool freshness failure");
    await f.runtime.toolResult({ toolName: initialToolName, toolCallId: "w", args: { path: "draft.md" },
      result: { content: [{ type: "text", text: "mutation completed" }] } }, f.ctx);
    const task = await findTask({ projectRoot: f.root, sessionId: "host" });
    assert.equal(task.groundTruth.version, 0); assert.equal(task.verification.status, "UNVERIFIED");
    assert.equal((await readMaterialBasis(f.root, task.taskId)).status, "UNVERIFIED");
  });
});

test("an unchanged first qualified PowerShell tool establishes and publishes the original MATERIAL normally", async t => {
  const original = "Preserve the original qualified command requirement.\r\n";
  const f = await lifecycle(t, { initialPrompt: false, initialToolName: "functions.PowerShell", panelSize: 1, materialText: original });
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.groundTruth.version, 1, JSON.stringify(f.warnings));
  assert.equal((await readMaterialBasis(f.root, task.taskId)).status, "CAPTURED");
  const truth = JSON.parse(await fs.readFile(path.join(f.root, ".runtime-correction/tasks", task.taskId, "ground-truth/current.json"), "utf8"));
  assert(truth.claims.some(claim => claim.text === original.trim() && claim.authority === "MATERIAL_DERIVED"));
});

test("unchanged materials initialize normally and temporary replacement cannot enter inline source authority", async t => {
  const original = "Keep the complete original acceptance gate.\r\n";
  let observed = 0;
  const f = await lifecycle(t, { panelSize: 1, materialText: original, baselineReview: async params => {
    const entry = params.request.materials.entries[0], file = path.join(entry.root, entry.path);
    assert.equal(entry.text, original);
    await fs.writeFile(file, "A temporary weaker source that must never become original authority.\n");
    assert.equal((await params.readOriginalMaterial(file)).toString("utf8"), original);
    await fs.writeFile(file, original); observed++;
  } });
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert(observed > 0); assert.equal(task.groundTruth.version, 1, JSON.stringify(f.warnings));
  const truth = JSON.parse(await fs.readFile(path.join(f.root, ".runtime-correction/tasks", task.taskId, "ground-truth/current.json"), "utf8"));
  assert(truth.claims.some(claim => claim.text === original.trim() && claim.authority === "MATERIAL_DERIVED"));
  assert.equal((await readMaterialBasis(f.root, task.taskId)).status, "CAPTURED");
});

test("reset fences detached material publication while keeping the captured unchanged originals", async t => {
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1, materialText: "Preserve the original requirement.\n",
    baselineReview: async () => { started.resolve(); await finish.promise; } });
  await within(started.promise, "material review before cancellation"); const pending = f.state.hotReviewWork.promise;
  await f.runtime.reset({ sessionId: "host" }, f.ctx); finish.resolve(); await within(pending, "cancelled material review");
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.groundTruth.version, 0); assert.equal((await readMaterialBasis(f.root, task.taskId)).status, "CAPTURED");
});

test("an idle dispatcher adopts the next autopilot run in both wait modes instead of silently losing its candidate", async t => {
  for (const waitMode of ["assessment", "until_pass"]) await t.test(waitMode, async t => {
    const f = await lifecycle(t, { waitMode, postRunTerminal: async () => ({ status: "ok" }) });
    const identity = { agentId: f.ctx.agentId, sessionId: f.ctx.sessionId, sessionKey: f.ctx.sessionKey, projectRoot: f.root,
      scopeFingerprint: f.state.projectScope.fingerprint, scopeTaskId: f.state.scopeTaskId, controlRevision: f.state.enabledRevision };
    await f.runtime.postRuns.started(identity, f.ctx.runId); await f.runtime.postRuns.release(identity, "INITIAL_RUN_ENDED");
    assert.equal(f.runtime.postRuns.snapshot(identity).phase, "IDLE");
    let externalCalls = 0;
    f.runtime.postRuns.externalStarted = async () => { externalCalls++; throw new Error("IDLE must use normal started admission"); };
    f.api.config.plugins = { entries: { autopilot: { enabled: true } } };
    const request = f.api.runtime.gateway.request;
    f.api.runtime.gateway.request = (method, ...args) => method === "autopilot.status" ? { projection: { status: "running" } } : request(method, ...args);
    const next = { ...f.ctx, runId: `autopilot-next-${waitMode}` };
    await f.runtime.prompt({ prompt: "Trusted host continuation." }, next);
    await f.runtime.beforeTool({ toolName: "write", toolCallId: "next-write", params: { path: "draft.md" } }, next);
    await f.state.hotReviewWork?.promise;
    await f.runtime.beforeFinalize({ sessionId: next.sessionId, lastAssistantMessage: "Latest candidate." }, next);
    const record = f.runtime.postRuns.snapshot(identity);
    assert.equal(record.runId, next.runId); assert.equal(externalCalls, 0);
    await f.runtime.postRuns.drain();
  });
});

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

test("delivered correction admission survives host compaction and same-run retry", async t => {
  for (const observeModelStart of [false, true]) await t.test(observeModelStart ? "started" : "delivered before model start", async t => {
    const terminal = deferred(t), dispatched = deferred(t); let childRunId, reviews = 0;
    const f = await lifecycle(t, { waitMode: "until_pass", observeModelStart,
      review: async () => ++reviews === 1,
      postRunTerminal: async (_identity, runId) => {
        if (runId.startsWith("rc-stop-")) await terminal.promise;
        return { runId, status: "ok" };
      } });
    f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; dispatched.resolve(); return { runId: childRunId }; } };
    try {
      await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
      await within(dispatched.promise, "correction dispatch");
      await within(f.runtime.waitForNativeReviews(), "initial review");
      const child = { ...f.ctx, runId: childRunId };
      await f.runtime.prompt({ prompt: "Apply the delivered feedback." }, child);
      const protocol = f.sharedState.stopStartProtocol;
      const before = await protocol.findRun({ state: f.state, runId: childRunId });
      assert.equal(before.admission.deliveryStatus, "DELIVERED");
      assert.equal(before.admission.accounting, observeModelStart ? "USED" : "RESERVED");
      await f.runtime.agentEnd({ runId: childRunId, success: false, error: "Context overflow" }, child);
      // This is the host retry gate that previously returned ADMISSION_DENIED.
      const prepared = await protocol.prepare({ state: f.state, runId: childRunId, signal: child.abortSignal });
      assert.notEqual(prepared?.blocked, true, JSON.stringify(await protocol.findRun({ state: f.state, runId: childRunId })));
      let checkpoints = 0;
      f.api.runtime.agent.session.runWithWorkAdmission = async (params, run) => {
        params.signal.throwIfAborted(); checkpoints++; return run(params.signal);
      };
      // The native host may omit runId on the compaction hook; it still owns
      // only the current session checkpoint, never another run's admission.
      const compactContext = { ...child };
      if (!observeModelStart) delete compactContext.runId;
      await f.runtime.compact({ sessionId: child.sessionId }, compactContext);
      await until(() => checkpoints > 0, "compaction checkpoint admission");
      assert(checkpoints > 0, "PreCompact checkpoint must actually enter native work admission");
      assert.equal(f.state.reviewController.signal.aborted, false, "compaction must have a live checkpoint controller");
      assert(!f.warnings.some(message => /Compaction checkpoint unavailable/u.test(message)), JSON.stringify(f.warnings));
      const resumed = await f.runtime.prompt({ prompt: "Continue after compaction." }, child);
      const gate = await f.runtime.beforeAgentRun({ prompt: resumed?.prependContext ?? "Continue after compaction." }, child);
      assert.equal(gate.outcome, "pass");
      await f.startModel(child);
      assert.equal((await protocol.findRun({ state: f.state, runId: childRunId })).admission.accounting, "USED");
      await fs.writeFile(path.join(f.root, "draft.md"), "The corrected current draft.\n");
      await f.runtime.agentEnd({ runId: childRunId, success: true, messages: [{ role: "assistant", content: "Corrected." }] }, child);
      terminal.resolve();
      await within(f.runtime.waitForNativeReviews({ drain: true }), "corrected Stop settlement");
      const task = await findTask({ projectRoot: f.root, sessionId: "host" });
      assert.equal(task.verification.status, "NO_DEVIATION_FOUND", JSON.stringify(task.verification));
      assert.equal(f.post().phase, "IDLE");
      assert.equal(f.post().reviewStatus, "NO_DEVIATION_FOUND");
      assert.equal(task.stop.correctionAttempts, 1, "same-run retry consumes only one correction");
      assert.equal(f.hostAbort.signal.aborted, false);
    } finally { terminal.resolve(); await f.runtime.reset({}, f.ctx); await f.runtime.waitForNativeReviews({ drain: true }); }
  });
});

test("gateway-confirmed correction failure closes its receipt and fences late completion", async t => {
  for (const waitMode of ["until_pass", "assessment"]) await t.test(waitMode, async t => {
    const terminal = deferred(t);
    let childRunId, dispatched;
    const dispatchObserved = new Promise(resolve => { dispatched = resolve; });
    const f = await lifecycle(t, { deviation: true, waitMode,
      postRunTerminal: async (_identity, runId) => {
        if (runId.startsWith("rc-stop-")) { await terminal.promise; return { runId, status: "error", aborted: true }; }
        return { runId, status: "ok" };
      } });
    f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; dispatched(); return { runId: childRunId }; } };
    await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
    // Assessment settlement and native queue acceptance are separate events.
    // Abort the actual child only after its host dispatch has been observed.
    // Observe the actual dispatch event within the existing asynchronous-test
    // bound, instead of a separate five-second busy-poll horizon shorter than
    // this fixture's eleven-second assessment budget.
    try { await within(dispatchObserved, 'queued corrective run'); }
    catch (error) {
      const task = await findTask({ projectRoot: f.root, sessionId: 'host' });
      t.diagnostic(JSON.stringify({ phase: f.post()?.phase, reviewStatus: f.post()?.reviewStatus,
        taskStatus: task?.status, verification: task?.verification?.status, warnings: f.warnings.slice(-3) }));
      throw error;
    }
    if(waitMode==='assessment')await f.runtime.prompt({prompt:'RC feedback'},{...f.ctx,runId:childRunId});
    const reviewed=await within(f.runtime.waitForNativeReviews(), "native review settlement");
    assert(childRunId,JSON.stringify({reviewed,warnings:f.warnings,task:await findTask({projectRoot:f.root,sessionId:'host'})}));
    const child = { ...f.ctx, runId: childRunId };
    if(waitMode!=='assessment')await f.runtime.prompt({ prompt: "RC feedback" }, child);
    await f.runtime.agentEnd({ runId: childRunId, success: false, aborted: true }, child);
    const pending = await f.sharedState.stopStartProtocol.findRun({ state: f.state, runId: childRunId });
    assert.equal(pending.admission.invalidatedAt, undefined, "attempt failure alone cannot revoke admission");
    assert.equal(pending.finishedAt, undefined);
    terminal.resolve();
    await within(f.runtime.waitForNativeReviews({ drain: true }), "gateway terminal cleanup");
    const task = await findTask({ projectRoot: f.root, sessionId: "host" });
    assert.equal(task.status, "STOPPED_UNVERIFIED");
    assert.equal(task.verification.terminalRunId, childRunId);
    assert.equal(task.verification.reasonCode, "HOST_RUN_NOT_COMPLETED");
    assert.equal(task.verification.previousVerification.status, "DEVIATION");
    const ledger=await f.sharedState.stopStartProtocol.findRun({state:f.state,runId:childRunId});
    assert.equal(ledger.status,'CANCELLED');assert(ledger.admission.invalidatedAt);assert(ledger.finishedAt);
    assert.equal(f.post().phase, "IDLE");
    assert.equal(f.post().reviewStatus, "UNVERIFIED");
    assert.equal(f.hostAbort.signal.aborted, false);
    await f.runtime.prompt({ prompt: "Late retry after terminal." }, child);
    const gate = await f.runtime.beforeAgentRun({ prompt: "Late retry after terminal." }, child);
    assert.equal(gate.outcome, "block");
    await f.runtime.agentEnd({ runId: childRunId, success: true, messages: [{ role: "assistant", content: "Late success." }] }, child);
    await f.runtime.agentEnd({ runId: f.ctx.runId, success: false, aborted: true }, f.ctx);
    assert.deepEqual((await findTask({ projectRoot: f.root, sessionId: "host" })).verification, task.verification);
  });
});

test("correction retry keeps foreign-run, expiry and changed-basis fences", async t => {
  for (const fence of ["expiry", "changed basis"]) await t.test(fence, async t => {
    const terminal = deferred(t), dispatched = deferred(t); let childRunId;
    const f = await lifecycle(t, { deviation: true, waitMode: "until_pass", observeModelStart: false,
      postRunTerminal: async (_identity, runId) => {
        if (runId.startsWith("rc-stop-")) await terminal.promise;
        return { runId, status: "ok" };
      } });
    f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; dispatched.resolve(); return { runId: childRunId }; } };
    try {
      await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
      await within(dispatched.promise, "correction dispatch");
      await within(f.runtime.waitForNativeReviews(), "initial review");
      const child = { ...f.ctx, runId: childRunId };
      await f.runtime.prompt({ prompt: "Apply feedback." }, child);
      await f.runtime.agentEnd({ runId: childRunId, success: false, error: "Context overflow" }, child);
      const controller = f.state.reviewController;
      const foreign = { ...child, runId: "rc-stop-" + "f".repeat(64) };
      assert.equal((await f.runtime.beforeAgentRun({ prompt: "Borrow another run's admission." }, foreign)).outcome, "block");
      await f.runtime.compact({}, foreign);
      assert.equal(f.state.reviewController, controller, "foreign run cannot rearm the failed attempt");
      const protocol = f.sharedState.stopStartProtocol;
      const receipt = await protocol.findRun({ state: f.state, runId: childRunId });
      if (fence === "expiry") {
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        t.mock.timers.tick(Math.max(1, receipt.admission.deadlineAt - Date.now() + 1));
      } else await fs.writeFile(path.join(f.root, "draft.md"), "The feedback's evidence has changed.\n");
      const prepared = await protocol.prepare({ state: f.state, runId: childRunId, signal: child.abortSignal });
      assert.equal(prepared.blocked, true, fence);
      assert.equal((await f.runtime.beforeAgentRun({ prompt: "Retry old feedback." }, child)).outcome, "block");
    } finally { terminal.resolve(); await f.runtime.reset({}, f.ctx); await f.runtime.waitForNativeReviews({ drain: true }); }
  });
});

test('an initial review that crosses its absolute deadline cannot create a corrective child',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 let childRunId;const f=await lifecycle(t,{deviation:true,waitMode:'until_pass'});
 f.api.runtime.subagent={run:async args=>{childRunId=args.idempotencyKey;return {runId:childRunId};}};
 f.api.runtime.agent.reviewAdmission=async()=>{
  const deadline=f.post().deadlineAt;assert(Number.isFinite(deadline));
  t.mock.timers.tick(Math.max(1,deadline-Date.now()+1));
 };
 await f.runtime.reply({kind:'final',runId:f.ctx.runId,sessionKey:f.ctx.sessionKey,payload:{text:'Delivered.'}},f.ctx);
 const reviewed=await within(f.runtime.waitForNativeReviews(),'expired initial review settlement');
 assert.equal(childRunId,undefined);assert.equal(reviewed[0].reviewStatus,'UNVERIFIED',JSON.stringify(reviewed));
 const task=await findTask({projectRoot:f.root,sessionId:'host'});
 assert.equal(task.status,'STOPPED_UNVERIFIED');assert.equal(task.verification.terminalRunId,f.ctx.runId);
 assert.equal(task.stop.correctionAttempts,0);
});

test("until_pass execution watchdog closes an unfinished correction and fences its late terminal", async t => {
  let childRunId;
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass", executionTimeoutMs: 50 });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(f.runtime.waitForNativeReviews(), "review");
  const child = { ...f.ctx, runId: childRunId };
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  await until(() => f.post().phase === "IDLE", "execution watchdog");
  assert.equal(f.post().reviewStatus, "UNVERIFIED");
  assert.equal(f.post().reason, "POST_RUN_EXECUTION_TIMEOUT");
  await f.runtime.agentEnd({ runId: childRunId, success: true, messages: [] }, child);
  await within(f.runtime.waitForNativeReviews(), "review");
  assert.equal(f.post().reviewStatus, "UNVERIFIED");
  assert.equal(f.hostAbort.signal.aborted, false);
});

test("kitchen parent expiry closes an admitted receipt and terminalizes the task while a child review is running", async t => {
  const started = deferred(t), finish = deferred(t); let childRunId, calls = 0;
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass", hookTimeoutMs: 20000, waitTimeoutMs: 20000,
    review: async () => { if (++calls === 1) return true; started.resolve(); await finish.promise; return false; } });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(f.runtime.waitForNativeReviews(), "native review settlement");
  const child = { ...f.ctx, runId: childRunId };
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  await fs.writeFile(path.join(f.root,'draft.md'),'The changed current source requires a fresh child review.\n');
  await f.runtime.agentEnd({ runId: childRunId, success: true, messages: [{ role: "assistant", content: "Rechecked." }] }, child);
  await within(started.promise, "started signal");
  await f.runtime.postRuns.release(f.post(), "POST_RUN_EXECUTION_TIMEOUT"); finish.resolve();
  await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
  let task;
  for (let i = 0; i < 30; i++) { task = await findTask({ projectRoot: f.root, sessionId: "host" });
    if (task.status === "STOPPED_UNVERIFIED") break; await pause(10); }
  assert.equal(task.status, "STOPPED_UNVERIFIED"); assert.equal(task.verification.status, "UNVERIFIED");
  assert.equal(task.verification.previousVerification.status, "DEVIATION");
  assert.equal(task.stop.correctionAttempts, 1); assert.equal(f.hostAbort.signal.aborted, false);
  const receipt=await f.sharedState.stopStartProtocol.findRun({state:f.state,runId:childRunId});
  assert(receipt.finishedAt);assert.equal(receipt.status,'CANCELLED');
});

test("reset during correction releases until_pass even after the original review has settled", async t => {
  let childRunId;
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass" });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(f.runtime.waitForNativeReviews(), "native review settlement");
  const child = { ...f.ctx, runId: childRunId };
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  await f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {});
  await f.runtime.reset({}, child);
  assert.equal(f.post().phase, "CLOSED");
  assert.equal(f.hostAbort.signal.aborted, false);
});

test("late correction tools after wait expiry cannot replace or cancel the next business review", async t => {
  let childRunId, reviews = 0;
  const started = deferred(t), finish = deferred(t);
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass", waitTimeoutMs: 20000, hookTimeoutMs: 20000, review: async () => {
    if (++reviews === 1) return true;
    started.resolve(); await finish.promise; return false;
  } });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await within(f.runtime.waitForNativeReviews(), "native review settlement");
  const child = { ...f.ctx, runId: childRunId };
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  await f.runtime.postRuns.release(f.post(), "POST_RUN_EXECUTION_TIMEOUT");
  await f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {});
  const next = { ...f.ctx, runId: "new-business" };
  await fs.appendFile(path.join(f.root,'native.jsonl'),'\n'+JSON.stringify({type:'message',id:'new-real-user',parentId:'u',message:{role:'user',content:'Inspect this new changed draft.'}})+'\n');
  await f.runtime.prompt({ prompt: "Next task" }, next);
  await fs.writeFile(path.join(f.root,'draft.md'),'The newly changed draft in a distinct real user flow.\n');
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "new-write", params: { path: "draft.md" } }, next);
  await f.runtime.reply({ kind: "final", runId: next.runId, sessionKey: next.sessionKey, payload: { text: "New delivery." } }, next);
  await within(started.promise, "started signal");
  const controller = f.state.reviewController;
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "late-child-write", params: { path: "draft.md" } }, child);
  assert.equal(f.state.nativeRunId, next.runId);
  assert.equal(f.state.reviewController, controller);
  assert.equal(controller.signal.aborted, false);
  finish.resolve();
  const records = await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
  assert.equal(records.find(record => record.runId === next.runId).reviewStatus, "NO_DEVIATION_FOUND");
});

test("host auto-compaction after a failed attempt does not become an RC hook failure", async t => {
  const terminal = deferred(t);
  const f = await lifecycle(t, { waitMode: "until_pass", postRunTerminal: async (_identity, runId) => {
    await terminal.promise; return { runId, status: "ok" };
  } });
  try {
  const releases = [], release = f.runtime.postRuns.release.bind(f.runtime.postRuns);
  f.runtime.postRuns.release = (identity, reason) => { releases.push(reason); return release(identity, reason); };
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: false, error: "Context overflow" }, f.ctx);
  assert.equal(f.state.reviewController.signal.reason.code, "RC_NATIVE_ATTEMPT_ENDED");
  // Native admission rejects work under an already cancelled review signal.
  f.api.runtime.agent.session.runWithWorkAdmission = async (params, run) => {
    params.signal.throwIfAborted();
    return run(params.signal);
  };
  await f.runtime.compact({ sessionId: f.ctx.sessionId }, f.ctx);
  await pause(30);
  assert(!releases.includes("RC_HOOK_UNAVAILABLE"), JSON.stringify(releases));
  assert.equal(f.hostAbort.signal.aborted, false);
  await f.runtime.prompt({ prompt: "Continue the original task." }, f.ctx);
  assert.equal(f.state.reviewController.signal.aborted, false);
  assert.equal(f.state.nativeInvalidated, false);
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered after retry." } }, f.ctx);
  terminal.resolve();
  const [review] = await within(f.runtime.waitForNativeReviews(), "review after a genuine outer terminal");
  assert.equal(review.reviewStatus, "NO_DEVIATION_FOUND");
  } finally {
    terminal.resolve();
    await f.runtime.reset({}, f.ctx);
    await f.runtime.waitForNativeReviews({ drain: true });
  }
});

test("an unrelated admission failure during compaction still releases RC as unavailable", async t => {
  const f = await lifecycle(t, { waitMode: "until_pass" });
  const releases = [], release = f.runtime.postRuns.release.bind(f.runtime.postRuns);
  f.runtime.postRuns.release = (identity, reason) => { releases.push(reason); return release(identity, reason); };
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: false, error: "Context overflow" }, f.ctx);
  f.api.runtime.agent.session.runWithWorkAdmission = async () => {
    throw Object.assign(new Error("Admission backend unavailable"), { code: "RC_NATIVE_ATTEMPT_ENDED" });
  };
  await f.runtime.compact({ sessionId: f.ctx.sessionId }, f.ctx);
  assert(releases.includes("RC_HOOK_UNAVAILABLE"), JSON.stringify(releases));
  assert.equal(f.hostAbort.signal.aborted, false);
  await f.runtime.reset({}, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
});

test("host memory maintenance cannot replace or finalize the business run in the same session", async t => {
  const f = await lifecycle(t, { waitMode: "until_pass" });
  const controller = f.state.reviewController;
  const maintenance = { ...f.ctx, runId: "host-memory-flush", trigger: "memory" };
  await f.runtime.prompt({ prompt: "Continue the OpenClaw runtime event." }, maintenance);
  const later = { ...maintenance }; delete later.trigger;
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "memory-write", params: { path: "memory/today.md" } }, later);
  await f.runtime.reply({ kind: "final", runId: later.runId, sessionKey: later.sessionKey, payload: { text: "NO_REPLY" } }, later);
  await f.runtime.agentEnd({ runId: later.runId, success: true }, later);
  assert.equal(f.state.nativeRunId, f.ctx.runId);
  assert.equal(f.state.reviewController, controller);
  assert.equal(controller.signal.aborted, false);
  assert.equal(f.calls(), 0);
  assert.equal(f.post().phase, "RUNNING");
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [review] = await within(f.runtime.waitForNativeReviews(), "business review after maintenance");
  assert.equal(review.reviewStatus, "NO_DEVIATION_FOUND");
});

test("host maintenance filtering retains private reviewer tool authorization", async t => {
  const f = await lifecycle(t);
  let observed = 0;
  const result = await runInternalExecution("private", () => f.runtime.beforeTool({ toolName: "write", params: { path: "memory/today.md" } },
    { ...f.ctx, sessionId: "private", sessionKey: "agent:main:runtime-corrector:private", runId: "private-memory", trigger: "memory" }),
  async () => { observed++; return { block: true, blockReason: "Private write denied" }; });
  assert.equal(observed, 1);
  assert.equal(result.block, true);
  assert.equal(f.state.nativeRunId, f.ctx.runId);
});

test("a read-only continuation retries an interrupted Stop, while accepted work stays quiet", async t => {
  for (const { status, reasonCode } of [
    { status: "UNVERIFIED", reasonCode: "STOP_SESSION_MIGRATION_REQUIRED" },
    { status: "UNVERIFIED", reasonCode: "BASELINE_INPUT_CHANGED" },
    { status: "PASS" },
  ]) await t.test(reasonCode ?? status, async t => {
    const f = await lifecycle(t, { waitMode: "until_pass" });
    await f.runtime.postRuns.release(f.post(), "PREVIOUS_RUN_ENDED");
    const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
    await withTaskState({ projectRoot: f.root, taskId: task.taskId }, current => {
      current.status = status === "UNVERIFIED" ? "STOPPED_UNVERIFIED" : "ACTIVE";
      current.verification = { status, ...(reasonCode ? { reasonCode } : {}) };
      if (reasonCode) current.stop.lastAssessmentId = 'prior-interrupted-assessment';
    });
    await fs.appendFile(path.join(f.root, 'native.jsonl'), '\n' + JSON.stringify({ type: 'message', id: 'continue-verification', parentId: 'u',
      message: { role: 'user', content: 'Continue pending final verification.' } }) + '\n');
    const next = { ...f.ctx, runId: 'read-only-continuation' };
    await f.runtime.prompt({ prompt: 'Continue pending final verification.' }, next);
    assert.equal(f.state.nativeNeedsStop, status === "UNVERIFIED");
    assert.equal(f.state.nativeRetryUnverifiedStop, reasonCode === "STOP_SESSION_MIGRATION_REQUIRED");
    assert.equal(f.state.nativeRetryEvidenceStop, reasonCode === "BASELINE_INPUT_CHANGED");
    if (status === "UNVERIFIED") {
      await f.runtime.reply({ kind: 'final', runId: next.runId, sessionKey: next.sessionKey, payload: { text: 'Implementation complete; verify actual acceptance.' } }, next);
      const [review] = await within(f.runtime.waitForNativeReviews(), 'resumed acceptance without dummy source edits');
      const after = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
      assert.equal(review.reviewStatus, 'NO_DEVIATION_FOUND', JSON.stringify({ reasonCode: review.reasonCode, status: review.reviewStatus, calls: f.calls(),
        taskStatus: after.status, verification: { status: after.verification?.status, reason: after.verification?.reasonCode, assessmentId: after.verification?.assessmentId },
        armed: after.stop.armedAtStart, assessmentReason: f.state.nativeAssessment?.outcome?.reason,
        assessmentMode: f.state.nativeAssessment?.outcome?.assessmentMode, warnings: f.warnings.slice(-2) }));
    } else {
      assert.equal(f.calls(), 0, 'accepted work must not trigger another private review');
    }
  });
});
