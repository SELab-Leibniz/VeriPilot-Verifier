import { privateJson, controllerDirectory } from "./controller-store.mjs";
import { reconcileDelivery } from "./delivery.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson } from "../runtime-v2/utils.mjs";
import { withTaskState, findTask, decisionGuard, authorizeCorrection, withTaskResourceLock } from "../runtime-v2/task-store.mjs";
import { isInternalExecution, isManagedExecution } from "./internal-context.mjs";
import { bindingPath, authenticatedActor, receiveCommand, updateReceipt, readReceipt, interactionSnapshot } from "./interaction-store.mjs";
import { createEvidenceLedger, matchesEvidence, evidencePath } from "./evidence.mjs";
import { readReport } from "./report.mjs";
import { unsettledNativeRuns } from "./native-runs.mjs";

export const CONTROL_ACTIONS = ["stop", "update-requirements", "reverify", "continue-correction"];
export function createControlService(api, runtime, sharedState, { resolveBinding, currentSession } = {}) {
  const jobs = sharedState.controlJobs ??= new Map();
  const continuations = sharedState.authorizedContinuations ??= new Map();
  const config = () => api.runtime?.config?.current?.() ?? api.config;
  const enabled = () => config()?.plugins?.entries?.[api.id]?.enabled !== false
    && (config()?.plugins?.entries?.[api.id]?.config ?? api.pluginConfig)?.enabled !== false;
  async function bindingFor(sessionKey) {
    if (typeof sessionKey !== "string" || sessionKey.length > 500) throw new Error("A native sessionKey is required.");
    if (resolveBinding) return resolveBinding(sessionKey);
    const match = /^agent:([a-zA-Z0-9_-]+):/u.exec(sessionKey);
    if (!match || /:rc-worker:|:runtime-corrector:/u.test(sessionKey)) throw new Error("Unsupported session target.");
    const root = api.runtime.agent.resolveAgentWorkspaceDir(config(), match[1]);
    const binding = await readJson(bindingPath(root, sessionKey));
    if (!binding || binding.sessionKey !== sessionKey || binding.agentId !== match[1] || path.resolve(binding.workspaceDir) !== path.resolve(root)) {
      throw new Error("No trusted Runtime Corrector binding for this native session; submit a task first.");
    }
    if (currentSession) {
      const native = await currentSession(config(), match[1], sessionKey);
      if (!native || native.sessionId !== binding.sessionId) throw new Error("Native session was reset or replaced; submit a task to establish its new binding.");
    }
    return binding;
  }
  function controllerFor(binding) {
    return [...(sharedState.controllers?.values() ?? [])].find((item) => item.sessionId === binding.sessionId && item.sessionKey === binding.sessionKey);
  }
  async function processCommand(binding, receipt) {
    const controller = controllerFor(binding);
    if (receipt.action === "stop") {
      const stopping = [...jobs.values()].filter((job) => job.taskId === receipt.taskId);
      for (const job of stopping) job.abort.abort(new Error("User cancelled."));
      await controller?.abort();
      if (controller || stopping.length) {
        await updateReceipt(binding, receipt, { status: "STOPPING" });
        await Promise.all([controller?.promise, ...stopping.map((job) => job.settled)]);
      }
      const snapshot = await interactionSnapshot(binding);
      if ((!controller && snapshot.task?.control?.ownerActive) || (await unsettledNativeRuns(binding.workspaceDir, receipt.taskId)).length) return updateReceipt(binding, receipt,
        { status: "STOP_REQUESTED_UNCONFIRMED", reason: "PREVIOUS_NATIVE_RUN_NOT_CONFIRMED", filesPreserved: true });
      await withTaskState({ projectRoot: binding.workspaceDir, taskId: receipt.taskId }, (state) => {
        if (state.control.cancelEpoch === receipt.guard.cancelEpoch) state.status = "STOPPED";
      });
      return updateReceipt(binding, receipt, { status: "STOPPED", filesPreserved: true });
    }
    if (!enabled()) return updateReceipt(binding, receipt, { status: "REJECTED", reason: "PLUGIN_DISABLED" });
    if (["reverify", "continue-correction"].includes(receipt.action) && controller) {
      return updateReceipt(binding, receipt, { status: "REJECTED", reason: "ACTIVE_RUN_STOP_OR_WAIT_FIRST" });
    }
    const signal = new AbortController();
    const job = { abort: signal, taskId: receipt.taskId, binding };
    job.settled = new Promise((resolve) => { job.resolve = resolve; });
    jobs.set(receipt.key, job);
    let timer, disabledWatch, ownedGeneration, progressWrites = Promise.resolve();
    try {
      return await withTaskResourceLock({ projectRoot: binding.workspaceDir, taskId: receipt.taskId,
        resource: "manual-control", timeoutMs: 1000, reclaimDeadOwner: true }, async () => {
        const windowMs = await runtime.effectiveReviewTimeout(binding);
        if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("Invalid verification time limit.");
        const deadlineAt = Date.now() + windowMs;
        const windowId = randomUUID();
        timer = setTimeout(() => signal.abort(new Error("Manual verification window exhausted.")), windowMs);
        disabledWatch = setInterval(() => { if (!enabled()) signal.abort(new Error("Plugin disabled.")); }, 250);
        await updateReceipt(binding, receipt, { status: "STARTED", windowId, startedAt: Date.now(), deadlineAt,
          mode: receipt.action === "reverify" ? "verify_only" : receipt.action });
        const state = await runtime.restoreBinding(binding);
        const progressFile = path.join(controllerDirectory(binding.workspaceDir, binding.sessionId), "manual-progress.json");
        const saveProgress = (event) => {
          progressWrites = progressWrites.then(async () => {
            if (jobs.get(receipt.key) !== job || signal.signal.aborted) return;
            await privateJson(progressFile, { ...event, windowId, commandKey: receipt.key, sequence: job.sequence = (job.sequence ?? 0) + 1 });
          });
          return progressWrites;
        };
        job.previousCallbacks = { onProgress: state.onProgress, onReviewRunStart: state.onReviewRunStart, onReviewRunEnd: state.onReviewRunEnd, observeReviewTool: state.observeReviewTool, onReviewTool: state.onReviewTool };
        if (!controller) {
        const reviewRuns = new Set();
        state.onProgress = saveProgress;
        state.onReviewRunStart = (id, metadata = {}) => { reviewRuns.add(id); return saveProgress({ phase: "REVIEWING", nativeRunId: id,
          role: metadata.role, attemptPhase: metadata.attemptPhase, startedAt: metadata.startedAt ?? Date.now() }); };
        state.onReviewRunEnd = (id) => reviewRuns.delete(id);
        state.onReviewTool = ({ runId, role, name, args }) => {
          if (!reviewRuns.has(runId) || String(name).toLowerCase() !== "read") return;
          const file = evidencePath(binding.workspaceDir, args?.path ?? args?.file_path);
          if (file) return saveProgress({ phase: "REVIEWING", file, role, nativeRunId: runId, startedAt: Date.now() });
        };
        }
        job.state = state;
        await saveProgress({ phase: receipt.action === "reverify" ? "ASSESSING" : "UPDATING_REQUIREMENTS", startedAt: Date.now() });
        if (receipt.action === "update-requirements") {
          // Invalidate in-flight results before waiting for baseline extraction.
          controller?.invalidateAssessment?.();
          const outcome = await runtime.commitRequirement(state, receipt.text, receipt, signal.signal, deadlineAt);
          if (!outcome.baselineCommitted || outcome.stale) return updateReceipt(binding, receipt, { status: "PENDING_BASELINE", reason: outcome.reason ?? "UNVERIFIED" });
          await updateReceipt(binding, receipt, { status: "BASELINE_COMMITTED", requirementVersion: outcome.requirementVersion });
          if (controller?.deliverRequirement) {
            const delivery = await controller.deliverRequirement(receipt.text, receipt);
            return updateReceipt(binding, receipt, { status: "APPLIED_TO_WORKER", delivery });
          }
          return updateReceipt(binding, receipt, { status: "BASELINE_COMMITTED", workerDelivery: "NO_ACTIVE_WORKER" });
        }
        const { task } = await interactionSnapshot(binding);
        if (receipt.action === "reverify") {
          const generation = ownedGeneration = randomUUID();
          await withTaskState({ projectRoot: binding.workspaceDir, taskId: receipt.taskId }, (current) => {
            const guard = decisionGuard(current);
            if (Object.entries(receipt.guard).some(([key, value]) => guard[key] !== value)) throw new Error("Reverify command was superseded before start.");
            signal.signal.throwIfAborted();
            current.control = { ...current.control, generation, cancelled: false, ownerActive: false, activeWindow: windowId };
            current.verification = { ...current.verification, status: "RUNNING" };
          });
          const updated = await findTask({ projectRoot: binding.workspaceDir, sessionId: binding.sessionId });
          const ledger = createEvidenceLedger(binding.workspaceDir);
          await ledger.capture(new Set([...(task.verification?.evidence?.files ?? []), ...(runtime.evidenceFiles ? await runtime.evidenceFiles(state) : state.observedPaths ?? [])]));
          state.observeReviewTool = ledger.observeTool;
          const outcome = await runtime.assessSupervised(state, { text: "请仅验收当前成果，不修改文件。", assessmentId: receipt.key,
            mode: "verify_only", stopHookActive: true, abortSignal: signal.signal, deadlineAt,
            assessmentContext: { guard: decisionGuard(updated), isEnabled: enabled, evidence: ledger.snapshot, evidenceMatches: ledger.matches } });
          return updateReceipt(binding, receipt, { status: outcome.stale ? "STALE" : "ASSESSED", outcome,
            report: (await readReport(binding)).text });
        }
        if (Object.entries(receipt.guard).some(([key, value]) => decisionGuard(task)[key] !== value)) throw new Error("Correction authorization was superseded.");
        const runId = randomUUID();
        job.nativeRunId = runId;
        const intent = await authorizeCorrection({ projectRoot: binding.workspaceDir, taskId: receipt.taskId,
          intentId: receipt.key, context: { guard: decisionGuard(task), abortSignal: signal.signal, isEnabled: enabled,
            evidenceMatches: () => matchesEvidence(task.verification?.evidence) } });
        // Persist first; recovery will inspect this intent and never replay it.
        await updateReceipt(binding, receipt, { status: "DISPATCH_COMMITTED", nativeRunId: runId, correctionAttempt: intent.correctionAttempt });
        continuations.set(runId, { binding, intent, receipt });
        clearTimeout(timer); timer = null;
        const outcome = await api.runtime.agent.runEmbeddedAgent({ ...binding, cwd: binding.workspaceDir,
          config: config(), model: binding.modelId, runId, prompt: intent.feedback,
          inputProvenance: { kind: "external_user" }, agentHarnessRuntimeOverride: "runtime-corrector-supervised",
          timeoutMs: binding.timeoutMs ?? 600000, abortSignal: signal.signal,
          lane: `runtime-corrector-control:${binding.sessionId}` });
        continuations.delete(runId);
        return updateReceipt(binding, receipt, { status: "SETTLED", runError: outcome.meta?.error?.kind ?? null,
          report: (await readReport(binding)).text });
      });
    } catch (error) {
      const status = signal.signal.aborted ? "UNVERIFIED" : "FAILED";
      return updateReceipt(binding, receipt, { status, reason: signal.signal.aborted ? "CANCELLED_OR_DEADLINE" : String(error.message).slice(0, 500) });
    } finally {
      clearTimeout(timer); clearInterval(disabledWatch); jobs.delete(receipt.key);
      if (job.nativeRunId) continuations.delete(job.nativeRunId);
      if (job.state && !controller) Object.assign(job.state, job.previousCallbacks);
      await progressWrites.catch(() => {});
      try { if (ownedGeneration) await withTaskState({ projectRoot: binding.workspaceDir, taskId: receipt.taskId }, (state) => {
        if (state.control?.generation !== ownedGeneration) return;
        state.control.activeWindow = null;
        if (state.verification?.status === "RUNNING") state.verification = { ...state.verification, status: "UNVERIFIED", reason: "MANUAL_WINDOW_ENDED_WITHOUT_VALID_COMMIT" };
      }); } finally { job.resolve(); }
    }
  }
  async function handle(method, params, client) {
    if (isInternalExecution() || isManagedExecution()) throw new Error("Internal execution cannot invoke user controls.");
    const actor = authenticatedActor(client, method === "control");
    if (!params || Object.keys(params).some((key) => !["sessionKey", "commandId", "actionId", "action", "text", "expected", "deliveryId"].includes(key))) throw new Error("Unsupported parameters; workspace and actor are resolved by the host.");
    const binding = await bindingFor(params.sessionKey);
    if (method === "status" || method === "feedback") return readReport(binding);
    if (method === "receipt") return params.deliveryId ? reconcileDelivery(binding, params.deliveryId) : readReceipt(binding, actor, params);
    if (method !== "control" || !CONTROL_ACTIONS.includes(params.action)) throw new Error("Unsupported control action.");
    if (params.action === "update-requirements" && (typeof params.text !== "string" || !params.text.trim() || params.text.length > 64000)) throw new Error("A non-empty requirement up to 64000 characters is required.");
    const accepted = await receiveCommand(binding, actor, params);
    if (!accepted.duplicate) {
      // Delivery acknowledgement is the persisted command receipt, independent
      // of the model queue. Background work never invents a new retry command.
      void processCommand(binding, accepted.receipt).catch(() => updateReceipt(binding, accepted.receipt, { status: "FAILED", reason: "CONTROL_PROCESSING_FAILED" })).catch(() => {});
    }
    return accepted.receipt;
  }
  return { handle, bindingFor, processCommand };
}
