import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionRuntimeDetails, summarizeReviewView, summarizeSessionRepairs } from "../lib/openclaw/session-runtime-details.mjs";
import { nativeStopReviewDirectory } from "../lib/openclaw/native-stop-review.mjs";
import { recordNativeRun } from "../lib/openclaw/native-runs.mjs";
import { ensureTask, taskDirectory, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { boundHostFeedback } from "../lib/runtime-v2/feedback-delivery.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

test("review view uses concluded items and preserves the denominator for every category", () => {
  const summarize = (...categories) => summarizeReviewView({ scopeKnown: true, items: categories.map(category => ({ category })) });
  assert.equal(summarize("NOT_REVIEWED", "NOT_REVIEWED").outcome, "NOT_REVIEWED");
  assert.equal(summarize("UNVERIFIED", "UNVERIFIED").outcome, "UNVERIFIED");
  assert.equal(summarize("UNVERIFIED", "NOT_REVIEWED", "NOT_APPLICABLE").outcome, "UNVERIFIED");
  assert.equal(summarize("NO_DEVIATION_FOUND", "UNVERIFIED", "NOT_REVIEWED").outcome, "NO_DEVIATION_FOUND");
  assert.equal(summarizeReviewView(), null);
  assert.deepEqual(summarize().categories.map(row => row.percentage), [null, null, null, null, null]);
  const mixed = summarize("NO_DEVIATION_FOUND", "DEVIATION", "UNVERIFIED", "NOT_REVIEWED", "NOT_APPLICABLE", null);
  assert.equal(mixed.outcome, "DEVIATION");
  assert.equal(mixed.total, 5);
  assert.deepEqual(mixed.categories.map(({ count, percentage }) => [count, percentage]), Array(5).fill([1, 20]));
});

test("console binds stored review, brief and repair input to the selected host session and run", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-runtime-details-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "session-one" });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => {
    state.verification = { status: "UNVERIFIED", evaluationId: "stop-test", assessmentId: "repair-one:stop:infra-2" };
  });
  const evaluations = path.join(taskDirectory(root, task.taskId), "evaluations");
  const frame = path.join(root, ".runtime-correction", "requirement-frame", sha256("session-one").slice(0, 24));
  await fs.mkdir(evaluations, { recursive: true });
  await fs.mkdir(frame, { recursive: true });
  await fs.writeFile(path.join(evaluations, "stop-test.json"), JSON.stringify({
    evaluationId: "stop-test", outcome: { status: "UNVERIFIED" }, coverage: { selectedObjectCount: 2 },
    review: { metricObjectJudgements: [{ objectId: "export", judgement: "DEVIATION", reason: "Filter omitted", evidence: ["export.ts:3"] }],
      unverifiedItems: [{ objectId: "sorting", reason: "Missing evidence" }] },
  }));
  const deliveryFile = path.join(frame, "deliveries.jsonl");
  const delivery = { at: "2026-11-17T08:11:00.000Z", channel: "tool_result", runId: "original-run" };
  const briefText = "[runtime-corrector:feedback]\nKeep the original filter.";
  await fs.writeFile(deliveryFile, JSON.stringify({ ...delivery, text: briefText }) + "\n{partial");
  const snapshot = { projectRoot: root, sessionKey: "agent:main:first", sessionId: "session-one",
    taskId: task.taskId, runId: "repair-one", roundId: "repair-round", outcome: "UNVERIFIED" };
  const reviews = nativeStopReviewDirectory(snapshot);
  await fs.mkdir(reviews, { recursive: true });
  await fs.writeFile(path.join(reviews, sha256("original-run") + ".json"), JSON.stringify({
    sessionKey: snapshot.sessionKey, sessionId: snapshot.sessionId, runId: "original-run",
    status: "SETTLED", reviewStatus: "DEVIATION", settledAt: 3, evaluationId: "stop-original",
  }));
  await fs.writeFile(path.join(evaluations, "stop-original.json"), JSON.stringify({
    evaluationId: "stop-original", outcome: { status: "DEVIATION", reasonCode: "TURN_LIMIT" },
    review: { metricObjectJudgements: [{ objectId: "original-criterion", judgement: "DEVIATION" }, { objectId: "validated", judgement: "PASS" }],
      collection: { complete: false }, scopeSelection: { metrics: { M16: { objects: [
        { objectId: "waiting", description: "Additional criterion", selected: true },
        { objectId: "out-of-scope", description: "Outside this review", selected: false },
      ] } } } },
  }));
  const message = "Apply the filter from the original requirement.";
  const receipt = { runId: snapshot.runId, source: { runId: "original-run" }, assessmentId: "old-stop",
    modelObservedAt: Date.now(), message, messageHash: sha256(message) };
  const hostRequest = { runId: "repair-one", source: { runId: "original-run" }, sessionKey: snapshot.sessionKey, projectRoot: root };
  const ledger = { sessionId: snapshot.sessionId, admissions: {
    other: { hostRequest: { ...hostRequest, runId: "foreign", projectRoot: path.dirname(root) } },
    repair: { hostRequest, startedAt: 1, endedAt: 2, finalReview: { status: "UNVERIFIED" } },
    original: { originalRequest: hostRequest },
  } };
  const details = await readSessionRuntimeDetails(snapshot, async () => receipt, identity => summarizeSessionRepairs(identity, ledger));
  assert.equal(details.round.outcome, "UNVERIFIED");
  assert.equal(details.review.summary.outcome, "DEVIATION");
  assert.deepEqual(details.review.items.map(item => item.judgement), ["DEVIATION", "UNVERIFIED"]);
  assert.deepEqual(details.review.items[0].evidence, ["export.ts:3"]);
  assert.equal(details.brief, null);
  assert.equal(details.repair.text, message);
  assert.deepEqual(details.repairs, [{ runId: "repair-one", sourceRunId: "original-run",
    startedAt: 1, endedAt: 2, closed: false, outcome: "UNVERIFIED", roundId: "repair-round" }]);
  const originalRoundId = details.rounds.find(row => row.runId === "original-run").roundId;
  assert.equal(details.latestBriefRoundId, originalRoundId);
  const historical = await readSessionRuntimeDetails(snapshot, async () => receipt,
    identity => summarizeSessionRepairs(identity, ledger), originalRoundId);
  assert.equal(historical.round.outcome, "DEVIATION");
  assert.equal(historical.review.evaluationId, "stop-original");
  assert.equal(historical.review.reasonCode, "TURN_LIMIT");
  assert.deepEqual(historical.review.items.map(item => item.judgement), ["DEVIATION", "PASS", "NOT_REVIEWED"]);
  assert.equal(historical.brief.channel, "tool_result");
  assert.equal(historical.brief.text, briefText);
  assert.equal(historical.repair, null);
  assert.equal(historical.repairs[0].roundId, "repair-round");
  assert.equal(historical.repairs[0].input, message);
  await assert.rejects(readSessionRuntimeDetails({ ...snapshot, sessionId: "other-session" }, null, null, originalRoundId),
    { code: "CONFLICT" });
  assert.deepEqual(summarizeSessionRepairs({ ...snapshot, sessionId: "other-session" }, ledger), []);
  assert.equal((await readSessionRuntimeDetails({ ...snapshot, runId: "other-run" }, async () => receipt)).review, null);
  assert.equal((await readSessionRuntimeDetails({ ...snapshot, sessionId: "other-session" })).review, null);
  assert.equal((await readSessionRuntimeDetails({ ...snapshot, sessionId: "other-session" })).brief, null);
  assert.equal((await readSessionRuntimeDetails(snapshot, async () => ({ ...receipt, modelObservedAt: null }))).repair.text, null);
  const opaque = "[runtime-corrector:stop-reference] placeholder";
  assert.equal((await readSessionRuntimeDetails(snapshot, async () => ({ ...receipt, message: opaque, messageHash: sha256(opaque) }))).repair.text, null);
  await fs.writeFile(deliveryFile, JSON.stringify(delivery) + "\n");
  assert.deepEqual((await readSessionRuntimeDetails(snapshot, null, null, originalRoundId)).brief, { ...delivery, text: null });
});

