import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostRunDispatcher, createPostRunReviewPool } from "../lib/openclaw/post-run-dispatch.mjs";
import { waitPostRunTerminal, createPostRunHostRequester } from "../lib/openclaw/post-run-host.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-post-run-"));
  const sent = [], errors = [];
  const manager = createPostRunDispatcher({ directoryFor: () => root, defaultDirectory: root,
    validate: async () => true, waitTerminal: async () => ({ status: "ok" }), review: async () => ({ reviewStatus: "PASS" }),
    sendUser: async (r, task) => { sent.push({ sessionId: r.sessionId, ...task }); return { runId: task.runId }; },
    onError: e => errors.push(e), ...overrides });
  const identity = id => ({ agentId: "main", sessionKey: `agent:main:${id}`, sessionId: id, projectRoot: root, scopeFingerprint: "scope-1" });
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, manager, identity, sent, errors };
}

test('an unbounded trusted business correction reaches its next bounded review without execution expiry', async t => {
  let reviews = 0, cancelled = 0, f;
  f = await fixture(t, { cancelCorrection: async () => { cancelled++; }, review: async record => {
    reviews++;
    if (reviews === 1) { await f.manager.correction(record, 'repair-unbounded', Date.now() + 10000, 'stop-1'); return { reviewStatus: 'DEVIATION' }; }
    assert(Number.isFinite(record.deadlineAt));
    return { reviewStatus: 'PASS' };
  } });
  const id = f.identity('unbounded'); await f.manager.started(id, 'original');
  await f.manager.candidate(id, { runId: 'original', text: 'done', reviewBudgetMs: 10000 }); await f.manager.drain();
  await f.manager.started(id, 'repair-unbounded', null);
  await pause(60);
  assert.equal(f.manager.snapshot(id).phase, 'CORRECTING'); assert.equal(f.manager.snapshot(id).deadlineAt, null);
  await f.manager.started(id, 'repair-unbounded', 5);
  assert.equal(f.manager.snapshot(id).deadlineAt, null); assert.equal(cancelled, 0);
  await f.manager.candidate(id, { runId: 'repair-unbounded', text: 'fixed', reviewBudgetMs: 10000 }); await f.manager.drain();
  assert.equal(f.manager.snapshot(id).phase, 'IDLE'); assert.equal(f.manager.snapshot(id).reviewStatus, 'PASS');
  assert.equal(reviews, 2); assert.equal(cancelled, 0);
});

test('explicit owner cancellation still cancels an unbounded correction', async t => {
  let cancelled = 0, f;
  f = await fixture(t, { cancelCorrection: async (_record, runId) => { assert.equal(runId, 'repair-unbounded'); cancelled++; },
    review: async record => { await f.manager.correction(record, 'repair-unbounded', Date.now() + 10000, 'stop-1'); return { reviewStatus: 'DEVIATION' }; } });
  const id = f.identity('cancel-unbounded'); await f.manager.started(id, 'original');
  await f.manager.candidate(id, { runId: 'original', text: 'done', reviewBudgetMs: 10000 }); await f.manager.drain();
  await f.manager.started(id, 'repair-unbounded', null);
  await f.manager.release(id, 'USER_DISABLED'); await f.manager.drain();
  assert.equal(cancelled, 1); assert.equal(f.manager.snapshot(id).phase, 'IDLE');
});

test('task history retains target, unknown dispatch, actual start and final review across reload', async t => {
  const f = await fixture(t, { review: async () => ({ reviewStatus: 'UNVERIFIED', reasonCode: 'STOP_STAGE_METRICS_UNDECLARED',
    reviewSummary: { groundTruthVersion: 2, status: 'UNVERIFIED', scopeSelection: { fullObjectCount: 4, selectedObjectCount: 0 } } }) });
  const a = f.identity('a'), b = f.identity('b');
  const task = await f.manager.defer(a, { sourceId: 'control:one', text: 'insertion sort' }); await f.manager.drain();
  assert.equal(f.manager.snapshot(a).history[0].status, 'QUEUED');
  assert.equal(f.manager.snapshot(a).history[0].id, task.id);
  assert.equal(f.manager.get(b), undefined);
  const runId = f.sent[0].runId; await f.manager.started(a, runId);
  assert.equal(f.manager.snapshot(a).history[0].status, 'RUNNING');
  await f.manager.candidate(a, { runId, text: 'done', reviewBudgetMs: 10000 }); await f.manager.drain();
  const record = f.manager.snapshot(a);
  assert.equal(record.history[0].status, 'FINISHED'); assert.equal(record.history[0].reviewStatus, 'UNVERIFIED');
  assert.equal(record.pending.length, 0); assert.equal(record.reviewSummary.scopeSelection.fullObjectCount, 4);
  const recovered = createPostRunDispatcher({ directoryFor: () => f.root, defaultDirectory: f.root, validate: async () => true,
    sendUser: async () => { throw new Error('finished tasks cannot replay'); } });
  t.after(() => recovered.dispose()); await recovered.load();
  assert.equal(recovered.snapshot(a).history[0].status, 'FINISHED');
  assert.equal(recovered.snapshot(a).reviewSummary.groundTruthVersion, 2);
});

