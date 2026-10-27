import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostRunDispatcher } from "../lib/openclaw/post-run-dispatch.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 5000;
  while (!check()) { assert(Date.now() < end, `Timed out: ${label}`); await pause(5); }
}
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-scenarios-"));
  const sent = [], errors = [], cancelled = [];
  const manager = createPostRunDispatcher({ directoryFor: () => directory, defaultDirectory: directory,
    validate: async () => true, waitTerminal: async () => ({ status: "ok" }),
    review: async () => ({ reviewStatus: "PASS" }),
    sendUser: async (record, task) => { sent.push({ sessionId: record.sessionId, ...task }); return { runId: task.runId }; },
    cancelCorrection: async (_record, runId) => { cancelled.push(runId); }, onError: error => errors.push(error), ...overrides });
  t.after(async () => { await manager.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const identity = sessionId => ({ agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId,
    projectRoot: directory, scopeFingerprint: "scope", scopeTaskId: "activation-1", controlRevision: 0 });
  return { manager, identity, sent, errors, cancelled, directory };
}
async function endRun(f, id, runId, options = {}) {
  await f.manager.candidate(id, { runId, text: `Completed ${runId}`, reviewBudgetMs: 10000, ...options });
  await f.manager.drain();
}
async function completeUser(f, id, index) {
  const runId = f.sent[index].runId;
  await f.manager.started(id, runId);
  await endRun(f, id, runId, { needsReview: false });
}

// Assert actual transitions and subsequent turns, rather than only an ALLOW flag.
for (const outcome of [
  { name: "Stop not required", needsReview: false, status: "DISABLED" },
  { name: "PASS", status: "PASS" },
  { name: "disabled metrics", status: "DISABLED" },
  { name: "no actionable feedback", status: "UNVERIFIED", reason: "NO_VALID_FEEDBACK" },
  { name: "unsupported correction protocol", status: "DEVIATION", reason: "HOST_START_PROTOCOL_UNSUPPORTED" },
  { name: "session quota exhausted", status: "DEVIATION", reason: "SESSION_CORRECTION_LIMIT" },
  { name: "flow quota exhausted", status: "DEVIATION", reason: "FLOW_CORRECTION_LIMIT" },
  { name: "host admission refused", status: "UNVERIFIED", reason: "HOST_ADMISSION_DENIED" },
  { name: "review cancelled", status: "CANCELLED", reason: "STOP_CANCELLED" },
  { name: "review failed", throws: true, status: "UNVERIFIED", reason: "CHECKER_FAILED" },
]) test(`release scenario: ${outcome.name} runs edited FIFO tasks exactly once and returns idle`, async t => {
  const terminal = deferred(); let reviews = 0;
  const f = await fixture(t, { waitTerminal: (_record, runId) => runId === "business" ? terminal.promise : { status: "ok" },
    review: async () => { reviews++; if (outcome.throws) throw Object.assign(new Error("checker failed"), { code: outcome.reason });
      return { reviewStatus: outcome.status, reasonCode: outcome.reason }; } });
  const id = f.identity("release"); await f.manager.started(id, "business");
  const first = await f.manager.defer(id, { sourceId: "one", text: "original first" });
  const removed = await f.manager.defer(id, { sourceId: "two", text: "deleted second" });
  await f.manager.candidate(id, { runId: "business", text: "Done", reviewBudgetMs: 10000, needsReview: outcome.needsReview });
  assert.equal(f.manager.snapshot(id).phase, "FINALIZING"); assert.equal(f.sent.length, 0);
  await f.manager.mutate(id, { id: first.id, revision: 1, text: "edited first" });
  await f.manager.mutate(id, { id: removed.id, revision: 1, remove: true });
  await f.manager.defer(id, { sourceId: "three", text: "third" });
  terminal.resolve({ status: "ok" }); await f.manager.drain();
  assert.equal(reviews, outcome.needsReview === false ? 0 : 1);
  assert.equal(f.manager.snapshot(id).reviewStatus, outcome.status);
  if (outcome.reason) assert.equal(f.manager.snapshot(id).reason, outcome.reason);
  assert.deepEqual(f.sent.map(task => task.text), ["edited first"]);
  assert.deepEqual(f.manager.snapshot(id).pending.map(task => task.text), ["third"]);
  await assert.rejects(f.manager.mutate(id, { id: first.id, revision: 2, text: "too late" }), { code: "CONFLICT" });
  await endRun(f, id, "business"); // Delayed duplicate cannot release the second task.
  assert.equal(f.sent.length, 1);
  await completeUser(f, id, 0);
  assert.deepEqual(f.sent.map(task => task.text), ["edited first", "third"]);
  await completeUser(f, id, 1);
  assert.equal(f.manager.snapshot(id).phase, "IDLE"); assert.equal(f.manager.snapshot(id).pending.length, 0);
  assert.equal(new Set(f.sent.map(task => task.runId)).size, 2); assert.deepEqual(f.errors, []);
});

test("two corrective rounds keep user work waiting through start, execution and review, then release FIFO", async t => {
  let calls = 0, f;
  f = await fixture(t, { review: async record => {
    if (++calls <= 2) { await f.manager.correction(record, `repair-${calls}`, Date.now() + 10000, `stop-${calls}`);
      return { reviewStatus: "DEVIATION" }; }
    return { reviewStatus: "PASS" };
  } });
  const id = f.identity("loop"); await f.manager.started(id, "business");
  let task = await f.manager.defer(id, { text: "user first" });
  await endRun(f, id, "business");
  for (const number of [1, 2]) {
    assert.equal(f.manager.snapshot(id).phase, "WAIT_CORRECTION"); assert.equal(f.sent.length, 0);
    await f.manager.mutate(id, { id: task.id, revision: number, text: `edited ${number}` });
    await f.manager.started(id, `repair-${number}`);
    assert.equal(f.manager.snapshot(id).phase, "CORRECTING"); assert.equal(f.sent.length, 0);
    const extra = await f.manager.defer(id, { text: `remove during correction ${number}` });
    await f.manager.mutate(id, { id: extra.id, revision: 1, remove: true });
    await endRun(f, id, `repair-${number}`);
  }
  assert.equal(calls, 3); assert.deepEqual(f.sent.map(task => task.text), ["edited 2"]);
  await completeUser(f, id, 0); assert.equal(f.manager.snapshot(id).phase, "IDLE");
  assert.deepEqual(f.cancelled, []); assert.deepEqual(f.errors, []);
});

test("a queued review deadline releases its own next task while a different session keeps reviewing", async t => {
  const gate = deferred(), entered = deferred(); let reviews = 0;
  const f = await fixture(t, { concurrency: 1, review: async () => { reviews++; entered.resolve(); await gate.promise; return { reviewStatus: "PASS" }; } });
  const a = f.identity("a"), b = f.identity("b");
  await f.manager.started(a, "a-business"); await f.manager.defer(a, { text: "a-next" });
  await f.manager.candidate(a, { runId: "a-business", text: "done", reviewBudgetMs: 10000 }); await entered.promise;
  await f.manager.started(b, "b-business"); await f.manager.defer(b, { text: "b-next" });
  await f.manager.candidate(b, { runId: "b-business", text: "done", reviewBudgetMs: 150 });
  await until(() => f.sent.length === 1, "queued deadline release");
  assert.equal(f.sent[0].text, "b-next"); assert.equal(f.manager.snapshot(b).reviewStatus, "UNVERIFIED");
  assert.equal(f.manager.snapshot(a).phase, "REVIEWING"); assert.equal(reviews, 1);
  gate.resolve(); await f.manager.drain(); assert.deepEqual(f.sent.map(task => task.text), ["b-next", "a-next"]);
});

test("review timeout releases one task and late PASS or correction cannot touch its next run", async t => {
  const entered = deferred(), gate = deferred(); let old;
  const f = await fixture(t, { review: async record => { old = record; entered.resolve(); await gate.promise; return { reviewStatus: "PASS" }; } });
  const id = f.identity("timeout"); await f.manager.started(id, "business");
  await f.manager.defer(id, { text: "first" }); await f.manager.defer(id, { text: "second" });
  await f.manager.candidate(id, { runId: "business", text: "done", reviewBudgetMs: 150 }); await entered.promise;
  await f.manager.drain(); assert.deepEqual(f.sent.map(task => task.text), ["first"]);
  assert.equal(f.manager.snapshot(id).reviewStatus, "UNVERIFIED");
  await f.manager.started(id, f.sent[0].runId);
  gate.resolve(); await pause(10);
  await assert.rejects(f.manager.correction(old, "late-repair", Date.now() + 10000, "old-stop"), { code: "CONFLICT" });
  assert.equal(f.manager.snapshot(id).phase, "RUNNING"); assert.equal(f.sent.length, 1);
  await completeUser(f, id, 0); assert.equal(f.sent[1].text, "second");
});

test("correction cancellation finishes cleanup before the next user task starts", async t => {
  const cleanup = deferred(), entered = deferred(); let f;
  f = await fixture(t, { review: async record => {
    await f.manager.correction(record, "repair", Date.now() + 10000, "stop"); return { reviewStatus: "DEVIATION" };
  }, cancelCorrection: async () => { entered.resolve(); await cleanup.promise; } });
  const id = f.identity("cancel"); await f.manager.started(id, "business");
  await f.manager.defer(id, { text: "first" }); await f.manager.defer(id, { text: "second" });
  await endRun(f, id, "business"); await f.manager.started(id, "repair");
  const release = f.manager.release(id, "MANUAL_CANCEL"); await entered.promise;
  assert.equal(f.manager.snapshot(id).phase, "RELEASING"); assert.equal(f.sent.length, 0);
  cleanup.resolve(); await release;
  assert.deepEqual(f.sent.map(task => task.text), ["first"]); assert.equal(f.manager.snapshot(id).reason, "MANUAL_CANCEL");
  await endRun(f, id, "repair"); assert.equal(f.sent.length, 1);
  await completeUser(f, id, 0); assert.equal(f.sent[1].text, "second");
});

test("a start watchdog already queued before a trusted start cannot expire the new execution window", async t => {
  const gate = deferred(), reserved = deferred(); let f;
  f = await fixture(t, { review: async record => {
    await f.manager.correction(record, "repair", Date.now() + 50, "stop"); reserved.resolve(); await gate.promise;
    return { reviewStatus: "DEVIATION" };
  } });
  const id = f.identity("watchdog"); await f.manager.started(id, "business"); await f.manager.defer(id, { text: "later" });
  await f.manager.candidate(id, { runId: "business", text: "done", reviewBudgetMs: 10000 }); await reserved.promise;
  await pause(100); // The first watchdog has fired and is queued behind the review callback.
  await f.manager.started(id, "repair", 10000); gate.resolve(); await f.manager.drain();
  assert.equal(f.manager.snapshot(id).phase, "CORRECTING"); assert.equal(f.sent.length, 0);
  await endRun(f, id, "repair", { needsReview: false }); assert.equal(f.sent.length, 1);
});

test("reset during user-task validation prevents a late host dispatch", async t => {
  const gate = deferred(), entered = deferred(); let calls = 0;
  const f = await fixture(t, { validate: async () => { if (++calls === 2) { entered.resolve(); await gate.promise; } return true; } });
  const id = f.identity("reset-dispatch"); await f.manager.started(id, "business"); await f.manager.defer(id, { text: "cancelled by reset" });
  await f.manager.candidate(id, { runId: "business", text: "done", reviewBudgetMs: 10000, needsReview: false });
  await entered.promise; await f.manager.close(id, "SESSION_RESET"); gate.resolve(); await f.manager.drain();
  assert.equal(f.manager.snapshot(id).phase, "CLOSED"); assert.equal(f.sent.length, 0);
});

test("restarting after a lost user ACK waits for that run, then releases only the next pending task", async t => {
  const f = await fixture(t, { sendUser: async () => { throw new Error("lost ACK"); } });
  const id = f.identity("restart"); await f.manager.defer(id, { sourceId: "one", text: "uncertain first" }); await f.manager.drain();
  await f.manager.defer(id, { sourceId: "two", text: "second" }); await f.manager.defer(id, { sourceId: "three", text: "third" });
  const oldRunId = f.manager.snapshot(id).dispatching.runId; await f.manager.dispose();
  const sent = [], observed = [];
  const recovered = createPostRunDispatcher({ directoryFor: () => f.directory, defaultDirectory: f.directory, validate: async () => true,
    waitTerminal: async (_record, runId) => { observed.push(runId); return { status: "ok" }; }, review: async () => ({ reviewStatus: "PASS" }),
    sendUser: async (_record, task) => { sent.push(task); return { runId: task.runId }; } });
  t.after(() => recovered.dispose()); await recovered.load(); await recovered.drain();
  assert.deepEqual(observed, [oldRunId]); assert.deepEqual(sent.map(task => task.text), ["second"]);
  assert.equal(recovered.snapshot(id).pending[0].text, "third");
  await recovered.started(id, sent[0].runId);
  await recovered.candidate(id, { runId: sent[0].runId, text: "done", needsReview: false, reviewBudgetMs: 10000 }); await recovered.drain();
  assert.deepEqual(sent.map(task => task.text), ["second", "third"]);
});

test("24 sessions keep FIFO task order, bounded reviews and isolated task mutations", async t => {
  let active = 0, maximum = 0;
  const f = await fixture(t, { concurrency: 3, review: async () => {
    maximum = Math.max(maximum, ++active); await pause(10); active--; return { reviewStatus: "PASS" };
  } });
  const ids = Array.from({ length: 24 }, (_, i) => f.identity(`session-${i}`));
  await Promise.all(ids.map(async (id, i) => {
    await f.manager.started(id, `business-${i}`);
    const first = await f.manager.defer(id, { sourceId: "first", text: `first-${i}` });
    const deleted = await f.manager.defer(id, { sourceId: "deleted", text: `deleted-${i}` });
    await f.manager.defer(id, { sourceId: "last", text: `last-${i}` });
    await f.manager.mutate(id, { id: first.id, revision: 1, text: `edited-${i}` });
    await f.manager.mutate(id, { id: deleted.id, revision: 1, remove: true });
    await f.manager.candidate(id, { runId: `business-${i}`, text: "done", reviewBudgetMs: 15000 });
  }));
  await f.manager.drain(); assert(maximum <= 3); assert(maximum > 1); assert.equal(f.sent.length, 24);
  await Promise.all(ids.map(async (id, i) => {
    const sent = f.sent.find(task => task.sessionId === id.sessionId); assert.equal(sent.text, `edited-${i}`);
    await f.manager.started(id, sent.runId);
    await f.manager.candidate(id, { runId: sent.runId, text: "done", needsReview: false, reviewBudgetMs: 10000 });
  }));
  await f.manager.drain(); assert.equal(f.sent.length, 48);
  for (const [i, id] of ids.entries()) assert.deepEqual(f.sent.filter(task => task.sessionId === id.sessionId).map(task => task.text), [`edited-${i}`, `last-${i}`]);
  assert.equal(f.manager.list({ filter: "pending" }).total, 0); assert.deepEqual(f.errors, []);
});

test("a delayed trusted model-start event cannot rewind the correction's final review", async t => {
  const entered = deferred(), gate = deferred(); let f;
  f = await fixture(t, { review: async record => {
    if (record.runId === "business") { await f.manager.correction(record, "repair", Date.now() + 10000, "stop"); return { reviewStatus: "DEVIATION" }; }
    entered.resolve(); await gate.promise; return { reviewStatus: "PASS" };
  } });
  const id = f.identity("late-model-start"); await f.manager.started(id, "business"); await f.manager.defer(id, { text: "later" });
  await endRun(f, id, "business"); await f.manager.started(id, "repair");
  await f.manager.candidate(id, { runId: "repair", text: "fixed", reviewBudgetMs: 10000 }); await entered.promise;
  await f.manager.started(id, "repair");
  const phase = f.manager.snapshot(id).phase;
  gate.resolve(); await f.manager.drain();
  assert.equal(phase, "REVIEWING"); assert.equal(f.sent.length, 1);
});

test("deleting every pending task keeps correction alive; a later task is picked up after PASS", async t => {
  let calls = 0, f;
  f = await fixture(t, { review: async record => {
    if (++calls === 1) { await f.manager.correction(record, "repair", Date.now() + 10000, "stop"); return { reviewStatus: "DEVIATION" }; }
    return { reviewStatus: "PASS" };
  } });
  const id = f.identity("empty-then-add"); await f.manager.started(id, "business");
  const deleted = await f.manager.defer(id, { sourceId: "one", text: "delete me" }); await endRun(f, id, "business");
  await f.manager.mutate(id, { id: deleted.id, revision: 1, remove: true });
  assert.equal(f.manager.snapshot(id).phase, "WAIT_CORRECTION"); assert.equal(f.manager.snapshot(id).pending.length, 0);
  const duplicate = await f.manager.defer(id, { sourceId: "one", text: "delete me" });
  assert.equal(duplicate.duplicate, true); assert.equal(f.manager.snapshot(id).pending.length, 0);
  await f.manager.started(id, "repair"); await f.manager.defer(id, { sourceId: "two", text: "added during repair" });
  await endRun(f, id, "repair"); assert.deepEqual(f.sent.map(task => task.text), ["added during repair"]);
  await completeUser(f, id, 0); assert.equal(f.manager.snapshot(id).phase, "IDLE");
  await f.manager.defer(id, { sourceId: "three", text: "added while idle" }); await f.manager.drain();
  assert.deepEqual(f.sent.map(task => task.text), ["added during repair", "added while idle"]);
});

test("an empty user queue does not stop two correction rounds or invent a subsequent task", async t => {
  let calls = 0, f;
  f = await fixture(t, { review: async record => {
    if (++calls <= 2) { await f.manager.correction(record, `repair-${calls}`, Date.now() + 10000, `stop-${calls}`); return { reviewStatus: "DEVIATION" }; }
    return { reviewStatus: "PASS" };
  } });
  const id = f.identity("empty-loop"); await f.manager.started(id, "business"); await endRun(f, id, "business");
  for (const i of [1, 2]) { await f.manager.started(id, `repair-${i}`); await endRun(f, id, `repair-${i}`); }
  assert.equal(calls, 3); assert.equal(f.sent.length, 0); assert.equal(f.manager.snapshot(id).phase, "IDLE");
});

test("closed sessions keep their list for inspection but cannot dispatch, edit, delete or accept tasks", async t => {
  const f = await fixture(t), id = f.identity("closed"); await f.manager.started(id, "business");
  const task = await f.manager.defer(id, { sourceId: "one", text: "preserved" }); await f.manager.close(id, "SESSION_RESET");
  await assert.rejects(f.manager.defer(id, { text: "new" }), { code: "CONFLICT" });
  await assert.rejects(f.manager.mutate(id, { id: task.id, revision: 1, text: "edit" }), { code: "CONFLICT" });
  await assert.rejects(f.manager.mutate(id, { id: task.id, revision: 1, remove: true }), { code: "CONFLICT" });
  await f.manager.started(id, "late-start"); await endRun(f, id, "business");
  assert.equal(f.manager.list({ filter: "active" }).total, 0); assert.equal(f.manager.list({ filter: "pending" }).total, 1);
  assert.equal(f.manager.snapshot(id).pending[0].text, "preserved"); assert.equal(f.sent.length, 0);
  const reactivated = { ...id, scopeTaskId: "activation-2", controlRevision: 1 };
  await f.manager.defer(reactivated, { text: "fresh activation" }); await f.manager.drain();
  assert.equal(f.sent[0].text, "fresh activation"); assert.equal(f.manager.snapshot(id).phase, "CLOSED");
});

test("editing or deleting at the same time as release produces one atomic decision", async t => {
  const gates = new Map(), entered = new Map();
  const f = await fixture(t, { review: async record => { entered.get(record.sessionId).resolve(); await gates.get(record.sessionId).promise; return { reviewStatus: "PASS" }; } });
  for (let i = 0; i < 12; i++) {
    const id = f.identity(`race-${i}`); gates.set(id.sessionId, deferred()); entered.set(id.sessionId, deferred());
    await f.manager.started(id, `business-${i}`); const task = await f.manager.defer(id, { text: `original-${i}` });
    await f.manager.candidate(id, { runId: `business-${i}`, text: "done", reviewBudgetMs: 10000 }); await entered.get(id.sessionId).promise;
    const remove = i % 2 === 0;
    const mutation = f.manager.mutate(id, { id: task.id, revision: 1, text: `edited-${i}`, remove });
    gates.get(id.sessionId).resolve(); const result = await Promise.allSettled([mutation]); await f.manager.drain();
    const sent = f.sent.filter(task => task.sessionId === id.sessionId); assert(sent.length <= 1);
    if (result[0].status === "fulfilled") assert.deepEqual(sent.map(task => task.text), remove ? [] : [`edited-${i}`]);
    else { assert.equal(result[0].reason.code, "CONFLICT"); assert.deepEqual(sent.map(task => task.text), [`original-${i}`]); }
  }
  assert.deepEqual(f.errors, []);
});

test("an RC failure during finalization cannot release queued work before the business host terminal", async t => {
  const terminal = deferred(), firstQuery = deferred(), cleanupQuery = deferred(); let queries = 0;
  const f = await fixture(t, { waitTerminal: () => { (++queries === 1 ? firstQuery : cleanupQuery).resolve(); return terminal.promise; } });
  const id = f.identity("failed-hook"); await f.manager.started(id, "business");
  await f.manager.defer(id, { text: "first" }); await f.manager.defer(id, { text: "second" });
  await f.manager.candidate(id, { runId: "business", text: "done", reviewBudgetMs: 10000 });
  await firstQuery.promise;
  const release = f.manager.release(id, "RC_HOOK_UNAVAILABLE");
  const result = await Promise.race([cleanupQuery.promise.then(() => "checked"), release.then(() => "released")]);
  const sentBeforeTerminal = f.sent.length;
  terminal.resolve({ status: "ok" }); await release; await f.manager.drain();
  assert.equal(result, "checked");
  assert.equal(sentBeforeTerminal, 0); assert.deepEqual(f.sent.map(task => task.text), ["first"]);
});

for (const started of [false, true]) test(`cancellation while ${started ? "executing" : "waiting for"} correction waits for its terminal after abort ACK`, async t => {
  const terminal = deferred(), queried = deferred(); let f;
  f = await fixture(t, { waitTerminal: (_record, runId) => {
    if (runId === "repair") { queried.resolve(); return terminal.promise; } return { status: "ok" };
  }, review: async record => { await f.manager.correction(record, "repair", Date.now() + 10000, "stop"); return { reviewStatus: "DEVIATION" }; } });
  const id = f.identity("cancel-terminal"); await f.manager.started(id, "business");
  await f.manager.defer(id, { text: "first" }); await f.manager.defer(id, { text: "second" }); await endRun(f, id, "business");
  if (started) await f.manager.started(id, "repair");
  const release = f.manager.release(id, "CANCEL_CORRECTION");
  const result = await Promise.race([queried.promise.then(() => "checked"), release.then(() => "released")]);
  const sentBeforeTerminal = f.sent.length;
  terminal.resolve({ status: "error" }); await release; await f.manager.drain();
  assert.equal(result, "checked");
  assert.equal(sentBeforeTerminal, 0); assert.deepEqual(f.sent.map(task => task.text), ["first"]);
  assert.equal(f.cancelled[0], "repair");
});

test("unknown correction terminal after cancellation survives restart and never falls back to its ended parent", async t => {
  let f;
  f = await fixture(t, { waitTerminal: (_record, runId) => runId === "repair" ? null : { status: "ok" },
    review: async record => { await f.manager.correction(record, "repair", Date.now() + 10000, "stop"); return { reviewStatus: "DEVIATION" }; } });
  const id = f.identity("cancel-restart"); await f.manager.started(id, "business");
  await f.manager.defer(id, { text: "first" }); await f.manager.defer(id, { text: "second" }); await endRun(f, id, "business");
  await f.manager.release(id, "CORRECTION_CANCELLED");
  assert.equal(f.manager.snapshot(id).phase, "RELEASING"); assert.equal(f.sent.length, 0);
  await f.manager.release(id, "DUPLICATE_RELEASE");
  assert.equal(f.manager.snapshot(id).terminalRelease.runId, "repair"); await f.manager.dispose();
  const observed = [], sent = [];
  const recovered = createPostRunDispatcher({ directoryFor: () => f.directory, defaultDirectory: f.directory,
    validate: async () => true, waitTerminal: async (_record, runId) => { observed.push(runId); return { status: "error" }; },
    review: () => assert.fail("Cancelled correction cannot start a review"),
    sendUser: async (_record, task) => { sent.push(task); return { runId: task.runId }; } });
  t.after(() => recovered.dispose()); await recovered.load(); await recovered.drain();
  assert.deepEqual(observed, ["repair"]); assert.deepEqual(sent.map(task => task.text), ["first"]);
  assert.equal(recovered.snapshot(id).reason, "CORRECTION_CANCELLED");
  assert.equal(recovered.snapshot(id).pending[0].text, "second");
});

test("a review failure releases after the already confirmed host terminal even if later terminal queries fail", async t => {
  let queries = 0;
  const f = await fixture(t, { waitTerminal: () => ++queries === 1 ? { status: "ok" } : null,
    review: async () => { throw Object.assign(new Error("review failed"), { code: "CHECKER_FAILED" }); } });
  const id = f.identity("known-terminal"); await f.manager.started(id, "business"); await f.manager.defer(id, { text: "first" });
  await endRun(f, id, "business");
  assert.deepEqual(f.sent.map(task => task.text), ["first"]); assert.equal(queries, 1);
  assert.equal(f.manager.snapshot(id).reviewStatus, "UNVERIFIED"); assert.equal(f.manager.snapshot(id).reason, "CHECKER_FAILED");
});

test("a transient Windows atomic-rename refusal preserves one durable task and one subsequent dispatch", async t => {
  const f = await fixture(t), id = f.identity("windows-write"); await f.manager.started(id, "business");
  const record = f.manager.snapshot(id), destination = path.join(f.directory, `${record.id}.json`), rename = fs.rename;
  let refusals = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (target === destination && refusals++ === 0) throw Object.assign(new Error("temporarily busy"), { code: "EPERM" });
    return rename(source, target);
  });
  const task = await f.manager.defer(id, { sourceId: "one", text: "survives Windows sharing violation" });
  const saved = JSON.parse(await fs.readFile(destination, "utf8"));
  assert.equal(saved.pending.length, 1); assert.equal(saved.pending[0].id, task.id); assert(refusals >= 2);
  await f.manager.defer(id, { sourceId: "one", text: "survives Windows sharing violation" });
  await endRun(f, id, "business", { needsReview: false });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].id, task.id); assert.deepEqual(f.errors, []);
});
