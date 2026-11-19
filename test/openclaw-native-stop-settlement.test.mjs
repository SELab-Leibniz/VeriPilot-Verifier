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
  await within(f.runtime.waitForBackgroundReviews(), "next prompt background review");
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