test("console shows the selected Stop checklist while it is running and keeps missing verdicts separate", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-live-review-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = "live-session", sessionKey = "agent:main:live", runId = "business-run";
  const task = await ensureTask({ projectRoot: root, sessionId });
  const snapshot = { projectRoot: root, sessionId, sessionKey, taskId: task.taskId, controlRevision: 1, runId,
    roundId: "live-round", phase: "REVIEWING", active: true };
  const workspace = path.join(taskDirectory(root, task.taskId), "workspace-reviews", "live-attempt");
  await fs.mkdir(path.join(workspace, "items"), { recursive: true });
  const write = (name, data) => fs.writeFile(path.join(workspace, name), JSON.stringify(data));
  const owner = { sessionId, sessionKey, runId, controlRevision: 1, occurrenceId: "current-stop" };
  const worker = { taskId: task.taskId, role: "stop-reviewer", sessionFile: path.join(workspace,"host-session.jsonl"), startedAt: 1 };
  await recordNativeRun(root, { ...worker, runId: "unrelated-worker", stopReviewOwner: { ...owner, runId:"old-run" } });
  assert.equal((await readSessionRuntimeDetails(snapshot)).review, null);
  await recordNativeRun(root, { ...worker, runId: "owned-worker", stopReviewOwner: owner });
  assert.equal((await readSessionRuntimeDetails(snapshot)).review.stage, "READING_BASIS");
  const ids = ["ready", "deviation", "unknown", "pending", "outside"];
  await write("original-checklist.json", { population: { metrics: { M16: ids.map(objectId => ({ objectId, description: "Check " + objectId })) } } });
  assert.equal((await readSessionRuntimeDetails(snapshot)).review.stage, "SELECTING_SCOPE");
  await write("scope.json", { objectIds: ids.slice(0,4), qualityTargets: [{ path: "quality.md" }] });
  for (const [id, judgement] of [["ready","PASS"],["deviation","DEVIATION"],["unknown","UNVERIFIED"]])
    await write("items/" + sha256(id) + ".json", { itemId: id, result: { objectId: id, judgement, evidence: ["app.mjs:1"] } });
  await write("items/" + sha256("file:quality.md") + ".json",
    { itemId: "file:quality.md", result: { path: "quality.md", status:"PASS" } });
  const { review, round } = await readSessionRuntimeDetails(snapshot);
  assert.equal(round.outcome, null);
  assert.equal(review.provisional, true);
  assert.equal(review.coverage.selectedObjectCount, 5);
  assert.deepEqual(review.summary.categories.map(row => row.count), [2, 1, 1, 1, 0]);
  assert.deepEqual(review.items.map(item => [item.label,item.judgement]), [
    ["Check ready","PASS"],["Check deviation","DEVIATION"],["Check unknown","UNVERIFIED"],["Check pending","NOT_REVIEWED"],["quality.md","PASS"],
  ]);
  assert.equal((await readSessionRuntimeDetails({ ...snapshot, controlRevision: 2 })).review, null);
});

