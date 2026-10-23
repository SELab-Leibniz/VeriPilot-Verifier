import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeFollowups } from "../lib/openclaw/native-followup.mjs";
import { createNativeStopChains } from "../lib/openclaw/native-stop-chain.mjs";
import { prepareHostFeedback } from "../lib/runtime-v2/feedback-delivery.mjs";

async function fixture(t, run = null, options = {}) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-partial-native-feedback-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const calls = [], state = { projectRoot, sessionId: "partial-host", sessionKey: "agent:main:partial-business",
    nativeRunId: "original-run", reviewController: new AbortController() };
  const api = { runtime: { subagent: { run: async args => {
    calls.push(args); return run ? run(args) : { runId: args.idempotencyKey };
  } } } };
  const task = { taskId: "task-partial", correctionEpoch: { id: 2 },
    stop: { epochId: 2, lastAssessmentId: "assessment-partial", correctionAttempts: 0, infrastructureFailures: 1 },
    verification: { status: "UNVERIFIED", evaluationId: "assessment-partial" } };
  const outcome = { status: "UNVERIFIED", decision: "block", correctionAttempt: 0,
    partialFeedbackEligible: true, infrastructureAttempt: 1, correctionBudgetExhausted: false,
    feedback: "Retained validated finding M12:storage: output contradicts the current source. app.py#L2-L4" };
  const params = { projectRoot, state, task, outcome, maxCorrections: 3,
    source: { runId: state.nativeRunId, leafId: "final", usersDigest: "original-user-digest", evidenceDigest: "snapshot-1" } };
  const journal = async () => (await fs.readFile(path.join(projectRoot,
    ".runtime-correction/tasks/task-partial/journal/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { api, state, task, outcome, params, calls, journal, manager: createNativeFollowups(api, options) };
}

test("validated partial UNVERIFIED feedback is admitted at correctionAttempt zero without spending k", async t => {
  const f = await fixture(t), before = structuredClone(f.task);
  const receipt = await f.manager.submit(f.params);
  assert.equal(receipt.status, "ADMITTED");
  assert.equal(receipt.feedbackOnly, true);
  assert.equal(receipt.correctionAttempt, 0);
  assert.equal(receipt.infrastructureAttempt, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].deliver, false);
  assert.match(f.calls[0].message, /整体未验证/u);
  assert.match(f.calls[0].message, /不消耗业务纠偏次数/u);
  assert.doesNotMatch(f.calls[0].message, /纠偏机会 0\/3/u);
  assert.deepEqual(f.task, before);
  assert((await f.journal()).every(event => event.correctionAttempt === 0));
});

test("the second infrastructure attempt still permits eligible feedback without renewing correction budget", async t => {
  const f = await fixture(t);
  f.task.stop.infrastructureFailures = 2; f.outcome.infrastructureAttempt = 2;
  const before = structuredClone(f.task);
  assert.equal((await f.manager.submit(f.params)).status, "ADMITTED");
  assert.deepEqual(f.task, before);
});

test("one assessment admits partial feedback once across concurrent submissions and manager reload", async t => {
  const f = await fixture(t);
  const receipts = await Promise.all([f.manager.submit(f.params), f.manager.submit(f.params)]);
  assert.equal(f.calls.length, 1);
  assert.equal(receipts[0].runId, receipts[1].runId);
  const reloaded = await createNativeFollowups(f.api).submit(f.params);
  assert.equal(reloaded.runId, receipts[0].runId);
  assert.equal(reloaded.feedbackOnly, true);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.journal()).filter(event => event.type === "NATIVE_STOP_FOLLOWUP_ADMITTED").length, 1);
  assert.equal(f.task.stop.correctionAttempts, 0);
});

test("ordinary UNVERIFIED, mismatched assessment or infrastructure identity never admits partial feedback", async t => {
  const changes = [
    f => { delete f.outcome.partialFeedbackEligible; },
    f => { f.outcome.partialFeedbackEligible = false; },
    f => { f.task.verification.evaluationId = "other-assessment"; },
    f => { f.task.verification.status = "PASS"; },
    f => { f.outcome.infrastructureAttempt = 2; },
    f => { f.outcome.infrastructureAttempt = 0; f.task.stop.infrastructureFailures = 0; },
  ];
  for (const change of changes) {
    const f = await fixture(t); change(f);
    assert.equal((await f.manager.submit(f.params)).status, "INELIGIBLE");
    assert.equal(f.calls.length, 0);
    assert.equal(f.task.stop.correctionAttempts, 0);
  }
});

