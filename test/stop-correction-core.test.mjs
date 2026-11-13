import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeStopCorrectionConfig as config, stopCorrectionWindow } from "../lib/runtime-v2/stop-correction-config.mjs";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";

async function fixture(t) {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "stop-core-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = 1000;
  const now = () => clock;
  const store = createStopCorrectionStore({ directory, now });
  const initialize = { kind: "NEW_SESSION", evidence: "trusted host session-created event" };
  const begin = (stopId, overrides = {}) => store.beginStop({ sessionId: "session", flowId: "flow", stopId,
    sourceInput: { origin: "HUMAN", id: "user-1" }, initialize, config: { enabled: true }, ...overrides });
  const reserve = async (stopId, overrides = {}) => {
    await store.settleReview({ sessionId: "session", stopId, status: "DEVIATION",
      currentDeviations: [{ objectId: "M16:R1", reason: "Required producer result is discarded.", basisKey: "current-source" }] });
    return store.reserveFeedback({ sessionId: "session", stopId, packageId: `feedback-${stopId}`, basisCurrent: async () => true, ...overrides });
  };
  const observe = (admission, overrides = {}) => store.observeStart({ sessionId: "session", admissionId: admission.id,
    executionId: `execution-${admission.id}`, observationId: `observed-${admission.id}`, startedAt: clock, ...overrides });
  return { directory, store, initialize, begin, reserve, observe, now, advance: ms => { clock += ms; }, set: value => { clock = value; } };
}

test("AC-01: new core defaults, switches, two limits and shared 17/20-minute window", () => {
  const value = config({ enabled: true });
  assert.deepEqual([value.waitMode, value.maxCorrectionsPerSession, value.maxCorrectionsPerFlow,
    value.assessmentTimeoutMs, value.feedbackReserveMs, value.reviewGroupSize], ["until_pass", 3, 3, 1200000, 180000, 3]);
  assert.deepEqual(Object.keys(value.metrics).filter(id => value.metrics[id]), ["M08", "M09", "M12", "M13", "M15", "M16"]);
  assert.equal(value.fileQualityReviewEnabled, false);
  assert.deepEqual(stopCorrectionWindow(value, 1000), { startedAt: 1000, reviewDeadlineAt: 1021000, deadlineAt: 1201000 });
  assert.deepEqual(stopCorrectionWindow(value, 1000, 501000), { startedAt: 1000, reviewDeadlineAt: 321000, deadlineAt: 501000 });
});

test("checker failure keeps its cause when an unverified Stop has no proven business deviation", async t => {
  const f=await fixture(t);
  await f.begin("checker-fault");
  const settled=await f.store.settleReview({sessionId:"session",stopId:"checker-fault",status:"UNVERIFIED",
    progress:{complete:false,reasonCode:"REVIEWER_RUN_FAILED",reason:"No callable tools"}});
  assert.equal(settled.control,"ALLOW");
  assert.equal(settled.reviewStatus,"UNVERIFIED");
  assert.equal(settled.releaseReason,"REVIEWER_RUN_FAILED");
  assert.equal((await f.store.inspect("session")).used,0);
});