test("the review summary reads existing receipts and counts each known checklist item once", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-review-summary-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = "summary-session";
  const { taskId } = await ensureTask({ projectRoot: root, sessionId });
  const snapshot = { projectRoot: root, sessionId, taskId, runId: "summary-run", roundId: "summary-round", outcome: "UNVERIFIED" };
  const evaluationId = "stop-summary";
  await withTaskState({ projectRoot: root, taskId }, state => {
    state.verification = { status: "UNVERIFIED", evaluationId, terminalRunId: snapshot.runId };
  });
  const directory = path.join(taskDirectory(root, taskId), "evaluations");
  await fs.mkdir(directory, { recursive: true });
  const evaluation = path.join(directory, evaluationId + ".json");
  const report = {
    evaluationId, outcome: { status: "UNVERIFIED", historicalDeviations: [{ objectId: "past", kind: "IRREVERSIBLE_ORDER" }] },
    core: { summary: { items: [{ objectId: "missing-receipt", receiptId: null, result: { judgement: "UNVERIFIED" } }] } },
    review: {
      metricObjectJudgements: [
        { objectId: "passed", judgement: "PASS" },
        { objectId: "missing-receipt", judgement: "UNVERIFIED" },
        { objectId: "later-stage", judgement: "NOT_YET_APPLICABLE" },
      ],
      scopeSelection: { metrics: { M16: { objects: ["passed", "missing-receipt", "missing-evidence", "unreached", "later-stage"]
        .map(objectId => ({ objectId, selected: true })) } } },
      unverifiedItems: [
        { id: "path-witness", objectId: "missing-evidence", type: "OUTPUT_PATH" },
        { id: "missing-evidence", objectId: "missing-evidence", type: "REQUIREMENT" },
        { id: "unreached", objectId: "unreached", type: "REQUIREMENT", reviewState: "UNREVIEWED" },
        { id: "original:requirements.md", type: "ORIGINAL_SOURCE", reviewState: "UNREVIEWED" },
      ],
    },
  };
  const bytes = JSON.stringify(report);
  await fs.writeFile(evaluation, bytes);
  const { round, review } = await readSessionRuntimeDetails(snapshot);
  assert.equal(round.outcome, "UNVERIFIED");
  assert.equal(review.summary.outcome, "NO_DEVIATION_FOUND");
  assert.equal(review.summary.total, 6);
  assert.deepEqual(review.summary.categories.map(row => row.count), [1, 0, 1, 3, 1]);
  assert.equal(review.items.find(item => item.label === "missing-receipt").judgement, "UNVERIFIED");
  assert.equal(review.items.filter(item => item.category === null).length, 1);
  assert.equal(await fs.readFile(evaluation, "utf8"), bytes);
  report.review.collection = { mode: "deviation-only", complete: true };
  report.coverage = { scanCompleted: true };
  report.review.metricObjectJudgements = [];
  await fs.writeFile(evaluation, JSON.stringify(report));
  const scan = (await readSessionRuntimeDetails(snapshot)).review.summary;
  assert.deepEqual(scan.categories.map(row => row.count), [2, 0, 1, 3, 0]);
});

