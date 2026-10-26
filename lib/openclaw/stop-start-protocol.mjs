import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createStopCorrectionStore } from "../runtime-v2/stop-correction-store.mjs";
import { createStopReviewStore } from "../runtime-v2/stop-review-store.mjs";
import { beforeStopDeadline, scheduleStopDeadline } from "../runtime-v2/stop-deadline.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";
import { boundHostFeedback } from "../runtime-v2/feedback-delivery.mjs";
import { stopFeedbackCurrent } from "../runtime-v2/production-stop.mjs";

// MatrixAssistant's native runtime provides the public fail-closed input gate,
// trusted timestamped diagnostics, and run-specific Gateway cancellation.
// Unknown hosts keep review-only behavior instead of guessing a start fact.
export async function loadStopStartCompatibility({ packageFile } = {}) {
  if (!packageFile) {
    try { packageFile = createRequire(import.meta.url).resolve("openclaw/package.json"); }
    catch { packageFile = path.join(path.dirname(await fs.realpath(process.argv[1])), "package.json"); }
  }
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (pkg.name !== "openclaw" || pkg.version !== "2026.7.1-2") throw new Error("This Stop start adapter is verified only for MatrixAssistant's OpenClaw 2026.7.1-2.");
  const dist = path.join(path.dirname(packageFile), "dist");
  const diagnostics = await import(pathToFileURL(path.join(dist, "plugin-sdk/diagnostic-runtime.js")));
  if (typeof diagnostics.onInternalDiagnosticEvent !== "function" || typeof diagnostics.waitForDiagnosticEventsDrained !== "function")
    throw new Error("Trusted native start diagnostics unavailable.");
  return { version: 1, onStart: diagnostics.onInternalDiagnosticEvent,
    drain: diagnostics.waitForDiagnosticEventsDrained,
    diagnosticsEnabled: config => diagnostics.isDiagnosticsEnabled(config) };
}

const textOf = record => {
  const value = (record.message ?? record).content;
  return typeof value === "string" ? value : (value ?? []).filter(block => block.type === "text").map(block => block.text).join("");
};

