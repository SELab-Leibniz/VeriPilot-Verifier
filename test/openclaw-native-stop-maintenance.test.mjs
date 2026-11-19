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
    try {
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
    } finally {
      // prompt() can start background bookkeeping even when PASS correctly
      // avoids a new Stop review. Drain these owned writes before fixture rm.
      await within(f.runtime.waitForBackgroundReviews(), 'continuation background bookkeeping');
      await within(f.runtime.waitForNativeReviews({ drain: true }), 'continuation Stop bookkeeping');
    }
  });
});
