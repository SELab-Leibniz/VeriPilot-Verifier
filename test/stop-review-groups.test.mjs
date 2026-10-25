import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createStopReviewStore } from "../lib/runtime-v2/stop-review-store.mjs";
import { runStopReviewRound } from "../lib/runtime-v2/stop-review-round.mjs";
import { validateProductionTrace } from "../lib/review-task/production-trace.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";
import { assessStopCorrection } from "../lib/runtime-v2/stop-correction-assessment.mjs";

const trace = () => ({ version: 1, entryPoint: "main.py:convert", actualInput: "CLI argument", producerToConsumer: "The parsed argument is converted and returned to the caller.",
  stateful: false, statelessReason: "This pure conversion has no shared or persisted state.", stateTargets: [], targetRelations: [] });
const verdict = (judgement = "PASS") => ({ judgement, reason: "The observed source supports this item verdict.", evidence: judgement === "UNVERIFIED" ? [] : ["main.py:1"] });
async function fixture(t, options = {}) {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "stop-groups-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "main.py"), "def convert(value): return int(value)\n");
  await fs.writeFile(path.join(directory, "other.py"), "unrelated = True\n");
  let clock = 1000;
  const now = options.now ?? (() => clock);
  const dependenciesCurrent = async definition => {
    for (const dependency of definition.dependencies) {
      try { if (sha256(await fs.readFile(path.join(directory, dependency.path))) !== dependency.sha256) return false; }
      catch { return false; }
    }
    return true;
  };
  // This local source-reading validator tests the persistence boundary. It is
  // deliberately not an LLM or a claim of production-host semantic coverage.
  const validateResult = async ({ item, result }) => {
    for (const reference of result.evidence) assert.equal(reference, "main.py:1", "Unregistered evidence reference");
    if (result.judgement !== "UNVERIFIED") assert.equal(result.evidence.length > 0, true);
    if (item.metricId === "M16" && result.judgement === "PASS") validateProductionTrace(result.productionTrace, result.evidence);
    return { result, snapshotKey: sha256(item.dependencies), sourceCitations: result.evidence };
  };
  const makeStore = (scopeId = "task-scope", sessionId = "session") => createStopReviewStore({ directory, sessionId, scopeId, now,
    dependenciesCurrent, validateResult });
  const store = makeStore();
  const item = async (objectId, metricId = "M12", revisionId = "R1@1") => ({ objectId, metricId, revisionId,
    basis: { text: `Original frozen obligation ${objectId}`, conditions: ["only if enabled"], exceptions: ["user-approved fallback"], source: "user", authority: "HARD" },
    dependencies: [{ path: "main.py", sha256: sha256(await fs.readFile(path.join(directory, "main.py"))) }] });
  const begin = (items, roundId = "round-1", overrides = {}) => store.beginRound({ roundId, stopId: roundId, items,
    deadlineAt: now() + 10000, groupSize: 3, ...overrides });
  const submit = (group, objectId = group.members[0].objectId, result = verdict(), overrides = {}) => {
    const member = group.members.find(member => member.objectId === objectId);
    return store.submit({ groupId: group.id, token: group.token, objectId, revisionId: member?.revisionId, basisKey: member?.basisKey, result, ...overrides });
  };
  return { directory, store, makeStore, item, begin, submit, now, advance: ms => { clock += ms; } };
}

test("AC-21/22/24: groups contain <= K unchanged items of one M and priority, rotating across M", async t => {
  for (const size of [1, 3]) {
    const f = await fixture(t);
    const items = await Promise.all([f.item("A"), f.item("B"), f.item("C"), f.item("D"), f.item("E", "M13"), f.item("F", "M16")]);
    await f.begin(items, "round-1", { groupSize: size });
    const groups = [];
    for (;;) {
      const group = await f.store.dispatch({ roundId: "round-1" });
      if (!group) break;
      groups.push(group);
      assert.ok(group.items.length <= size);
      assert.ok(group.items.every(item => item.metricId === group.metricId));
      assert.ok(group.items.every(item => items.some(original => JSON.stringify(original) === JSON.stringify(item))));
    }
    assert.deepEqual(groups.slice(0, 3).map(group => group.metricId), ["M12", "M13", "M16"]);
    assert.equal(groups[3].metricId, "M12");
    assert.ok(groups.every(group => group.priority === 0));
    assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), items.length);
  }
});

