import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";
import { createStopReviewStore } from "../lib/runtime-v2/stop-review-store.mjs";
import { createStopStartProtocol } from "../lib/openclaw/stop-start-protocol.mjs";

async function fixture(t, owner, config = {}) {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "stop-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "host-state"), state = { projectRoot: root, sessionId: "session", sessionKey: "key" };
  const store = createStopCorrectionStore({ directory });
  const entry = await store.beginStop({ sessionId: state.sessionId, flowId: "flow", stopId: "stop", scope: root, owner,
    sourceInput: { origin: "HUMAN", id: "human" }, initialize: { kind: "NEW_SESSION", evidence: "trusted creation" },
    config: { enabled: true, assessmentTimeoutMs: 30000, feedbackReserveMs: 1000, ...config } });
  const released = [];
  const protocol = createStopStartProtocol({ runtime: {}, logger: { warn() {} } }, { directoryFor: () => directory,
    isCurrent: async () => true, onReleased: (identity, reason) => released.push({ identity, reason }) });
  t.after(() => protocol.dispose());
  return { root, directory, state, store, entry, released, protocol };
}
async function deadOwner() {
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return { pid: Number(stdout) };
}

test("a dead assessment owner releases its persisted wait, fences the old round and preserves item receipts", async t => {
  const f = await fixture(t, await deadOwner());
  const scopeId = `${f.root}:task`;
  await f.store.bindReviewScope({ sessionId: "session", stopId: "stop", scopeId });
  let validations = 0;
  const review = createStopReviewStore({ directory: f.directory, sessionId: "session", scopeId,
    validateResult: async ({ result }) => { validations++; return { result, snapshotKey: "controlled immutable proof" }; }, dependenciesCurrent: async () => true });
  await review.beginRound({ roundId: "stop", stopId: "stop", deadlineAt: f.entry.stop.reviewDeadlineAt,
    items: ["A", "B"].map(objectId => ({ objectId, metricId: "M12", revisionId: "1", basis: objectId, dependencies: [] })) });
  const group = await review.dispatch({ roundId: "stop" });
  const receipt = await review.submit({ groupId: group.id, token: group.token, objectId: "A", revisionId: "1",
    basisKey: group.members[0].basisKey, result: { judgement: "PASS", reason: "Controlled proof saved before owner exit.", evidence: ["controlled source"] } });
  await f.protocol.recover(f.state);
  const ledger = await f.store.inspect("session"), recovered = await review.inspect();
  assert.equal(ledger.stops.stop.control, "ALLOW");
  assert.equal(ledger.stops.stop.reviewStatus, "UNVERIFIED");
  assert.equal(ledger.stops.stop.releaseReason, "STOP_REVIEW_OWNER_LOST");
  assert.equal(ledger.used, 0);
  assert.equal(recovered.items["M12:A"].current.receiptId, receipt.id);
  assert.equal(recovered.rounds.stop.summary.status, "UNVERIFIED");
  assert.equal(recovered.rounds.stop.summary.progress.completed, 1);
  assert.equal(validations, 1, "recovery never starts a new review or validates another result");
  await assert.rejects(review.submit({ groupId: group.id, token: group.token, objectId: "B", revisionId: "1",
    basisKey: group.members[1].basisKey, result: { judgement: "PASS", reason: "A late old worker.", evidence: ["source"] } }), { code: "STOP_REVIEW_ROUND_CLOSED" });
  assert.equal(f.released[0].identity.stopId, "stop");
});

test("recovering a live owner cannot cancel its ongoing assessment", async t => {
  const f = await fixture(t, { pid: process.pid });
  await f.protocol.recover(f.state);
  const stop = (await f.store.inspect("session")).stops.stop;
  assert.equal(stop.control, "WAIT_REVIEW");
  assert.equal(stop.releasedAt, undefined);
  assert.equal(f.released.length, 0);
});

test("owner loss before any bound host request releases its reservation and preserves confirmed deviation", async t => {
  const f = await fixture(t, await deadOwner());
  await f.store.settleReview({ sessionId: "session", stopId: "stop", status: "DEVIATION", currentDeviations: [{ objectId: "A", receiptId: "saved" }] });
  const admission = await f.store.reserveFeedback({ sessionId: "session", stopId: "stop", packageId: "package", basisCurrent: async () => true });
  await f.protocol.recover(f.state);
  await f.protocol.recover(f.state);
  const ledger = await f.store.inspect("session");
  assert.equal(ledger.admissions[admission.id].accounting, "RELEASED");
  assert.equal(ledger.admissions[admission.id].startStatus, "NOT_STARTED");
  assert.equal(ledger.stops.stop.reviewStatus, "DEVIATION");
  assert.equal(ledger.stops.stop.currentDeviations.length, 1);
  assert.equal(ledger.used, 0);
});

test("owner loss after an original revision offer retains uncertain capacity instead of inventing a non-start", async t => {
  const f = await fixture(t, await deadOwner());
  await f.store.settleReview({ sessionId: "session", stopId: "stop", status: "DEVIATION", currentDeviations: [{ objectId: "A", receiptId: "saved" }] });
  const admission = await f.store.reserveFeedback({ sessionId: "session", stopId: "stop", packageId: "package", basisCurrent: async () => true });
  await f.store.bindOriginalRequest({ sessionId: "session", admissionId: admission.id,
    request: { runId: "original", sessionKey: "key", afterSequence: 1 } });
  await f.protocol.recover(f.state);
  const ledger = await f.store.inspect("session");
  assert.equal(ledger.admissions[admission.id].accounting, "RESERVED");
  assert.equal(ledger.used, 0);
  assert.equal(ledger.admissions[admission.id].cancellationEvidence, undefined);
});

test("a recovered legacy review without an owner still releases at its original absolute deadline", async t => {
  const f = await fixture(t, undefined, { assessmentTimeoutMs: 300, feedbackReserveMs: 30 });
  let released;
  const wait = new Promise(resolve => { released = resolve; });
  const protocol = createStopStartProtocol({ runtime: {}, logger: { warn() {} } }, { directoryFor: () => f.directory,
    isCurrent: async () => true, onReleased: released });
  t.after(() => protocol.dispose());
  await protocol.recover(f.state);
  await wait;
  const stop = (await f.store.inspect("session")).stops.stop;
  assert.equal(stop.reviewStatus, "UNVERIFIED");
  assert.equal(stop.control, "ALLOW");
  assert(stop.releasedAt >= f.entry.stop.deadlineAt);
  assert.equal(stop.deadlineAt, f.entry.stop.deadlineAt);
});
