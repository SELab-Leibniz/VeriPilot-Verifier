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