test("AC-25/26/28/29: out-of-order per-item receipts survive process recreation; duplicate submissions do not double count", async t => {
  const f = await fixture(t), items = await Promise.all([f.item("A"), f.item("B")]);
  await f.begin(items);
  const group = await f.store.dispatch({ roundId: "round-1" });
  await assert.rejects(f.submit(group, "foreign"), { code: "STOP_REVIEW_OWNERSHIP_INVALID" });
  await assert.rejects(f.submit(group, "A", verdict(), { token: "invented" }), { code: "STOP_REVIEW_OWNERSHIP_INVALID" });
  await assert.rejects(f.submit(group, "A", verdict(), { revisionId: "wrong@99" }), { code: "STOP_REVIEW_OWNERSHIP_INVALID" });
  await assert.rejects(f.submit(group, "A", { ...verdict(), outputPath: "somewhere.json" }), { code: "STOP_REVIEW_RESULT_INVALID" });
  const receiptB = await f.submit(group, "B");
  const duplicate = await f.submit(group, "B");
  assert.deepEqual(duplicate, receiptB);
  const restarted = f.makeStore();
  assert.equal((await restarted.inspect()).items["M12:B"].current.receiptId, receiptB.id);
  await f.submit(group, "A");
  const summary = await restarted.finishRound({ roundId: "round-1" });
  assert.equal(summary.status, "PASS");
  assert.equal(summary.progress.completed, 2);
  assert.equal(Object.keys((await restarted.inspect()).receipts).length, 2);
});

test("AC-19/48/49: first item survives group failure; next Stop starts untouched tail M before failures", async t => {
  const f = await fixture(t), items = await Promise.all([f.item("A"), f.item("B"), f.item("C"), f.item("D", "M13")]);
  await f.begin(items);
  const group = await f.store.dispatch({ roundId: "round-1" });
  await f.submit(group, "A");
  await f.store.finishGroup({ groupId: group.id, token: group.token, reasonCode: "AGENT_CRASHED" });
  const first = await f.store.finishRound({ roundId: "round-1", reasonCode: "REVIEW_DEADLINE_EXPIRED" });
  assert.equal(first.status, "UNVERIFIED");
  assert.equal(first.progress.completed, 1);
  const restarted = f.makeStore();
  await restarted.beginRound({ roundId: "round-2", stopId: "stop-2", items, deadlineAt: f.now() + 10000, groupSize: 1 });
  const untouched = await restarted.dispatch({ roundId: "round-2" });
  assert.equal(untouched.metricId, "M13");
  assert.equal(untouched.priority, 0);
  const retry = await restarted.dispatch({ roundId: "round-2" });
  assert.equal(retry.metricId, "M12");
  assert.equal(retry.priority, 1);
  assert.deepEqual(retry.items.map(item => item.objectId), ["B"]);
});

test("AC-50/51: P1 cursor advances at dispatch despite repeated failure; disabled M is skipped forward", async t => {
  const f = await fixture(t), items = await Promise.all([f.item("A", "M12"), f.item("B", "M13"), f.item("C", "M16")]);
  await f.begin(items);
  while (await f.store.dispatch({ roundId: "round-1" })) { /* Give all items one unsuccessful opportunity. */ }
  await f.store.finishRound({ roundId: "round-1" });
  await f.begin(items, "round-2");
  const failing = await f.store.dispatch({ roundId: "round-2" });
  assert.equal(failing.metricId, "M12");
  assert.equal(failing.priority, 1);
  await f.store.finishRound({ roundId: "round-2" });
  assert.equal((await f.store.inspect()).nextMetric[1], "M13");
  await f.begin(items.filter(item => item.metricId !== "M13"), "round-3", { groupSize: 1 });
  const continued = await f.store.dispatch({ roundId: "round-3" });
  assert.equal(continued.metricId, "M16");
  assert.equal(continued.priority, 1);
});

