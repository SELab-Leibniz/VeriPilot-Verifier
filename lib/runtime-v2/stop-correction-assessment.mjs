import { runStopReviewRound } from "./stop-review-round.mjs";
import { beforeStopDeadline, scheduleStopDeadline } from "./stop-deadline.mjs";
import { normalizeStopCorrectionConfig, stopCorrectionWindow } from "./stop-correction-config.mjs";

const error = (code, message) => Object.assign(new Error(message), { code });

/** Shared assessment entry for host adapters. Quota entry precedes ALL model
 * work, including baseline preparation. Delivery/start/repair remain separate
 * adapter facts on the session store; returning an admission never charges it. */
export async function assessStopCorrection({ sessionStore, reviewStoreFor, sessionId, flowId, stopId, sourceInput,
  config, initialize, hostDeadlineAt, prepare, reviewGroup, feedbackBasisCurrent, signal,
  isCurrent = async () => true, now = Date.now, groupTimeoutMs = Infinity, admissionSupported = true, finalizeSummary, verificationOnly = false, scope, reviewOwner }) {
  // Explicit read-only verification has no business admission, quota mutation,
  // or authority to close an automatic correction flow.
  const verificationConfig = verificationOnly ? normalizeStopCorrectionConfig(config) : null;
  const verificationWindow = verificationOnly ? stopCorrectionWindow(verificationConfig, now(), hostDeadlineAt) : null;
  // Read-only checks cannot admit business work and need no reserved delivery
  // window. A short caller deadline must still permit the check itself.
  const entry = verificationOnly ? { reused: false, stop: { id: stopId, flowId: null,
    config: verificationConfig, ...verificationWindow, reviewDeadlineAt: verificationWindow.deadlineAt, control: "WAIT_REVIEW", reviewStatus: "PENDING" } }
    : await sessionStore.beginStop({ sessionId, flowId, stopId, sourceInput, config, initialize, hostDeadlineAt, scope, owner: reviewOwner });
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
        if(infrastructureAttempts>=3||controller.signal.aborted||signal?.aborted||cause.stopTaskFailure===true
          || /DEADLINE|CANCEL|STALE|DENIED|DRAINING|PERMISSION|INVALID|UNVERIFIED|BASIS|SOURCE|INPUT_CHANGED|NO_PROGRESS/u.test(cause.code??''))throw cause;
      }
    }
    if (!prepared?.scopeId || !Array.isArray(prepared.items)) throw error("STOP_REVIEW_PREPARATION_INVALID", "Preparation must preserve a frozen scope and independent original items.");
    if (!verificationOnly) await bounded(() => sessionStore.bindReviewScope({ sessionId, stopId, scopeId: prepared.scopeId,
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
    const currentDeviations = summary.deviations;
    if (verificationOnly) return { stop: { ...stop, control: "ALLOW", reviewStatus: summary.status, currentDeviations,
      releasedAt: now(), progress: { ...summary.progress, complete: summary.complete } }, summary, admission: null, reused: false };
    const settled = await bounded(() => sessionStore.settleReview({ sessionId, stopId, status: summary.status,
      progress: { ...summary.progress, complete: summary.complete }, currentDeviations, signal }), stop.deadlineAt, "STOP_TOTAL_DEADLINE");
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
    if (verificationOnly) return { stop: { ...stop, control: "ALLOW", reviewStatus: "UNVERIFIED", releasedAt: now() }, admission: null,
      summary: null, failure: { code: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message },infrastructureAttempts,preparationFailures, reused: false };
    const current = (await sessionStore.inspect(sessionId)).stops[stopId];
    if (cancelled || now() >= stop.deadlineAt || current.reviewStatus !== "PENDING") {
      const ended = await sessionStore.expireStop({ sessionId, stopId, force: true,
        reasonCode: cancelled ? "STOP_CANCELLED_OR_STALE" : now() >= stop.deadlineAt ? "STOP_TOTAL_DEADLINE" : "STOP_FEEDBACK_FAILED",
        fault: { code: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message }, scopeInvalidated: cancelled });
      return { stop: ended, admission: null, summary: cancelled ? null : summary, failure: { code: cause.code, reason: cause.message },infrastructureAttempts,preparationFailures, reused: false };
    }
    const settled = await sessionStore.settleReview({ sessionId, stopId, status: "UNVERIFIED", progress: { complete: false,
      reasonCode: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message } });
    return { stop: settled, admission: null, summary: null, failure: { code: cause.code ?? "STOP_ASSESSMENT_FAILED", reason: cause.message },infrastructureAttempts,preparationFailures, reused: false };
  } finally {
    cancelTimer?.();
    signal?.removeEventListener("abort", abort);
  }
}
