import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { readMaterialBasis } from "../lib/openclaw/material-basis.mjs";
import { createOpenClawReviewerFactory } from "./helpers/legacy-openclaw-reviewer.mjs";
import { runInternalExecution } from "../lib/openclaw/internal-context.mjs";
import { createNativeStopFixture, basic, deferred, pause, until, within } from "./support/openclaw-native-stop-fixture.mjs";
import { runtimeFailureDiagnostics } from "./helpers/runtime-failure-diagnostics.mjs";

const { lifecycle, findTask, withTaskState, readReport } = createNativeStopFixture();

async function diagnoseBaselineWait(t, f, baselineCallbacks) {
  const entry = f.runtime.postRuns.list().sessions.find(row => row.sessionId === f.ctx.sessionId);
  t.diagnostic(JSON.stringify({ fixturePhase: "WAITING_FOR_BASELINE_CALLBACK", baselineCallbacks,
    factoryCallbacksSinceFixtureReturn: f.calls(), hotReviewWorkPresent: Boolean(f.state.hotReviewWork),
    nativeRunMatches: f.state.nativeRunId === f.ctx.runId, reviewControllerAborted: f.state.reviewController.signal.aborted,
    ...await runtimeFailureDiagnostics({ root: f.root, warnings: f.warnings,
      post: entry ? f.runtime.postRuns.byId(entry.id) : undefined }) }));
}

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
  let baselineCallbacks = 0;
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1,
    baselineReview: async () => { baselineCallbacks++; started.resolve(); await finish.promise; } });
  await within(started.promise, "background extraction").catch(async error => {
    await diagnoseBaselineWait(t, f, baselineCallbacks); throw error;
  });
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
  let baselineCallbacks = 0;
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1,
    baselineReview: async () => { baselineCallbacks++; started.resolve(); await finish.promise; } });
  await within(started.promise, "uncooperative background reviewer").catch(async error => {
    await diagnoseBaselineWait(t, f, baselineCallbacks); throw error;
  });
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
  let baselineCallbacks = 0;
  const f = await lifecycle(t, { awaitInitialReview: false, panelSize: 1,
    baselineReview: async () => { baselineCallbacks++; started.resolve(); await finish.promise; } });
  await within(started.promise, "old background extraction").catch(async error => {
    await diagnoseBaselineWait(t, f, baselineCallbacks); throw error;
  });
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