test("AC-23/30/31/51: unchanged individual PASS survives regrouping, local revisions and unrelated file edits", async t => {
  const f = await fixture(t), items = await Promise.all([f.item("A"), f.item("B"), f.item("C", "M13")]);
  await f.begin(items);
  const group = await f.store.dispatch({ roundId: "round-1" });
  await f.submit(group, "A");
  await f.store.finishRound({ roundId: "round-1" });
  await fs.writeFile(path.join(f.directory, "other.py"), "unrelated = False\n");
  const changedB = { ...items[1], revisionId: "R1@2" };
  await f.begin([items[0], changedB, items[2]], "round-2", { groupSize: 1 });
  const first = await f.store.dispatch({ roundId: "round-2" });
  assert.deepEqual(first.items.map(item => item.objectId), ["C"]);
  const second = await f.store.dispatch({ roundId: "round-2" });
  assert.deepEqual(second.items.map(item => item.objectId), ["B"]);
  assert.equal(second.priority, 1, "A local revision preserves attempted history");
  const view = await f.store.finishRound({ roundId: "round-2" });
  assert.equal(view.items.find(item => item.objectId === "A").result.judgement, "PASS");
  assert.equal(view.progress.reused, 1);
});

test("AC-27: same-snapshot conflict preserves deviation and cannot create overall PASS", async t => {
  const f = await fixture(t), item = await f.item("A");
  await f.begin([item]);
  const group = await f.store.dispatch({ roundId: "round-1" });
  await f.submit(group, "A", verdict("DEVIATION"));
  const conflicting = await f.submit(group, "A", verdict("PASS"));
  assert.equal(conflicting.conflict, true);
  const summary = await f.store.finishRound({ roundId: "round-1" });
  assert.equal(summary.status, "DEVIATION");
  assert.equal(summary.complete, false);
  assert.equal(summary.deviations.length, 1);
  assert.equal((await f.store.inspect()).items["M12:A"].history.length, 2);
});

test("AC-53/54/55/56: old deviation becomes historical; new-version valid PASS closes current gap without deleting history", async t => {
  const f = await fixture(t), item = await f.item("A");
  await f.begin([item]);
  const group = await f.store.dispatch({ roundId: "round-1" });
  await f.submit(group, "A", verdict("DEVIATION"));
  await f.store.finishRound({ roundId: "round-1" });
  await f.begin([item], "round-2");
  assert.equal(await f.store.dispatch({ roundId: "round-2" }), null, "Current valid deviation needs no duplicate semantic review");
  assert.equal((await f.store.finishRound({ roundId: "round-2" })).deviations.length, 1);
  await fs.writeFile(path.join(f.directory, "main.py"), "def convert(value): return int(value.strip())\n");
  const changed = await f.item("A");
  await f.begin([changed], "round-3");
  const pending = await f.store.finishRound({ roundId: "round-3" });
  assert.equal(pending.status, "UNVERIFIED");
  assert.equal(pending.deviations.length, 0);
  assert.equal(pending.items[0].historicalDeviation, true);
  await f.begin([changed], "round-4");
  const recheck = await f.store.dispatch({ roundId: "round-4" });
  assert.equal(recheck.priority, 2);
  await f.submit(recheck, "A", verdict("PASS"));
  const passed = await f.store.finishRound({ roundId: "round-4" });
  assert.equal(passed.status, "PASS");
  const state = await f.store.inspect();
  assert.equal(state.items["M12:A"].history[0].result.judgement, "DEVIATION");
  assert.equal(state.items["M12:A"].current.result.judgement, "PASS");
  assert.equal(state.items["M12:A"].invalidations.length, 1);
});

test("AC-20/25/45/47: reject late, tampered and incomplete M16 PASS; accept grounded deviation and honest UNVERIFIED", async t => {
  const f = await fixture(t), items = await Promise.all([f.item("A", "M16"), f.item("B", "M16"), f.item("C", "M16")]);
  await f.begin(items);
  const group = await f.store.dispatch({ roundId: "round-1" });
  await assert.rejects(f.submit(group, "A"), /M16_PRODUCTION_TRACE/);
  await assert.rejects(f.submit(group, "A", { ...verdict("DEVIATION"), evidence: ["invented.py:99"] }), /Unregistered evidence/);
  await f.submit(group, "A", { ...verdict("PASS"), productionTrace: trace() });
  await f.submit(group, "B", verdict("DEVIATION"));
  await f.submit(group, "C", verdict("UNVERIFIED"));
  f.advance(10000);
  await assert.rejects(f.submit(group, "A", verdict("UNVERIFIED")), { code: "STOP_REVIEW_ROUND_CLOSED" });
  const summary = await f.store.finishRound({ roundId: "round-1" });
  assert.equal(summary.progress.completed, 3);
  assert.equal(summary.progress.unverified, 1);
  assert.equal(summary.deviations.length, 1);
  assert.equal(summary.complete, false);
});