test('an unknown dispatch stays visible with one history record and never reports execution completion', async t => {
  const f = await fixture(t, { sendUser: async () => { throw new Error('lost response'); } });
  const id = f.identity('a'); await f.manager.defer(id, { sourceId: 'one', text: 'new work' }); await f.manager.drain();
  await f.manager.defer(id, { sourceId: 'one', text: 'new work' });
  assert.equal(f.manager.snapshot(id).history.length, 1);
  assert.equal(f.manager.snapshot(id).history[0].status, 'UNKNOWN');
  assert.equal(f.manager.snapshot(id).history[0].endedAt, undefined);
});

test("normal host terminal precedes review; deferred input never waits and survives correction priority", async t => {
  const terminal = deferred(), reviewed = deferred(); let reviews = 0, f;
  f = await fixture(t, { waitTerminal: () => terminal.promise, review: async record => {
    reviews++; await f.manager.correction(record, "repair-1", Date.now() + 10000, "stop-1"); reviewed.resolve();
    return { reviewStatus: "DEVIATION" };
  } });
  const id = f.identity("a");
  await f.manager.started(id, "run-1");
  const task = await f.manager.defer(id, { sourceId: "user-2", text: "next" });
  await f.manager.candidate(id, { runId: "run-1", text: "finished", reviewBudgetMs: 10000 });
  assert.equal(f.manager.snapshot(id).phase, "FINALIZING"); assert.equal(reviews, 0);
  terminal.resolve({ status: "ok" }); await reviewed.promise; await f.manager.drain();
  assert.equal(reviews, 1); assert.equal(f.manager.snapshot(id).phase, "WAIT_CORRECTION"); assert.equal(f.sent.length, 0);
  await f.manager.mutate(id, { id: task.id, revision: task.revision, text: "changed next" });
  await f.manager.started(id, "repair-1");
  await f.manager.candidate(id, { runId: "repair-1", text: "fixed", reviewBudgetMs: 10000, needsReview: false });
  await f.manager.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, "changed next");
  assert.equal(f.manager.snapshot(id).phase, "USER_DISPATCHING");
});

test("A reviewing never blocks B; deleting A's pending task does not cancel review", async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { review: async () => { started.resolve(); await gate.promise; return { reviewStatus: "PASS" }; } });
  const a = f.identity("a"), b = f.identity("b");
  await f.manager.started(a, "run-a");
  const task = await f.manager.defer(a, { sourceId: "pending-a", text: "pending A" });
  await f.manager.candidate(a, { runId: "run-a", text: "done", reviewBudgetMs: 10000 }); await started.promise;
  await f.manager.defer(b, { sourceId: "pending-b", text: "pending B" });
  await f.manager.mutate(a, { id: task.id, revision: 1, remove: true });
  assert.equal(f.manager.snapshot(a).phase, "REVIEWING");
  gate.resolve(); await f.manager.drain();
  assert.deepEqual(f.sent.map(x => x.sessionId), ["b"]); assert.equal(f.manager.snapshot(a).phase, "IDLE");
});

test("duplicate terminal and incoming events are idempotent; stale revisions cannot edit or delete", async t => {
  let reviews = 0;
  const f = await fixture(t, { review: async () => { reviews++; return { reviewStatus: "PASS" }; } });
  const a = f.identity("a"); await f.manager.started(a, "run-a");
  const task = await f.manager.defer(a, { sourceId: "m", text: "v1" });
  await f.manager.defer(a, { sourceId: "m", text: "v1" });
  assert.equal(f.manager.snapshot(a).pending.length, 1);
  await f.manager.mutate(a, { id: task.id, revision: 1, text: "v2" });
  await assert.rejects(f.manager.mutate(a, { id: task.id, revision: 1, remove: true }), { code: "CONFLICT" });
  await Promise.all([1, 2].map(() => f.manager.candidate(a, { runId: "run-a", text: "done", reviewBudgetMs: 10000 })));
  await f.manager.drain(); assert.equal(reviews, 1); assert.equal(f.sent[0].text, "v2");
  await assert.rejects(f.manager.mutate(a, { id: task.id, revision: 2, remove: true }), { code: "CONFLICT" });
});

