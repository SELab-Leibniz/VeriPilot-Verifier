// Test observer for persisted Stop receipts. It authenticates the core's saved terminal result;
// it does not decide business correctness or mutate the supplied snapshots.
import { isDeepStrictEqual } from "node:util";

export function classifyStopTerminal(state, { taskId, population, ownerAlive } = {}) {
  const result = (kind, reason, detail = {}) => ({ kind, reason, taskId, allMetricsPass: false, ...detail });
  const task = state?.tasks?.find(value => value.taskId === taskId);
  if (!task) return ownerAlive === false
    ? result("NOT_ACCEPTED", "The isolated owner exited before publishing a task.", { reasonCode: "REVIEW_OWNER_LOST" })
    : result("WAITING", "The selected task is not visible yet.");
  const sessions = new Set([task.rootSessionId, ...(task.sessionIds ?? [])].filter(Boolean));
  const records = (state.records ?? []).filter(record => record.taskId === taskId || sessions.has(record.sessionId));
  const stops = records.filter(record => record.file?.includes("/native-stop-reviews/"));
  const latest = stops.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  const active = records.some(record => ["PENDING", "RUNNING", "DISPATCH_COMMITTED"].includes(record.status));
  const openReceipt = records.some(record => record.file?.includes("/native-followups/")
    && ["RESERVED", "ADMITTED", "UNVERIFIED"].includes(record.status) && !record.finishedAt);
  if ((!latest || latest.status !== "SETTLED" || active || openReceipt) && ownerAlive === false)
    return result("NOT_ACCEPTED", "The isolated owner exited with unfinished Stop work; saved RUNNING is orphaned state.", { reasonCode: "REVIEW_OWNER_LOST" });
  if (!latest || latest.status !== "SETTLED" || active || openReceipt)
    return result("WAITING", "Formal Stop settlement or a closed work/receipt boundary is still pending.");
  const verification = task.verification ?? {};
  if (latest.reviewStatus === "CANCELLED" || latest.reasonCode || task.control?.cancelled
    || verification.correctionBudgetExhausted || task.stop?.infrastructureFailures > 0)
    return result("NOT_ACCEPTED", "This experimental gate does not certify cancellation, budget exhaustion or an infrastructure fault.");
  if (["DEVIATION", "CHECKER_ERROR"].includes(latest.reviewStatus) && latest.followupStatus !== "ADMITTED")
    return result("NOT_ACCEPTED", "Stop settled with unresolved failure and no admitted corrective run.");
  if (!["COMPLETED", "COMPLETED_WITH_ISSUES"].includes(task.status))
    return ownerAlive === false
      ? result("NOT_ACCEPTED", "The isolated owner exited before publishing a terminal task.", { reasonCode: "REVIEW_OWNER_LOST" })
      : result("WAITING", "The core task has not published a terminal status.");
  const evaluationId = verification.evaluationId;
  const assessment = task.assessments?.[verification.assessmentId];
  const saved = assessment?.result;
  const stop = saved?.stop;
  const evaluation = (state.evaluations ?? []).find(value => value.evaluationId === evaluationId
    && value.file?.includes(`/tasks/${taskId}/evaluations/`));
  // Recursive disk snapshots are not atomic. A temporarily missing projection
  // cannot certify either success or failure; the caller retains its deadline.
  if (!evaluationId || task.stop?.lastAssessmentId !== evaluationId || latest.evaluationId !== evaluationId
    || !latest.assessmentCompletedAt || !evaluation || !saved || !stop)
    return ownerAlive === false
      ? result("NOT_ACCEPTED", "The isolated owner exited before committing a complete Stop assessment.", { reasonCode: "REVIEW_OWNER_LOST" })
      : result("WAITING", "Matching committed assessment/evaluation projections are not visible.");
  const report = evaluation.metricReport, review = evaluation.review;
  if (saved.decision !== "allow" || stop.decision !== "allow" || stop.correctionBudgetExhausted
    || stop.verificationUnavailable || stop.stale || saved.stale || saved.shadowMode || stop.shadowMode)
    return result("NOT_ACCEPTED", "The saved core decision does not provide an ordinary, current allow.");
  if (review?.stopClassification !== "TASK_COMPLETE" || !report || !Array.isArray(report.metrics))
    return result("NOT_ACCEPTED", "A complete task-level metric assessment is required.");
  const expected = Object.values(population?.metrics ?? {}).flat();
  const rows = report.metrics.flatMap(metric => metric.objects ?? []);
  const ids = values => values.map(value => value.objectId).sort();
  const expectedIds = ids(expected), actualIds = ids(rows);
  const collection = review.collection;
  if (!expected.length || expectedIds.some(id => typeof id !== "string")
    || new Set(expectedIds).size !== expected.length || new Set(actualIds).size !== rows.length
    || JSON.stringify(expectedIds) !== JSON.stringify(actualIds)
    || collection?.complete !== true || collection.mode !== "metrics"
    || collection.totalObjects !== expected.length || collection.reviewedObjects !== expected.length
    || collection.completedItems !== collection.totalItems || collection.totalItems < 1
    || collection.basis?.populationDigest !== population.digest
    || report.populationVersion !== population.version || report.groundTruthVersion !== population.groundTruthVersion
    || population.groundTruthVersion !== task.groundTruth?.version
    || collection.basis?.groundTruthDigest !== task.groundTruth?.digest)
    return result("NOT_ACCEPTED", "The nonempty frozen population and complete collected assessment do not match.");
  if (latest.reviewStatus !== verification.status || !isDeepStrictEqual(stop.report, report))
    return result("NOT_ACCEPTED", "The committed terminal/report identities disagree.");
  if (report.status === "CHECKER_ERROR" || report.checkerIssues?.length || report.blockingObjects?.length
    || collection.failures?.length || collection.status !== "COMPLETED"
    || rows.some(row => row.judgement === "CHECKER_ERROR")
    || evaluation.implementationReview?.status === "FAILED"
    || evaluation.implementationReview?.collection?.complete === false)
    return result("NOT_ACCEPTED", "The core report contains blocking, checker or incomplete verification evidence.");
  const excluded = new Set(["NOT_APPLICABLE", "NOT_YET_APPLICABLE"]);
  const applicable = rows.filter(row => !excluded.has(row.judgement));
  const unverifiedObjectIds = rows.filter(row => ["UNVERIFIED", "EXTERNAL_BLOCKED"].includes(row.judgement)).map(row => row.objectId);
  const incompleteFiles = (review.fileAssessments ?? []).filter(file => file.status !== "PASS")
    .map(({ path, status }) => ({ path, status }));
  const detail = { evaluationId, evaluationFile: evaluation.file, totalObjects: rows.length,
    applicableObjects: applicable.length, unverifiedObjectIds,
    deviationObjectIds: rows.filter(row => row.judgement === "DEVIATION").map(row => row.objectId),
    excludedObjectIds: rows.filter(row => excluded.has(row.judgement)).map(row => row.objectId), incompleteFiles };
  if (task.status === "COMPLETED" && verification.status === "PASS" && report.status === "PASS"
    && applicable.length > 0 && applicable.every(row => row.judgement === "PASS") && !incompleteFiles.length)
    return result("ALL_METRICS_PASS", "All applicable objects in the complete frozen population passed.", { ...detail, allMetricsPass: true });
  if (task.status === "COMPLETED_WITH_ISSUES" && verification.status === "UNVERIFIED"
    && report.status === "UNVERIFIED" && (unverifiedObjectIds.length || incompleteFiles.length))
    return result("SETTLED_WITH_UNVERIFIED", "The core formally allowed completion while retaining unverified objects.", detail);
  return result("NOT_ACCEPTED", "The formal allow does not meet either certification category of this experiment.", detail);
}