test("exhausted infrastructure or business budgets refuse a new partial-feedback continuation", async t => {
  const changes = [
    f => { f.outcome.infrastructureAttempt = 3; f.task.stop.infrastructureFailures = 3; },
    f => { f.outcome.correctionAttempt = 3; f.task.stop.correctionAttempts = 3; },
    f => { f.outcome.correctionBudgetExhausted = true; },
    f => { f.outcome.decision = "allow"; },
  ];
  for (const change of changes) {
    const f = await fixture(t); change(f); const before = structuredClone(f.task);
    assert.equal((await f.manager.submit(f.params)).status, "INELIGIBLE");
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.task, before);
  }
});

test("parent cancellation or a stale project blocks partial feedback before admission", async t => {
  const cancelled = await fixture(t);
  cancelled.state.reviewController.abort(new Error("Parent cancelled"));
  assert.equal((await cancelled.manager.submit(cancelled.params)).status, "CANCELLED");
  assert.equal(cancelled.calls.length, 0);
  const stale = await fixture(t, null, { isCurrent: async () => false });
  assert.equal((await stale.manager.submit(stale.params)).status, "CANCELLED");
  assert.equal(stale.calls.length, 0);
  const replaced = await fixture(t);
  replaced.state.nativeRunId = "new-business-run";
  assert.equal((await replaced.manager.submit(replaced.params)).status, "CANCELLED");
  assert.equal(replaced.calls.length, 0);
});

test("staleness after reservation cancels partial delivery and never enters the native API", async t => {
  let checks = 0;
  const f = await fixture(t, null, { isCurrent: async () => ++checks === 1 });
  assert.equal((await f.manager.submit(f.params)).status, "CANCELLED");
  assert.equal(f.calls.length, 0);
  assert((await f.journal()).some(event => event.type === "NATIVE_STOP_FOLLOWUP_CANCELLED"));
});

test("cancelled in-flight partial admission cannot become admitted after a late host success", async t => {
  let signalStarted, finish;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const f = await fixture(t, args => {
    signalStarted(); return new Promise(resolve => { finish = () => resolve({ runId: args.idempotencyKey }); });
  });
  const pending = f.manager.submit(f.params);
  await started;
  f.state.reviewController.abort(new Error("Reset"));
  await f.manager.cancel({ ...f.params, reason: "HOST_RESET" });
  finish();
  assert.equal((await pending).status, "CANCELLED");
  assert.equal((await f.manager.submit(f.params)).status, "CANCELLED");
  assert.equal(f.calls.length, 1);
  assert.equal(f.task.stop.correctionAttempts, 0);
});

test("deadline or reset cancellation alone fences late native admission without an explicit receipt cancel", async t => {
  for (const code of ["REVIEW_DEADLINE_EXPIRED", "RC_NATIVE_CANCELLED"]) {
    let signalStarted, finish;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const f = await fixture(t, args => {
      signalStarted(); return new Promise(resolve => { finish = () => resolve({ runId: args.idempotencyKey }); });
    });
    const pending = f.manager.submit(f.params);
    await started;
    f.state.reviewController.abort(Object.assign(new Error("Review lifecycle ended"), { code }));
    // No manager.cancel(): a deadline can abort just the captured controller.
    finish();
    const receipt = await pending;
    assert.equal(receipt.status, "CANCELLED");
    assert.equal(receipt.reason, code);
    assert.equal((await f.manager.findRun({ ...f.params, runId: receipt.runId })).status, "CANCELLED");
    assert(!(await f.journal()).some(event => event.type === "NATIVE_STOP_FOLLOWUP_ADMITTED"));
    assert.equal(f.task.stop.correctionAttempts, 0);
  }
});

test("a legitimate reentrant owned child may replace its parent before native admission returns", async t => {
  let f;
  f = await fixture(t, async args => {
    f.state.reviewController.abort(new Error("Native run replaced."));
    f.state.reviewController = new AbortController();
    f.state.nativeRunId = args.idempotencyKey;
    return { runId: args.idempotencyKey };
  });
  const receipt = await f.manager.submit(f.params);
  assert.equal(receipt.status, "ADMITTED");
  assert.equal(receipt.runId, f.state.nativeRunId);
  assert.equal(receipt.feedbackOnly, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.task.stop.correctionAttempts, 0);
});

test("an unrelated replacement or a cancelled owned child cannot use the normal handoff exception", async t => {
  for (const childCancelled of [false, true]) {
    let f;
    f = await fixture(t, async args => {
      f.state.reviewController.abort(new Error("Native run replaced."));
      f.state.reviewController = new AbortController();
      f.state.nativeRunId = childCancelled ? args.idempotencyKey : "unrelated-business-run";
      if (childCancelled) f.state.reviewController.abort(Object.assign(new Error("Stop deadline expired"), { code: "STOP_WAIT_DEADLINE_EXPIRED" }));
      return { runId: args.idempotencyKey };
    });
    assert.equal((await f.manager.submit(f.params)).status, "CANCELLED");
    assert(!(await f.journal()).some(event => event.type === "NATIVE_STOP_FOLLOWUP_ADMITTED"));
  }
});