test("AC-52: distinct task scopes/sessions do not share scheduling or results", async t => {
  const f = await fixture(t), item = await f.item("A");
  await f.begin([item]);
  await f.submit(await f.store.dispatch({ roundId: "round-1" }));
  for (const store of [f.makeStore("other-task"), f.makeStore("task-scope", "other-session")]) {
    await store.beginRound({ roundId: "round-1", stopId: "stop", items: [item], deadlineAt: f.now() + 1000 });
    const group = await store.dispatch({ roundId: "round-1" });
    assert.equal(group.priority, 0);
  }
});

test("round runner starts one reviewer per group; saved A survives crash and late B is fenced", async t => {
  const f = await fixture(t, { now: Date.now }), items = await Promise.all([f.item("A"), f.item("B"), f.item("C", "M13")]);
  const calls = [];
  let oldSubmit;
  const result = await runStopReviewRound({ store: f.store, roundId: "round-1", stopId: "stop", items,
    deadlineAt: Date.now() + 10000, reviewGroup: async ({ brief, submit }) => {
      calls.push(brief.metricId);
      if (brief.metricId === "M12") {
        oldSubmit = submit;
        await submit({ objectId: "A", revisionId: "R1@1", result: verdict() });
        throw new Error("backend crashed after first receipt");
      }
      await submit({ objectId: "C", revisionId: "R1@1", result: verdict() });
      return "Everything saved successfully";
    } });
  assert.deepEqual(calls, ["M12", "M13"]);
  assert.equal(result.progress.completed, 2);
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.failures.length, 1);
  await assert.rejects(oldSubmit({ objectId: "B", revisionId: "R1@1", result: verdict() }), { code: "STOP_REVIEW_GROUP_CLOSED" });
});

test("round runner stops a hung group at cutoff, retaining per-item receipts and next M", async t => {
  const f = await fixture(t, { now: Date.now }), items = await Promise.all([f.item("A"), f.item("B"), f.item("C", "M13")]);
  let stopSignal;
  const began = Date.now();
  const result = await runStopReviewRound({ store: f.store, roundId: "round-1", stopId: "stop", items,
    deadlineAt: Date.now() + 300, reviewGroup: async ({ submit, signal }) => {
      stopSignal = signal;
      await submit({ objectId: "A", revisionId: "R1@1", result: verdict() });
      await new Promise(() => {});
    } });
  assert.equal(stopSignal.aborted, true);
  assert.ok(Date.now() - began < 3000);
  assert.equal(result.progress.completed, 1);
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.reasonCode, "REVIEW_DEADLINE_EXPIRED");
  assert.equal((await f.store.inspect()).nextMetric[0], "M13");
});

test("cancelled round preserves receipts as history and suppresses a current PASS/deviation delivery", async t => {
  const f = await fixture(t, { now: Date.now }), item = await f.item("A"), controller = new AbortController();
  const result = await runStopReviewRound({ store: f.store, roundId: "round-1", stopId: "stop", items: [item], signal: controller.signal,
    deadlineAt: Date.now() + 10000, reviewGroup: async ({ submit }) => {
      await submit({ objectId: "A", revisionId: "R1@1", result: verdict("DEVIATION") });
      controller.abort();
    } });
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.deviations.length, 0);
  assert.equal((await f.store.inspect()).items["M12:A"].history.length, 1);
});

test("excluded/pending/unexecuted obligations or an empty scope cannot generate an overall PASS", async t => {
  const f = await fixture(t), item = await f.item("A");
  for (const [index, status] of ["NOT_APPLICABLE", "NOT_YET_EXECUTED", "BASIS_PENDING", "NOT_YET_APPLICABLE"].entries()) {
    const store = f.makeStore(`scope-${index}`), roundId = `round-${index}`;
    await store.beginRound({ roundId, stopId: "stop", items: [item], deadlineAt: f.now() + 1000 });
    const group = await store.dispatch({ roundId });
    await store.submit({ groupId: group.id, token: group.token, objectId: "A", revisionId: "R1@1", basisKey: group.members[0].basisKey, result: verdict(status) });
    assert.notEqual((await store.finishRound({ roundId })).status, "PASS");
  }
  await f.begin([]);
  assert.equal((await f.store.finishRound({ roundId: "round-1" })).status, "SKIPPED");
});