test("console displays the admitted feedback for a started native repair with an opaque request", async () => {
  const receipt = { runId: "rc-stop-example", source: { runId: "original" }, modelObservedAt: 20,
    message: "[runtime-corrector:stop-reference] queued request" };
  const snapshot = { projectRoot: os.tmpdir(), sessionId: "feedback-test", runId: receipt.runId, roundId: "repair" };
  const feedback = boundHostFeedback("behavior (r1): Function returned its input.\napp.mjs:1", {
    prefix: "[runtime-corrector:stop-feedback]\n以下仅为当前有效偏差，不新增用户需求或授权。请对照原始需求和当前实现核实并修复；如反馈不成立，请说明依据。处理须遵守现有约束及宿主工具和审批要求，修正后重新完成验收。",
  });
  const admission = { startStatus: "STARTED", startedAt: 20, feedbackRevision: 1,
    currentDeviations: [{ objectId: "behavior", revisionId: "r1", result: { reason: "Function returned its input.", evidence: ["app.mjs:1"] } }],
    hostRequest: { gate: { at: 19, feedbackRevision: 1, messageHash: sha256(feedback) } },
  };
  const repairText = async (entry, candidate = receipt) => (await readSessionRuntimeDetails(snapshot,
    async () => ({ ...candidate, admission: entry }))).repair.text;
  assert.equal(await repairText(admission), feedback);
  assert.equal(await repairText(admission, { ...receipt, modelObservedAt: null }), null);
  assert.equal(await repairText({ ...admission, startStatus: "PROTOCOL_VIOLATION" }), null);
  assert.equal(await repairText({ ...admission, currentDeviations: [] }), null);
});