test("config rejects invalid scalar types, bounds, legacy conflicts and reserve >= total", () => {
  for (const field of ["maxCorrectionsPerSession", "maxCorrectionsPerFlow"]) {
    assert.equal(config({ [field]: 0 })[field], 0);
    for (const value of [-1, 1.5, "3", false, null, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => config({ [field]: value }), new RegExp(field));
  }
  for (const field of ["reviewGroupSize", "assessmentTimeoutMs", "feedbackReserveMs"])
    for (const value of [0, -1, 1.5, "3", true, null]) assert.throws(() => config({ [field]: value }), new RegExp(field));
  for (const field of ["enabled", "waitMode", "metrics", "fileQualityReviewEnabled"])
    assert.throws(() => config({ [field]: null }), new RegExp(field));
  assert.throws(() => config({ waitMode: "nonblocking" }), /waitMode/);
  assert.throws(() => config({ metrics: { M16: "true" } }), /M16/);
  assert.throws(() => config({ assessmentTimeoutMs: 180000 }), /feedbackReserveMs/);
  assert.throws(() => config({ maxCorrectionsPerEpoch: 3, maxCorrectionsPerFlow: 3 }), /conflicts/);
  assert.throws(() => config({ waitTimeoutMs: 1200000, assessmentTimeoutMs: 1200000 }), /conflicts/);
  const migrated = config({ maxCorrectionsPerEpoch: 2, waitTimeoutMs: 600000 });
  assert.equal(migrated.maxCorrectionsPerFlow, 2);
  assert.equal(migrated.maxCorrectionsPerSession, 3);
  assert.equal(migrated.assessmentTimeoutMs, 600000);
  assert.equal(migrated.migrationWarnings.length, 2);
});

test("AC-05/09: zero limits skip before review; reservations and deliveries are not usage", async t => {
  for (const field of ["maxCorrectionsPerSession", "maxCorrectionsPerFlow"]) {
    const f = await fixture(t);
    const entry = await f.begin("zero", { config: { enabled: true, [field]: 0 } });
    assert.equal(entry.stop.reviewStatus, "SKIPPED");
    assert.equal(entry.stop.control, "ALLOW");
    assert.match(entry.stop.releaseReason, /CORRECTION_LIMIT/);
    assert.equal((await f.store.inspect("session")).used, 0);
  }
  const f = await fixture(t);
  await f.begin("one");
  const admission = await f.reserve("one");
  await f.store.delivery({ sessionId: "session", admissionId: admission.id, status: "QUEUED" });
  const state = await f.store.inspect("session");
  assert.equal(state.used, 0);
  assert.equal(state.flows.flow.used, 0);
  assert.equal(state.admissions[admission.id].accounting, "RESERVED");
});

test("AC-02/10/11: real starts charge both quotas once; third Stop is skipped", async t => {
  const f = await fixture(t), options = { config: { enabled: true, maxCorrectionsPerFlow: 2 } };
  for (const id of ["one", "two"]) {
    await f.begin(id, options);
    const admission = await f.reserve(id);
    await Promise.all([f.observe(admission), f.observe(admission), f.observe(admission)]);
  }
  const { stop } = await f.begin("three", options);
  assert.equal(stop.reviewStatus, "SKIPPED");
  assert.equal(stop.releaseReason, "FLOW_CORRECTION_LIMIT");
  assert.equal((await f.store.inspect("session")).used, 2);
});

test("AC-03: complete third review releases a flow after only two actual charges", async t => {
  const f = await fixture(t);
  for (const id of ["one", "two"]) {
    await f.begin(id);
    await f.observe(await f.reserve(id));
  }
  const entry = await f.begin("three");
  assert.equal(entry.stop.control, "WAIT_REVIEW");
  const stop = await f.store.settleReview({ sessionId: "session", stopId: "three", status: "PASS", progress: { complete: true } });
  assert.equal(stop.reviewStatus, "PASS");
  assert.equal(stop.control, "ALLOW");
  assert.equal((await f.store.inspect("session")).used, 2);
});

test('historical notices do not consume a useful repair admission and its final historical closure is accepted', async t => {
  const f = await fixture(t);
  await f.begin('repair');
  const history = { kind: 'IRREVERSIBLE_ORDER', objectId: 'M11:order', source: { ref: 'AGENTS.md' }, factDigest: 'a'.repeat(64), reason: 'A proved old inversion.' };
  await f.store.settleReview({ sessionId: 'session', stopId: 'repair', status: 'DEVIATION', historicalDeviations: [history],
    currentDeviations: [{ objectId: 'M16:useful', reason: 'Repair the current implementation.' }] });
  const admission = await f.store.reserveFeedback({ sessionId: 'session', stopId: 'repair', packageId: 'useful', basisCurrent: async () => true });
  assert.equal((await f.store.inspect('session')).used, 0);
  await f.observe(admission);
  const finalized = await f.store.finishRepairReview({ sessionId: 'session', admissionId: admission.id,
    status: 'COMPLETED_WITH_HISTORICAL_DEVIATIONS', evaluationId: 'final' });
  assert.equal(finalized.finalReview.status, 'COMPLETED_WITH_HISTORICAL_DEVIATIONS');
  const state = await f.store.inspect('session'); assert.equal(state.used, 1);
  assert.equal(state.events.filter(event => event.type === 'HISTORICAL_DEVIATION_NOTIFIED').length, 1);
});

test("a completed stage releases its repair waits while the next stage keeps the same durable quota", async t => {
  const f = await fixture(t), classification = { stopClassification: "STAGE_COMPLETE", stage: "planning" };
  const bind = stopId => f.store.bindReviewScope({ sessionId: "session", stopId, scopeId: "task-scope", classification });
  await f.begin("planning-repair"); await bind("planning-repair");
  const repair = await f.reserve("planning-repair"); await f.observe(repair);
  await f.begin("planning-done"); await bind("planning-done");
  await f.store.settleReview({ sessionId: "session", stopId: "planning-done", status: "NO_DEVIATION_FOUND", progress: { complete: true } });
  const state = await f.store.inspect("session");
  assert.equal(state.stops["planning-done"].control, "ALLOW");
  assert.equal(state.stops["planning-repair"].control, "ALLOW");
  assert.equal(state.stops["planning-repair"].reviewStatus, "DEVIATION");
  assert.equal(state.admissions[repair.id].accounting, "USED");
  assert.equal(state.flows.flow.closedAt, undefined);
  // Recreate the store, as happens between host workflow phases.
  const restored = createStopCorrectionStore({ directory: f.directory, now: f.now });
  f.advance(100);
  const next = await restored.beginStop({ sessionId: "session", flowId: "flow", stopId: "coding", config: { enabled: true } });
  assert.equal(next.stop.control, "WAIT_REVIEW");
  assert.equal(next.stop.capacity.sessionUsed, 1);
  assert.equal(next.stop.capacity.flowUsed, 1);
  assert.equal(next.stop.capacity.reasonCode, null);
  f.set(state.stops["planning-done"].deadlineAt + 1);
  await restored.expireStop({ sessionId: "session", stopId: "planning-done" });
  await restored.expireStop({ sessionId: "session", stopId: "planning-repair" });
  const afterTimers = await restored.inspect("session");
  assert.equal(afterTimers.flows.flow.closedAt, undefined);
  assert.equal(afterTimers.stops.coding.control, "WAIT_REVIEW");
  assert.equal((await f.begin("planning-done")).reused, true);
  assert.equal((await restored.inspect("session")).used, 1);
});

test("successful nonfinal scopes do not close a flow, but task completion still does", async t => {
  const f = await fixture(t);
  for (const [index, kind] of ["STAGE_COMPLETE", "INTERMEDIATE", "WAITING_FOR_USER", "BLOCKED_EXTERNAL", "TASK_COMPLETE"].entries()) {
    const stopId = `scope-${index}`, classification = { stopClassification: kind, stage: kind === "STAGE_COMPLETE" ? "draft" : null };
    await f.begin(stopId);
    await f.store.bindReviewScope({ sessionId: "session", stopId, scopeId: "task-scope", classification });
    const settled = await f.store.settleReview({ sessionId: "session", stopId, status: index % 2 ? "PASS" : "NO_DEVIATION_FOUND", progress: { complete: true } });
    assert.equal(settled.control, "ALLOW");
    assert.equal((await f.store.inspect("session")).flows.flow.closedAt !== undefined, kind === "TASK_COMPLETE");
  }
  assert.equal((await f.begin("after-task")).stop.releaseReason, "CORRECTION_FLOW_CLOSED");
});

test("stage completion preserves quota exhaustion and cannot reopen a cancelled or failed flow", async t => {
  for (const outcome of ["limit", "cancel", "timeout", "stale", "failed"]) await t.test(outcome, async subtest => {
    const f = await fixture(subtest), options = { config: { enabled: true, maxCorrectionsPerFlow: 1 } };
    const { stop } = await f.begin("stage", options);
    await f.store.bindReviewScope({ sessionId: "session", stopId: "stage", scopeId: "task-scope",
      classification: { stopClassification: "STAGE_COMPLETE", stage: "draft" } });
    if (outcome === "limit") {
      await f.observe(await f.reserve("stage"));
      await f.begin("stage-final", { config: { enabled: true, maxCorrectionsPerFlow: 2 } });
      await f.store.bindReviewScope({ sessionId: "session", stopId: "stage-final", scopeId: "task-scope",
        classification: { stopClassification: "STAGE_COMPLETE", stage: "draft" } });
      await f.store.settleReview({ sessionId: "session", stopId: "stage-final", status: "PASS", progress: { complete: true } });
    } else if (outcome === "failed") {
      await f.store.settleReview({ sessionId: "session", stopId: "stage", status: "UNVERIFIED", assessmentFailed: true,
        progress: { complete: false, reasonCode: "REVIEWER_RUN_FAILED" } });
    } else {
      if (outcome === "timeout") f.set(stop.deadlineAt);
      await f.store.expireStop({ sessionId: "session", stopId: "stage", force: true,
        scopeInvalidated: outcome === "stale", reasonCode: outcome });
      await f.store.settleReview({ sessionId: "session", stopId: "stage", status: "PASS", progress: { complete: true } });
    }
    const next = await f.begin("coding", options);
    assert.equal(next.stop.control, "ALLOW");
    assert.equal(next.stop.reviewStatus, "SKIPPED");
    assert.equal(next.stop.releaseReason, outcome === "limit" ? "FLOW_CORRECTION_LIMIT" : "CORRECTION_FLOW_CLOSED");
    assert.equal((await f.store.inspect("session")).used, outcome === "limit" ? 1 : 0);
  });
});

test("a Stop cannot change its bound classification to keep a completed task open", async t => {
  const f = await fixture(t); await f.begin("one");
  const binding = { sessionId: "session", stopId: "one", scopeId: "task-scope", classification: { stopClassification: "TASK_COMPLETE", stage: null } };
  await f.store.bindReviewScope(binding);
  await f.store.bindReviewScope({ ...binding, classification: { ...binding.classification, stage: "legacy-workflow-stage" } });
  await f.store.bindReviewScope(binding);
  await assert.rejects(f.store.bindReviewScope({ ...binding, classification: { stopClassification: "STAGE_COMPLETE", stage: "draft" } }), { code: "STOP_IDENTITY_CONFLICT" });
  assert.deepEqual((await f.store.inspect("session")).stops.one.classification, binding.classification);
});

test("stage success leaves unrelated scope, stage and legacy repair waits untouched", async t => {
  const f = await fixture(t), options = { config: { enabled: true, maxCorrectionsPerSession: 5, maxCorrectionsPerFlow: 5 } };
  const classification = { stopClassification: "STAGE_COMPLETE", stage: "draft" };
  for (const [id, scopeId, frame] of [["other-scope", "other", classification],
    ["other-stage", "task", { ...classification, stage: "design" }], ["legacy", "task", undefined]]) {
    await f.begin(id, options);
    await f.store.bindReviewScope({ sessionId: "session", stopId: id, scopeId, classification: frame });
    await f.observe(await f.reserve(id));
  }
  const before = await f.store.inspect("session");
  await f.begin("done", options);
  await f.store.bindReviewScope({ sessionId: "session", stopId: "done", scopeId: "task", classification });
  await f.store.settleReview({ sessionId: "session", stopId: "done", status: "PASS", progress: { complete: true } });
  const after = await f.store.inspect("session");
  for (const id of ["other-scope", "other-stage", "legacy"]) assert.deepEqual(after.stops[id], before.stops[id]);
  assert.equal(after.flows.flow.closedAt, undefined);
  assert.equal(after.used, 3);
});

test("an inconclusive nonfinal review stays UNVERIFIED without preventing a later coding review", async t => {
  const cases = [["STAGE_COMPLETE", { total: 0, reasonCode: "STOP_NO_REVIEW_SCOPE" }],
    ["STAGE_COMPLETE", { total: 0, reasonCode: "STOP_STAGE_METRICS_UNDECLARED" }],
    ["STAGE_COMPLETE", { total: 0, reasonCode: "NO_APPLICABLE_STAGE_OBJECTS" }],
    ["STAGE_COMPLETE", { total: 0, reasonCode: "NO_APPLICABLE_METRIC_OBJECTS" }],
    ["STAGE_COMPLETE", { total: 1, unverified: 1 }], ["STAGE_COMPLETE", { total: 1, reasonCode: "STOP_MOST_REQUIREMENTS_UNVERIFIED" }],
    ["INTERMEDIATE", { reasonCode: "FINDINGS_ONLY_SCOPE" }], ["WAITING_FOR_USER", { total: 2, unverified: 2 }], ["BLOCKED_EXTERNAL", {}]];
  for (const [kind, progress] of cases) await t.test(`${kind} ${progress.reasonCode ?? "incomplete"}`, async subtest => {
    const f = await fixture(subtest);
    const { stop } = await f.begin("draft");
    await f.store.bindReviewScope({ sessionId: "session", stopId: "draft", scopeId: "task",
      classification: { stopClassification: kind, stage: kind === "STAGE_COMPLETE" ? "proposal" : null } });
    const settled = await f.store.settleReview({ sessionId: "session", stopId: "draft", status: "UNVERIFIED",
      progress: { complete: false, ...progress } });
    assert.equal(settled.control, "ALLOW");
    assert.equal(settled.reviewStatus, "UNVERIFIED");
    assert.equal(settled.releaseReason, progress.reasonCode ?? "STOP_REVIEW_INCOMPLETE");
    const next = await f.begin("coding");
    assert.equal(next.stop.control, "WAIT_REVIEW");
    assert.equal(next.stop.capacity.reasonCode, null);
    f.set(stop.deadlineAt + 1);
    await f.store.expireStop({ sessionId: "session", stopId: "draft" });
    assert.equal((await f.store.inspect("session")).flows.flow.closedAt, undefined);
  });
  await t.test("execution failure and final completion still close the flow", async subtest => {
    const f = await fixture(subtest);
    for (const [stopId, stopClassification, stage, assessmentFailed] of [["coding", "STAGE_COMPLETE", "coding", true], ["final", "TASK_COMPLETE", null, false]]) {
      const flowId = `flow-${stopId}`;
      await f.begin(stopId, { flowId, sourceInput: { origin: "HUMAN", id: `user-${stopId}` } });
      await f.store.bindReviewScope({ sessionId: "session", stopId, scopeId: "task", classification: { stopClassification, stage } });
      await f.store.settleReview({ sessionId: "session", stopId, status: "UNVERIFIED", assessmentFailed,
        progress: { complete: false, reasonCode: assessmentFailed ? "REVIEWER_RUN_FAILED" : undefined } });
      assert.equal((await f.store.inspect("session")).flows[flowId].closeReason, assessmentFailed ? "REVIEWER_RUN_FAILED" : "STOP_REVIEW_INCOMPLETE");
      assert.equal((await f.begin(`after-${stopId}`, { flowId })).stop.releaseReason, "CORRECTION_FLOW_CLOSED");
    }
  });
});

test("an inconclusive proposal Stop leaves the user's coding Stop reviewable and repairable", async t => {
  const f = await fixture(t);
  await f.begin("proposal");
  await f.store.bindReviewScope({ sessionId: "session", stopId: "proposal", scopeId: "task",
    classification: { stopClassification: "STAGE_COMPLETE", stage: "proposal" } });
  await f.store.settleReview({ sessionId: "session", stopId: "proposal", status: "UNVERIFIED",
    progress: { complete: false, total: 1, passed: 0, unverified: 1 } });
  assert.equal((await f.begin("coding")).stop.control, "WAIT_REVIEW");
  await f.store.bindReviewScope({ sessionId: "session", stopId: "coding", scopeId: "task",
    classification: { stopClassification: "STAGE_COMPLETE", stage: "codeing" } });
  const admission = await f.reserve("coding");
  assert.equal(admission.accounting, "RESERVED");
  await f.observe(admission);
  const state = await f.store.inspect("session");
  assert.equal(state.flows.flow.closedAt, undefined);
  assert.equal(state.used, 1);
});

test("AC-04: assessment releases after delivery and never reblocks while tracking start", async t => {
  const f = await fixture(t), options = { config: { enabled: true, waitMode: "assessment" } };
  await f.begin("one", options);
  const admission = await f.reserve("one");
  await f.store.delivery({ sessionId: "session", admissionId: admission.id, status: "DELIVERED" });
  const delivered = (await f.store.inspect("session")).stops.one;
  assert.equal(delivered.control, "ALLOW");
  assert.equal((await f.store.inspect("session")).used, 0);
  f.advance(1);
  await f.observe(admission);
  assert.equal((await f.store.inspect("session")).stops.one.releasedAt, delivered.releasedAt);
  const entry = await f.begin("two", options);
  assert.equal(entry.stop.reviewStatus, "SKIPPED");
  assert.equal(entry.stop.releaseReason, "FLOW_CORRECTION_LIMIT");
});

test("AC-06/07/08/12: session ledger survives tasks, mode changes, reload and process recreation", async t => {
  const f = await fixture(t);
  await f.begin("one", { config: { enabled: true, maxCorrectionsPerSession: 1 } });
  await f.observe(await f.reserve("one"));
  const store = createStopCorrectionStore({ directory: f.directory, now: f.now });
  const next = await store.beginStop({ sessionId: "session", flowId: "new-task-flow", stopId: "two",
    sourceInput: { origin: "HUMAN", id: "user-2" }, config: { enabled: true, waitMode: "assessment", maxCorrectionsPerSession: 1 } });
  assert.equal(next.stop.releaseReason, "SESSION_CORRECTION_LIMIT");
  assert.equal((await store.inspect("session")).used, 1);
  assert.equal((await store.inspect("session")).flows["new-task-flow"].used, 0);
  const other = await f.begin("other", { sessionId: "different-session" });
  assert.equal(other.stop.control, "WAIT_REVIEW");
  assert.equal((await store.inspect("different-session")).used, 0);
  await assert.rejects(f.begin("plugin-message", { flowId: "plugin-flow", sourceInput: { origin: "PLUGIN", id: "feedback-as-user" } }), /genuine user/);
  await assert.rejects(f.begin("reused-source", { flowId: "another-flow" }), /cannot mint/);
});

test("AC-08/36: duplicate Stop keeps its snapshot; next Stop applies config without resetting usage", async t => {
  const f = await fixture(t);
  const original = await f.begin("one");
  const admission = await f.reserve("one");
  await f.observe(admission);
  const duplicate = await f.begin("one", { config: { enabled: true, waitMode: "assessment", reviewGroupSize: 1 } });
  assert.equal(duplicate.reused, true);
  assert.deepEqual(duplicate.stop.config, original.stop.config);
  const next = await f.begin("two", { config: { enabled: true, reviewGroupSize: 1, maxCorrectionsPerFlow: 1 } });
  assert.equal(next.stop.config.reviewGroupSize, 1);
  assert.equal(next.stop.releaseReason, "FLOW_CORRECTION_LIMIT");
});

test("migration never invents a zero history for an existing session", async t => {
  const f = await fixture(t);
  await assert.rejects(f.begin("one", { initialize: undefined }), { code: "STOP_SESSION_MIGRATION_REQUIRED" });
  assert.equal(await f.store.inspect("session"), null);
  const entry = await f.begin("one", { initialize: { kind: "VERIFIED_HISTORY", evidence: "host durable starts",
    starts: [{ executionId: "run-old", flowId: "old-flow", startedAt: 1 }, { executionId: "run-old", flowId: "old-flow", startedAt: 1 }] } });
  assert.equal(entry.stop.capacity.sessionUsed, 1);
  assert.equal((await f.store.inspect("session")).flows["old-flow"].used, 1);
});

test("AC-17/18: checker faults or partial PASS release without business work or overall PASS", async t => {
  const f = await fixture(t);
  await f.begin("partial");
  await assert.rejects(f.store.settleReview({ sessionId: "session", stopId: "partial", status: "PASS", progress: { complete: false } }), { code: "STOP_INCOMPLETE_PASS" });
  const stop = await f.store.settleReview({ sessionId: "session", stopId: "partial", status: "UNVERIFIED", progress: { complete: false, passed: 2, total: 5 } });
  assert.equal(stop.control, "ALLOW");
  assert.equal(stop.reviewStatus, "UNVERIFIED");
  assert.equal((await f.store.inspect("session")).used, 0);
});

test("AC-37/40: definite rejection/cancellation releases reservation idempotently", async t => {
  const f = await fixture(t);
  await f.begin("reject");
  const admission = await f.reserve("reject");
  await f.store.delivery({ sessionId: "session", admissionId: admission.id, status: "REJECTED", cannotStart: true });
  await f.store.confirmNotStarted({ sessionId: "session", admissionId: admission.id, evidence: "host definitive cancellation receipt" });
  await f.store.confirmNotStarted({ sessionId: "session", admissionId: admission.id, evidence: "same receipt" });
  const state = await f.store.inspect("session");
  assert.equal(state.used, 0);
  assert.equal(state.admissions[admission.id].accounting, "RELEASED");
  assert.equal(state.stops.reject.control, "ALLOW");
  const next = await f.begin("new", { flowId: "new-flow", sourceInput: { origin: "HUMAN", id: "user-2" } });
  assert.equal(next.stop.capacity.sessionReserved, 0);
});

test("AC-38/39/41: deadline closes queued admission and wait; unknown slot remains reserved", async t => {
  const f = await fixture(t);
  const { stop } = await f.begin("queued");
  const admission = await f.reserve("queued");
  await f.store.delivery({ sessionId: "session", admissionId: admission.id, status: "QUEUED" });
  f.set(stop.deadlineAt);
  const expired = await f.store.expireStop({ sessionId: "session", stopId: "queued" });
  assert.equal(expired.control, "ALLOW");
  assert.equal(expired.reviewStatus, "DEVIATION");
  const state = await f.store.inspect("session");
  assert.equal(state.used, 0);
  assert.equal(state.admissions[admission.id].accounting, "RESERVED");
  assert.equal(state.admissions[admission.id].startStatus, "UNCERTAIN");
  const denied = await f.store.checkAdmission({ sessionId: "session", admissionId: admission.id, basisCurrent: async () => true });
  assert.equal(denied.allowed, false);
  // Merely querying an expired guard does not manufacture cancellation proof.
  assert.equal((await f.store.inspect("session")).admissions[admission.id].accounting, "RESERVED");
});

test("AC-42: late confirmation charges trustworthy timely start, original flow, without reopening", async t => {
  const f = await fixture(t);
  const { stop } = await f.begin("one");
  const admission = await f.reserve("one");
  const actualStart = stop.deadlineAt - 1;
  f.set(stop.deadlineAt);
  await f.store.expireStop({ sessionId: "session", stopId: "one" });
  const releasedAt = (await f.store.inspect("session")).stops.one.releasedAt;
  await f.begin("new", { flowId: "new-flow", sourceInput: { origin: "HUMAN", id: "user-2" } });
  const observed = await f.observe(admission, { startedAt: actualStart });
  assert.equal(observed.startStatus, "STARTED");
  assert.equal(observed.lateConfirmation, true);
  const state = await f.store.inspect("session");
  assert.equal(state.used, 1);
  assert.equal(state.flows.flow.used, 1);
  assert.equal(state.flows["new-flow"].used, 0);
  assert.equal(state.stops.one.releasedAt, releasedAt);
  assert.equal(state.stops.one.control, "ALLOW");
});

test("AC-43: actual late start is charged once and marked protocol defect requiring termination", async t => {
  const f = await fixture(t);
  const { stop } = await f.begin("one");
  const admission = await f.reserve("one");
  f.set(stop.deadlineAt);
  await f.store.expireStop({ sessionId: "session", stopId: "one" });
  f.advance(1);
  const value = await f.observe(admission);
  assert.equal(value.startStatus, "PROTOCOL_VIOLATION");
  assert.equal(value.stopExecutionRequired, true);
  await f.observe(admission);
  assert.equal((await f.store.inspect("session")).used, 1);
  assert.equal((await f.store.inspect("session")).stops.one.control, "ALLOW");
});

test("AC-44/16: timely confirmed repair survives old deadline; following Stop has a fresh window", async t => {
  const f = await fixture(t);
  const { stop } = await f.begin("one");
  const admission = await f.reserve("one");
  await f.observe(admission);
  f.set(stop.deadlineAt + 500000);
  const stillRepairing = await f.store.expireStop({ sessionId: "session", stopId: "one" });
  assert.equal(stillRepairing.control, "WAIT_REPAIR");
  await f.store.observeEnd({ sessionId: "session", admissionId: admission.id, executionId: `execution-${admission.id}`, endedAt: f.now() });
  const next = await f.begin("two");
  assert.equal(next.stop.deadlineAt, f.now() + 1200000);
  assert.equal(next.stop.capacity.sessionUsed, 1);
});

test("AC-53: stale feedback is invalidated before reserve and before actual admission", async t => {
  const f = await fixture(t);
  await f.begin("before-delivery");
  assert.equal(await f.reserve("before-delivery", { basisCurrent: async () => false }), null);
  const entry = await f.begin("before-start", { flowId: "new-flow", sourceInput: { origin: "HUMAN", id: "user-2" } });
  assert.equal(entry.stop.control, "WAIT_REVIEW");
  const admission = await f.reserve("before-start");
  const denied = await f.store.checkAdmission({ sessionId: "session", admissionId: admission.id, basisCurrent: async () => false });
  assert.equal(denied.allowed, false);
  assert.equal(denied.admission.accounting, "RELEASED");
  assert.equal((await f.store.inspect("session")).used, 0);
});

test("concurrent flows cannot over-reserve the last session slot or duplicate one package", async t => {
  const f = await fixture(t);
  for (const [stopId, flowId, user] of [["one", "flow", "user-1"], ["two", "flow-2", "user-2"]])
    await f.begin(stopId, { flowId, sourceInput: { origin: "HUMAN", id: user }, config: { enabled: true, maxCorrectionsPerSession: 1 } });
  const results = await Promise.all([f.reserve("one"), f.reserve("two")]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await f.store.inspect("session")).used, 0);
  const admission = results.find(Boolean);
  const replay = await f.store.reserveFeedback({ sessionId: "session", stopId: admission.stopId, packageId: "another-package-id", basisCurrent: async () => true });
  assert.equal(replay.id, admission.id);
});

