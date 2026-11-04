// admission.finalReview is only written for the budget-exhausting review.
// Earlier successful repairs are proved by their own finished Stop assessment.
export function latestBenchmarkRepairReview({ ledger, admissions, verification, deviationOnly = false }) {
  const repair = admissions.at(-1);
  const runId = repair?.executionId ?? repair?.hostRequest?.runId;
  const stop = ledger?.stops?.[runId];
  if (!runId || !Number.isFinite(repair.endedAt) || !Number.isFinite(stop?.startedAt) || !Number.isFinite(stop?.assessmentFinishedAt)
    || stop.startedAt < repair.endedAt || stop.assessmentFinishedAt < stop.startedAt
    || !['PASS', 'DEVIATION', 'UNVERIFIED', ...(deviationOnly ? ['NO_DEVIATION_FOUND'] : [])].includes(stop.reviewStatus)
    || stop.reviewStatus !== verification?.status || !verification?.evaluationId
    || !verification?.assessmentId?.startsWith(`${runId}:`)) return null;
  return { status: stop.reviewStatus, evaluationId: verification.evaluationId,
    assessmentId: verification.assessmentId, runId, at: stop.assessmentFinishedAt,
    source: 'Exact repair terminal followed by its recorded current Stop assessment' };
}