test("reset fences a delayed review result and keeps another session independent", async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { review: async () => { started.resolve(); await gate.promise; return { reviewStatus: "PASS" }; } });
  const a = f.identity("a"); await f.manager.started(a, "run-a");
  await f.manager.defer(a, { text: "not after reset" });
  await f.manager.candidate(a, { runId: "run-a", text: "done", reviewBudgetMs: 10000 }); await started.promise;
  await f.manager.close(a); gate.resolve(); await f.manager.drain();
  assert.equal(f.manager.snapshot(a).phase, "CLOSED"); assert.equal(f.sent.length, 0);
  assert.equal(f.manager.get(f.identity("new-incarnation")), undefined);
});

test("review concurrency is bounded and queue wait consumes the review deadline", async t => {
  const gate = deferred(), started = deferred(); let calls = 0;
  const f = await fixture(t, { concurrency: 1, review: async () => { calls++; started.resolve(); await gate.promise; return { reviewStatus: "PASS" }; } });
  const a = f.identity("a"), b = f.identity("b");
  await f.manager.started(a, "run-a"); await f.manager.started(b, "run-b");
  await f.manager.candidate(a, { runId: "run-a", text: "done", reviewBudgetMs: 10000 }); await started.promise;
  await f.manager.candidate(b, { runId: "run-b", text: "done", reviewBudgetMs: 40 });
  await pause(100); assert.equal(f.manager.snapshot(b).phase, "IDLE");
  assert.equal(f.manager.snapshot(b).reviewStatus, "UNVERIFIED"); assert.equal(calls, 1);
  gate.resolve(); await f.manager.drain();
});

test("recovery does not resend an unknown user dispatch and preserves later pending tasks", async t => {
  const f = await fixture(t, { sendUser: async () => { throw new Error("lost ACK"); } });
  const a = f.identity("a"); await f.manager.defer(a, { sourceId: "1", text: "first" }); await f.manager.drain();
  await f.manager.defer(a, { sourceId: "2", text: "second" });
  let resends = 0;
  const recovered = createPostRunDispatcher({ directoryFor: () => f.root, defaultDirectory: f.root,
    validate: async () => true, waitTerminal: async () => ({ status: "timeout" }), review: async () => {},
    sendUser: async () => { resends++; } });
  t.after(() => recovered.dispose());
  await recovered.load(); await recovered.drain();
  const r = recovered.snapshot(a);
  assert.equal(resends, 0); assert.equal(r.dispatching.status, "UNKNOWN"); assert.equal(r.pending[0].text, "second");
  assert.equal(r.reason, "HOST_RUN_RECONCILIATION_REQUIRED");
});

test("host terminal reader rejects a different run and accepts only a trustworthy terminal", async () => {
  const calls = []; let count = 0;
  const api = { runtime: { gateway: { request: async (method, params) => {
    calls.push({ method, params }); return { runId: "r", status: ++count === 1 ? "timeout" : "ok" };
  } } } };
  assert.equal((await waitPostRunTerminal(api, {}, "r", Date.now() + 2000)).status, "ok");
  assert.equal(calls.length, 2); assert.equal(calls[0].method, "agent.wait");
  api.runtime.gateway.request = async () => ({ runId: "wrong", status: "ok" });
  await assert.rejects(waitPostRunTerminal(api, {}, "r", Date.now() + 2000), /IDENTITY/);
});

test("unknown host terminal holds later tasks instead of starting them beside an unfinished run", async t => {
  const f = await fixture(t, { waitTerminal: async () => null });
  const a = f.identity("a"); await f.manager.started(a, "run-a");
  await f.manager.defer(a, { text: "later" });
  await f.manager.candidate(a, { runId: "run-a", text: "done", reviewBudgetMs: 10000 });
  await f.manager.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.manager.snapshot(a).phase, "FINALIZING");
  assert.equal(f.manager.snapshot(a).reason, "HOST_RUN_RECONCILIATION_REQUIRED");
});

