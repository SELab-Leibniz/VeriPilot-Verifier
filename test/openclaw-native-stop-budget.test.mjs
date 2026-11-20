import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { readMaterialBasis } from "../lib/openclaw/material-basis.mjs";
import { createOpenClawReviewerFactory } from "./helpers/legacy-openclaw-reviewer.mjs";
import { runInternalExecution } from "../lib/openclaw/internal-context.mjs";
import { createNativeStopFixture, basic, deferred, pause, until, within } from "./support/openclaw-native-stop-fixture.mjs";

const { lifecycle, findTask, withTaskState, readReport } = createNativeStopFixture();

test('an expired input gate cannot later publish admission after slow transcript I/O completes', async t => {
  const dispatched=deferred(t),terminal=deferred(t),slow=deferred(t),entered=deferred(t);let childRunId;
  const f=await lifecycle(t,{waitMode:'until_pass',observeModelStart:false,review:async()=>true,
    postRunTerminal:async(_identity,runId)=>{if(runId.startsWith('rc-stop-'))await terminal.promise;return {runId,status:'ok'};}});
  f.api.runtime.subagent={run:async args=>{childRunId=args.idempotencyKey;dispatched.resolve();return {runId:childRunId};}};
  // Initial fixture admission establishes the prior gate; this case tests the
  // subsequent real1s expiry, not the latency of that completed setup.
  const originalNow=Date.now,initialInputGate=f.runtime.beforeAgentRun;
  f.runtime.beforeAgentRun=async function(event,ctx){
    const fixedNow=Date.now(),clock=t.mock.method(Date,'now',()=>fixedNow),setupAbort=new AbortController();
    try {
      return await within(initialInputGate.call(this,event,{...ctx,
        abortSignal:ctx.abortSignal?AbortSignal.any([ctx.abortSignal,setupAbort.signal]):setupAbort.signal}),
        'initial fixture input admission');
    } finally {
      setupAbort.abort();clock.mock.restore();f.runtime.beforeAgentRun=initialInputGate;
    }
  };
  try {
    await f.runtime.reply({kind:'final',runId:f.ctx.runId,sessionKey:f.ctx.sessionKey,payload:{text:'Delivered.'}},f.ctx);
    await within(dispatched.promise,'correction dispatch');await within(f.runtime.waitForNativeReviews(),'initial review');
    const child={...f.ctx,runId:childRunId};const prompt=await f.runtime.prompt({prompt:'Apply current feedback.'},child);
    assert.equal(Date.now,originalNow,'the tested gate must use the original real clock');
    const previousGate=(await f.sharedState.stopStartProtocol.findRun({state:f.state,runId:childRunId})).admission.hostRequest.gate;
    const session=f.api.runtime.agent.session,getEntry=session.getSessionEntry;
    session.getSessionEntry=async(...args)=>{entered.resolve();await slow.promise;return getEntry(...args);};
    const targetStarted=performance.now(),gate=f.runtime.beforeAgentRun({prompt:prompt.prependContext},child);
    await within(entered.promise,'slow input identity check');
    assert.equal((await within(gate,'bounded input gate')).outcome,'block');
    assert(performance.now()-targetStarted>=900,'the target must retain its real1s expiry');
    slow.resolve();await pause(100);
    const receipt=await f.sharedState.stopStartProtocol.findRun({state:f.state,runId:childRunId});
    assert.equal(receipt.admission.accounting,'RESERVED');
    assert.deepEqual(receipt.admission.hostRequest.gate,previousGate,'late validation must not publish or replace a gate after denial');
  } finally {slow.resolve();terminal.resolve();await f.runtime.reset({},f.ctx);await f.runtime.waitForNativeReviews({drain:true});}
});