test("shared assessment checks budget before preparation, and duplicate Stop never repeats model work", async t => {
  const f = await fixture(t, { now: Date.now }), sessionStore = createStopCorrectionStore({ directory: f.directory });
  let prepared = 0;
  const options = { sessionStore, reviewStoreFor: async () => f.store, sessionId: "session", flowId: "flow", stopId: "one",
    sourceInput: { origin: "HUMAN", id: "user-1" }, initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" },
    config: { enabled: true, maxCorrectionsPerFlow: 0 }, prepare: async () => { prepared++; throw new Error("Must not run"); },
    reviewGroup: async () => { throw new Error("Must not launch"); }, feedbackBasisCurrent: async () => true };
  const result = await assessStopCorrection(options);
  assert.equal(result.stop.reviewStatus, "SKIPPED");
  assert.equal(prepared, 0);
  const repeat = await assessStopCorrection({ ...options, config: { enabled: true } });
  assert.equal(repeat.reused, true);
  assert.equal(prepared, 0);
});

test("shared assessment runs one group, preserves original items and reserves one unified multi-item package without charging", async t => {
  const f = await fixture(t, { now: Date.now }), items = await Promise.all([f.item("A"), f.item("B")]);
  const sessionStore = createStopCorrectionStore({ directory: f.directory });
  let launches = 0, preparationDeadline;
  const options = { sessionStore, reviewStoreFor: async scopeId => { assert.equal(scopeId, "task-scope"); return f.store; },
    sessionId: "session", flowId: "flow", stopId: "one", sourceInput: { origin: "HUMAN", id: "user-1" },
    initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" }, config: { enabled: true },
    prepare: async ({ deadlineAt }) => { preparationDeadline = deadlineAt; return { scopeId: "task-scope", items }; },
    reviewGroup: async ({ brief, submit }) => {
      launches++;
      assert.deepEqual(brief.items, items);
      for (const item of brief.items) await submit({ objectId: item.objectId, revisionId: item.revisionId, result: verdict("DEVIATION") });
    }, feedbackBasisCurrent: async deviations => deviations.length === 2 };
  const result = await assessStopCorrection(options);
  assert.equal(launches, 1);
  assert.equal(preparationDeadline, result.stop.reviewDeadlineAt);
  assert.equal(result.summary.deviations.length, 2);
  assert.equal(result.admission.accounting, "RESERVED");
  assert.equal(result.stop.control, "WAIT_DELIVERY");
  assert.equal((await sessionStore.inspect("session")).used, 0);
  const repeated = await assessStopCorrection(options);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.admission.id, result.admission.id);
  assert.equal(launches, 1);
});

test("shared review cutoff preserves confirmed deviation and uses reserve to settle partial work", async t => {
  const f = await fixture(t, { now: Date.now }), items = await Promise.all([f.item("A"), f.item("B")]);
  const sessionStore = createStopCorrectionStore({ directory: f.directory });
  const result = await assessStopCorrection({ sessionStore, reviewStoreFor: async () => f.store,
    sessionId: "session", flowId: "flow", stopId: "one", sourceInput: { origin: "HUMAN", id: "user-1" },
    initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" },
    config: { enabled: true, assessmentTimeoutMs: 2000, feedbackReserveMs: 1000 },
    prepare: async () => ({ scopeId: "task-scope", items }), reviewGroup: async ({ submit }) => {
      await submit({ objectId: "A", revisionId: "R1@1", result: verdict("DEVIATION") });
      await new Promise(() => {});
    }, feedbackBasisCurrent: async () => true });
  assert.equal(result.summary?.status, "DEVIATION");
  assert.equal(result.summary.progress.completed, 1);
  assert.equal(result.summary.progress.unverified, 1);
  assert.equal(result.admission.accounting, "RESERVED");
  assert.ok(Date.now() < result.stop.deadlineAt);
});

