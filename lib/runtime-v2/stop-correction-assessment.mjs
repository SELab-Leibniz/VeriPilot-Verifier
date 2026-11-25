import { runStopReviewRound } from "./stop-review-round.mjs";
import { partitionHistoricalDeviations } from "./historical-order.mjs";
import { beforeStopDeadline, scheduleStopDeadline } from "./stop-deadline.mjs";
import { normalizeStopCorrectionConfig, stopCorrectionWindow } from "./stop-correction-config.mjs";

const error = (code, message) => Object.assign(new Error(message), { code });
const nonRestartablePreparation = new Set([
  'BASELINE_REPAIR_LIMIT', 'BASELINE_COVERAGE_REPAIR', 'BASELINE_AUDIT_INCOMPLETE',
  'REVIEWER_OUTPUT_LIMIT', 'TURN_LIMIT', 'JOURNAL_UNCERTAIN',
]);

/** Review evidence independently of repair eligibility. A trusted reservation
 * and start remain separate, durable host facts. */
export async function assessStopCorrection({ sessionStore, reviewStoreFor, sessionId, flowId, stopId, sourceInput,
  config, initialize, hostDeadlineAt, prepare, reviewGroup, feedbackBasisCurrent, signal,
  isCurrent = async () => true, now = Date.now, groupTimeoutMs = Infinity, admissionSupported = true, finalizeSummary,
  historicalContext, verificationOnly = false, scope, reviewOwner }) {
  let entry, repairUnavailable;
  if (!verificationOnly && sessionStore) {
    try {
      entry = await sessionStore.beginStop({ sessionId, flowId, stopId, sourceInput, config, initialize, hostDeadlineAt, scope, owner: reviewOwner });
    } catch (cause) {
      if (cause.code !== "STOP_SESSION_MIGRATION_REQUIRED") throw cause;
      repairUnavailable = cause.code;
    }
  } else if (!verificationOnly) repairUnavailable = "STOP_SESSION_STORE_UNAVAILABLE";
  // A review without authority to reserve a repair has no delivery cutoff.
  const readOnly = verificationOnly || Boolean(repairUnavailable);
  if (readOnly) {
    const policy = normalizeStopCorrectionConfig(config);
    const window = stopCorrectionWindow(policy, now(), hostDeadlineAt);
    entry = { reused: false, stop: { id: stopId, flowId: null, config: policy, ...window,
      reviewDeadlineAt: window.deadlineAt, control: "WAIT_REVIEW", reviewStatus: "PENDING" } };
  }
  if (entry.reused || entry.stop.control === "ALLOW") {
    const admission = entry.stop.admissionId ? (await sessionStore.inspect(sessionId)).admissions[entry.stop.admissionId] : null;
    return { ...entry, admission, summary: null };
  }
  const stop = entry.stop;
  const controller = new AbortController();
  let cancelTimer, summary = null, infrastructureAttempts=0;
  const preparationFailures=[];
  const abort = () => controller.abort(signal.reason ?? error("STOP_CANCELLED", "Stop cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const bounded = async (operation, cutoff, code, operationSignal = signal) => {
    return beforeStopDeadline(operation, { deadlineAt: cutoff, code, signal: operationSignal, now });
  };
  try {
    if (now() >= stop.reviewDeadlineAt) throw error("STOP_REVIEW_DEADLINE", "No review time remains after reserving feedback time.");
    cancelTimer = scheduleStopDeadline(() => controller.abort(error("STOP_REVIEW_DEADLINE", "Review cutoff reached.")), stop.reviewDeadlineAt, now);
    if (!await bounded(isCurrent, stop.reviewDeadlineAt, "STOP_REVIEW_DEADLINE", controller.signal)) throw error("STOP_SCOPE_STALE", "The Stop scope is no longer current.");
    let prepared;
    for(;;){
      infrastructureAttempts++;
      try{prepared=await bounded(() => prepare({ stop: structuredClone(stop), signal: controller.signal,
        deadlineAt: stop.reviewDeadlineAt }), stop.reviewDeadlineAt, "STOP_REVIEW_DEADLINE", controller.signal);break;}
      catch(cause){
        preparationFailures.push({attempt:infrastructureAttempts,code:cause.code??'STOP_PREPARATION_FAILED',reason:cause.message});
        // A preparation that has spent its owned baseline allowance cannot be
        // restarted as infrastructure work under the same Stop identity.
        if(infrastructureAttempts>=3||controller.signal.aborted||signal?.aborted||cause.stopTaskFailure===true
          ||cause.coverageAuditFailure===true||nonRestartablePreparation.has(cause.code)
          || /DEADLINE|CANCEL|STALE|DENIED|DRAINING|PERMISSION|INVALID|UNVERIFIED|BASIS|SOURCE|INPUT_CHANGED|NO_PROGRESS/u.test(cause.code??''))throw cause;
      }
    }
    if (!prepared?.scopeId || !Array.isArray(prepared.items)) throw error("STOP_REVIEW_PREPARATION_INVALID", "Preparation must preserve a frozen scope and independent original items.");
    if (!readOnly) await bounded(() => sessionStore.bindReviewScope({ sessionId, stopId, scopeId: prepared.scopeId, classification: prepared.classification,
      signal: controller.signal }), stop.reviewDeadlineAt, "STOP_REVIEW_DEADLINE", controller.signal);
    const reviewStore = await bounded(() => reviewStoreFor(prepared.scopeId), stop.reviewDeadlineAt, "STOP_REVIEW_DEADLINE", controller.signal);
    summary = await runStopReviewRound({ store: reviewStore, roundId: stopId, stopId, items: prepared.items,
      groupSize: stop.config.reviewGroupSize, deadlineAt: stop.reviewDeadlineAt, reviewGroup, signal: controller.signal,
      isCurrent, now, groupTimeoutMs, settlementDeadlineAt: stop.deadlineAt, settlementSignal: signal });
    summary={...summary,infrastructureAttempts,preparationFailures};
    cancelTimer?.();
    if (finalizeSummary) summary = await bounded(() => finalizeSummary(summary, { reviewDeadlineAt: stop.reviewDeadlineAt,
      deadlineAt: stop.deadlineAt, signal }), stop.deadlineAt, "STOP_TOTAL_DEADLINE");
    // A review deadline ends reading, not the reserved settlement window.
    // Explicit cancellation/scope loss suppresses publication and delivery.
    if (signal?.aborted || !await bounded(isCurrent, stop.deadlineAt, "STOP_TOTAL_DEADLINE")) throw error("STOP_SCOPE_STALE", "The Stop was cancelled or superseded before settlement.");
    const historical=historicalContext?.()??{};
    const partition=partitionHistoricalDeviations({...summary,historicalCandidates:historical.proofs??[],historicalUnverifiedCount:historical.unverifiedCount??0});
    summary={...summary,status:partition.status,historicalDeviations:partition.historical};
    const currentDeviations = partition.actionable;
    if (readOnly) return { stop: { ...stop, control: "ALLOW", reviewStatus: summary.status, currentDeviations,
      ...(currentDeviations.length && repairUnavailable ? { releaseReason: repairUnavailable } : {}), releasedAt: now(), progress: { ...summary.progress, complete: summary.complete } }, summary, admission: null, reused: false };
    const settled = await bounded(() => sessionStore.settleReview({ sessionId, stopId, status: summary.status,
      progress: { ...summary.progress, complete: summary.complete }, currentDeviations,
      historicalDeviations:partition.historical, signal }), stop.deadlineAt, "STOP_TOTAL_DEADLINE");
    if (!currentDeviations.length) return { stop: settled, summary, admission: null, reused: false };
    if (!admissionSupported) {
      const ended = await sessionStore.expireStop({ sessionId, stopId, force: true, cannotStart: true,
        reasonCode: "HOST_START_PROTOCOL_UNSUPPORTED" });
      return { stop: ended, summary, admission: null, reused: false };
    }
    const admission = await bounded(() => sessionStore.reserveFeedback({ sessionId, stopId,
      packageId: `${stopId}:deviations`, signal, basisCurrent: async deviations => !signal?.aborted && await isCurrent()
        && await feedbackBasisCurrent(deviations) }), stop.deadlineAt, "STOP_TOTAL_DEADLINE");
    return { stop: (await sessionStore.inspect(sessionId)).stops[stopId], summary, admission, reused: false };
  } catch (cause) {
    cancelTimer?.();
    controller.abort(cause);
    const cancelled = signal?.aborted || cause.code === "STOP_SCOPE_STALE";
    if (readOnly) return { stop: { ...stop, control: "ALLOW", reviewStatus: "UNVERIFIED", releasedAt: now() }, admission: null,
      summary: null, failure: { code: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message },infrastructureAttempts,preparationFailures, reused: false };
    const current = (await sessionStore.inspect(sessionId)).stops[stopId];
    if (cancelled || now() >= stop.deadlineAt || current.reviewStatus !== "PENDING") {
      const ended = await sessionStore.expireStop({ sessionId, stopId, force: true,
        reasonCode: cancelled ? "STOP_CANCELLED_OR_STALE" : now() >= stop.deadlineAt ? "STOP_TOTAL_DEADLINE" : "STOP_FEEDBACK_FAILED",
        fault: { code: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message }, scopeInvalidated: cancelled });
      return { stop: ended, admission: null, summary: cancelled ? null : summary, failure: { code: cause.code, reason: cause.message },infrastructureAttempts,preparationFailures, reused: false };
    }
    const settled = await sessionStore.settleReview({ sessionId, stopId, status: "UNVERIFIED", assessmentFailed: true,
      progress: { complete: false, reasonCode: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message } });
    return { stop: settled, admission: null, summary: null, failure: { code: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message },infrastructureAttempts,preparationFailures, reused: false };
  } finally {
    cancelTimer?.();
    signal?.removeEventListener("abort", abort);
  }
}