test('a failed attempt with slow transcript capture does not invalidate its admitted retry', async t => {
  const capture = deferred(t), entered = deferred(t), terminal = deferred(t);
  const f = await lifecycle(t, { waitMode: 'until_pass', postRunTerminal: async (_identity, runId) => {
    await terminal.promise;
    return { runId, status: 'ok' };
  } });
  const configPath = path.join(f.root, '.runtime-corrector/config.yaml');
  await fs.appendFile(configPath, '\nartifactCorrection:\n  originalRequirementsEnabled: true\n');
  const session = f.api.runtime.agent.session, getEntry = session.getSessionEntry;
  let blocked = true;
  session.getSessionEntry = async (...args) => {
    if (blocked) { blocked = false; entered.resolve(); await capture.promise; }
    return getEntry(...args);
  };
  f.api.pluginConfig.hookTimeoutMs = 1200;
  const ended = f.runtime.agentEnd({ runId: f.ctx.runId, success: false, error: 'Context overflow' }, f.ctx);
  await within(entered.promise, 'failed-attempt transcript capture');
  await within(ended, 'bounded failed-attempt hook');
  f.api.pluginConfig.hookTimeoutMs = 5000;
  assert.equal(f.state.nativeInvalidated, false, 'bookkeeping must not invalidate an admitted host retry');
  assert.equal(f.state.reviewController.signal.reason?.code, 'RC_NATIVE_ATTEMPT_ENDED');
  const oldController = f.state.reviewController;
  await f.runtime.prompt({ prompt: 'Retry after automatic compaction.' }, f.ctx);
  assert.notEqual(f.state.reviewController, oldController);
  assert.equal(f.state.reviewController.signal.aborted, false);
  capture.resolve();
  await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'retry-write', params: { path: 'draft.md' } }, f.ctx);
  await fs.writeFile(path.join(f.root, 'draft.md'), 'A draft delivered by the retried attempt.\n');
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey,
    payload: { text: 'Delivered after retry.' } }, f.ctx);
  terminal.resolve();
  await within(f.runtime.waitForNativeReviews({ drain: true }), 'retried Stop review');
  const task = await findTask({ projectRoot: f.root, sessionId: 'host' });
  assert.equal(task.verification.status, 'NO_DEVIATION_FOUND');
  assert.equal(f.hostAbort.signal.aborted, false);
});