test("recovery checks the admitted corrective run instead of treating its ended parent as idle", async t => {
  let first;
  const f = await fixture(t, { review: async record => {
    await f.manager.correction(record, "queued-repair", Date.now() + 10000, "stop"); return { reviewStatus: "DEVIATION" };
  } });
  const a = f.identity("a"); await f.manager.started(a, "parent");
  await f.manager.defer(a, { text: "later" });
  await f.manager.candidate(a, { runId: "parent", text: "done", reviewBudgetMs: 10000 }); await f.manager.drain();
  await f.manager.dispose();
  const recovered = createPostRunDispatcher({ directoryFor: () => f.root, defaultDirectory: f.root, validate: async () => true,
    waitTerminal: async (_id, runId) => { first = runId; return { status: "timeout" }; },
    review: async () => assert.fail("An uncertain repair cannot be reviewed"), sendUser: () => assert.fail("Repair is still uncertain") });
  t.after(() => recovered.dispose());
  await recovered.load(); await recovered.drain();
  assert.equal(first, "queued-repair"); assert.equal(recovered.snapshot(a).pending.length, 1);
});

test("FIFO review slots are fair and cancellation does not release a slot twice", async () => {
  const pool = createPostRunReviewPool(1), first = deferred(), trace = [];
  const options = { deadlineAt: Date.now() + 10000 };
  const a = pool.run(async () => { trace.push("a"); await first.promise; }, options);
  const b = pool.run(async () => { trace.push("b"); }, options);
  const c = pool.run(async () => { trace.push("c"); }, options);
  await pause(10); assert.deepEqual(trace, ["a"]); first.resolve();
  await Promise.all([a, b, c]); assert.deepEqual(trace, ["a", "b", "c"]);
});

test("disposing a scheduler never waits for a terminal reader that ignores cancellation", async t => {
  const f = await fixture(t, { waitTerminal: () => new Promise(() => {}) });
  const a = f.identity("a"); await f.manager.started(a, "run-a");
  await f.manager.candidate(a, { runId: "run-a", text: "done", reviewBudgetMs: 10000 });
  await pause(10); const start = Date.now(); await f.manager.dispose();
  assert(Date.now() - start < 1000); assert.equal(f.manager.snapshot(a).phase, "FINALIZING");
});

test("reset during delayed scope validation cannot reopen review or dispatch a waiting task", async t => {
  const entered = deferred(), gate = deferred(); let reviewed = 0;
  const f = await fixture(t, { validate: async () => { entered.resolve(); await gate.promise; return true; },
    review: async () => { reviewed++; return { reviewStatus: "PASS" }; } });
  const a = f.identity("a"); await f.manager.started(a, "run-a"); await f.manager.defer(a, { text: "later" });
  await f.manager.candidate(a, { runId: "run-a", text: "done", reviewBudgetMs: 10000 });
  await entered.promise; await f.manager.close(a); gate.resolve(); await f.manager.drain();
  assert.equal(f.manager.snapshot(a).phase, "CLOSED"); assert.equal(reviewed, 0); assert.equal(f.sent.length, 0);
});

test("third-party host dispatch uses native authentication only after a definite pre-dispatch denial", async () => {
  const calls = []; let nativeCalls = 0;
  const api = { runtime: { gateway: { request: async () => {
    nativeCalls++; throw new Error("Gateway requests are only available to bundled or trusted official plugins.");
  } } } };
  const request = createPostRunHostRequester(api, { compatibility: async () => ({ callGatewayFromCli: async (...args) => {
    calls.push(args); return { runId: "r" };
  } }) });
  await request("agent.wait", { runId: "r" }); await request("chat.send", { idempotencyKey: "r" });
  assert.equal(nativeCalls, 1); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][3].scopes, ["operator.read", "operator.write"]); assert.equal(calls[0][1].json, true);
  const uncertain = createPostRunHostRequester({ runtime: { gateway: { request: async () => { throw new Error("ACK lost"); } } } },
    { compatibility: async () => assert.fail("An uncertain dispatch must never be sent through a second transport") });
  await assert.rejects(uncertain("chat.send", {}), /ACK lost/u);
});

test("concurrent first registration and duplicate receipt create only one pending task and host intent", async t => {
  const f = await fixture(t), a = f.identity("new");
  const results = await Promise.all(Array.from({ length: 5 }, () => f.manager.defer(a, { sourceId: "one", text: "only once" })));
  await f.manager.drain();
  assert.equal(new Set(results.map(r => r.id)).size, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.manager.list().sessions.length, 1); assert.equal(f.errors.length, 0);
});
