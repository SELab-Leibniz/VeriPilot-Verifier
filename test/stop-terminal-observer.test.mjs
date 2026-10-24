import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyStopTerminal } from "../experiments/review-metrics-20261024/e2e-plan/stop-terminal.mjs";
import { calculateMetricReport } from "../lib/runtime-v2/metrics.mjs";
import { ensureTask, taskDirectory, taskStatePath, withTaskState, withTaskDecision, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson, sha256 } from "../lib/runtime-v2/utils.mjs";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { runtimeState } from "../scripts/diagnostics/lib/isolated-openclaw.mjs";

// Generate the saved assessment with the real core transaction and native Stop
// receipt writer. No business process, model, Gateway or live fixture is used.
async function terminal(t, judgement = "PASS") {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-observer-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "observer-session" });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, value => {
    value.groundTruth = { version: 1, digest: "frozen-truth" };
  });
  const object = { objectId: "M01:requirement", metricId: "M01", sourceId: "requirement", hard: true, evidenceRequired: false };
  const population = { version: 1, groundTruthVersion: 1, digest: sha256(object), metrics: { M01: [object] } };
  const report = calculateMetricReport({ population, judgements: [{ objectId: object.objectId, judgement,
    reason: "An isolated core fixture judgement.", evidence: [] }] });
  const evaluationId = "stop-observer-assessment";
  const review = { stopClassification: "TASK_COMPLETE", stage: null, findings: [],
    collection: { complete: true, status: "COMPLETED", mode: "metrics", totalObjects: 1, reviewedObjects: 1,
      completedItems: 1, totalItems: 1, failures: [], basis: { populationDigest: population.digest, groundTruthDigest: "frozen-truth" } } };
  const before = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  await withTaskDecision({ projectRoot: root, taskId: task.taskId, context: { assessmentId: "native-assessment-1", kind: "stop",
    guard: decisionGuard(before), mode: "execute_and_correct" } }, async () => {
    await atomicWriteJson(path.join(taskDirectory(root, task.taskId), "evaluations", evaluationId + ".json"), { evaluationId, review, metricReport: report });
    await withTaskState({ projectRoot: root, taskId: task.taskId }, value => {
      value.status = report.status === "PASS" ? "COMPLETED" : "COMPLETED_WITH_ISSUES";
      value.verification = { status: report.status, evaluationId, correctionBudgetExhausted: false };
      value.stop.lastAssessmentId = evaluationId;
      value.stop.infrastructureFailures = 0;
    });
    return { handled: true, taskId: task.taskId, decision: "allow", stop: { decision: "allow", report,
      review, correctionBudgetExhausted: false, verificationIncomplete: report.status !== "PASS" } };
  });
  const native = createNativeStopReviews();
  await native.schedule({ projectRoot: root, sessionId: "observer-session", sessionKey: "agent:main:observer", runId: "native-run-1",
    signal: new AbortController().signal, budgetMs: 10000, run: async ({ commit }) => {
      const outcome = { reviewStatus: report.status, evaluationId }; await commit(outcome); return outcome;
    } });
  await native.wait();
  const state = await runtimeState(root), options = { taskId: task.taskId, population };
  return { state, options, classify: () => classifyStopTerminal(state, options) };
}

test("real saved all-PASS assessment is certified without business-verifier substitution", async t => {
  const f = await terminal(t), before = structuredClone(f.state);
  assert.equal(f.classify().kind, "ALL_METRICS_PASS");
  assert.equal(f.classify().allMetricsPass, true);
  assert.deepEqual(f.state, before, "The observer must not mutate core records.");
});

test("real core allow with retained U settles normally but remains unverified", async t => {
  const f = await terminal(t, "UNVERIFIED"), result = f.classify();
  assert.equal(result.kind, "SETTLED_WITH_UNVERIFIED");
  assert.equal(result.allMetricsPass, false);
  assert.deepEqual(result.unverifiedObjectIds, ["M01:requirement"]);
  assert.equal(f.state.evaluations[0].metricReport.metrics[0].denominator, 1);
  assert.equal(f.state.evaluations[0].metricReport.metrics[0].numerator, 0);
});

test("empty populations and lost or duplicate rows cannot self-certify completeness", async t => {
  for (const change of ["empty", "missing", "duplicate", "wrongDigest"]) await t.test(change, async t => {
    const f = await terminal(t);
    if (change === "empty") f.options.population.metrics = {};
    if (change === "missing") f.state.evaluations[0].metricReport.metrics.find(metric => metric.metricId === "M01").objects = [];
    if (change === "duplicate") { const m = f.state.evaluations[0].metricReport.metrics.find(metric => metric.metricId === "M01"); m.objects.push(structuredClone(m.objects[0])); }
    if (change === "wrongDigest") f.options.population.digest = "different-population";
    assert.equal(f.classify().kind, "NOT_ACCEPTED");
  });
});

test("an unrelated or missing evaluation cannot impersonate the committed task assessment", async t => {
  const f = await terminal(t);
  f.state.evaluations[0].evaluationId = "another-evaluation";
  assert.equal(f.classify().kind, "WAITING");
  f.state.evaluations[0].evaluationId = f.state.tasks[0].verification.evaluationId;
  f.state.tasks[0].assessments = {};
  assert.equal(f.classify().kind, "WAITING");
});