export function createStopStartProtocol(api, { directoryFor, isCurrent, onReserved, onStarted, onModelCall,
  onReleased, compatibility = loadStopStartCompatibility } = {}) {
  let loading, sdk, unsubscribe, closed = false;
  const timers = new Map(), observationWork = new Set(), observationQueues = new Map(), deliveryWaiters = new Map();
  const knownRuns = new Set(), issuedOriginals = new Set();
  let lastSequence = 0;
  const runKey = (state, runId) => JSON.stringify([state.sessionKey, runId]);
  const released = async (state, reason, admission) => {
    deliveryWaiters.get(admission.id)?.();
    await onReleased?.({ ...state, stopId: admission.stopId, flowId: admission.flowId }, reason);
  };
  const storeFor = state => {
    const directory = directoryFor(state);
    return directory ? createStopCorrectionStore({ directory }) : null;
  };
  const runIn = (ledger, runId, state) => runId && Object.values(ledger?.admissions ?? {}).find(admission =>
    admission.hostRequest?.runId === runId && admission.hostRequest.sessionKey === state.sessionKey);
  const receipt = admission => admission && ({ ...(admission.hostRequest ?? admission.originalRequest), admissionId: admission.id,
    stopId: admission.stopId, flowId: admission.flowId, modelObservedAt: admission.startedAt,
    finishedAt: admission.endedAt, status: admission.invalidatedAt !== undefined ? "CANCELLED"
      : admission.accounting === "USED" ? "STARTED" : admission.deliveryStatus === "QUEUED" ? "ADMITTED" : admission.deliveryStatus,
    admission });
  const logError = error => { try { api.logger.warn(`[runtime-corrector] Stop start protocol: ${error.code ?? error.message}`); } catch {} };
  const ready = async () => {
    if (closed) return false;
    if (typeof api.runtime.gateway?.request !== "function" || typeof api.runtime.subagent?.run !== "function") return false;
    try {
      await (loading ??= Promise.resolve().then(() => compatibility()).then(value => {
        if (closed) throw new Error("The native start observer was disposed while loading.");
        if (value?.version !== 1 || typeof value.onStart !== "function" || typeof value.drain !== "function") throw new Error("Incomplete start capabilities.");
        sdk = value;
        unsubscribe = sdk.onStart((event, metadata) => {
          if (event.type !== "model.call.started" || metadata?.trusted !== true || !event.runId || !event.sessionId
            || !event.sessionKey || !Number.isFinite(event.ts) || !Number.isSafeInteger(event.seq)) return;
          lastSequence = Math.max(lastSequence, event.seq);
          onModelCall?.(event);
          const key = JSON.stringify([event.sessionId, event.runId]);
          const work = (observationQueues.get(key) ?? Promise.resolve()).then(() => observeStart(event)).catch(logError);
          observationQueues.set(key, work);
          void work.finally(() => { if (observationQueues.get(key) === work) observationQueues.delete(key); });
          observationWork.add(work); void work.finally(() => observationWork.delete(work));
        });
      }));
      return !closed && sdk.diagnosticsEnabled?.(api.runtime.config?.current?.() ?? api.config) !== false;
    } catch { return false; }
  };
  async function owned(state, runId) {
    const store = storeFor(state);
    return store && runIn(await store.inspect(state.sessionId), runId, state);
  }
  async function stopOwned(state, admission) {
    // Always provide the exact plugin-created runId. Never abort by session
    // alone, which could terminate a later independent user run.
    return api.runtime.gateway.request("chat.abort", { sessionKey: admission.hostRequest.sessionKey,
      runId: admission.hostRequest.runId, preserveSideRuns: true }, { timeoutMs: 5000 });
  }
  function arm(state, admission) {
    if (timers.has(admission.id) || admission.accounting === "USED" || admission.invalidatedAt !== undefined) return;
    timers.set(admission.id, scheduleStopDeadline(() => {
      timers.delete(admission.id);
      void (async () => {
        const store = storeFor(state);
        const current = (await store.inspect(state.sessionId)).admissions[admission.id];
        if (current.accounting === "USED" && current.startStatus === "STARTED" && !current.lateConfirmation) return;
        await store.expireStop({ sessionId: state.sessionId, stopId: admission.stopId });
        await released(state, "START_NOT_CONFIRMED", admission);
        // An approved gate with no persisted start is uncertain: delayed
        // diagnostics may still prove a timely actual start. Fence further
        // entry, retain its slot, and avoid killing that possible active repair.
        // A pre-gate queued request can be revoked by its exact runId.
        if (current.hostRequest && !current.hostRequest.gate) await stopOwned(state, current);
      })().catch(logError);
    }, admission.deadlineAt));
  }
  async function drain() {
    await sdk?.drain();
    await Promise.all([...observationWork]);
  }
  async function observeStart(event) {
    const state = { sessionId: event.sessionId, sessionKey: event.sessionKey, agentId: event.agentId ?? "main" };
    const store = storeFor(state), ledger = store && await store.inspect(state.sessionId);
    const admission = runIn(ledger, event.runId, state) ?? Object.values(ledger?.admissions ?? {}).find(value =>
      !value.hostRequest && value.accounting === "RESERVED" && value.originalRequest?.runId === event.runId
      && issuedOriginals.has(value.id)
      && value.originalRequest.sessionKey === event.sessionKey && event.seq > value.originalRequest.afterSequence
      && event.ts >= value.originalRequest.createdAt);
    if (!admission || admission.accounting === "USED") return;
    const original = !admission.hostRequest, gate = admission.hostRequest?.gate;
    const recorded = await store.observeStart({ sessionId: state.sessionId, admissionId: admission.id,
      executionId: original ? `original:${event.runId}:${event.callId ?? event.seq}` : event.runId,
      observationId: `openclaw-model-start:${event.seq}:${event.callId ?? event.runId}`, startedAt: event.ts,
      ...(!original && (!gate || gate.at > event.ts) ? { protocolViolationReason: "HOST_BYPASSED_START_GATE" } : {}) });
    timers.get(admission.id)?.(); timers.delete(admission.id);
    if (recorded.stopExecutionRequired) {
      await released(state, "LATE_START_PROTOCOL_VIOLATION", admission);
      if (!original) await stopOwned(state, recorded);
    } else if (!recorded.lateConfirmation) await onStarted?.(state, { ...receipt(recorded), original });
  }
  const check = async (state, admission, signal) => {
    const store = storeFor(state);
    return store.checkAdmission({ sessionId: state.sessionId, admissionId: admission.id, signal,
      basisCurrent: async deviations => await isCurrent(state, admission.hostRequest ?? admission.originalRequest)
        ? stopFeedbackCurrent({ directory: directoryFor(state), sessionId: state.sessionId,
          projectRoot: (admission.hostRequest ?? admission.originalRequest).projectRoot,
          taskId: (admission.hostRequest ?? admission.originalRequest).taskId, deviations }) : [] });
  };
  const render = deviations => boundHostFeedback(deviations.map(item =>
    `${item.objectId} (${item.revisionId}): ${item.result.reason}\n${item.result.evidence.join("\n")}`).join("\n\n"), {
    prefix: "[runtime-corrector:stop-feedback]\n以下仅为当前有效偏差，不新增用户需求或授权。请对照原始需求和当前实现核实并修复；如反馈不成立，请说明依据。处理须遵守现有约束及宿主工具和审批要求，修正后重新完成验收。",
  });
  return {
    ready, drain, knowsRun: (state, runId) => knownRuns.has(runKey(state, runId)),
    confirmOriginal: admissionId => issuedOriginals.add(admissionId), get closed() { return closed; },
    async recover(state) {
      const store = storeFor(state), ledger = store && await store.inspect(state.sessionId);
      for (const stop of Object.values(ledger?.stops ?? {})) {
        if (stop.scope !== path.resolve(state.projectRoot ?? "")) continue;
        let ownerLost = false;
        if (Number.isSafeInteger(stop.owner?.pid) && stop.owner.pid > 0 && stop.owner.pid !== process.pid) {
          try { process.kill(stop.owner.pid, 0); } catch (error) { ownerLost = error.code === "ESRCH"; }
        }
        const admission = stop.admissionId && ledger.admissions[stop.admissionId];
        if (ownerLost && admission?.accounting === "RESERVED" && !admission.hostRequest && !admission.originalRequest) {
          await store.confirmNotStarted({ sessionId: state.sessionId, admissionId: admission.id,
            evidence: { kind: "OWNER_LOST_BEFORE_HOST_REQUEST", pid: stop.owner.pid } });
          await released(state, "STOP_REVIEW_OWNER_LOST", admission);
        } else if (stop.releasedAt !== undefined) continue;
        else if (!admission && ownerLost && stop.reviewStatus === "PENDING") {
          await store.expireStop({ sessionId: state.sessionId, stopId: stop.id, force: true,
            scopeInvalidated: true, reasonCode: "STOP_REVIEW_OWNER_LOST" });
          await onReleased?.({ ...state, stopId: stop.id, flowId: stop.flowId }, "STOP_REVIEW_OWNER_LOST");
          if (stop.reviewScopeId) {
            const review = createStopReviewStore({ directory: directoryFor(state), sessionId: state.sessionId, scopeId: stop.reviewScopeId,
              validateResult() { throw new Error("Recovery cannot submit a model result."); },
              dependenciesCurrent() { throw new Error("Cancelled recovery cannot rerun validation."); } });
            const scope = await review.inspect();
            if (scope?.activeRoundId === stop.id) await review.finishRound({ roundId: stop.id, reasonCode: "CANCELLED_OR_STALE" });
          }
        } else if (!admission) {
          const key = `review:${state.sessionId}:${stop.id}`;
          if (!timers.has(key)) timers.set(key, scheduleStopDeadline(() => {
            timers.delete(key);
            void store.expireStop({ sessionId: state.sessionId, stopId: stop.id, reasonCode: "STOP_RECOVERED_REVIEW_DEADLINE" })
              .then(ended => ended.releasedAt !== undefined && onReleased?.({ ...state, stopId: stop.id, flowId: stop.flowId }, ended.releaseReason)).catch(logError);
          }, stop.deadlineAt));
        }
      }
      for (const admission of Object.values(ledger?.admissions ?? {})) if (admission.hostRequest) {
        knownRuns.add(runKey(state, admission.hostRequest.runId)); arm(state, admission);
      }
    },
    async findRun({ state, runId }) { return receipt(await owned(state, runId)); },
    async offerOriginal({ state, outcome, source, isOpen }) {
      if (!outcome.admission || !await ready() || !isOpen()) return;
      const store = storeFor(state);
      const admission = await store.bindOriginalRequest({ sessionId: state.sessionId, admissionId: outcome.admission.id,
        request: { runId: source.runId, sessionKey: state.sessionKey, projectRoot: state.projectRoot,
          agentId: state.agentId, taskId: outcome.taskId, source, afterSequence: lastSequence } });
      const checked = await check(state, admission);
      if (!checked.allowed || !isOpen()) return;
      await store.delivery({ sessionId: state.sessionId, admissionId: admission.id, status: "DELIVERED" });
      if (!isOpen()) return;
      arm(state, admission);
      return { action: "revise", reason: render(checked.currentDeviations), admissionId: admission.id };
    },
    async submit({ state, outcome, source }) {
      if (!outcome.admission || !await ready()) return { status: "INELIGIBLE" };
      // A declined original revision and the fallback share one reservation.
      // Drain trusted starts before binding another transport to that attempt.
      await drain();
      const store = storeFor(state), admission = outcome.admission;
      const current = (await store.inspect(state.sessionId)).admissions[admission.id];
      if (current?.accounting === "USED") return { ...receipt(current), original: !current.hostRequest };
      const request = { runId: `rc-stop-${admission.id}`, taskId: outcome.taskId, sessionKey: state.sessionKey,
        projectRoot: state.projectRoot, agentId: state.agentId, assessmentId: outcome.stopCorrection.evaluationId, source,
        message: `[runtime-corrector:stop-reference]\n插件已为原任务准备纠偏反馈，启动前由插件核对并附上当前有效内容。这是运行反馈，不是新的用户需求或授权。\n准入 ${admission.id}` };
      const bound = await store.bindHostRequest({ sessionId: state.sessionId, admissionId: admission.id, request });
      knownRuns.add(runKey(state, request.runId));
      if (!bound.created) return receipt((await store.inspect(state.sessionId)).admissions[admission.id]);
      let delivered;
      const deliveryDone = new Promise(resolve => { delivered = resolve; });
      deliveryWaiters.set(admission.id, delivered);
      arm(state, admission);
      await onReserved?.(state, receipt({ ...admission, hostRequest: bound.request }));
      let response;
      try {
        const checked = await check(state, { ...admission, hostRequest: bound.request });
        if (!checked.allowed) { await released(state, "ADMISSION_DENIED", admission); return receipt(checked.admission); }
        response = await beforeStopDeadline(() => api.runtime.subagent.run({ sessionKey: state.sessionKey,
          message: request.message, idempotencyKey: request.runId, deliver: false }), {
          deadlineAt: admission.deadlineAt, code: "STOP_HOST_START_DEADLINE" });
        const rejected = ["denied", "rejected", "blocked", "error"].includes(response?.status);
        await store.delivery({ sessionId: state.sessionId, admissionId: admission.id,
          status: rejected ? "REJECTED" : response?.runId === request.runId ? "QUEUED" : "UNKNOWN", cannotStart: rejected });
        if (rejected) await released(state, "HOST_REJECTED", admission);
        else if (outcome.stopCorrection.waitMode === "assessment") await beforeStopDeadline(() => deliveryDone,
          { deadlineAt: admission.deadlineAt, code: "STOP_HOST_DELIVERY_DEADLINE" });
      } catch {
        // An uncertain or timed-out RPC is never automatically retried. Its
        // reserved slot remains until a trusted start/cancellation settles it.
        await store.delivery({ sessionId: state.sessionId, admissionId: admission.id, status: "UNKNOWN" });
      } finally { deliveryWaiters.delete(admission.id); }
      return receipt((await store.inspect(state.sessionId)).admissions[admission.id]);
    },
    async prepare({ state, runId, signal }) {
      const admission = await owned(state, runId);
      if (!admission) return null;
      if (!await ready()) return { owned: true, blocked: true };
      if (admission.accounting === "USED") return { owned: true };
      const checked = await check(state, admission, signal);
      if (!checked.allowed) { await released(state, "ADMISSION_DENIED", admission); return { owned: true, blocked: true }; }
      const text = render(checked.currentDeviations);
      const store = storeFor(state);
      await store.delivery({ sessionId: state.sessionId, admissionId: admission.id, status: "DELIVERED" });
      deliveryWaiters.get(admission.id)?.();
      return { owned: true, prependContext: text };
    },
    async gate({ state, runId, event, signal }) {
      const admission = await owned(state, runId);
      if (!admission) return;
      const deny = { outcome: "block", reason: "RC_STOP_ADMISSION_CLOSED", message: "当前自动纠偏启动准入已失效，本次没有新增用户授权。" };
      if (!await ready()) return deny;
      if (admission.accounting === "USED") return admission.invalidatedAt === undefined ? { outcome: "pass" } : deny;
      try {
        const checked = await check(state, admission, signal);
        if (!checked.allowed) { await released(state, "ADMISSION_DENIED", admission); return deny; }
        const text = render(checked.currentDeviations);
        // The model must receive exactly this checked subset. A queue request
        // contains only an opaque reference, so removed counterevidence cannot
        // leak from an older feedback string into its user message.
        if (![event.prompt ?? "", event.systemPrompt ?? "", ...(event.messages ?? []).map(textOf)].some(value => value.includes(text))) {
          await storeFor(state).expireStop({ sessionId: state.sessionId, stopId: admission.stopId, force: true,
            cannotStart: !admission.hostRequest.gate, reasonCode: "FEEDBACK_CHANGED_AFTER_DELIVERY" });
          await released(state, "FEEDBACK_CHANGED_AFTER_DELIVERY", admission);
          return deny;
        }
        const gate = await storeFor(state).recordHostGate({ sessionId: state.sessionId, admissionId: admission.id,
          runId, feedbackRevision: checked.feedbackRevision, messageHash: sha256(text) });
        return gate.allowed ? { outcome: "pass" } : deny;
      } catch { return deny; }
    },
    async project({ state, records }) {
      const store = storeFor(state), ledger = store && await store.inspect(state.sessionId);
      const own = new Set();
      for (const admission of Object.values(ledger?.admissions ?? {})) {
        const request = admission.hostRequest;
        if (!request || request.sessionKey !== state.sessionKey) continue;
        const boundary = records.findIndex(record => record.id === request.source.leafId);
        if (boundary < 0) continue;
        const next = records.slice(boundary + 1).find(record => {
          const message = record.message ?? record;
          const key = message.idempotencyKey ?? message.runId ?? record.runId;
          return message.role === "user" && sha256(textOf(record)) === sha256(request.message)
            && (request.sourceRecordId === record.id || key === request.runId || state.nativeRunId === request.runId);
        });
        const key = next && ((next.message ?? next).idempotencyKey ?? (next.message ?? next).runId ?? next.runId);
        if (next && sha256(textOf(next)) === sha256(request.message)
          && (request.sourceRecordId === next.id || key === request.runId || state.nativeRunId === request.runId)) {
          if (!request.sourceRecordId) await store.recordHostMessage({ sessionId: state.sessionId, admissionId: admission.id, recordId: next.id });
          own.add(next.id);
        }
      }
      return records.map(record => own.has(record.id) ? { ...record, isMeta: true } : record);
    },
    async finish({ state, runId }) {
      await drain();
      const store = storeFor(state), ledger = store && await store.inspect(state.sessionId);
      for (const admission of Object.values(ledger?.admissions ?? {})) {
        if (admission.accounting !== "USED" || admission.endedAt !== undefined
          || (admission.hostRequest ?? admission.originalRequest)?.runId !== runId) continue;
        await store.observeEnd({ sessionId: state.sessionId, admissionId: admission.id,
          executionId: admission.executionId, endedAt: Date.now() });
      }
    },
    async cancel({ state, reason = "RC_STOP_CANCELLED", stopId }) {
      const store = storeFor(state), ledger = store && await store.inspect(state.sessionId);
      for (const admission of Object.values(ledger?.admissions ?? {})) {
        if (stopId && admission.stopId !== stopId || !admission.hostRequest || admission.hostRequest.projectRoot !== state.projectRoot || admission.endedAt !== undefined) continue;
        await store.expireStop({ sessionId: state.sessionId, stopId: admission.stopId, force: true, scopeInvalidated: true, reasonCode: reason });
        timers.get(admission.id)?.(); timers.delete(admission.id);
        await stopOwned(state, admission).catch(logError);
      }
      for (const admission of Object.values(ledger?.admissions ?? {})) if ((!stopId || admission.stopId === stopId) && admission.hostRequest?.projectRoot === state.projectRoot)
        deliveryWaiters.get(admission.id)?.();
      await onReleased?.({ ...state, ...(stopId ? { stopId } : {}) }, reason);
    },
    async dispose() { closed = true; for (const cancel of timers.values()) cancel(); timers.clear(); unsubscribe?.(); await drain(); },
  };
}
