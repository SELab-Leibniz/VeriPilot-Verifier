import path from "node:path";
import { outsideDecision } from "./decision-scope.mjs";
import { withTaskResourceLock } from "./task-store.mjs";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";
import { effectiveFlowLimit, normalizeStopCorrectionConfig, stopCorrectionWindow } from "./stop-correction-config.mjs";
import { beforeStopDeadline } from "./stop-deadline.mjs";
import { hasStopReviews } from "./metric-policy.mjs";

const schemaVersion = "runtime-corrector.stop-correction-session.v1";
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const identity = (value, name) => {
  if (typeof value !== "string" || !value.trim() || Object.hasOwn(Object.prototype, value)) fail("STOP_IDENTITY_REQUIRED", `${name} is required and must be an unambiguous identity.`);
  return value;
};
const reserved = admission => admission.accounting === "RESERVED";
const terminal = stop => stop.releasedAt !== undefined;

export function correctionCapacity(state, flow, config) {
  const pending = Object.values(state.admissions).filter(reserved);
  const sessionReserved = pending.length, flowReserved = pending.filter(value => value.flowId === flow.id).length;
  const flowLimit = effectiveFlowLimit(config);
  const result = { sessionLimit: config.maxCorrectionsPerSession, flowLimit, sessionUsed: state.used,
    flowUsed: flow.used, sessionReserved, flowReserved };
  result.reasonCode = flow.closedAt !== undefined ? "CORRECTION_FLOW_CLOSED"
    : state.used >= config.maxCorrectionsPerSession ? "SESSION_CORRECTION_LIMIT"
    : flow.used >= flowLimit ? "FLOW_CORRECTION_LIMIT"
    : state.used + sessionReserved >= config.maxCorrectionsPerSession ? "SESSION_ADMISSION_PENDING"
    : flow.used + flowReserved >= flowLimit ? "FLOW_ADMISSION_PENDING" : null;
  return result;
}

/** The adapter supplies one durable directory for ALL project scopes of a host
 * session. Deliberately no project-local fallback that could replenish quotas. */