test("an expired supplied Stop deadline rejects admission before any native work", async t => {
  const f = await fixture(t);
  f.params.source.deadlineAt = Date.now() - 1;
  assert.equal((await f.manager.submit(f.params)).status, "CANCELLED");
  assert.equal(f.calls.length, 0);
});

test("the original Stop deadline fences late admission after a legitimate reentrant child replaced the parent", async t => {
  let f, finish, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  f = await fixture(t, args => {
    f.state.reviewController.abort(new Error("Native run replaced."));
    f.state.reviewController = new AbortController();
    f.state.nativeRunId = args.idempotencyKey;
    signalStarted();
    return new Promise(resolve => { finish = () => resolve({ runId: args.idempotencyKey }); });
  });
  f.params.source.deadlineAt = Date.now() + 1000;
  const originalController = f.state.reviewController;
  const pending = f.manager.submit(f.params);
  await started;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, f.params.source.deadlineAt - Date.now()) + 5));
  // The parent's first abort reason is immutable and remains a normal handoff.
  assert.equal(originalController.signal.reason.message, "Native run replaced.");
  assert.equal(f.state.reviewController.signal.aborted, false);
  finish();
  const receipt = await pending;
  assert.equal(receipt.status, "CANCELLED");
  assert.equal(receipt.reason, "REVIEW_DEADLINE_EXPIRED");
  assert(!(await f.journal()).some(event => event.type === "NATIVE_STOP_FOLLOWUP_ADMITTED"));
});

test("native operational prefix and partial feedback together stay within 8192 UTF8 bytes with a readable index", async t => {
  const f = await fixture(t);
  const objects = Array.from({ length: 40 }, (_, index) => ({ objectId: `M12:partial-${index}`, sourceId: `partial-${index}`,
    judgement: "DEVIATION", reason: `Original observed defect ${index}: ` + "中文长原因🌻".repeat(200), evidence: ["app.py#L2-L4"] }));
  f.outcome.feedback = await prepareHostFeedback({ ...f.params, taskId: f.task.taskId, text: "Retained partial source-grounded findings",
    partialReview: { status: "PARTIAL", finalClassification: null, totalObjects: 41,
      metricObjectJudgements: objects, unreviewedObjectIds: ["M12:unread"], rejectedObjectIds: [] } });
  const receipt = await f.manager.submit(f.params), message = f.calls[0].message;
  assert.equal(receipt.status, "ADMITTED");
  assert(Buffer.byteLength(message, "utf8") <= 8192);
  assert.match(message, /不是新的用户需求或授权/u);
  assert.match(message, /不消耗业务纠偏次数/u);
  assert.match(message, /M12:partial-0/u);
  assert.match(message, /M12:partial-39/u);
  const indexPath = message.split("\n").findLast(line => line.startsWith("[RC_DETAILS] ")).slice(13);
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(index.itemCount, 41);
  for (const page of index.pages) await fs.access(page.path);
  assert.equal(f.task.stop.correctionAttempts, 0);
});

test("admitted feedbackOnly UNVERIFIED keeps the Stop chain waiting until a current recheck settles it", async () => {
  const manager = createNativeStopChains(), state = { projectRoot: "/partial-fixture", sessionId: "host",
    sessionKey: "agent:main:partial", nativeRunId: "first" };
  const chain = manager.begin({ state, runId: "first", taskId: "task", budgetMs: 1000 });
  manager.link(state, { runId: "feedback-only-run", taskId: "task", feedbackOnly: true });
  chain.assessed({ runId: "first", reviewStatus: "UNVERIFIED", feedbackOnly: true, followupStatus: "ADMITTED" });
  assert.equal(chain.pending, true);
  assert.equal(chain.record.phase, "REVIEWING");
  chain.enter("feedback-only-run");
  manager.begin({ state, runId: "feedback-only-run", taskId: "task", budgetMs: 1000 });
  chain.assessed({ runId: "first", reviewStatus: "PASS" });
  assert.equal(chain.pending, true, "an old parent cannot pass the feedback-only child");
  chain.assessed({ runId: "feedback-only-run", reviewStatus: "PASS", evaluationId: "rechecked" });
  assert.equal((await chain.released).reviewStatus, "PASS");
});