test("active work and unfinished admitted receipts keep observation pending", async t => {
  for (const record of [{ file: "/native-runs/work.json", status: "RUNNING" },
    { file: "/native-followups/receipt.json", status: "ADMITTED" }]) await t.test(record.status, async t => {
      const f = await terminal(t); f.state.records.push({ ...record, taskId: f.options.taskId });
      assert.equal(f.classify().kind, "WAITING");
      if (record.status === "ADMITTED") { f.state.records.at(-1).finishedAt = Date.now(); assert.equal(f.classify().kind, "ALL_METRICS_PASS"); }
    });
});

test("known owner exit stops waiting on orphan work without changing saved product state", async t => {
  for (const change of ["running", "receipt", "projection", "task"]) await t.test(change, async t => {
    const f = await terminal(t);
    if (change === "running") f.state.records[0].status = "RUNNING";
    if (change === "receipt") f.state.records.push({ taskId: f.options.taskId, file: "/native-followups/orphan.json", status: "ADMITTED" });
    if (change === "projection") f.state.evaluations = [];
    if (change === "task") f.state.tasks = [];
    const before = structuredClone(f.state);
    const result = classifyStopTerminal(f.state, { ...f.options, ownerAlive: false });
    assert.equal(result.kind, "NOT_ACCEPTED");
    assert.equal(result.reasonCode, "REVIEW_OWNER_LOST");
    assert.equal(result.allMetricsPass, false);
    assert.deepEqual(f.state, before);
  });
  const committed = await terminal(t);
  assert.equal(classifyStopTerminal(committed.state, { ...committed.options, ownerAlive: false }).kind, "ALL_METRICS_PASS",
    "a later owner exit does not erase an already committed complete result");
});

test("a refused continuation is terminal failure while an old refusal cannot hold a later committed PASS", async t => {
  const f = await terminal(t);
  f.state.records.push({ taskId: f.options.taskId, file: "/native-followups/refused.json", status: "REJECTED" });
  assert.equal(f.classify().kind, "ALL_METRICS_PASS", "An explicit refusal is closed, not unfinished work.");
  f.state.records[0].reviewStatus = "DEVIATION";
  f.state.records[0].followupStatus = "REJECTED";
  f.state.tasks[0].status = "ACTIVE";
  assert.equal(f.classify().kind, "NOT_ACCEPTED");
});

test("matching evaluation IDs cannot launder a report different from the saved core assessment", async t => {
  const f = await terminal(t), task = f.state.tasks[0];
  const saved = task.assessments[task.verification.assessmentId].result.stop.report;
  const row = saved.metrics.find(metric => metric.metricId === "M01").objects[0];
  row.judgement = "DEVIATION"; row.hard = false;
  assert.equal(f.classify().kind, "NOT_ACCEPTED");
});

test("hard deviation, exhausted budget, checker faults and cancellation cannot be certified", async t => {
  for (const change of ["hardD", "exhausted", "checker", "incomplete", "infra", "cancelled", "blockedDecision"]) await t.test(change, async t => {
    const f = await terminal(t), task = f.state.tasks[0], evaluation = f.state.evaluations[0];
    if (change === "hardD") {
      evaluation.metricReport = calculateMetricReport({ population: f.options.population, judgements: [{ objectId: "M01:requirement", judgement: "DEVIATION", reason: "Actual hard violation.", evidence: [] }] });
      task.assessments[task.verification.assessmentId].result.stop.report = evaluation.metricReport;
    }
    if (change === "exhausted") task.verification.correctionBudgetExhausted = true;
    if (change === "checker") evaluation.metricReport.checkerIssues.push({ type: "CHECKER_FAILURE" });
    if (change === "incomplete") evaluation.review.collection.complete = false;
    if (change === "infra") task.stop.infrastructureFailures = 1;
    if (change === "cancelled") f.state.records[0].reviewStatus = "CANCELLED";
    if (change === "blockedDecision") task.assessments[task.verification.assessmentId].result.decision = "block";
    assert.equal(f.classify().kind, "NOT_ACCEPTED");
  });
});

test("legitimate conditional exclusions remain rows and never make an empty denominator PASS", async t => {
  const f = await terminal(t), evaluation = f.state.evaluations[0], task = f.state.tasks[0], original = f.options.population.metrics.M01[0];
  const excluded = { ...original, objectId: "M01:conditional" };
  f.options.population.metrics.M01.push(excluded);
  evaluation.metricReport = calculateMetricReport({ population: f.options.population, judgements: [
    { objectId: original.objectId, judgement: "PASS", reason: "Observed.", evidence: [] },
    { objectId: excluded.objectId, judgement: "NOT_APPLICABLE", reason: "The original condition does not apply.", evidence: [] },
  ] });
  Object.assign(evaluation.review.collection, { totalObjects: 2, reviewedObjects: 2 });
  task.assessments[task.verification.assessmentId].result.stop.report = evaluation.metricReport;
  assert.equal(f.classify().kind, "ALL_METRICS_PASS");
  assert.deepEqual(f.classify().excludedObjectIds, [excluded.objectId]);
  evaluation.metricReport.metrics.find(metric => metric.metricId === "M01").objects[0].judgement = "NOT_APPLICABLE";
  assert.equal(f.classify().kind, "NOT_ACCEPTED");
});