test('a retried native turn retains its own persisted user input while later queued inputs stay excluded', async t => {
  const terminal = deferred(t);
  const f = await lifecycle(t, { waitMode: 'until_pass', postRunTerminal: async (_identity, runId) => {
    if (runId === 'second-business-run') await terminal.promise;
    return { runId, status: 'ok' };
  } });
  const completeNativeTurn = async (runId, description) => {
    const identity = { agentId: f.state.agentId, sessionId: f.state.sessionId, sessionKey: f.state.sessionKey,
      projectRoot: f.root, scopeFingerprint: f.state.projectScope.fingerprint,
      scopeTaskId: f.state.scopeTaskId ?? null, controlRevision: f.state.enabledRevision ?? 0 };
    const current = record => {
      assert.equal(f.state.nativeRunId, runId, 'Native turn owner changed');
      assert(!f.state.scopeClosed && !f.state.nativeInvalidated, 'Native turn is no longer current');
      assert(record && record.runId === runId, 'Dispatcher turn owner changed');
      for (const [key, value] of Object.entries(identity))
        assert.equal(record[key] ?? (key === 'controlRevision' ? 0 : key === 'scopeTaskId' ? null : undefined), value,
          `Dispatcher ${key} changed`);
    };
    const drain = f.runtime.waitForNativeReviews({ drain: true });
    void drain.catch(() => {}); // Preserve rejection for the bounded await without an unhandled race.
    let admissionOpen = true, originalDeadline;
    try {
      originalDeadline = await within((async () => {
        while (admissionOpen) {
          const record = f.post(); current(record);
          if (record.phase === 'IDLE') {
            assert(record.completedRuns?.includes(runId) && record.lastTerminal?.runId === runId
              && record.lastTerminal.terminalRunId === runId && record.lastTerminal.status === 'ok',
            'IDLE has no exact completed-turn receipt');
          }
          if (['REVIEW_QUEUED', 'REVIEWING', 'IDLE'].includes(record.phase)) {
            assert(Number.isFinite(record.deadlineAt), 'Missing original review phase deadline');
            return record.deadlineAt;
          }
          assert.notEqual(record.phase, 'CLOSED', 'Native turn closed before completion');
          await pause(2);
        }
      })(), `${description} admission`); // Retain the original real10s admission bound.
    } finally { admissionOpen = false; }
    const remaining = () => {
      current(f.post()); assert.equal(f.post().deadlineAt, originalDeadline, 'Original phase deadline changed');
      assert(Date.now() < originalDeadline, 'Original phase expired before durable completion');
      return originalDeadline - Date.now();
    };
    await within(drain, description, remaining());
    await within((async () => {
      const memory = f.post(); current(memory);
      const saved = JSON.parse(await fs.readFile(path.join(memory.directory, `${memory.id}.json`), 'utf8'));
      current(saved);
      assert.equal(saved.deadlineAt, originalDeadline);
      assert.equal(saved.phase, 'IDLE'); assert(saved.completedRuns.includes(runId));
      assert.equal(saved.lastTerminal?.runId, runId); assert.equal(saved.lastTerminal?.terminalRunId, runId);
      assert.equal(saved.lastTerminal?.status, 'ok'); assert.equal(saved.reviewStatus, 'NO_DEVIATION_FOUND');
      const jobs = [...f.sharedState.stopReviewJobs.values()].filter(job => job.projectRoot === f.root
        && job.record.runId === runId && job.record.sessionId === identity.sessionId
        && job.record.sessionKey === identity.sessionKey && (job.record.enabledRevision ?? 0) === identity.controlRevision);
      assert.equal(jobs.length, 1, 'Native completion receipt must have one exact owner');
      const record = jobs[0].record;
      const hash = text => createHash('sha256').update(text).digest('hex');
      const receipt = path.join(f.root, '.runtime-correction/openclaw/native-stop-reviews',
        hash(JSON.stringify([identity.sessionKey, identity.sessionId])),
        hash(record.enabledRevision ? JSON.stringify([record.occurrenceId, record.enabledRevision]) : record.occurrenceId) + '.json');
      const durable = JSON.parse(await fs.readFile(receipt, 'utf8'));
      assert.equal(durable.runId, runId); assert.equal(durable.sessionId, identity.sessionId);
      assert.equal(durable.sessionKey, identity.sessionKey); assert.equal(durable.ownerPid, process.pid);
      assert.equal(durable.occurrenceId, record.occurrenceId); assert.equal(durable.enabledRevision ?? 0, identity.controlRevision);
      assert.equal(durable.status, 'SETTLED'); assert.equal(durable.reviewStatus, 'NO_DEVIATION_FOUND');
      const timingChecks = {
        finiteAssessment: Number.isFinite(durable.assessmentCompletedAt),
        finiteNativeDeadline: Number.isFinite(durable.deadlineAt),
        finiteOriginalDeadline: Number.isFinite(originalDeadline),
        finiteSettlement: Number.isFinite(durable.settledAt),
        assessmentWithinNative: durable.assessmentCompletedAt <= durable.deadlineAt,
        assessmentWithinOriginal: durable.assessmentCompletedAt <= originalDeadline,
        settlementWithinOriginal: durable.settledAt <= originalDeadline
      };
      const timingValid = Object.values(timingChecks).every(Boolean);
      if (!timingValid) t.diagnostic('NATIVE_COMPLETION_TIMING ' + JSON.stringify({
        runId, description, checks: timingChecks,
        timestamps: Object.fromEntries(Object.entries({ assessmentCompletedAt: durable.assessmentCompletedAt,
          nativeDeadlineAt: durable.deadlineAt, originalDeadlineAt: originalDeadline, settledAt: durable.settledAt })
          .map(([key, value]) => [key, typeof value === 'number' ? Number.isFinite(value) ? value : String(value) : typeof value]))
      }));
      assert(timingValid, 'Native completion must belong to the original unexpired phase');
      const task = await findTask({ projectRoot: f.root, sessionId: identity.sessionId });
      assert.equal(task.verification.status, 'NO_DEVIATION_FOUND');
      assert.equal(task.verification.evaluationId, durable.evaluationId);
      remaining(); // A late read may not turn an expired observation into completion.
    })(), `${description} durable receipt`, remaining());
  };
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey,
    payload: { text: 'First task delivered.' } }, f.ctx);
  try {
    await completeNativeTurn(f.ctx.runId, 'first task completion');
  } catch (error) {
    // Observe only: retain the original watchdog, failure and ownership assertions.
    try {
      const post = f.post();
      const text = value => typeof value === 'string' ? value.slice(0, 160) : null;
      t.diagnostic('NATIVE_STOP_FIRST_COMPLETION_DIAGNOSTIC ' + JSON.stringify({
        runId: f.ctx.runId, nativeRunId: text(f.state.nativeRunId),
        controllerAborted: f.state.reviewController.signal.aborted,
        controllerReason: text(f.state.reviewController.signal.reason?.code),
        post: post ? { runId: text(post.runId), phase: text(post.phase), reason: text(post.reason),
          deadlineAt: Number.isFinite(post.deadlineAt) ? post.deadlineAt : null,
          completedRuns: (post.completedRuns ?? []).slice(-4).map(text),
          lastTerminal: post.lastTerminal ? { runId: text(post.lastTerminal.runId),
            terminalRunId: text(post.lastTerminal.terminalRunId), status: text(post.lastTerminal.status) } : null } : null,
        warnings: f.warnings.slice(-8).map(text)
      }));
    } catch { /* Diagnostics cannot replace or suppress the original failure. */ }
    throw error;
  }
  await until(() => f.post().phase === 'IDLE', 'first host terminal');

  const next = { ...f.ctx, runId: 'second-business-run' };
  // The pinned host calls before_prompt_build before persisting this input.
  await f.runtime.prompt({ prompt: 'Revise the draft.' }, next);
  const source = path.join(f.root, 'native.jsonl');
  await fs.appendFile(source, '\n' + JSON.stringify({ type: 'message', id: 'second-user', parentId: 'u',
    message: { role: 'user', content: 'Revise the draft.', idempotencyKey: `${next.runId}:user` } }) + '\n');
  // A context precheck can fail before the first tool has observed the user.
  await f.runtime.agentEnd({ runId: next.runId, success: false, error: 'Context overflow' }, next);
  assert.equal(f.post().phase, 'FINALIZING');
  await fs.appendFile(source, JSON.stringify({ type: 'message', id: 'queued-user', parentId: 'second-user',
    message: { role: 'user', content: 'A later task.', idempotencyKey: 'future-run:user' } }) + '\n');
  await f.runtime.prompt({ prompt: 'Retry the current task after compaction.' }, next);
  const entries = (await fs.readFile(f.state.transcriptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const users = entries.filter(entry => entry.type === 'user' && !entry.isMeta).map(entry => entry.uuid);
  assert.deepEqual(users, ['u', 'second-user'], 'the current host input must replace the previous flow boundary');
  await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'second-write', params: { path: 'draft.md' } }, next);
  await fs.writeFile(path.join(f.root, 'draft.md'), 'A revised delivered draft.\n');
  await f.runtime.reply({ kind: 'final', runId: next.runId, sessionKey: next.sessionKey,
    payload: { text: 'Revised draft delivered.' } }, next);
  terminal.resolve();
  await completeNativeTurn(next.runId, 'second task review');
  const task = await findTask({ projectRoot: f.root, sessionId: 'host' });
  assert.equal(task.verification.status, 'NO_DEVIATION_FOUND', 'a new user turn must not inherit CORRECTION_FLOW_CLOSED');
});

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