test("start observation arriving before delivery response cannot regress repair into startup waiting", async t => {
  const f = await fixture(t);
  const { stop } = await f.begin("one");
  const admission = await f.reserve("one");
  await f.observe(admission);
  await f.store.delivery({ sessionId: "session", admissionId: admission.id, status: "DELIVERED" });
  assert.equal((await f.store.inspect("session")).stops.one.control, "WAIT_REPAIR");
  f.set(stop.deadlineAt);
  assert.equal((await f.store.expireStop({ sessionId: "session", stopId: "one" })).control, "WAIT_REPAIR");
});

test("unknown in-flight capacity is not mislabeled as used; later trustworthy cancellation releases it", async t => {
  const f = await fixture(t);
  const { stop } = await f.begin("one", { config: { enabled: true, maxCorrectionsPerSession: 1 } });
  const admission = await f.reserve("one");
  f.set(stop.deadlineAt);
  await f.store.expireStop({ sessionId: "session", stopId: "one" });
  const next = await f.begin("two", { flowId: "new-flow", sourceInput: { origin: "HUMAN", id: "user-2" }, config: { enabled: true, maxCorrectionsPerSession: 1 } });
  assert.equal(next.stop.releaseReason, "SESSION_ADMISSION_PENDING");
  assert.equal(next.stop.capacity.sessionUsed, 0);
  assert.equal(next.stop.capacity.sessionReserved, 1);
  await f.store.confirmNotStarted({ sessionId: "session", admissionId: admission.id, evidence: "host queue removed, executor fenced, never started" });
  assert.equal((await f.store.inspect("session")).admissions[admission.id].accounting, "RELEASED");
});