test("baseline preparation timeout releases UNVERIFIED without launching groups or consuming quota", async t => {
  const f = await fixture(t, { now: Date.now }), sessionStore = createStopCorrectionStore({ directory: f.directory });
  let preparationSignal, calls = 0;
  const result = await assessStopCorrection({ sessionStore, reviewStoreFor: async () => f.store,
    sessionId: "session", flowId: "flow", stopId: "one", sourceInput: { origin: "HUMAN", id: "user-1" },
    initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" },
    config: { enabled: true, assessmentTimeoutMs: 1000, feedbackReserveMs: 700 },
    prepare: async ({ signal }) => { preparationSignal = signal; await new Promise(() => {}); },
    reviewGroup: async () => { calls++; }, feedbackBasisCurrent: async () => true });
  assert.equal(result.stop.control, "ALLOW");
  assert.equal(result.stop.reviewStatus, "UNVERIFIED");
  assert.equal(result.admission, null);
  assert.equal(calls, 0);
  assert.equal(preparationSignal.aborted, true);
  assert.equal((await sessionStore.inspect("session")).used, 0);
});

test("all duties disabled skips baseline preparation and creates no scheduling scope", async t => {
  const f = await fixture(t, { now: Date.now }), sessionStore = createStopCorrectionStore({ directory: f.directory });
  const result = await assessStopCorrection({ sessionStore, sessionId: "session", flowId: "flow", stopId: "off",
    sourceInput: { origin: "HUMAN", id: "user-1" }, initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" },
    config: { enabled: true, metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, "0")}`, false])) },
    prepare: async () => { throw new Error("No baseline preparation permitted"); },
    reviewStoreFor: async () => { throw new Error("No scheduling state permitted"); } });
  assert.equal(result.stop.reviewStatus, "DISABLED");
  assert.equal(result.stop.releaseReason, "ALL_STOP_REVIEWS_DISABLED");
  assert.equal(await f.store.inspect(), null);
});

test("explicit re-review queues only the selected PASS at P2, after unfinished P0, and consumes its request once", async t => {
  const f = await fixture(t), a = await f.item("A"), b = await f.item("B", "M13");
  await f.begin([a, b]);
  await f.submit(await f.store.dispatch({ roundId: "round-1" }), "A");
  await f.store.finishRound({ roundId: "round-1" });
  const requested = { ...a, recheckRequestId: "trusted-explicit-user-request-1" };
  await f.begin([requested, b], "round-2");
  const fresh = await f.store.dispatch({ roundId: "round-2" });
  assert.equal(fresh.metricId, "M13");
  assert.equal(fresh.priority, 0);
  await f.submit(fresh, "B");
  const recheck = await f.store.dispatch({ roundId: "round-2" });
  assert.equal(recheck.items[0].objectId, "A");
  assert.equal(recheck.priority, 2);
  await f.submit(recheck, "A");
  await f.store.finishRound({ roundId: "round-2" });
  await f.begin([requested, b], "round-3");
  assert.equal(await f.store.dispatch({ roundId: "round-3" }), null);
});

test("hung item validation releases the lock at group cutoff, permits the next M, and ignores late proof", async t => {
  const f = await fixture(t, { now: Date.now }), items = await Promise.all([f.item("A"), f.item("B", "M13")]);
  let finishValidation;
  const store = createStopReviewStore({ directory: f.directory, sessionId: "hung-proof", scopeId: "scope",
    dependenciesCurrent: async () => true, validateResult: async ({ item, result }) => {
      if (item.objectId === "A") await new Promise(resolve => { finishValidation = resolve; });
      return { result, snapshotKey: "actual-read-snapshot" };
    } });
  const calls = [];
  const result = await runStopReviewRound({ store, roundId: "round", stopId: "stop", items,
    deadlineAt: Date.now() + 3000, groupTimeoutMs: 200, reviewGroup: async ({ brief, submit }) => {
      calls.push(brief.metricId);
      const item = brief.items[0];
      await submit({ objectId: item.objectId, revisionId: item.revisionId, result: verdict() });
    } });
  assert.deepEqual(calls, ["M12", "M13"]);
  assert.equal(result.progress.completed, 1);
  finishValidation();
  // A late validator return must not acquire a second persistence path.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.inspect()).items["M12:A"].current, undefined);
  assert.equal((await store.inspect()).items["M13:B"].current.result.judgement, "PASS");
});

test("feedback validity timeout preserves reviewed deviation, releases wait by total deadline and consumes no quota", async t => {
  const f = await fixture(t, { now: Date.now }), item = await f.item("A");
  const sessionStore = createStopCorrectionStore({ directory: f.directory });
  const startedAt = Date.now();
  const result = await assessStopCorrection({ sessionStore, reviewStoreFor: async () => f.store,
    sessionId: "session", flowId: "flow", stopId: "one", sourceInput: { origin: "HUMAN", id: "user-1" },
    initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" },
    config: { enabled: true, assessmentTimeoutMs: 1000, feedbackReserveMs: 600 },
    prepare: async () => ({ scopeId: "task-scope", items: [item] }),
    reviewGroup: async ({ submit }) => { await submit({ objectId: "A", revisionId: "R1@1", result: verdict("DEVIATION") }); },
    feedbackBasisCurrent: async () => new Promise(() => {}) });
  assert.ok(Date.now() - startedAt < 2500);
  assert.equal(result.stop.control, "ALLOW");
  assert.equal(result.stop.reviewStatus, "DEVIATION");
  assert.equal(result.stop.currentDeviations.length, 1);
  assert.equal(result.admission, null);
  assert.equal((await sessionStore.inspect("session")).used, 0);
  assert.equal(result.stop.releaseReason, "STOP_TOTAL_DEADLINE");
});

test("cancellation while an item proof validator hangs ends promptly without a late PASS", async t => {
  const f = await fixture(t, { now: Date.now }), item = await f.item("A"), controller = new AbortController();
  const sessionStore = createStopCorrectionStore({ directory: f.directory });
  let entered;
  const validating = new Promise(resolve => { entered = resolve; });
  const store = createStopReviewStore({ directory: f.directory, sessionId: "session", scopeId: "scope",
    dependenciesCurrent: async () => true, validateResult: async () => { entered(); await new Promise(() => {}); } });
  const work = assessStopCorrection({ sessionStore, reviewStoreFor: async () => store,
    sessionId: "session", flowId: "flow", stopId: "one", sourceInput: { origin: "HUMAN", id: "user-1" }, signal: controller.signal,
    initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" }, config: { enabled: true },
    prepare: async () => ({ scopeId: "scope", items: [item] }), reviewGroup: async ({ submit }) => {
      await submit({ objectId: "A", revisionId: "R1@1", result: verdict() });
    }, feedbackBasisCurrent: async () => true });
  await validating;
  const cancelledAt = Date.now();
  controller.abort();
  const result = await work;
  assert.ok(Date.now() - cancelledAt < 1500);
  assert.equal(result.stop.control, "ALLOW");
  assert.equal(result.stop.reviewStatus, "UNVERIFIED");
  assert.equal(result.admission, null);
  assert.equal(Object.keys((await store.inspect()).receipts).length, 0);
});

test("a dispatch cutoff cancellation still aggregates and delivers already saved deviation", async t => {
  const f = await fixture(t, { now: Date.now }), items = await Promise.all([f.item("A"), f.item("B", "M13")]);
  const sessionStore = createStopCorrectionStore({ directory: f.directory });
  let dispatches = 0, summaries = 0;
  const wrapped = { ...f.store, dispatch: async options => {
    if (++dispatches === 2) throw Object.assign(new Error("Cutoff while acquiring the dispatch state"), { code: "STOP_REVIEW_DEADLINE" });
    return f.store.dispatch(options);
  }, finishRound: async options => { summaries++; return f.store.finishRound(options); } };
  const result = await assessStopCorrection({ sessionStore, reviewStoreFor: async () => wrapped,
    sessionId: "session", flowId: "flow", stopId: "one", sourceInput: { origin: "HUMAN", id: "user-1" },
    initialize: { kind: "NEW_SESSION", evidence: "trusted session creation" }, config: { enabled: true },
    prepare: async () => ({ scopeId: "scope", items }), reviewGroup: async ({ submit }) => {
      await submit({ objectId: "A", revisionId: "R1@1", result: verdict("DEVIATION") });
    }, feedbackBasisCurrent: async () => true });
  assert.equal(summaries, 1);
  assert.equal(result.summary.status, "DEVIATION");
  assert.equal(result.summary.deviations.length, 1);
  assert.equal(result.summary.complete, false);
  assert.equal(result.admission.accounting, "RESERVED");
});