export function createStopCorrectionStore({ directory, now = Date.now }) {
  if (!path.isAbsolute(directory ?? "")) throw new Error("A stable absolute host session store directory is required.");
  const fileFor = sessionId => path.join(directory, "sessions", `${sha256(identity(sessionId, "sessionId"))}.json`);
  const transaction = (sessionId, update, { initialize } = {}) => outsideDecision(() => withTaskResourceLock({
    projectRoot: directory, taskId: sha256(sessionId), resource: "stop-session", reclaimDeadOwner: true,
  }, async () => {
    const file = fileFor(sessionId);
    let state = await readJson(file);
    if (!state) {
      if (!initialize || !["NEW_SESSION", "VERIFIED_HISTORY"].includes(initialize.kind) || !initialize.evidence)
        fail("STOP_SESSION_MIGRATION_REQUIRED", "Existing session usage must be reconciled from trustworthy start records; a task/epoch count is insufficient.");
      if (initialize.kind === "NEW_SESSION" && initialize.starts !== undefined)
        fail("STOP_SESSION_MIGRATION_REQUIRED", "A new-session declaration cannot include historical starts.");
      if (initialize.kind === "VERIFIED_HISTORY" && (!Array.isArray(initialize.starts)
        || initialize.starts.some(start => !start.executionId || !start.flowId || !Number.isFinite(start.startedAt))))
        fail("STOP_SESSION_MIGRATION_REQUIRED", "Verified history requires individual execution start records.");
      state = { schemaVersion, sessionId, initializedAt: now(), initialization: structuredClone(initialize),
        used: 0, flows: {}, stops: {}, admissions: {}, events: [] };
      for (const start of initialize.starts ?? []) {
        identity(start.executionId, "executionId"); identity(start.flowId, "flowId");
        if (start.startedAt > now()) fail("STOP_SESSION_MIGRATION_REQUIRED", "Historical starts cannot be in the future.");
        if (state.admissions[start.executionId]) {
          const prior = state.admissions[start.executionId];
          if (prior.flowId !== start.flowId || prior.startedAt !== start.startedAt)
            fail("STOP_SESSION_MIGRATION_REQUIRED", "Conflicting historical execution start records.");
          continue;
        }
        const flow = state.flows[start.flowId] ??= { id: start.flowId, used: 0, sourceInputId: null, migrated: true };
        state.admissions[start.executionId] = { ...start, id: start.executionId, accounting: "USED", historical: true };
        state.used++; flow.used++;
      }
    }
    if (state.schemaVersion !== schemaVersion || state.sessionId !== sessionId) fail("STOP_SESSION_STORE_INVALID", "Session store identity/schema mismatch.");
    const value = await update(state);
    state.updatedAt = now();
    await atomicWriteJson(file, state);
    return structuredClone(value);
  }));
  const event = (state, type, data) => state.events.push({ type, observedAt: now(), ...data });
  const stopFor = (state, stopId) => state.stops[stopId] ?? fail("STOP_NOT_FOUND", "Unknown Stop occurrence.");
  const admissionFor = (state, id) => state.admissions[id] ?? fail("STOP_ADMISSION_NOT_FOUND", "Unknown continuation admission.");
  const release = (stop, reasonCode) => {
    if (terminal(stop)) return;
    stop.releasedAt = now(); stop.control = "ALLOW"; stop.releaseReason = reasonCode;
  };
  const close = (state, stop, reasonCode) => {
    const flow = state.flows[stop.flowId];
    flow.closedAt ??= now(); flow.closeReason ??= reasonCode;
    for (const related of Object.values(state.stops)) {
      if (related.flowId !== stop.flowId) continue;
      release(related, reasonCode);
      related.flowEndedByStopId ??= stop.id;
    }
    for (const admission of Object.values(state.admissions))
      if (admission.flowId === stop.flowId && reserved(admission)) invalidate(admission, reasonCode, false);
  };
  const invalidate = (admission, reasonCode, cannotStart) => {
    admission.invalidatedAt ??= now(); admission.invalidationReason ??= reasonCode;
    if (reserved(admission)) admission.accounting = cannotStart ? "RELEASED" : "RESERVED";
    admission.startStatus = admission.startedAt !== undefined ? admission.startStatus : cannotStart ? "NOT_STARTED" : "UNCERTAIN";
  };
  const checkedSubset = (original, checked) => {
    if (checked === true) return original;
    if (checked === false) return [];
    if (!Array.isArray(checked)) fail("STOP_FEEDBACK_VALIDATION_INVALID", "Feedback validation must return a boolean or an unchanged subset of the supplied deviations.");
    const allowed = new Map(original.map(value => [sha256(value), value]));
    const selected = new Set();
    for (const value of checked) {
      const key = sha256(value);
      if (!allowed.has(key) || selected.has(key)) fail("STOP_FEEDBACK_VALIDATION_INVALID", "Feedback validation invented, changed or repeated a deviation.");
      selected.add(key);
    }
    return original.filter(value => selected.has(sha256(value)));
  };
  const applySubset = (stop, subset) => {
    if (sha256(stop.currentDeviations) === sha256(subset)) return;
    const kept = new Set(subset.map(sha256));
    stop.feedbackInvalidations ??= [];
    stop.feedbackInvalidations.push({ at: now(), reason: "FEEDBACK_BASIS_CHANGED",
      deviations: stop.currentDeviations.filter(value => !kept.has(sha256(value))) });
    stop.currentDeviations = structuredClone(subset);
    stop.feedbackRevision = (stop.feedbackRevision ?? 0) + 1;
    if (!subset.length) stop.reviewStatus = "UNVERIFIED";
  };
  return {
    fileFor,
    async initializeSession({ sessionId, initialize }) { return transaction(sessionId, state => state, { initialize }); },
    async inspect(sessionId) { return outsideDecision(() => readJson(fileFor(sessionId))); },
    async beginStop({ sessionId, flowId, stopId, sourceInput, config: input, initialize, hostDeadlineAt, scope, owner }) {
      identity(flowId, "flowId"); identity(stopId, "stopId");
      const config = normalizeStopCorrectionConfig(input);
      return transaction(sessionId, state => {
        const previous = state.stops[stopId];
        if (previous) {
          if (previous.flowId !== flowId) fail("STOP_IDENTITY_CONFLICT", "A Stop occurrence cannot move between flows.");
          return { stop: previous, reused: true };
        }
        let flow = state.flows[flowId];
        if (!flow) {
          if (sourceInput?.origin !== "HUMAN" || !sourceInput.id)
            fail("STOP_FLOW_SOURCE_REQUIRED", "Only a genuine user input can establish a new correction flow.");
          if (Object.values(state.flows).some(value => value.sourceInputId === sourceInput.id))
            fail("STOP_FLOW_SOURCE_REUSED", "One user input cannot mint another correction flow.");
          flow = state.flows[flowId] = { id: flowId, sourceInputId: sourceInput.id, used: 0, createdAt: now() };
        }
        const capacity = correctionCapacity(state, flow, config);
        const stop = state.stops[stopId] = { id: stopId, flowId, ...(scope ? { scope } : {}), ...(owner ? { owner: structuredClone(owner) } : {}), config: structuredClone(config), capacity,
          ...stopCorrectionWindow(config, now(), hostDeadlineAt), control: "WAIT_REVIEW", reviewStatus: "PENDING", deliveryStatus: "NONE" };
        const disabled = !config.enabled || !hasStopReviews(config);
        const reasonCode = !config.enabled ? "STOP_CORRECTION_DISABLED" : !hasStopReviews(config) ? "ALL_STOP_REVIEWS_DISABLED" : capacity.reasonCode;
        if (reasonCode) { stop.reviewStatus = disabled ? "DISABLED" : "SKIPPED"; close(state, stop, reasonCode); }
        event(state, "STOP_ENTERED", { stopId, flowId, capacity, skipped: Boolean(reasonCode) });
        return { stop, reused: false };
      }, { initialize });
    },
    async bindReviewScope({ sessionId, stopId, scopeId, signal }) {
      identity(scopeId, "scopeId");
      return transaction(sessionId, state => {
        signal?.throwIfAborted();
        const stop = stopFor(state, stopId);
        if (terminal(stop) || now() >= stop.reviewDeadlineAt) fail("STOP_REVIEW_WINDOW_CLOSED", "The review scope cannot bind after cancellation or the review cutoff.");
        if (stop.reviewScopeId && stop.reviewScopeId !== scopeId) fail("STOP_IDENTITY_CONFLICT", "One Stop cannot change its frozen review scope.");
        stop.reviewScopeId = scopeId;
        return stop;
      });
    },
    async settleReview({ sessionId, stopId, status, progress = {}, currentDeviations = [], signal }) {
      return transaction(sessionId, state => {
        signal?.throwIfAborted();
        const stop = stopFor(state, stopId);
        if (terminal(stop)) return stop;
        if (now() >= stop.deadlineAt) fail("STOP_REVIEW_WINDOW_CLOSED", "Review settlement arrived after this Stop's total deadline.");
        if (!["PASS", "DEVIATION", "UNVERIFIED", "DISABLED", "SKIPPED"].includes(status)) fail("STOP_REVIEW_STATUS_INVALID", "Invalid review status.");
        if (status === "PASS" && (progress.complete !== true || currentDeviations.length))
          fail("STOP_INCOMPLETE_PASS", "Only a complete review without deviations may establish overall PASS.");
        stop.reviewStatus = status; stop.progress = structuredClone(progress);
        stop.currentDeviations = structuredClone(currentDeviations); stop.assessmentFinishedAt = now();
        if (!currentDeviations.length) close(state, stop, status === "PASS" ? "REVIEW_PASSED"
          : status === "UNVERIFIED" ? progress.reasonCode ?? "STOP_REVIEW_INCOMPLETE" : "NO_CURRENT_DEVIATION");
        else stop.control = "WAIT_DELIVERY";
        event(state, "STOP_REVIEW_SETTLED", { stopId, status, progress, currentDeviationCount: currentDeviations.length });
        return stop;
      });
    },
    async reserveFeedback({ sessionId, stopId, packageId, basisCurrent, signal }) {
      identity(packageId, "packageId");
      if (typeof basisCurrent !== "function") throw new Error("Program-owned feedback validity check is required.");
      const captured = await transaction(sessionId, state => {
        const stop = stopFor(state, stopId);
        if (stop.admissionId) return { existing: admissionFor(state, stop.admissionId) };
        if (terminal(stop) || now() >= stop.deadlineAt) fail("STOP_ADMISSION_CLOSED", "The Stop delivery window has ended.");
        return { deviations: stop.currentDeviations ?? [], deadlineAt: stop.deadlineAt };
      });
      if (captured.existing) return captured.existing;
      const subset = checkedSubset(captured.deviations, await beforeStopDeadline(() => basisCurrent(structuredClone(captured.deviations)),
        { deadlineAt: captured.deadlineAt, signal, now, code: "STOP_FEEDBACK_WINDOW_CLOSED" }));
      return transaction(sessionId, state => {
        signal?.throwIfAborted();
        const stop = stopFor(state, stopId);
        if (stop.admissionId) return admissionFor(state, stop.admissionId);
        if (terminal(stop) || now() >= stop.deadlineAt) fail("STOP_ADMISSION_CLOSED", "The Stop delivery window has ended.");
        if (sha256(stop.currentDeviations ?? []) !== sha256(captured.deviations)) fail("STOP_FEEDBACK_CHANGED", "Feedback changed during validation; recheck the current package.");
        applySubset(stop, subset);
        if (!subset.length) {
          close(state, stop, "FEEDBACK_BASIS_CHANGED");
          return null;
        }
        const capacity = correctionCapacity(state, state.flows[stop.flowId], stop.config);
        if (capacity.reasonCode) { close(state, stop, capacity.reasonCode); return null; }
        const id = sha256([sessionId, stop.flowId, stopId, packageId]);
        const admission = state.admissions[id] = { id, flowId: stop.flowId, stopId, packageId,
          createdAt: now(), deadlineAt: stop.deadlineAt, accounting: "RESERVED", deliveryStatus: "PENDING", startStatus: "PENDING",
          feedbackRevision: stop.feedbackRevision ?? 0, currentDeviations: structuredClone(subset) };
        stop.admissionId = id; stop.deliveryStatus = "PENDING";
        event(state, "CONTINUATION_RESERVED", { admissionId: id, stopId, flowId: stop.flowId, capacity });
        return admission;
      });
    },
    async delivery({ sessionId, admissionId, status, cannotStart = false }) {
      return transaction(sessionId, state => {
        if (!["DELIVERED", "QUEUED", "REJECTED", "UNKNOWN"].includes(status)) fail("STOP_DELIVERY_STATUS_INVALID", "Invalid delivery state.");
        const admission = admissionFor(state, admissionId), stop = stopFor(state, admission.stopId);
        if (admission.invalidatedAt !== undefined) return admission;
        if (admission.deliveryStatus === status) return admission;
        if (admission.deliveryStatus === "DELIVERED" && ["QUEUED", "UNKNOWN"].includes(status)) return admission;
        admission.deliveryStatus = status; stop.deliveryStatus = status;
        event(state, "FEEDBACK_DELIVERY", { admissionId, status });
        if (admission.accounting === "USED") {
          if (status === "REJECTED") admission.deliveryConflict = "HOST_REJECTION_AFTER_OBSERVED_START";
          if (status === "DELIVERED" && stop.config.waitMode === "assessment") release(stop, "ASSESSMENT_DELIVERED");
          return admission;
        }
        if (status === "REJECTED") {
          invalidate(admission, "HOST_REJECTED", cannotStart); close(state, stop, "HOST_REJECTED");
        } else if (now() >= admission.deadlineAt) {
          invalidate(admission, "START_DEADLINE_EXPIRED", cannotStart); close(state, stop, "START_NOT_CONFIRMED");
        } else if (status === "DELIVERED" && stop.config.waitMode === "assessment") release(stop, "ASSESSMENT_DELIVERED");
        else if (!terminal(stop)) stop.control = "WAIT_START";
        return admission;
      });
    },
    async checkAdmission({ sessionId, admissionId, basisCurrent, signal }) {
      if (typeof basisCurrent !== "function") throw new Error("Program-owned feedback validity check is required.");
      const captured = await transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId), stop = stopFor(state, admission.stopId);
        if (admission.accounting !== "RESERVED" || admission.invalidatedAt !== undefined) return { denied: true, admission };
        return { deviations: stop.currentDeviations ?? [], deadlineAt: admission.deadlineAt };
      });
      if (captured.denied) return { allowed: false, admission: captured.admission };
      const expired = now() >= captured.deadlineAt;
      const subset = expired ? [] : checkedSubset(captured.deviations, await beforeStopDeadline(() => basisCurrent(structuredClone(captured.deviations)),
        { deadlineAt: captured.deadlineAt, signal, now, code: "STOP_FEEDBACK_WINDOW_CLOSED" }));
      return transaction(sessionId, state => {
        signal?.throwIfAborted();
        const admission = admissionFor(state, admissionId), stop = stopFor(state, admission.stopId);
        if (admission.accounting !== "RESERVED" || admission.invalidatedAt !== undefined || state.flows[stop.flowId].closedAt !== undefined)
          return { allowed: false, admission };
        if (sha256(stop.currentDeviations ?? []) !== sha256(captured.deviations)) return { allowed: false, admission, reasonCode: "STOP_FEEDBACK_CHANGED" };
        applySubset(stop, subset);
        admission.currentDeviations = structuredClone(subset); admission.feedbackRevision = stop.feedbackRevision ?? 0;
        if (!subset.length || now() >= admission.deadlineAt) {
          // The adapter calls this before entering the business executor: it can
          // prove this request has not started and cannot pass this guard later.
          invalidate(admission, expired || now() >= admission.deadlineAt ? "START_DEADLINE_EXPIRED" : "FEEDBACK_BASIS_CHANGED", true);
          close(state, stop, admission.invalidationReason);
          event(state, "CONTINUATION_ADMISSION_DENIED", { admissionId, reasonCode: admission.invalidationReason });
          return { allowed: false, admission };
        }
        return { allowed: true, admission, currentDeviations: subset, feedbackRevision: admission.feedbackRevision };
      });
    },
    async bindOriginalRequest({ sessionId, admissionId, request }) {
      identity(request?.runId, "runId");
      return transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId);
        if (admission.originalRequest) return admission;
        if (admission.hostRequest || admission.accounting !== "RESERVED" || admission.invalidatedAt !== undefined || now() >= admission.deadlineAt)
          fail("STOP_HOST_REQUEST_CLOSED", "The original-run revision opportunity is closed.");
        admission.originalRequest = { ...structuredClone(request), createdAt: now() };
        event(state, "ORIGINAL_REVISION_REQUESTED", { admissionId, runId: request.runId });
        return admission;
      });
    },
    async bindHostRequest({ sessionId, admissionId, request }) {
      identity(request?.runId, "runId");
      if (!request.message || !request.taskId || !request.sessionKey) fail("STOP_HOST_REQUEST_INVALID", "A continuation needs a bound host session, task and message.");
      return transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId);
        if (admission.hostRequest) return { created: false, request: admission.hostRequest };
        if (admission.accounting !== "RESERVED" || admission.invalidatedAt !== undefined || now() >= admission.deadlineAt)
          fail("STOP_HOST_REQUEST_CLOSED", "No new request may be created for a closed admission.");
        admission.hostRequest = { ...structuredClone(request), createdAt: now() };
        event(state, "HOST_REQUEST_BOUND", { admissionId, runId: request.runId });
        return { created: true, request: admission.hostRequest };
      });
    },
    async recordHostGate({ sessionId, admissionId, runId, feedbackRevision, messageHash }) {
      return transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId);
        if (admission.hostRequest?.runId !== runId || admission.accounting !== "RESERVED" || admission.invalidatedAt !== undefined
          || now() >= admission.deadlineAt || admission.feedbackRevision !== feedbackRevision)
          return { allowed: false };
        admission.hostRequest.gate = { at: now(), feedbackRevision, messageHash };
        return { allowed: true };
      });
    },
    async recordHostMessage({ sessionId, admissionId, recordId }) {
      identity(recordId, "recordId");
      return transaction(sessionId, state => {
        const request = admissionFor(state, admissionId).hostRequest;
        if (!request || request.sourceRecordId && request.sourceRecordId !== recordId) fail("STOP_HOST_MESSAGE_CONFLICT", "Host message identity conflicts with the owned continuation.");
        request.sourceRecordId ??= recordId;
        return request;
      });
    },
    async observeStart({ sessionId, admissionId, executionId, startedAt, observationId, protocolViolationReason }) {
      identity(executionId, "executionId"); identity(observationId, "observationId");
      if (!Number.isFinite(startedAt) || startedAt > now()) fail("STOP_START_EVIDENCE_INVALID", "A trustworthy actual start time is required.");
      return transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId), stop = stopFor(state, admission.stopId);
        if (admission.executionId && admission.executionId !== executionId)
          fail("STOP_START_IDENTITY_CONFLICT", "An admission can account for only one execution.");
        if (admission.accounting === "USED") {
          if (admission.startedAt !== startedAt) fail("STOP_START_EVIDENCE_CONFLICT", "Actual start time conflicts with the recorded fact.");
          return admission;
        }
        if (Object.values(state.admissions).some(other => other !== admission && other.executionId === executionId))
          fail("STOP_START_IDENTITY_CONFLICT", "This execution is already charged to another admission.");
        const valid = !protocolViolationReason && startedAt >= admission.createdAt && startedAt < admission.deadlineAt
          && (admission.invalidatedAt === undefined || startedAt < admission.invalidatedAt)
          && admission.accounting !== "RELEASED";
        const flow = state.flows[admission.flowId];
        admission.accounting = "USED"; admission.executionId = executionId; admission.startedAt = startedAt;
        admission.observedAt = now(); admission.observationId = observationId;
        admission.lateConfirmation = now() >= admission.deadlineAt || (terminal(stop) && stop.releaseReason !== "ASSESSMENT_DELIVERED");
        admission.startStatus = valid ? "STARTED" : "PROTOCOL_VIOLATION";
        if (protocolViolationReason) admission.protocolViolationReason = protocolViolationReason;
        state.used++; flow.used++;
        if (!valid) { admission.stopExecutionRequired = true; close(state, stop, "LATE_START_PROTOCOL_VIOLATION"); }
        else if (!terminal(stop) && now() < stop.deadlineAt) {
          if (stop.config.waitMode === "until_pass") stop.control = "WAIT_REPAIR";
          else if (stop.deliveryStatus === "DELIVERED") release(stop, "ASSESSMENT_DELIVERED");
        } else if (!terminal(stop)) close(state, stop, "START_CONFIRMATION_LATE");
        event(state, "CONTINUATION_STARTED", { admissionId, executionId, startedAt, valid,
          lateConfirmation: admission.lateConfirmation, sessionUsed: state.used, flowUsed: flow.used });
        return admission;
      });
    },
    async expireStop({ sessionId, stopId, reasonCode = "START_DEADLINE_EXPIRED", cannotStart = false, force = false, fault, scopeInvalidated = false }) {
      return transaction(sessionId, state => {
        const stop = stopFor(state, stopId);
        const admission = stop.admissionId && admissionFor(state, stop.admissionId);
        // A start observed on time has ended this Stop's admission clock.
        if (!force && (now() < stop.deadlineAt || stop.control === "WAIT_REPAIR")) return stop;
        if (admission) invalidate(admission, reasonCode, cannotStart);
        if (scopeInvalidated) {
          stop.invalidatedReview ??= { status: stop.reviewStatus, currentDeviations: stop.currentDeviations ?? [], at: now() };
          stop.reviewStatus = "UNVERIFIED"; stop.currentDeviations = [];
        }
        if (stop.reviewStatus === "PENDING") stop.reviewStatus = "UNVERIFIED";
        if (fault) stop.fault ??= structuredClone(fault);
        close(state, stop, reasonCode);
        event(state, "STOP_RELEASED", { stopId, reasonCode, accounting: admission?.accounting ?? null });
        return stop;
      });
    },
    async confirmNotStarted({ sessionId, admissionId, evidence }) {
      if (!evidence) fail("STOP_CANCEL_EVIDENCE_REQUIRED", "Cancellation must prove no start occurred and no late start remains possible.");
      return transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId);
        if (admission.accounting === "USED") return admission;
        invalidate(admission, "HOST_CONFIRMED_NOT_STARTED", true);
        admission.cancellationEvidence ??= structuredClone(evidence);
        close(state, stopFor(state, admission.stopId), "HOST_CONFIRMED_NOT_STARTED");
        return admission;
      });
    },
    async finishRepairReview({ sessionId, admissionId, status, evaluationId }) {
      identity(evaluationId, "evaluationId");
      return transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId);
        if (admission.accounting !== "USED" || !["PASS", "DEVIATION", "UNVERIFIED"].includes(status))
          fail("STOP_FINAL_REVIEW_INVALID", "Only an executed repair may complete its final review.");
        admission.finalReview = { status, evaluationId, at: now() };
        close(state, stopFor(state, admission.stopId), status === "PASS" ? "FINAL_REVIEW_PASSED" : "CORRECTION_BUDGET_EXHAUSTED");
        event(state, "FINAL_REPAIR_REVIEW", { admissionId, status, evaluationId });
        return admission;
      });
    },
    async observeEnd({ sessionId, admissionId, executionId, endedAt }) {
      identity(executionId, "executionId");
      return transaction(sessionId, state => {
        const admission = admissionFor(state, admissionId);
        if (admission.accounting !== "USED" || admission.executionId !== executionId || !Number.isFinite(endedAt) || endedAt < admission.startedAt || endedAt > now())
          fail("STOP_END_EVIDENCE_INVALID", "End evidence must belong to the recorded execution.");
        admission.endedAt ??= endedAt; admission.endObservedAt ??= now();
        return admission;
      });
    },
  };
}