test("end records require a real known execution and cannot predate start or come from the future", async t => {
  const f = await fixture(t);
  await f.begin("one");
  const admission = await f.reserve("one");
  await assert.rejects(f.store.observeEnd({ sessionId: "session", admissionId: admission.id, executionId: "fake", endedAt: f.now() }), { code: "STOP_END_EVIDENCE_INVALID" });
  await f.observe(admission);
  await assert.rejects(f.store.observeEnd({ sessionId: "session", admissionId: admission.id, executionId: `execution-${admission.id}`, endedAt: f.now() + 1 }), { code: "STOP_END_EVIDENCE_INVALID" });
});

test("admission basis validation runs outside the session lock and cancellation completes before its return", async t => {
  const f = await fixture(t);
  await f.begin("one");
  const admission = await f.reserve("one");
  let entered, finish;
  const checking = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const work = f.store.checkAdmission({ sessionId: "session", admissionId: admission.id, signal: controller.signal,
    basisCurrent: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  void work.catch(() => {});
  await checking;
  const stopped = await f.store.expireStop({ sessionId: "session", stopId: "one", force: true, scopeInvalidated: true, reasonCode: "HOST_CANCELLED" });
  assert.equal(stopped.control, "ALLOW");
  controller.abort();
  await assert.rejects(work, { name: "AbortError" });
  finish(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.store.inspect("session")).admissions[admission.id].accounting, "RESERVED");
  assert.equal((await f.store.checkAdmission({ sessionId: "session", admissionId: admission.id, basisCurrent: async () => true })).allowed, false);
});

test("closing a flow releases earlier repair waits and preserves their review and accounting facts", async t => {
  const f = await fixture(t);
  await f.begin("one");
  const admission = await f.reserve("one");
  await f.observe(admission);
  await f.begin("two");
  await f.store.settleReview({ sessionId: "session", stopId: "two", status: "PASS", progress: { complete: true } });
  const state = await f.store.inspect("session");
  assert.equal(state.stops.one.control, "ALLOW");
  assert.equal(typeof state.stops.one.releasedAt, "number");
  assert.equal(state.stops.one.flowEndedByStopId, "two");
  assert.equal(state.stops.one.reviewStatus, "DEVIATION");
  assert.equal(state.stops.two.reviewStatus, "PASS");
  assert.equal(state.used, 1);
});

test("feedback validation retains only unchanged valid members at reservation and actual admission", async t => {
  const f = await fixture(t);
  await f.begin("one");
  const deviations = ["A", "B", "C"].map(objectId => ({ objectId, metricId: "M16", basisKey: objectId, reason: "Concrete current counterexample" }));
  await f.store.settleReview({ sessionId: "session", stopId: "one", status: "DEVIATION", currentDeviations: deviations });
  const admission = await f.store.reserveFeedback({ sessionId: "session", stopId: "one", packageId: "package",
    basisCurrent: async original => original.filter(value => value.objectId !== "A") });
  assert.deepEqual(admission.currentDeviations.map(value => value.objectId), ["B", "C"]);
  const checked = await f.store.checkAdmission({ sessionId: "session", admissionId: admission.id,
    basisCurrent: async original => original.filter(value => value.objectId === "C") });
  assert.equal(checked.allowed, true);
  assert.deepEqual(checked.currentDeviations, [deviations[2]]);
  const state = await f.store.inspect("session");
  assert.deepEqual(state.stops.one.currentDeviations, [deviations[2]]);
  assert.equal(state.stops.one.feedbackInvalidations.length, 2);
  assert.equal(state.used, 0);
});
