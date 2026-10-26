import { matchPathTemplates } from "../path-template.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { observeNativeTranscript } from "./native-transcript.mjs";
import { hostDeviceVerifier, captureCommand, sourceDigest, isInteraction } from "./native-evidence.mjs";
import { renderNativeSummary } from "./native-summary.mjs";
import { createNativeFollowups } from "./native-followup.mjs";
import { createNativeStopReviews } from "./native-stop-review.mjs";
import { createNativeStopChains } from "./native-stop-chain.mjs";
import { createStopWaitStatus, stopWaitText } from "./stop-wait-status.mjs";
import { savedStopFeedbackNotice, stopFeedbackNotice } from "./stop-feedback-notice.mjs";
import {assertRequiredReviewerTools} from './native-config.mjs';
import {hasStopReviews} from '../runtime-v2/metric-policy.mjs';
import {TASK_TOOL_NAMES,BASELINE_TOOL_NAMES} from './tool-contracts.mjs';
import {createReviewNoticePublisher} from './review-notice.mjs';
import { settleIncompleteStop } from "./stop-terminal.mjs";
import { boundHostFeedback } from "../runtime-v2/feedback-delivery.mjs";
import { markStopFeedbackDelivered } from "../runtime-v2/deviations.mjs";
import { loadConfig, checkArtifact, finalizeArtifactCheck } from "../runtime-corrector.mjs";
import { runSemanticReview, REVIEW_SCHEMA } from "../semantic-review.mjs";
import { handleRuntimeV2Event, handleRuntimeV2SessionEnd, refreshRuntimeRequirements, finalizeArtifactRuntimeV2 } from "../runtime-v2/orchestrator.mjs";
import { recordFailOpenWarning, countOuterStopFailure, clearOuterStopFailures } from "../runtime-v2/fail-open.mjs";
import { createOpenClawReviewerFactory, INTERNAL_SESSION_MARKER } from "./reviewer.mjs";
import { persistTranscript } from "./transcript.mjs";
import { changedFiles, selectedSkillRead, sessionSkillPlan, toolName } from "./tools.mjs";
import { checkEvidenceDistinctness } from "../evidence-distinctness.mjs";
import { isInternalExecution, observeInternalTool } from "./internal-context.mjs";
import { isReviewerContextBudgetError } from "./reviewer-context.mjs";
import { bindInteraction } from "./interaction-store.mjs";
import { evidencePath, fingerprint, createEvidenceLedger, matchesEvidence } from "./evidence.mjs";
import { findTask, decisionGuard, appendTaskJournal, taskDirectory, ensureTask, withTaskDecision, withTaskState } from "../runtime-v2/task-store.mjs";
import { privateJson } from "./controller-store.mjs";
import { isPersistedWorker } from "./controller-store.mjs";
import { createSessionProjects } from "./session-projects.mjs";
import { hookReviewBudgetMs } from "./hook-timeout.mjs";
import { DEFAULT_REVIEW_TIMEOUT_MS } from "../review-timeout.mjs";
import { outsideDecision } from "../runtime-v2/decision-scope.mjs";
import { createStopCorrectionStore } from "../runtime-v2/stop-correction-store.mjs";
import { createStopStartProtocol, loadStopStartCompatibility } from "./stop-start-protocol.mjs";
import { beforeStopDeadline } from "../runtime-v2/stop-deadline.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const joined = (...items) => items.filter(Boolean).join("\n\n");
const FEEDBACK = "[runtime-corrector:feedback]";

export function createOpenClawRuntime(api, { pluginRoot, reviewerFactory: injectedFactory, sharedState = {}, compatibility, nativeHooks = false, projectScopes, stopWorkOwner,
  stopStartCompatibility = loadStopStartCompatibility } = {}) {
  const states = sharedState.states ??= new Map();
  const queues = sharedState.queues ??= new Map();
  const internalSessions = sharedState.internalSessions ??= new Set();
  const toolBindings = sharedState.toolBindings ??= new Map();
  const workers = sharedState.workers ??= new Map();
  const pausedScopes = sharedState.pausedScopes ??= new Map();
  const settings = api.pluginConfig ?? {};
  const projects = projectScopes ?? createSessionProjects(api, { pluginRoot, compatibility });
  const stopChains = nativeHooks ? createNativeStopChains(sharedState.stopWaitChains ??= new Map(), sharedState.stopWaitRunOwners ??= new Map()) : null;
  const stopOccurrenceId = (runId, enabledRevision = 0) => enabledRevision
    ? hash(JSON.stringify({ runId, enabledRevision })) : runId;
  const followups = nativeHooks ? createNativeFollowups(api, { isCurrent: scopeCurrent, onObserved: ({ projectRoot, receipt }) =>
    markStopFeedbackDelivered({ projectRoot, taskId: receipt.taskId, evaluationId: receipt.assessmentId,
      deliveredAt: new Date(receipt.modelObservedAt).toISOString() }),
    onReserved: ({ state, receipt }) => stopChains.link(state, receipt) }) : null;
  const stopReviews = nativeHooks ? createNativeStopReviews(sharedState.stopReviewJobs ??= new Map(), stopWorkOwner) : null;
  const stopStatus = createStopWaitStatus(api, compatibility);
  const publishReviewNotice=createReviewNoticePublisher(api);
  function sessionStopDirectory(state) {
    const stateRoot = api.runtime.state?.resolveStateDir?.();
    const storePath = !stateRoot && api.runtime.agent?.session?.resolveStorePath?.(
      (api.runtime.config?.current?.() ?? api.config)?.session?.store, { agentId: state.agentId ?? "main" });
    const root = stateRoot ?? (typeof storePath === "string" ? path.dirname(storePath) : null);
    return root ? path.join(root, "runtime-corrector-stop-sessions") : null;
  }
  if (sharedState.stopStartProtocol?.closed) delete sharedState.stopStartProtocol;
  const nativeStart = nativeHooks ? (sharedState.stopStartProtocol ??= createStopStartProtocol(api, {
    directoryFor: sessionStopDirectory, compatibility: stopStartCompatibility,
    isCurrent: async (identity, request) => {
      const state = states.get(`${request.agentId ?? "main"}:${identity.sessionId}`);
      if (!state || state.projectRoot !== request.projectRoot || state.nativeInvalidated || !await scopeCurrent(state)) return false;
      const observed = await observeNativeTranscript(api, state);
      return observed.status === "OBSERVED" && observed.externalUsersDigest === request.source.usersDigest;
    },
    onReserved: (state, receipt) => stopChains.link(state, receipt),
    onModelCall: event => {
      const state = states.get(`${event.agentId ?? "main"}:${event.sessionId}`);
      if (state?.nativeRunId === event.runId) state.nativeCallSequence = Math.max(state.nativeCallSequence ?? 0, event.seq);
    },
    onStarted: async (identity, receipt) => {
      const state = [...states.values()].find(value => value.sessionId === identity.sessionId && value.sessionKey === identity.sessionKey);
      if (state) {
        if (receipt.taskId && receipt.assessmentId) await markStopFeedbackDelivered({ projectRoot: state.projectRoot,
          taskId: receipt.taskId, evaluationId: receipt.assessmentId, deliveredAt: new Date(receipt.modelObservedAt).toISOString() });
        if (receipt.taskId) {
          const ledger = await createStopCorrectionStore({ directory: state.stopSessionDirectory ?? sessionStopDirectory(state) }).inspect(state.sessionId);
          await withTaskState({ projectRoot: state.projectRoot, taskId: receipt.taskId }, task => {
            task.stop.correctionAttempts = ledger.flows[receipt.flowId].used;
          });
        }
        stopChains.get(state)?.observeStart(receipt.runId, receipt.original === true);
        if (receipt.original) { state.nativePendingStop = null; state.nativeNeedsStop = true; }
      }
    },
    onReleased: (identity, reason) => {
      const state = [...states.values()].find(value => value.sessionId === identity.sessionId && value.sessionKey === identity.sessionKey);
      const chain = stopChains.get(state ?? identity);
      if (!identity.stopId || identity.stopId === chain?.record.stopId) chain?.cancel(reason);
    },
  })) : null;
  const findFollowup = async (state, runId) => await nativeStart.findRun({ state, runId })
    ?? followups.findRun({ projectRoot: state.projectRoot, state, runId });
  function internal(event, ctx) {
    const id = event.sessionId ?? ctx.sessionId;
    const worker = workers.get(id), runId = ctx.runId ?? event.runId;
    return (!worker && isPersistedWorker(ctx.workspaceDir ?? event.cwd, id))
      || worker?.closed === true || worker?.settled === true
      || Boolean(worker?.runId && runId && worker.runId !== runId)
      || isInternalExecution() || ctx.runtimeCorrectorInternal === true || internalSessions.has(id)
      || [ctx.sessionKey, event.sessionKey].some((key) => String(key ?? "").includes(INTERNAL_SESSION_MARKER));
  }
  async function retire(state, reason = "RC_PROJECT_SCOPE_CHANGED", deactivate = true) {
    state.scopeClosed = true;
    state.nativeInvalidated = true;
    stopChains?.cancel(state, reason);
    state.reviewController?.abort(Object.assign(new Error(reason), { code: reason }));
    try {
      await cancelStopScope(state, reason);
      await nativeStart?.cancel({ state, reason });
      if (followups) await followups.cancel({ projectRoot: state.projectRoot, state, reason });
    }
    finally {
      if (states.get(state.key) === state) states.delete(state.key);
      if (deactivate) await projects.deactivate?.(state.projectScope);
    }
  }
  async function cancelStopScope(state, reason, stopId) {
    if (!state.stopSessionDirectory) return;
    const store = createStopCorrectionStore({ directory: state.stopSessionDirectory });
    const ledger = await store.inspect(state.sessionId);
    for (const stop of Object.values(ledger?.stops ?? {})) if ((!stopId || stop.id === stopId) && stop.scope === path.resolve(state.projectRoot) && stop.releasedAt === undefined)
      await store.expireStop({ sessionId: state.sessionId, stopId: stop.id, force: true, scopeInvalidated: true, reasonCode: reason });
  }
  async function initializeNativeHistory(state) {
    const directory = sessionStopDirectory(state);
    if (!directory || api.runtime.version !== "2026.7.1-2") return;
    try {
      const store = createStopCorrectionStore({ directory });
      if (await store.inspect(state.sessionId)) return;
      const observed = await observeNativeTranscript(api, state);
      const evidence = observed.emptySessionEvidence ?? observed.initialTurnEvidence;
      api.logger.debug?.(`[runtime-corrector] Stop session history: ${observed.status}, verifiedZero=${Boolean(evidence)}, reason=${observed.reason ?? "none"}`);
      if (observed.status === "OBSERVED" && evidence) await store.initializeSession({ sessionId: state.sessionId,
        initialize: { kind: "VERIFIED_HISTORY", starts: [], evidence } });
    } catch (error) { api.logger.warn(`[runtime-corrector] Session history remains unverified: ${error.code ?? error.name}`); }
  }
  async function pauseControl(state, reason = "RC_SESSION_DISABLED") {
    if (state.controlPause) return state.controlPause;
    state.controlPaused = true;
    state.scopeClosed = true;
    state.nativeInvalidated = true;
    state.enabledRevision = (state.enabledRevision ?? 0) + 1;
    pausedScopes.set(state.key, state);
    // Release the old execution queue even if a backend ignores cancellation.
    // New work has a separate state/controller and still restores the same task.
    queues.delete(state.key);
    state.controlPause = (async () => {
      const retiring = outsideDecision(() => retire(state, reason, false));
      // Observe an early cleanup failure while the independent revision write
      // is still pending; the finally below propagates the original failure.
      void retiring.catch(() => {});
      try {
        await outsideDecision(async () => {
          const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
          if (task) await withTaskState({ projectRoot: state.projectRoot, taskId: task.taskId }, current => {
            current.control ??= {};
            current.control.enabledRevision = Math.max((current.control.enabledRevision ?? 0) + 1, state.enabledRevision);
            state.enabledRevision = current.control.enabledRevision;
          });
        });
      } finally {
        try { await retiring; } finally { stopChains?.forget(state); }
      }
    })();
    return state.controlPause;
  }
  async function reconcilePausedScope(scope) {
    if (!scope.identity) return;
    const key = `${scope.identity.agentId}:${scope.identity.sessionId}`;
    const paused = pausedScopes.get(key);
    if (!paused) return;
    // An earlier write error is reported to that control request; it must not
    // permanently block a later user attempt after the filesystem recovers.
    await paused.controlPause.catch(() => {});
    if (scope.fingerprint !== paused.projectScope.fingerprint) {
      await projects.deactivate?.(paused.projectScope);
      pausedScopes.delete(key);
    }
  }
  async function scopeAllowed(state, controller = state.reviewController, diagnostic) {
    if (state.scopeClosed || state.reviewController !== controller || controller.signal.aborted) {
      if (diagnostic) Object.assign(diagnostic, { reason: state.scopeClosed ? 'SCOPE_CLOSED' : state.reviewController !== controller ? 'RUN_REPLACED' : 'CANCELLED' });
      return false;
    }
    const scope = await projects.resolve({}, { agentId: state.agentId, sessionId: state.sessionId,
      sessionKey: state.sessionKey, workspaceDir: state.executionDirectory });
    const allowed = scope.enabled && scope.fingerprint === state.projectScope.fingerprint;
    if (diagnostic) Object.assign(diagnostic, { allowed: Boolean(allowed), reason: scope.reason ?? (scope.fingerprint !== state.projectScope.fingerprint ? 'PROJECT_CHANGED' : null) });
    return allowed;
  }
  projects.setOnChanged?.(async identity => {
    // The manual command already owns the project lock and publishes a new
    // binding generation; don't reacquire that lock while retiring its state.
    for (const state of states.values()) if (state.sessionId === identity.sessionId && state.agentId === identity.agentId) await retire(state, "RC_PROJECT_SCOPE_CHANGED", false);
  });
  async function scopeCurrent(state) {
    if (state.scopeClosed) return false;
    const scope = await projects.resolve({}, { agentId: state.agentId, sessionId: state.sessionId,
      sessionKey: state.sessionKey, workspaceDir: state.executionDirectory });
    if (scope.fingerprint !== state.projectScope.fingerprint) { await retire(state); return false; }
    if (!scope.enabled) {
      if (scope.controlDisabled) await pauseControl(state, scope.reason);
      else await retire(state);
      return false;
    }
    return true;
  }
  function staleStopRun(state, event, ctx) {
    const runId = ctx.runId ?? event.runId;
    if (runId && runId === state?.nativeRunId) return false;
    const owner = stopChains?.owner({ sessionId: event.sessionId ?? ctx.sessionId ?? state?.sessionId,
      sessionKey: event.sessionKey ?? ctx.sessionKey ?? state?.sessionKey }, runId);
    return Boolean(owner?.isStale(runId));
  }
  async function stateFor(event, ctx) {
    const sessionId = event.sessionId ?? ctx.sessionId;
    if (!sessionId || internal(event, ctx) || ctx.runtimeCorrectorControlEnabled === false) return null;
    const worker = workers.get(sessionId);
    if (worker) return worker.state;
    const agentId = ctx.agentId ?? "main";
    const key = `${agentId}:${sessionId}`;
    let state = states.get(key);
    if (staleStopRun(state, event, ctx)) return null;
    let scope = await projects.resolve(event, ctx);
    if (projects.ensure && scope.configValid) scope = await projects.ensure(scope);
    await reconcilePausedScope(scope);
    state = states.get(key);
    if (staleStopRun(state, event, ctx)) return null;
    if (ctx.runtimeCorrectorScopeFingerprint && ctx.runtimeCorrectorScopeFingerprint !== scope.fingerprint) return null;
    if (!scope.enabled) {
      if (state) {
        if (scope.controlDisabled && state.projectScope.fingerprint === scope.fingerprint) await pauseControl(state, scope.reason);
        else await retire(state);
      }
      return null;
    }
    const directory = scope.projectRoot;
    if (state && (state.projectScope.fingerprint !== scope.fingerprint || state.sessionKey && ctx.sessionKey && state.sessionKey !== ctx.sessionKey)) {
      await retire(state); state = null;
    }
    if (!state) {
      const active = await projects.activate(scope);
      state = states.get(key);
      if (state && state.projectScope.fingerprint !== scope.fingerprint) return null;
      if (!state) {
        const task = await findTask({ projectRoot: directory, sessionId, explicitTaskId: active.taskId });
        state = { key, sessionId, agentId, projectRoot: directory, projectScope: scope, scopeTaskId: active.taskId,
          enabledRevision: Math.max(task?.control?.enabledRevision ?? 0, pausedScopes.get(key)?.enabledRevision ?? 0),
          executionDirectory: scope.executionDirectory, entries: [], seen: new Map(), hostCompatibility: compatibility };
        state.projectNativeRecords = async records => {
          if (active.startAfter || active.startAt) {
            const index = records.findIndex(record => record.id === (active.startAfter ?? active.startAt));
            records = index < 0 ? [] : records.slice(index + (active.startAfter ? 1 : 0));
          }
          if (!nativeHooks) return records;
          const projected = await nativeStart.project({ state, records: await followups.project({ projectRoot: state.projectRoot, state, records }) });
          // Later queued inputs belong to their next admitted turn. Freeze only
          // this flow's user-input prefix, without changing the host transcript.
          const boundary = stopChains.get(state)?.pending && state.nativeActiveUserId
            ? projected.findIndex(record => record.id === state.nativeActiveUserId) : -1;
          return boundary < 0 ? projected : projected.filter((record, index) => index <= boundary
            || (record.message ?? record).role !== "user" || record.isMeta);
        };
        state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
        if (nativeHooks) {
          state.observedPaths = new Set();
        }
        states.set(key, state);
        pausedScopes.delete(key);
      }
    }
    if (ctx.runtimeCorrectorEnabledRevision !== undefined && ctx.runtimeCorrectorEnabledRevision !== state.enabledRevision) return null;
    if (staleStopRun(state, event, ctx)) return null;
    state.executionDirectory = scope.executionDirectory ?? state.executionDirectory;
    state.sessionKey = ctx.sessionKey ?? event.sessionKey ?? state.sessionKey;
    state.provider = ctx.modelProviderId ?? event.provider ?? state.provider;
    state.model = ctx.modelId ?? event.model ?? state.model;
    const runId = ctx.runId ?? event.runId;
    if (nativeHooks && runId && state.nativeRunId !== runId) {
      state.reviewController.abort(new Error("Native run replaced."));
      state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
      state.nativeRunId = runId; state.nativeInvalidated = false; state.nativePostRunReview = false; state.nativeAssessment = null;
      state.nativeCallSequence = 0;
      state.nativeEndedRun = null; state.nativePendingStop = null; state.nativePreparingStop = null;
      state.nativeTerminalAbortRunId = null;
      state.nativeNeedsStop = false; state.nativeFollowupReceipt = null;
    }
    return state;
  }
  function queue(state, callback) {
    const previous = queues.get(state.key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(callback);
    queues.set(state.key, next);
    return next.finally(() => { if (queues.get(state.key) === next) queues.delete(state.key); });
  }
  function hookBudget(name) {
    const policy = (api.runtime.config?.current?.() ?? api.config)?.plugins?.entries?.[api.id]?.hooks;
    // reply_dispatch is registered with a one-hour outer wait. Its caller
    // spans review -> repair -> re-review; a single phase's hookTimeoutMs
    // must not abort a healthy later phase at the original cutoff.
    return hookReviewBudgetMs(name === "reply_dispatch" ? 3600000 : settings.hookTimeoutMs,
      policy?.timeouts?.[name] ?? policy?.timeoutMs ?? Infinity);
  }
  function directReviewBudget(plan, hookName) {
    const runtime = plan.runtimeV2;
    const roleBudget = name => Math.min(runtime?.reviewers?.[name]?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      settings.reviewerTimeoutMs ?? Infinity);
    if (hookName === "before_prompt_build") return roleBudget("groundTruthExtractor")
      + (runtime?.dynamicGroundTruth?.panel?.size > 0 && runtime.dynamicGroundTruth.panel.adjudicator
        ? roleBudget("onboardingAdjudicator") : 0);
    return runtime?.stopCorrection?.assessmentTimeoutMs ?? (roleBudget("groundTruthExtractor")
      + roleBudget("stopReviewer") + (runtime?.implementationCorrection?.enabled
        ? roleBudget("implementationReviewer") + runtime.implementationCorrection.deviceBudgetMs : 0));
  }
  async function context(state, hookName, assessmentContext = null, { direct = false } = {}) {
    const controller = state.reviewController;
    const plan = sessionSkillPlan(await loadConfig({ cwd: state.projectRoot, pluginRoot }), state.executionDirectory);
    const required=[...new Set([
      ...(plan.runtimeV2?.stopCorrection?.enabled&&hasStopReviews(plan.runtimeV2.stopCorrection)||plan.runtimeV2?.artifactCorrection?.stageMetricsEnabled?TASK_TOOL_NAMES:[]),
      ...(plan.runtimeV2?.stopCorrection?.enabled&&hasStopReviews(plan.runtimeV2.stopCorrection)&&plan.runtimeV2?.dynamicGroundTruth?.enabled?BASELINE_TOOL_NAMES:[]),
    ])];
    assertRequiredReviewerTools(api.runtime.config?.current?.()??api.config??{},state.agentId??'main',required,{provider:state.provider,model:state.model});
    const baseReviewerFactory = injectedFactory ?? createOpenClawReviewerFactory(api, {
      agentId: state.agentId, provider: state.provider, model: state.model,
      pluginRoot, skillRoots: plan.runtimeV2?.skillCorrection?.skillRoots,
      reviewerModel: settings.reviewerModel, reviewerTimeoutMs: settings.reviewerTimeoutMs,
      stopReviewEngine: settings.stopReviewEngine ?? "task",
      // Controller-owned calls are not host Hooks. Worker tool Hooks still use
      // the native policy window; neither path may outlive its parent deadline.
      deadlineAt: Math.min(Date.now() + (direct ? directReviewBudget(plan, hookName) : hookBudget(hookName)),
        assessmentContext?.deadlineAt ?? state.runDeadlineAt ?? Infinity), internalSessions,
      abortSignal: state.abortSignal,
      observeTool: state.observeReviewTool,
      onRunStart: state.onReviewRunStart,
      onRunEnd: state.onReviewRunEnd,
      onTool: state.onReviewTool,
      // The supervised controller already relays its private children's activity.
      // Native hook mode has no controller and must bind to this exact parent run.
      ...(!state.supervised && state.hookRunId && !state.nativePostRunReview ? { compatibility, activityTarget: {
        runId: state.hookRunId, sessionId: state.sessionId, sessionKey: state.sessionKey, agentId: state.agentId,
      } } : {}),
    });
    const guardedReview = invoke => async options => {
      if (controller !== state.reviewController || controller.signal.aborted || !await scopeCurrent(state)) throw Object.assign(new Error("RC scope is no longer active."), { code: "RC_SESSION_DISABLED" });
      const handle = await invoke(options);
      if (controller !== state.reviewController || controller.signal.aborted || !await scopeCurrent(state)) {
        await handle.close?.();
        throw Object.assign(new Error("RC scope was disabled during review."), { code: "RC_SESSION_DISABLED" });
      }
      return handle;
    };
    const reviewerFactory = Object.assign(guardedReview(options => baseReviewerFactory(options)), baseReviewerFactory);
    if (baseReviewerFactory.handoff) reviewerFactory.handoff = guardedReview(options => baseReviewerFactory.handoff(options));
    state.stopSessionDirectory = sessionStopDirectory(state);
    await nativeStart?.recover(state);
    return { input: null, plan, projectRoot: state.projectRoot, pluginRoot, reviewerFactory,
      stopHost: { directory: state.stopSessionDirectory,
        // Re-enabling RC in the same host run creates a fresh Stop occurrence.
        // Its cancelled predecessor remains durable and cannot be reused.
        stopId: assessmentContext?.stopId ?? stopOccurrenceId(state.nativeRunId ?? state.runId, state.enabledRevision), isCurrent: () => scopeCurrent(state),
        ...(nativeStart && await nativeStart.ready() ? { startProtocol: { version: 1 } } : {}) },
      ...(state.scopeTaskId ? { env: { ...process.env, RUNTIME_CORRECTOR_TASK_ID: state.scopeTaskId } } : {}),
      ...(nativeHooks ? { deviceVerifier: hostDeviceVerifier(state), stopFeedbackDeferred: true } : {}),
      ...(assessmentContext ? { assessmentContext: { ...assessmentContext,
        onTaskCreated: state.onTaskState, rulesDigest: hash(JSON.stringify(plan)), maxCorrections: plan.runtimeV2?.stopCorrection?.maxCorrectionsPerFlow } } : {}) };
  }
  function inputFor(state, eventName, fields = {}) {
    return { hook_event_name: eventName, session_id: state.sessionId, cwd: state.projectRoot,
      transcript_path: state.transcriptPath ?? "", hook_event_id: randomUUID(), ...fields };
  }
  async function semanticArtifactReview(state, value, input, prepared, outcome = {}) {
    return runSemanticReview({ input, prepared, pluginRoot, runtimeV2Handle: outcome.reviewerHandle,
      runtimeV2Context: outcome.artifactReviewContext, runtimeV2ExecutionContext: outcome.reviewerExecutionContext,
      runtimeV2Evidence: outcome.reviewerEvidence, runtimeV2ReviewerFactory: value.reviewerFactory,
      invokeFork: async request => {
        const semanticReviewRequestPath = request.prompt.match(/--request "([^"]+)"/u)?.[1];
        if (!semanticReviewRequestPath) throw new Error("Semantic review request path is missing.");
        const handle = await value.reviewerFactory({ projectRoot: state.projectRoot, sessionCwd: state.projectRoot,
          taskId: outcome.taskId ?? state.scopeTaskId ?? `openclaw-${hash(state.sessionId)}`, parentSessionId: state.sessionId,
          role: "artifact-reviewer", reviewer: { timeoutMs: request.timeoutMs, session: "detached" },
          reviewerRuntime: request.reviewerRuntime, evidence: { snapshot: { entries: state.entries } },
          schema: REVIEW_SCHEMA, request: { semanticReviewRequestPath,
            instructions: "Read semanticReviewRequestPath and review all available artifacts according to the semantic-review protocol, project criteria and deterministic diagnostics." }, pluginRoot });
        try { return { sessionId: handle.sessionId, review: handle.result }; } finally { await handle.close(); }
      } });
  }
  async function finalizeScopedArtifact(state, prepared, review) {
    if (!await scopeCurrent(state)) throw new Error("RC_PROJECT_SCOPE_CHANGED");
    // Keep mutable latest pointers and artifact rounds Session-scoped too.
    // Artifact policy always comes from this exact bound project, even if a
    // nested folder or an ancestor also contains an RC config.
    prepared.finalizeContext.output = { ...prepared.finalizeContext.output, mode: "centralized",
      directory: path.join(prepared.finalizeContext.output.directory ?? ".runtime-correction", "openclaw/session-artifacts", state.scopeTaskId ?? hash(state.key)) };
    return finalizeArtifactCheck(prepared, review);
  }
  async function run(state, eventName, fields, contextValue) {
    const outcome = await handleRuntimeV2Event({ ...contextValue, input: inputFor(state, eventName, fields) });
    if (state.onTaskState) {
      const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
      if (task) await state.onTaskState(task);
    }
    return outcome;
  }
  async function failure(state, error, label) {
    if (state.scopeClosed || state.controlPaused || state.abortSignal?.aborted || error.code === "RC_SESSION_DISABLED") return "";
    // Host/model errors can include request data; expose a bounded message,
    // and redact ambient named credentials before persisting diagnostics.
    let message = String(error.message ?? error);
    for (const [key, value] of Object.entries(process.env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD/iu.test(key) && value?.length > 7) message = message.split(value).join("<redacted>");
    }
    message = message.replace(/(?:ark-|sk-)[a-z0-9_-]{15,}/giu, "<redacted>").slice(0, 1500);
    api.logger.warn(`[runtime-corrector] ${label}: ${message}`);
    if(error.code==='RC_REQUIRED_TOOLS_DENIED'){
      const task=await ensureTask({projectRoot:state.projectRoot,sessionId:state.sessionId,explicitTaskId:state.scopeTaskId});
      await withTaskState({projectRoot:state.projectRoot,taskId:task.taskId},current=>{
        current.stop.requiredToolsDiagnostic={code:error.code,message,recordedAt:new Date().toISOString()};
      });
      if(nativeHooks)state.nativeNeedsStop=true;
    }
    await recordFailOpenWarning({ projectRoot: state.projectRoot, category: `OPENCLAW_${label}_${hash(state.sessionId)}`, message }).catch(() => {});
    return `${FEEDBACK} 本次纠偏检查未完成：${message}`;
  }
  async function syncNative(state) {
    const observed = await observeNativeTranscript(api, state);
    state.nativeSourceStatus = observed.status;
    if (observed.status === "OBSERVED") {
      await persistTranscript(state, { messages: observed.messages });
      restoreObservedPaths(state);
      state.nativeUserDigest = observed.externalUsersDigest;
      if (!stopChains?.get(state)?.pending) state.nativeActiveUserId = observed.lastExternalUser?.uuid;
    }
    return observed;
  }
  function restoreObservedPaths(state) {
    state.observedPaths ??= new Set();
    // A fresh Gateway has no in-memory write history. Rediscover paths from
    // the verified active host branch, then fingerprint their CURRENT bytes.
    // Historical contents and fingerprints never grant current acceptance.
    for (const entry of state.entries) for (const item of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (item.type !== "tool_use") continue;
      for (const file of changedFiles(item.name, item.input ?? {}, state.projectRoot, state.executionDirectory)) {
        const target = evidencePath(state.projectRoot, file);
        if (target) state.observedPaths.add(target);
      }
    }
  }
  async function cancelNative(event = {}, ctx = {}, invalidated = true, reason = "RC_NATIVE_CANCELLED") {
    const sessionId = event.sessionId ?? ctx.sessionId, sessionKey = event.sessionKey ?? ctx.sessionKey, runId = ctx.runId ?? event.runId;
    // Reviewer end events can omit business-session identity. They never own
    // cancellation of a host run or another reviewer population.
    if ((!sessionId && !sessionKey) || internal(event, ctx)) return;
    for (const state of states.values()) {
      if (sessionId && state.sessionId !== sessionId || sessionKey && state.sessionKey !== sessionKey
        || runId && state.nativeRunId && state.nativeRunId !== runId) continue;
      const chain = stopChains.get(state);
      if (invalidated) state.nativeInvalidated = true;
      // Only the exact current run's terminal abort may close its task after
      // invalidation. Reset, replacement and scope retirement keep their fence.
      state.nativeTerminalAbortRunId = reason === "RC_NATIVE_ATTEMPT_ENDED" ? runId : null;
      state.reviewController?.abort(Object.assign(new Error("Native review lifecycle ended."), { code: reason }));
      await cancelStopScope(state, reason);
      await nativeStart.cancel({ state, reason });
      await followups.cancel({ projectRoot: state.projectRoot, state, reason });
      chain?.cancel(reason);
      await chain?.cleanup;
    }
  }
  async function withState(event, ctx, callback) {
    if(ctx.abortSignal?.aborted)return;
    if (settings.enabled === false || internal(event, ctx)) return;
    if (ctx.abortSignal?.aborted) return;
    // Prompt/tool hooks may already own the session lane. Only the outer
    // dispatch hook may wait; a bypassed entry abandons RC instead.
    if (nativeHooks) releaseBypassedEntry(states.get(`${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`), ctx.runId ?? event.runId);
    let state;
    try { state = await stateFor(event, ctx); }
    catch (error) { api.logger.warn(`[runtime-corrector] ${error.message}`); return; }
    if (!state) return;
    const admittedController = state.reviewController;
    const execute = () => queue(state, async () => {
      if (!await scopeCurrent(state)) return;
      state.hookRunId = ctx.runId ?? event.runId;
      if (nativeHooks) {
        if (state.abortSignal?.aborted) return;
        const observed = await syncNative(state);
        if (observed.status !== "OBSERVED") {
          state.finalRunId = ctx.runId ?? event.runId;
          state.finalNotice = `UNVERIFIED：RC 无法读取本次原生会话依据：${observed.reason ?? observed.status}。宿主继续执行。`;
          return;
        }
      }
      if ((!state.supervised && !nativeHooks) || !event.toolName) {
        const result = await callback(state);
        return await scopeCurrent(state) ? result : undefined;
      }
      state.abortSignal?.throwIfAborted();
      const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
      if (!plan.runtimeV2?.enabled) return callback(state);
      let task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
      if (!task && ["write", "edit", "exec", "bash", "apply_patch"].includes(String(event.toolName).toLowerCase())) {
        task = await ensureTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
      }
      if (!task) return callback(state);
      await state.onTaskState?.(task);
      task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
      const ledger = createEvidenceLedger(state.projectRoot);
      for (const file of [...state.observedPaths ?? [], plan.configPath,
        ...(plan.artifacts ?? []).flatMap(artifact => [artifact.reviewerFile, artifact.simpleRulesFile])].filter(Boolean)) {
        if (await fingerprint(file) !== "missing") await ledger.observe(file);
      }
      const previousObserver = state.observeReviewTool, previousEvidence = state.artifactEvidence;
      state.observeReviewTool = ledger.observeTool; state.artifactEvidence = ledger.snapshot;
      let result;
      try { result = await withTaskDecision({ projectRoot: state.projectRoot, taskId: task.taskId, context: {
        kind: "hook", assessmentId: `${ctx.runId ?? "run"}${state.enabledRevision ? `:enabled-${state.enabledRevision}` : ""}:${event.toolCallId ?? ctx.toolCallId}:${event.result ? "post" : "pre"}`,
        guard: decisionGuard(task), abortSignal: state.abortSignal, deadlineAt: state.runDeadlineAt,
        maxCorrections: plan.runtimeV2?.stopCorrection?.maxCorrectionsPerFlow,
        evidenceMatches: async () => await scopeAllowed(state, admittedController) && await ledger.matches(),
      } }, () => callback(state)); }
      finally { state.observeReviewTool = previousObserver; state.artifactEvidence = previousEvidence; }
      if (result?.stale || !await scopeCurrent(state)) return undefined;
      return result;
    });
    if (!nativeHooks) return execute().catch(error => {
      if (state.scopeClosed) return;
      throw error;
    });
    const sessions = api.runtime.agent.session;
    if (typeof sessions?.runWithWorkAdmission !== "function") return;
    const config = api.runtime.config?.current?.() ?? api.config;
    const reviewController = state.reviewController;
    return sessions.runWithWorkAdmission({ sessionKey: state.sessionKey,
      storePath: sessions.resolveStorePath(config.session?.store, { agentId: state.agentId }),
      signal: reviewController.signal }, async signal => {
      const abort = () => reviewController.abort(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      try {
        if (reviewController.signal.aborted || state.reviewController !== reviewController) return;
        return await execute();
      } finally { signal.removeEventListener("abort", abort); }
    }).catch(error => {
      if (state.scopeClosed) return;
      throw error;
    });
  }
  function releaseBypassedEntry(state, runId) {
    const chain = state && stopChains?.get(state);
    if (!state || !runId || runId === state.nativeRunId || chain?.runs.has(runId) || nativeStart?.knowsRun(state, runId)) return;
    const pending = stopReviews?.pending(state, runId) ?? [];
    if (!chain?.pending && !pending.length) return;
    if (!chain?.pending) {
      for (const job of pending) job.expire();
      state.nativeInvalidated = true;
      state.reviewController?.abort(new Error("RC_QUEUE_ENTRY_BYPASSED"));
      return;
    }
    chain.cancel("RC_QUEUE_ENTRY_BYPASSED");
    state.nativeInvalidated = true;
    state.reviewController?.abort(new Error("RC_QUEUE_ENTRY_BYPASSED"));
    void nativeStart.cancel({ state, reason: "RC_QUEUE_ENTRY_BYPASSED", stopId: chain.record.stopId }).catch(() => {});
    void cancelStopScope(state, "RC_QUEUE_ENTRY_BYPASSED", chain.record.stopId).catch(() => {});
  }
  async function waitForStop(event = {}, ctx = {}, hookName = "before_prompt_build") {
    if (!nativeHooks || settings.enabled === false || internal(event, ctx)) return;
    const sessionKey = event.sessionKey ?? ctx.sessionKey;
    const sessionId = event.sessionId ?? ctx.sessionId;
    const state = sessionId ? states.get(`${ctx.agentId ?? "main"}:${sessionId}`)
      : [...states.values()].find(value => value.sessionKey === sessionKey);
    if (!state || sessionKey && state.sessionKey !== sessionKey) return;
    if (staleStopRun(state, event, ctx)) return;
    const runId = ctx.runId ?? event.runId;
    if (state.nativePreparingStop && runId !== state.nativeRunId) {
      try { await beforeStopDeadline(() => state.nativePreparingStop, { deadlineAt: Date.now() + 1000, signal: ctx.abortSignal }); }
      catch { stopChains.get(state)?.expire(); return; }
    }
    const knownChain = stopChains.get(state), chain = knownChain?.pending ? knownChain : null;
    const pending = stopReviews.pending(state, runId).filter(job => !knownChain || knownChain.pending || !knownChain.runs.has(job.record.runId));
    if ((!pending.length && !chain) || !await scopeCurrent(state)) return;
    if (chain?.runs.has(runId)) {
      if (!ctx.runtimeCorrectorIndependentStop && runId !== chain.record.rootRunId) chain.enter(runId);
      return;
    }
    // A submitted RC continuation can start before subagent.run returns.
    if (runId) {
      const owned = await findFollowup(state, runId);
      if (owned && owned.status !== "CANCELLED" && !owned.finishedAt) { chain?.enter(runId); return; }
    }
    const signal = ctx.abortSignal;
    if (signal?.aborted) return;
    const controller = state.reviewController;
    // UI follows the current phase deadline. The caller also retains its own
    // bounded wait, independent of missing terminal events and cleanup.
    const deadlineAt = chain ? chain.record.deadlineAt : Math.min(Math.max(...pending.map(job => job.record.deadlineAt)), Date.now() + hookBudget(hookName));
    const callerDeadlineAt=ctx.runtimeCorrectorHookDeadlineAt??Date.now()+hookBudget(hookName);
    const settlementGrace=Math.min(250,Math.max(10,Math.floor((callerDeadlineAt-Date.now())/10)));
    const waitDeadlineAt=chain?callerDeadlineAt-settlementGrace:Math.min(deadlineAt,callerDeadlineAt-settlementGrace);
    const targetRun = runId;
    const current = () => !state.scopeClosed && !signal?.aborted && (chain
      ? stopChains.get(state) === chain && chain.runs.has(state.nativeRunId) : state.reviewController === controller);
    const keepalive = async text => {
      const healthy = await stopStatus({ state, runId: targetRun, phase: "waiting",
        deadlineAt: Math.min(chain?.record.deadlineAt ?? deadlineAt,waitDeadlineAt), signal, waiting: true, isCurrent: current, text });
      if (healthy === false && current()) {
        // Release before best-effort cancellation/persistence. Only this
        // captured flow is affected if a newer run starts during notification.
        if (chain) chain.expire("RC_STOP_KEEPALIVE_UNAVAILABLE");
        else for (const job of pending) job.expire("RC_STOP_KEEPALIVE_UNAVAILABLE");
      }
      return healthy;
    };
    let heartbeat, timeout, remove = () => {};
    try {
      const healthy = await keepalive(`正在等待 RC ${chain ? "纠偏流程结束" : "评审结论和反馈"}，后续任务暂缓${deadlineAt ? `；截止 ${new Date(deadlineAt).toISOString()}` : ""}。`);
      if (!current()) return;
      if (healthy !== false) {
        timeout = setTimeout(() => {
          if (chain) chain.expire();
          else for (const job of pending) job.expire();
        }, Math.max(1,waitDeadlineAt-Date.now()));
        heartbeat = setInterval(() => { void keepalive(); }, 30000);
      }
      const results = await Promise.race([chain ? chain.released.then(result => [result]) : Promise.all(pending.map(job => job.released)), new Promise(resolve => {
        if (!signal) return;
        const abort = () => resolve(null);
        signal.addEventListener("abort", abort, { once: true });
        remove = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
      })]);
      if (results && current()) await stopStatus({ state, runId: targetRun, phase: "settled", signal, waiting: true,
        isCurrent: current, text: stopWaitText(results.at(-1)) });
    } finally { clearInterval(heartbeat); clearTimeout(timeout); remove(); stopStatus.close(state, targetRun); }
  }
  async function nativeStopSource(state, runId, saved, deadlineAt) {
    if (state.nativeRunId !== runId || state.nativeInvalidated || !await scopeCurrent(state)) return;
    const observed = await observeNativeTranscript(api, state);
    if (observed.status !== "OBSERVED" || observed.externalUsersDigest !== saved?.usersDigest || !await matchesEvidence(saved.evidence)) return;
    return { runId, leafId: observed.messages.at(-1)?.id, usersDigest: observed.externalUsersDigest,
      evidenceDigest: observed.evidenceDigest, ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}) };
  }
  async function handoffNativeStop(state) {
    const pending = state.nativePendingStop;
    if (!pending || state.nativeEndedRun !== pending.runId) return;
    return pending.handoff ??= submitNativeFollowup(state, pending.runId, pending.assessed, pending.deadlineAt);
  }
  async function submitNativeFollowup(state, expectedRunId, saved, deadlineAt = Infinity) {
    if (state.nativeRunId !== expectedRunId || !await scopeCurrent(state)) return;
    const outcome = saved?.outcome;
    if (outcome?.assessmentMode === "verify_only") return;
    if (outcome?.decision !== "block" || (outcome.status === "UNVERIFIED" && !outcome.partialFeedbackEligible)) return;
    const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
    // The core's armed Stop decision is authoritative, including protection
    // against an agent disabling the project flag mid-task.
    if (plan.runtimeV2?.shadowMode) return;
    const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
    const observed = await observeNativeTranscript(api, state);
    if (!task || state.nativeRunId !== expectedRunId || state.nativeInvalidated || observed.status !== "OBSERVED"
      || observed.externalUsersDigest !== saved.usersDigest || !await matchesEvidence(saved.evidence)) {
      if (task) await appendTaskJournal(state.projectRoot, task.taskId, { type: "NATIVE_STOP_FOLLOWUP_SKIPPED", reason: "STALE_EVIDENCE" });
      return;
    }
    const source = { runId: expectedRunId, leafId: observed.messages.at(-1)?.id, usersDigest: observed.externalUsersDigest,
      evidenceDigest: observed.evidenceDigest, ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}) };
    if (outcome.stopCorrection) {
      const receipt = await nativeStart.submit({ state, outcome, source });
      if (state.nativeRunId === expectedRunId) state.nativeFollowupReceipt = receipt;
      return receipt;
    }
    const receipt = await followups.submit({ projectRoot: state.projectRoot, state, task, outcome,
      maxCorrections: plan.runtimeV2.stopCorrection.maxCorrectionsPerFlow, source: {
        runId: expectedRunId, leafId: observed.messages.at(-1)?.id, usersDigest: observed.externalUsersDigest, evidenceDigest: observed.evidenceDigest,
        ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}),
      } });
    if (state.nativeRunId === expectedRunId) state.nativeFollowupReceipt = receipt;
    if (receipt.status === "REJECTED" && !receipt.modelObservedAt && !receipt.feedbackOnly) {
      // Confirmed refusal returns the chance; uncertain admission keeps its
      // reservation because a native run may already have started.
      await withTaskState({ projectRoot: state.projectRoot, taskId: task.taskId }, current => {
        if (current.stop.lastAssessmentId === task.stop.lastAssessmentId
          && current.correctionEpoch.id === task.correctionEpoch.id
          && current.stop.correctionAttempts === outcome.correctionAttempt) current.stop.correctionAttempts -= 1;
      });
    }
    return receipt;
  }
  async function scheduleNativeStop(state, { text, runId, ctx, receipt = null, opportunity = null, preparedAssessment = null }) {
    const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
    if (state.nativeRunId !== runId || state.nativeInvalidated) return;
    const controller = state.reviewController;
    const occurrenceId = ctx.runtimeCorrectorStopId ?? stopOccurrenceId(runId, state.enabledRevision);
    const waitMode = stopChains.get(state)?.runs.has(runId) ? "until_pass" : plan.runtimeV2.stopCorrection.waitMode;
    const chain = waitMode === "until_pass" ? stopChains.begin({ state, runId,
      taskId: state.scopeTaskId ?? receipt?.taskId ?? (await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId }))?.taskId,
      fresh: Boolean(ctx.runtimeCorrectorStopId),
      budgetMs: directReviewBudget(plan, "before_agent_finalize"),
      repairBudgetMs: Math.min(settings.hookTimeoutMs ?? 1200000, 3600000),
      onCancel: async reasonCode => {
        for (const job of stopReviews.pending(state)) if (chain.runs.has(job.record.runId))
          job.expire(reasonCode === "RC_STOP_KEEPALIVE_UNAVAILABLE" ? reasonCode : undefined);
        if (!state.scopeClosed && stopChains.get(state) === chain && chain.runs.has(state.nativeRunId))
          state.reviewController.abort(Object.assign(new Error("RC Stop wait ended."), { code: reasonCode }));
        const stoppedRunId = chain.record.runId;
        // A child review has its own Stop ID, while the executed repair's
        // admission still belongs to the parent Stop. Close both exact owners.
        const stopIds = new Set([chain.record.stopId]);
        for (const ownedRunId of chain.runs) {
          const owned = await nativeStart.findRun({ state, runId: ownedRunId });
          if (owned?.admission?.stopId) stopIds.add(owned.admission.stopId);
        }
        for (const ownedStopId of stopIds) if (ownedStopId) {
          await cancelStopScope(state, reasonCode, ownedStopId);
          await nativeStart.cancel({ state, reason: reasonCode, stopId: ownedStopId });
        }
        const currentTask = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: chain.record.taskId });
        if (currentTask?.stop.correctionProtocol === "grouped-v1") return;
        await Promise.all([
          followups.finish({ projectRoot: state.projectRoot, state, runId: stoppedRunId, status: "UNVERIFIED", reasonCode }),
          settleIncompleteStop({ projectRoot: state.projectRoot, taskId: chain.record.taskId,
            runId: stoppedRunId, reasonCode, startedAt: chain.record.createdAt,
            isCurrent: () => state.nativeRunId === stoppedRunId && !state.scopeClosed
              && stopChains.get(state) === chain
              && (!state.nativeInvalidated || state.nativeTerminalAbortRunId === stoppedRunId) }),
        ]);
      },
      onPhase: value => stopStatus({ state, runId, phase: value.phase.toLowerCase(),
        deadlineAt: value.deadlineAt, isCurrent: () => !state.scopeClosed && stopChains.get(state) === chain && chain.runs.has(state.nativeRunId),
        text: value.phase === "CORRECTING" ? "RC 发现偏差，正在等待宿主修正；后续任务继续等待复验到 PASS。"
          : "RC 正在复验修正结果；后续任务继续等待 PASS。" }),
      onSettled: record => stopStatus({ state, runId, phase: "settled",
        text: stopWaitText(record), isCurrent: () => !state.scopeClosed && stopChains.get(state) === chain && chain.runs.has(state.nativeRunId) }),
    }) : null;
    if (chain) { chain.record.stopId = occurrenceId; chain.record.occurrenceId = occurrenceId; }
    if (chain && !chain.pending && receipt) {
      await followups.finish({ projectRoot: state.projectRoot, state, runId, status: chain.record.reviewStatus });
      return chain.record;
    }
    return stopReviews.schedule({ projectRoot: state.projectRoot, sessionId: state.sessionId,
      sessionKey: state.sessionKey, runId, occurrenceId, enabledRevision: state.enabledRevision, signal: controller.signal,
      budgetMs: directReviewBudget(plan, "before_agent_finalize"), waitMode,
      onCancel: reason => controller.abort(reason),
      onSettled: async record => {
        let terminal;
        try {
          if (record.reasonCode && (!record.assessmentCompletedAt || record.reviewStatus === 'UNVERIFIED' && !record.evaluationId)) {
            try {
              await followups.finish({ projectRoot: state.projectRoot, state, runId, status: "UNVERIFIED", reasonCode: record.reasonCode });
            } finally {
              const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
              if (task) terminal = await settleIncompleteStop({ projectRoot: state.projectRoot, taskId: task.taskId, runId,
                reasonCode: record.reasonCode, startedAt: chain?.record.createdAt ?? record.createdAt,
                 isCurrent: () => state.nativeRunId === runId && state.reviewController === controller && !state.scopeClosed && !state.nativeInvalidated });
            }
          }
        } catch (error) { api.logger.warn(`RC Stop termination metadata: ${error.message}`); }
        finally {
          if (terminal) Object.assign(record, { verificationFeedback: terminal.feedback, terminalIndex: terminal.indexPath });
          if (chain && chain.record.occurrenceId === record.occurrenceId) chain.assessed(record);
          else await stopStatus({ state, runId, phase: "settled", text: stopWaitText(record),
             isCurrent: () => state.nativeRunId === runId && state.reviewController === controller && !state.scopeClosed });
        }
        const noticeTask=await findTask({projectRoot:state.projectRoot,sessionId:state.sessionId,explicitTaskId:state.scopeTaskId});
        if(!plan.runtimeV2?.shadowMode)await publishReviewNotice({state,record,taskId:noticeTask?.taskId,
          isCurrent:()=>state.nativeRunId===runId&&state.reviewController===controller&&!state.scopeClosed});
        return terminal ? { verificationFeedback: terminal.feedback, terminalIndex: terminal.indexPath } : undefined;
      },
      run: async ({ deadlineAt, ownerSignal, commit }) => {
        if (state.nativeRunId !== runId || controller.signal.aborted) return { reviewStatus: "CANCELLED" };
        const ownerClosed = () => controller.abort(ownerSignal.reason);
        if (ownerSignal?.aborted) ownerClosed();
        else ownerSignal?.addEventListener("abort", ownerClosed, { once: true });
        state.nativePostRunReview = true;
        let result;
        try {
          const ledger = state.stopSessionDirectory && await createStopCorrectionStore({ directory: state.stopSessionDirectory }).inspect(state.sessionId);
          const repair = Object.values(ledger?.admissions ?? {}).findLast(value => value.accounting === "USED"
            && (value.hostRequest?.runId === runId || value.originalRequest?.runId === runId));
          const finalVerification = repair && (ledger.used >= plan.runtimeV2.stopCorrection.maxCorrectionsPerSession
            || ledger.flows[repair.flowId].used >= (waitMode === "assessment" ? 1 : plan.runtimeV2.stopCorrection.maxCorrectionsPerFlow));
          const cached = preparedAssessment && await nativeStopSource(state, runId, preparedAssessment, deadlineAt);
          const assessed = cached ? preparedAssessment : await handlers.finalize({ lastAssistantMessage: text, stopHookActive: Boolean(receipt) }, {
              ...ctx, sessionId: state.sessionId, sessionKey: state.sessionKey, workspaceDir: state.executionDirectory,
              agentId: state.agentId, runId, runtimeCorrectorIndependentStop: true,
              runtimeCorrectorReviewDeadlineAt: deadlineAt,
              runtimeCorrectorVerificationOnly: Boolean(finalVerification),
            });
          if (chain && assessed?.outcome?.stopCorrection?.stopId) chain.record.stopId = assessed.outcome.stopCorrection.stopId;
          if (state.nativeRunId !== runId || controller.signal.aborted) return { reviewStatus: "CANCELLED" };
          const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
          const current = assessed?.runId === runId && ["allow", "block"].includes(assessed.outcome?.decision)
            && task?.verification?.assessmentId === assessed.assessmentId;
          result = { reviewStatus: current ? task.verification.status : "UNVERIFIED",
            evaluationId: current ? task.verification.evaluationId : null,
            ...(!current ? { reasonCode: assessed?.outcome?.reasonCode ?? 'STOP_ASSESSMENT_NOT_PUBLISHED' }
              : assessed.outcome.reasonCode ? { reasonCode: assessed.outcome.reasonCode } : {}),
            ...(current && stopFeedbackNotice(assessed.outcome) ? { verificationFeedback: stopFeedbackNotice(assessed.outcome) } : {}),
            ...(assessed?.outcome?.correctionBudgetExhausted && !assessed.outcome.stopCorrection ? { reasonCode: "CORRECTION_BUDGET_EXHAUSTED" } : {}) };
          if(current&&assessed.outcome.partialFeedbackEligible)result.feedbackOnly=true;
          if (finalVerification && result.reviewStatus !== "PASS") result.reasonCode = "CORRECTION_BUDGET_EXHAUSTED";
          await commit(result); // Persist the old run's assessment before the host can start a new run.
          if (finalVerification && current && result.evaluationId) await createStopCorrectionStore({ directory: state.stopSessionDirectory })
            .finishRepairReview({ sessionId: state.sessionId, admissionId: repair.id, status: result.reviewStatus, evaluationId: result.evaluationId });
          let followup;
          if (opportunity) {
            const source = await nativeStopSource(state, runId, assessed, deadlineAt);
            if (source && opportunity.isOpen() && !state.nativeOriginalOffered?.has(runId)) {
              const decision = await nativeStart.offerOriginal({ state, outcome: assessed.outcome, source, isOpen: opportunity.isOpen });
              if (decision && opportunity.isOpen()) {
                (state.nativeOriginalOffered ??= new Set()).add(runId);
                opportunity.decision = { action: decision.action, reason: decision.reason };
                opportunity.admissionId = decision.admissionId;
                state.nativeNeedsStop = true;
                followup = { status: "ORIGINAL_REQUESTED" };
              }
            }
            // Keep the gate closed across host refusal and a slow review that
            // finishes after the short finalize window. Only one terminal
            // handoff may consume the existing reservation.
            if (!followup && assessed?.outcome?.admission) {
              state.nativePendingStop = { runId, assessed, deadlineAt };
              followup = state.nativeEndedRun === runId ? await handoffNativeStop(state) : { status: "WAIT_TERMINAL" };
            } else if (followup) state.nativePendingStop = { runId, assessed, deadlineAt };
          } else followup = await submitNativeFollowup(state, runId, assessed, deadlineAt);
          if (followup) {
            result.followupStatus = followup.status;
            if (followup.feedbackOnly) result.feedbackOnly = true;
          }
          if (receipt) await followups.finish({ projectRoot: state.projectRoot, state, runId,
            evaluationId: result.evaluationId, status: result.reviewStatus });
          return result;
        } catch (error) {
          await failure(state, error, "NATIVE_STOP_REVIEW");
          if (receipt) await followups.finish({ projectRoot: state.projectRoot, state, runId,
            evaluationId: result?.evaluationId, status: result?.reviewStatus ?? "UNVERIFIED" });
          return result ? { ...result, reasonCode: error.code ?? error.name } : { reviewStatus: controller.signal.aborted ? "CANCELLED" : "UNVERIFIED",
            reasonCode: error.code ?? error.name };
        } finally {
          ownerSignal?.removeEventListener("abort", ownerClosed);
          try {
            if (receipt && controller.signal.aborted) await followups.finish({ projectRoot: state.projectRoot, state, runId,
              evaluationId: result?.evaluationId, status: result?.reviewStatus ?? "UNVERIFIED",
              reasonCode: controller.signal.reason?.code });
          } finally {
            if (state.nativeRunId === runId) state.nativePostRunReview = false;
            opportunity?.complete();
          }
        }
      },
    });
  }
  const handlers = {
    async beforeFinalize(event, ctx = {}) {
      if (!nativeHooks || settings.enabled === false || internal(event, ctx)) return;
      const runId = ctx.runId ?? event.runId;
      const state = states.get(`${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`);
      if (!state || state.nativeRunId !== runId || !state.nativeNeedsStop || state.nativeInvalidated) return;
      const key = `${runId}:${state.nativeCallSequence ?? 0}:${hash(event.lastAssistantMessage ?? "")}`;
      if (state.nativeFinalizeKey === key) return;
      state.nativeFinalizeKey = key;
      state.nativeNeedsStop = false;
      state.nativeFinalizeHandledRun = runId;
      const occurrenceId = `${stopOccurrenceId(runId, state.enabledRevision)}:check-${state.nativeStopSequence = (state.nativeStopSequence ?? 0) + 1}`;
      // Zero is the safe default: MA exposes no remaining hard run deadline.
      // An explicit small window enables same-run revision at the caller's risk.
      const waitMs = Math.max(0, Math.min(2000, settings.finalizeReviewWaitMs ?? 0));
      let complete, open = true;
      const done = new Promise(resolve => { complete = resolve; });
      const until = Date.now() + waitMs;
      const opportunity = { complete, isOpen: () => open && waitMs > 0 && Date.now() < until && state.nativeEndedRun !== runId
        && state.nativeRunId === runId && !state.nativeInvalidated };
      const preparedAssessment = state.nativeAssessment?.runId === runId && state.nativeAssessmentText === event.lastAssistantMessage
        ? state.nativeAssessment : null;
      const work = scheduleNativeStop(state, { text: event.lastAssistantMessage ?? "", runId,
        ctx: { ...ctx, runtimeCorrectorStopId: occurrenceId }, opportunity, preparedAssessment });
      state.nativePreparingStop = work;
      void work.catch(error => {
        if (state.nativeRunId === runId) {
          stopChains.get(state)?.expire();
          try { api.logger.warn(`[runtime-corrector] Stop registration unavailable: ${error.code ?? error.name}`); } catch {}
        }
        complete();
      });
      if (!waitMs) { open = false; return; }
      void stopStatus({ state, runId, phase: "reviewing", progressId: occurrenceId, waiting: true,
        deadlineAt: until, signal: state.reviewController.signal, isCurrent: opportunity.isOpen, text: "正在审查当前成果。" });
      let timer;
      try {
        await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
        if (opportunity.decision) nativeStart.confirmOriginal(opportunity.admissionId);
        return opportunity.decision;
      } finally { open = false; clearTimeout(timer); stopStatus.close(state, runId, occurrenceId); }
    },
    async beforeAgentRun(event, ctx = {}) {
      if (!nativeHooks) return;
      const state = { sessionId: event.sessionId ?? ctx.sessionId, sessionKey: event.sessionKey ?? ctx.sessionKey, agentId: ctx.agentId ?? "main" };
      if (!state.sessionId || !state.sessionKey) return;
      const runId = ctx.runId ?? event.runId;
      // The reserved ID namespace may deny an unverifiable continuation, but
      // never grants admission. A persisted, checked receipt is still required.
      const owned = nativeStart.knowsRun(state, runId) || /^rc-stop-[a-f0-9]{64}$/u.test(runId ?? "");
      const deny = { outcome: "block", reason: "RC_STOP_ADMISSION_CLOSED", message: "RC 续修准入未能核实，未启动本次自动纠偏。" };
      try {
        if (!nativeHooks || internal(event, ctx)) return;
        return await beforeStopDeadline(async () => {
          const directory = sessionStopDirectory(state);
          if (directory) await initializeNativeHistory(state);
          const decision = await nativeStart.gate({ state, event, runId, signal: ctx.abortSignal });
          return owned && !decision ? deny : decision;
        }, { deadlineAt: Date.now() + 1000, signal: ctx.abortSignal });
      } catch (error) {
        try { api.logger.warn(`[runtime-corrector] Input check unavailable: ${error.code ?? error.name}`); } catch {}
        // MA fails this hook closed on throws/timeouts. RC's own health must
        // never veto ordinary input. Only a known RC continuation is denied.
        return owned ? deny : undefined;
      }
    },
    // These public awaited hooks run before our stateFor can replace the run.
    async beforeDispatch(event, ctx) { await waitForStop(event, ctx, "reply_dispatch"); },
    async beforeModelResolve(event, ctx = {}) {
      // This hook already owns the host session lane. Never wait here for a
      // continuation queued behind it. The normal chat entry waits outside.
      const state = [...states.values()].find(value => value.sessionKey === (event.sessionKey ?? ctx.sessionKey));
      if (!state || internal(event, ctx)) return;
      releaseBypassedEntry(state, ctx.runId ?? event.runId);
    },
    async sessionStart(event, ctx) {
      if (workers.has(event.sessionId ?? ctx.sessionId)) return;
      // A host can create a session before it has an RC-enabled project. Keep
      // that trusted creation fact in the host-level store so selecting its
      // project later does not require guessing the session's past usage.
      const source = event.source ?? (event.resumedFrom ? "resume" : "startup");
      if (nativeHooks && source === "startup" && settings.enabled !== false && !internal(event, ctx)) {
        const sessionId = event.sessionId ?? ctx.sessionId;
        const directory = sessionStopDirectory(ctx);
        if (sessionId && directory) await createStopCorrectionStore({ directory }).initializeSession({ sessionId,
          initialize: { kind: "NEW_SESSION", evidence: { hook: "session_start", sessionId, source } } });
      }
      return withState(event, ctx, async (state) => {
        try { const value = await context(state, "session_start"); await run(state, "SessionStart", { source }, value); }
        catch (error) { await failure(state, error, "SESSION_START"); }
      });
    },
    async prompt(event, ctx) {
      if (nativeHooks) {
        const state = states.get(`${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`);
        // A host-admitted retry may retain the runId after an attempt ended.
        // Reopen only our reviewer signal, never a reset/cancelled host run.
        if (state?.reviewController.signal.aborted && state.reviewController.signal.reason?.code === "RC_NATIVE_ATTEMPT_ENDED") {
          state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
          state.nativeInvalidated = false; state.nativeAssessment = null;
        }
      }
      return withState(event, ctx, async (state) => {
        try {
          const runId = ctx.runId ?? event.runId;
          if (nativeHooks) {
            const ownedRun = await findFollowup(state, runId);
            if (ownedRun) {
              state.nativeNeedsStop = true;
              const prepared = await nativeStart.prepare({ state, runId, signal: ctx.abortSignal });
              return prepared?.prependContext ? { prependContext: prepared.prependContext } : undefined;
            }
            const observed = await syncNative(state);
            if (observed.status !== "OBSERVED" || !observed.lastExternalUser
              || state.preparedNativeUsers === observed.externalUsersDigest) return;
            await followups.cancel({ projectRoot: state.projectRoot, state, reason: "NEW_USER_TURN" });
            await cancelStopScope(state, "NEW_USER_TURN");
            state.preparedNativeUsers = observed.externalUsersDigest;
            const previousTask = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
            const previousNotice = savedStopFeedbackNotice(previousTask);
            state.finalNotice = null; state.nativeAssessment = null;
            const prompt = observed.lastExternalUser.message.content.filter(x => x.type === "text").map(x => x.text).join("\n");
            const value = await context(state, "before_prompt_build");
            const outcome = await run(state, "UserPromptSubmit", { prompt }, value);
            if (previousNotice && state.lastVerificationNotice !== previousNotice.evaluationId) {
              state.lastVerificationNotice = previousNotice.evaluationId;
              return { prependContext: boundHostFeedback([outcome.feedback, previousNotice.feedback].filter(Boolean).join("\n\n"), {
                prefix: `${FEEDBACK}\n以下包含本轮反馈和上次 Stop 保留事项。历史评审及依据位置仅供定位，请结合当前文件和原要求核对；它不新增用户需求，也不证明当前文件仍有同一问题。`,
              }) };
            }
            if (outcome.feedback) return { prependContext: `${FEEDBACK}\n${outcome.feedback}` };
            return;
          }
          // Finalize retries reuse the runId. They are not new user messages
          // and must not reset the correction budget or alter Ground Truth.
          const realUser = [undefined, "user", "manual"].includes(ctx.trigger)
            && !workers.has(event.sessionId ?? ctx.sessionId)
            && (!state.hasPrompt || (runId && state.promptRunId !== runId));
          await persistTranscript(state, { messages: event.messages, prompt: event.prompt, realUser, runId });
          if (!realUser) return;
          state.promptRunId = runId;
          state.hasPrompt = true;
          state.finalNotice = null;
          const value = await context(state, "before_prompt_build", null, { direct: ctx.runtimeCorrectorDirectReview === true });
          const outcome = await run(state, "UserPromptSubmit", { prompt: event.prompt }, value);
          if (outcome.feedback) return { prependContext: `${FEEDBACK}\n${outcome.feedback}` };
        } catch (error) { const feedback=await failure(state, error, "PROMPT");if(feedback)return {prependContext:feedback}; }
      });
    },
    async beforeTool(event, ctx) {
      if (isInternalExecution()) {
        try {
          const decision = await observeInternalTool(event.toolName, event.params);
          if (decision) return decision;
        }
        catch (error) {
          // The private reviewer has already aborted its own controller. Give
          // the host a terminal tool decision instead of its fail-open wrapper.
          if (isReviewerContextBudgetError(error)) return { block: true, blockReason: error.message };
          throw error;
        }
      }
      // The pinned native runtime supplies only {runtime:"openclaw"} to
      // result middleware. Bind the exact call before execution; never infer
      // a session from cwd (several conversations can share one workspace).
      const callId = event.toolCallId ?? ctx.toolCallId;
      if (callId && ctx.sessionId) {
        const scope = await projects.resolve(event, ctx);
        const bindings = toolBindings.get(callId) ?? new Map();
        bindings.set(`${ctx.agentId ?? "main"}:${ctx.sessionId}:${ctx.runId ?? ""}`, {
          ...ctx, runtimeCorrectorScopeFingerprint: scope.fingerprint,
          runtimeCorrectorControlEnabled: scope.enabled,
          runtimeCorrectorEnabledRevision: states.get(`${ctx.agentId ?? "main"}:${ctx.sessionId}`)?.enabledRevision
            ?? pausedScopes.get(`${ctx.agentId ?? "main"}:${ctx.sessionId}`)?.enabledRevision ?? 0,
          ...(internal(event, ctx) ? { runtimeCorrectorInternal: true } : {}),
        });
        toolBindings.set(callId, bindings);
        if (toolBindings.size > 5000) toolBindings.delete(toolBindings.keys().next().value);
      }
      return withState(event, ctx, async (state) => {
        const id = event.toolCallId ?? ctx.toolCallId;
        if (!id) return;
        // The first event after a restart can be this tool call. Bind the
        // restored task revision rather than the pre-activation fallback zero.
        for (const binding of toolBindings.get(id)?.values() ?? []) {
          if (binding.sessionId === state.sessionId && (binding.agentId ?? "main") === state.agentId
            && (!binding.runId || binding.runId === (ctx.runId ?? event.runId))) binding.runtimeCorrectorEnabledRevision = state.enabledRevision;
        }
        const key = `pre:${id}`;
        if (state.seen.has(key)) return state.seen.get(key);
        try {
          const value = await context(state, "before_tool_call");
          if (nativeHooks) await initializeNativeHistory(state);
          const args = event.params ?? {};
          if (nativeHooks && ["Write", "Edit", "Bash", "Skill", "Monitor", "NotebookEdit"].includes(toolName(event.toolName))) state.nativeNeedsStop = true;
          if (nativeHooks && toolName(event.toolName) === "Bash" && value.plan.runtimeV2?.implementationCorrection?.enabled) {
            state.commandDigests ??= new Map(); state.commandDigests.set(id, await sourceDigest(state.projectRoot, value.plan));
          }
          await state.onProgress?.({ phase: ["write", "edit"].includes(String(event.toolName).toLowerCase()) ? "WRITING" : "TOOL_EXECUTION",
            file: args.path ?? args.file_path ?? null, toolName: event.toolName, toolCallId: id, startedAt: Date.now() });
          if (state.observedPaths) {
            const candidates = changedFiles(event.toolName, args, state.projectRoot, event.cwd ?? state.executionDirectory);
            for (const file of candidates) { const target = evidencePath(state.projectRoot, file); if (target) state.observedPaths.add(target); }
          }
          const skill = await selectedSkillRead(event.toolName, args, state, pluginRoot,
            value.plan.runtimeV2?.skillCorrection?.skillRoots);
          const name = skill ? "Skill" : toolName(event.toolName);
          if (!nativeHooks) state.entries.push({ type: "assistant", uuid: `oc-tool-${id}`, message: { id: `oc-tool-${id}`,
            content: [{ type: "tool_use", id, name, input: args }] } });
          await persistTranscript(state);
          const outcome = await run(state, "PreToolUse", { tool_name: name,
            tool_input: skill ? { skill } : args, tool_use_id: id }, value);
          // Advisory skill feedback travels with the read's tool result.
          if (outcome.feedback) state.seen.set(`feedback:${id}`, outcome.feedback);
          state.seen.set(key, undefined);
        } catch (error) { await failure(state, error, "PRE_TOOL"); }
      });
    },
    async toolResult(event, ctx) {
      // Check before resolving a bare call id: reviewer calls must never be
      // attached to a main task's binding, including after reviewer cleanup.
      if (internal(event, ctx)) {
        try { await observeInternalTool("read:result", event); }
        catch (error) {
          // Do not retain the oversized original in the transcript or append
          // feedback to it. This is solely the isolated review's read budget.
          if (isReviewerContextBudgetError(error)) return { result: {
            content: [{ type: "text", text: error.message }], isError: true,
            details: { code: error.code },
          } };
          throw error;
        }
        return;
      }
      if (!ctx.sessionId && !event.sessionId) {
        const bindings = [...(toolBindings.get(event.toolCallId)?.values() ?? [])];
        if (bindings.length !== 1) {
          if (bindings.length > 1) api.logger.warn("[runtime-corrector] Ambiguous tool call identity; result review skipped.");
          return;
        }
        ctx = { ...bindings[0], ...ctx };
      } else if (toolBindings.has(event.toolCallId)) {
        const matches = [...toolBindings.get(event.toolCallId).values()].filter(binding =>
          binding.sessionId === (ctx.sessionId ?? event.sessionId)
          && (!ctx.agentId || binding.agentId === ctx.agentId)
          && (!ctx.runId || !binding.runId || binding.runId === ctx.runId));
        if (matches.length !== 1) return;
        ctx = { ...matches[0], ...ctx, runtimeCorrectorScopeFingerprint: matches[0].runtimeCorrectorScopeFingerprint,
          runtimeCorrectorControlEnabled: matches[0].runtimeCorrectorControlEnabled,
          runtimeCorrectorEnabledRevision: matches[0].runtimeCorrectorEnabledRevision };
      }
      return withState(event, ctx, async (state) => {
        const id = event.toolCallId;
        if (!id || nativeHooks && isInteraction(event.result)) return;
        const key = `post:${id}`;
        if (state.seen.has(key)) return state.seen.get(key);
        let value;
        try {
          value = await context(state, "tool_result");
          const content = event.result?.content ?? [];
          state.entries.push({ type: "user", isMeta: true, uuid: `oc-result-${id}`, message: {
            content: [{ type: "tool_result", tool_use_id: id, content, is_error: event.isError === true }] } });
          await persistTranscript(state);
          if (nativeHooks && toolName(event.toolName) === "Bash" && value.plan.runtimeV2?.implementationCorrection?.enabled) {
            captureCommand(state, event, state.commandDigests?.get(id), await sourceDigest(state.projectRoot, value.plan));
            state.commandDigests?.delete(id);
          }
          const fields = { tool_name: toolName(event.toolName), tool_input: event.args ?? {},
            tool_response: event.result, tool_use_id: id };
          if (state.observedPaths && String(event.toolName).toLowerCase() === "read" && !event.isError && !event.result?.isError) {
            const target = event.args?.path ?? event.args?.file_path;
            const file = target && evidencePath(state.projectRoot, path.isAbsolute(target) ? target
              : state.executionDirectory ? path.resolve(state.executionDirectory, target) : "");
            if (file && await fs.stat(file).then(stat => stat.isFile()).catch(() => false)) state.observedPaths.add(file);
          }
          let feedback = state.seen.get(`feedback:${id}`);
          const files = event.isError || event.result?.isError ? [] : changedFiles(event.toolName, event.args ?? {}, state.projectRoot, event.cwd ?? state.executionDirectory);
          const existing = [];
          for (const file of files) { try { if ((await fs.stat(file)).isFile()) existing.push(file); } catch { /* Deleted file: covered by terminal review. */ } }
          const artifactTask = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
          if (artifactTask) for (const file of existing) {
            const contents = await fs.readFile(file);
            const snapshotFile = path.join(taskDirectory(state.projectRoot, artifactTask.taskId), "artifact-snapshots", `${hash(id + file)}.json`);
            await privateJson(snapshotFile, { file, toolCallId: id, recordedAt: Date.now(), fingerprint: await fingerprint(file),
              contents: contents.length <= 1024 * 1024 ? contents.toString("utf8") : null, omitted: contents.length > 1024 * 1024 });
            await appendTaskJournal(state.projectRoot, artifactTask.taskId, { type: "OPENCLAW_ARTIFACT_SNAPSHOT", file, toolCallId: id,
              snapshotPath: path.relative(state.projectRoot, snapshotFile) });
          }
          for (const file of existing.length ? existing : [null]) {
            if (file) await state.onProgress?.({ phase: "REVIEWING_ARTIFACT", file, toolCallId: id, startedAt: Date.now() });
            const input = inputFor(state, "PostToolUse", { ...fields, ...(file ? {
              tool_name: "Edit", tool_input: { ...fields.tool_input, file_path: file },
            } : {}) });
            const prepared = file ? await checkArtifact({ filePath: file, cwd: state.projectRoot, config: value.plan,
              projectRootSource: "session-project", deferPersistence: true, pluginRoot }) : { matched: false };
            const outcome = await handleRuntimeV2Event({ ...value, input,
              artifact: prepared.matched ? prepared.reviewContext.artifact : null });
            feedback = joined(feedback, outcome.feedback);
            if (!prepared.matched) continue;
            prepared.reviewContext.enabled = prepared.reviewContext.nodeReviewEnabled
              || (prepared.reviewContext.workflow?.incomingEdges?.length ?? 0) > 0 || Boolean(outcome.artifactReviewContext);
            const review = prepared.reviewContext.enabled ? await semanticArtifactReview(state, value, input, prepared, outcome) : null;
            if (!prepared.reviewContext.enabled) await outcome.reviewerHandle?.close();
            const finalized = await finalizeScopedArtifact(state, prepared, review);
            if (artifactTask) await appendTaskJournal(state.projectRoot, artifactTask.taskId, {
              type: "OPENCLAW_ARTIFACT_REVIEW", file, toolCallId: id,
              fingerprint: await fingerprint(file), requirementVersion: artifactTask.groundTruth.version,
              evidence: state.artifactEvidence?.() ?? null,
              result: finalized.result, feedback: finalized.feedback,
            });
            feedback = joined(feedback, finalized.feedback);
            if (outcome.artifactReviewContext) {
              const metrics = await finalizeArtifactRuntimeV2({ runtimeV2: value.plan.runtimeV2,
                projectRoot: state.projectRoot, taskId: outcome.taskId,
                artifactReviewContext: outcome.artifactReviewContext, semanticReview: review,
                delivered: !value.plan.runtimeV2?.shadowMode && Boolean(finalized.feedback) });
              feedback = joined(feedback, metrics.feedback);
            }
          }
          if (["Bash", "Write", "Edit"].includes(fields.tool_name)) {
            feedback = joined(feedback, checkEvidenceDistinctness({ projectRoot: state.projectRoot, plan: value.plan }));
          }
          const result = feedback && !value.plan.runtimeV2?.shadowMode ? { result: { ...event.result,
            content: [...content, { type: "text", text: `${FEEDBACK}\n${feedback}` }] } } : undefined;
          const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
          if (task) {
            for (const file of files) await appendTaskJournal(state.projectRoot, task.taskId, {
              type: "OPENCLAW_FILE_CHANGED", file, toolCallId: id, fingerprint: await fingerprint(file) });
            if (result) for (const file of files) await appendTaskJournal(state.projectRoot, task.taskId, {
              type: "OPENCLAW_FEEDBACK_DELIVERED", file, toolCallId: id, feedback, acknowledgement: "tool_result_middleware" });
            await state.onTaskState?.(task);
          }
          state.seen.set(key, result);
          await state.onProgress?.({ phase: "WAITING_FOR_WORKER", startedAt: Date.now() });
          if (state.seen.size > 3000) state.seen.clear();
          return result;
        } catch (error) {
          const feedback = await failure(state, error, "POST_TOOL");
          if (value && !value.plan.runtimeV2?.shadowMode) return { result: { ...event.result,
            content: [...(event.result?.content ?? []), { type: "text", text: feedback }] } };
        }
      });
    },
    async finalize(event, ctx) {
      const worker = workers.get(event.sessionId ?? ctx.sessionId);
      if (worker) {
        if (!worker.closed) worker.candidate = { ...event };
        return; // The controller assesses once, after native execution settles.
      }
      return withState(event, ctx, async (state) => {
        let value;
        const expectedRunId = ctx.runId ?? event.runId, reviewController = state.reviewController;
        try {
          await persistTranscript(state, nativeHooks ? {} : { messages: event.messages, transcriptPath: event.transcriptPath });
          if (nativeHooks) await initializeNativeHistory(state);
          if (nativeHooks && (state.nativeRunId !== expectedRunId || reviewController.signal.aborted)) return;
          value = await context(state, "before_agent_finalize",
            nativeHooks ? { deadlineAt: ctx.runtimeCorrectorReviewDeadlineAt, stopId: ctx.runtimeCorrectorStopId } : null,
            { direct: nativeHooks && ctx.runtimeCorrectorIndependentStop === true });
          const evidence = nativeHooks ? createEvidenceLedger(state.projectRoot) : null;
          const scopeDiagnostic = {};
          if (evidence) {
            for (const file of [value.plan.configPath, ...state.observedPaths]) if (file && await fingerprint(file) !== "missing") await evidence.observe(file);
            state.observeReviewTool = evidence.observeTool;
            const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
            if (task) value.assessmentContext = { ...value.assessmentContext, kind: "native-stop", mode: ctx.runtimeCorrectorVerificationOnly ? "verify_only" : "execute_and_correct",
              assessmentId: ctx.runtimeCorrectorStopId ?? `${expectedRunId}:stop${state.enabledRevision ? `:enabled-${state.enabledRevision}` : ""}${ctx.runtimeCorrectorReviewAttempt ? `:infra-${ctx.runtimeCorrectorReviewAttempt}` : ""}`, guard: decisionGuard(task), abortSignal: reviewController.signal,
              evidence: () => ({ ...evidence.snapshot(), scope: { ...scopeDiagnostic } }), evidenceMatches: async () => await scopeAllowed(state, reviewController, scopeDiagnostic) && await evidence.matches(), maxCorrections: value.plan.runtimeV2.stopCorrection.maxCorrectionsPerFlow };
          }
          const outcome = await run(state, "Stop", { stop_hook_active: event.stopHookActive === true,
            last_assistant_message: event.lastAssistantMessage ?? "" }, value);
          if (nativeHooks && (state.nativeRunId !== expectedRunId || reviewController.signal.aborted)) return;
          if (nativeHooks && outcome.stale) {
            const reasonCode = `STOP_ASSESSMENT_${String(outcome.evidenceFailure?.code ?? outcome.reason ?? 'STALE').replace(/[^a-z0-9]+/giu, '_').toUpperCase()}`;
            await cancelStopScope(state, reasonCode, ctx.runtimeCorrectorStopId);
            return { runId: expectedRunId, assessmentId: value.assessmentContext?.assessmentId,
              outcome: { decision: 'allow', status: 'UNVERIFIED', reasonCode, verificationIncomplete: true, stale: true } };
          }
          state.finalRunId = ctx.runId ?? event.runId;
          if (nativeHooks) {
            state.observeReviewTool = null;
            const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
            if (state.nativeRunId !== expectedRunId || reviewController.signal.aborted) return;
            if (task || outcome.handled) state.nativeAssessment = { outcome: outcome.stop
              ? { ...outcome, ...outcome.stop, decision: outcome.decision, feedback: outcome.feedback } : outcome,
              runId: expectedRunId, assessmentId: value.assessmentContext?.assessmentId,
              taskId: task?.taskId, evidence: evidence.snapshot(), usersDigest: state.nativeUserDigest };
            state.nativeAssessmentText = event.lastAssistantMessage;
          }
          state.finalNotice = value.plan.runtimeV2?.shadowMode ? null : outcome.decision === "block"
            ? nativeHooks ? "纠偏验收尚未通过；是否已接受续作以原生派发记录为准。" : "纠偏验收尚未通过。已要求修正；宿主可能因副作用保护、重试上限或中止而结束，最后的改动仍需重新验收。"
            : outcome.feedback ?? null;
          if (["block", "allow"].includes(outcome.decision)) await clearOuterStopFailures(state.projectRoot, state.scopeTaskId ?? state.sessionId);
          if (nativeHooks && ctx.runtimeCorrectorIndependentStop) {
            if (outcome.feedback && !value.plan.runtimeV2?.shadowMode) api.logger.warn(outcome.feedback);
            return state.nativeAssessment;
          }
          if (outcome.decision === "block" && outcome.feedback && (!nativeHooks || outcome.status !== "UNVERIFIED")) {
            api.logger.warn(`${FEEDBACK}\n${outcome.feedback}`);
            return {
            action: "revise", reason: `${FEEDBACK}\n${outcome.feedback}`,
            retry: { instruction: "继续修正以上问题；修正后重新完成验收。", idempotencyKey: `runtime-corrector:${state.sessionId}:${ctx.runId ?? event.runId}`,
              maxAttempts: value.plan.runtimeV2?.stopCorrection?.maxCorrectionsPerFlow },
            };
          }
          if (outcome.feedback && !value.plan.runtimeV2?.shadowMode) api.logger.warn(outcome.feedback);
        } catch (error) {
          if (nativeHooks && ctx.runtimeCorrectorIndependentStop) throw error;
          if (nativeHooks && (state.nativeRunId !== expectedRunId || reviewController.signal.aborted)) return;
          const feedback = await failure(state, error, "FINALIZE");
          state.finalRunId = ctx.runId ?? event.runId;
          state.finalNotice = value?.plan.runtimeV2?.shadowMode ? null : feedback;
          if (!nativeHooks && value?.plan.runtimeV2?.stopCorrection?.enabled && !value.plan.runtimeV2.shadowMode) {
            const { released } = await countOuterStopFailure(state.projectRoot, state.scopeTaskId ?? state.sessionId);
            if (!released) return { action: "revise", reason: feedback,
              retry: { instruction: "验收尚未完成；请保留未验证状态并重试。", maxAttempts: 3,
                idempotencyKey: `runtime-corrector-failure:${state.sessionId}:${ctx.runId ?? event.runId}` } };
          }
        }
      });
    },
    async reply(event, ctx = {}) {
      if (nativeHooks) {
        if (settings.enabled === false || internal(event, ctx) || event.kind !== "final" || !event.sessionKey) return;
        let state = [...states.values()].find(s => s.sessionKey === event.sessionKey);
        if (!state || state.nativeRunId !== event.runId || !await scopeCurrent(state)) return;
        if (state.nativeFinalizeKey === `${event.runId}:${state.nativeCallSequence ?? 0}:${hash(event.payload.text ?? "")}`) return;
        const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
        if (state.nativeRunId !== event.runId || !task || !state.nativeNeedsStop || !event.payload.text?.trim() || isInteraction(event.payload)) return; // Keep ordinary chat and host interaction native.
        const key = `${event.runId ?? "native"}:${hash(event.payload.text ?? "")}`;
        if (state.replyAssessmentKey === key) return;
        state.replyAssessmentKey = key;
        state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
        state.nativeInvalidated = false;
        const preparing = scheduleNativeStop(state, { text: event.payload.text, runId: event.runId, ctx });
        state.nativePreparingStop = preparing;
        state.nativeNeedsStop = false;
        void preparing.catch(() => stopChains.get(state)?.expire());
        return; // Progress belongs to UI events; deliver the host's answer now.
      }
      if (settings.enabled === false || internal(event, {}) || event.kind !== "final" || !event.runId) return;
      const matches = [...states.values()].filter((state) => state.finalRunId === event.runId
        && (!event.sessionKey || state.sessionKey === event.sessionKey)
        && (!event.usageState?.sessionId || state.sessionId === event.usageState.sessionId));
      if (matches.length !== 1 || (!matches[0].finalNotice && !(nativeHooks && matches[0].nativeAssessment))) return;
      const notice = nativeHooks ? await renderNativeSummary(api, matches[0]) : `${FEEDBACK}\n${matches[0].finalNotice}`;
      if (event.payload.text?.includes(notice)) return;
      return { payload: { ...event.payload, text: joined(event.payload.text, notice) } };
    },
    async compact(event, ctx) {
      return withState(event, ctx, async (state) => {
        try { const value = await context(state, "before_compaction");
          await run(state, "PreCompact", { trigger: "auto", custom_instructions: null }, value);
        } catch (error) { await failure(state, error, "COMPACT"); }
      });
    },
    async reset(event, ctx) {
      if (nativeHooks) await cancelNative(event, ctx);
      const key = `${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`;
      const paused = pausedScopes.get(key);
      if (paused) { await paused.controlPause.catch(() => {}); await projects.deactivate?.(paused.projectScope); pausedScopes.delete(key); }
    },
    async agentEnd(event, ctx = {}) {
      if (!nativeHooks || internal(event, ctx)) return;
      const key = `${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`;
      const state = states.get(key);
      const runId = event.runId ?? ctx.runId;
      if (!state || !runId) return;
      const controller = state.reviewController;
      const current = () => states.get(key) === state && state.nativeRunId === runId
        && state.reviewController === controller && !state.scopeClosed;
      // A terminal event may arrive after replacement, or become stale while
      // its scope/receipt is being read. It never owns the latest controller.
      if (!current() || !await scopeAllowed(state, controller) || !current()) return;
      const chain = stopChains.get(state);
      if (state.nativeFinalizeHandledRun === runId) {
        state.nativeEndedRun = runId;
        void nativeStart.finish({ state, runId }).catch(() => {});
        if (event.success === false || event.error || event.aborted) {
          if (chain?.runs.has(runId)) chain.cancel("RC_NATIVE_ATTEMPT_ENDED");
          controller.abort(Object.assign(new Error("RC_NATIVE_ATTEMPT_ENDED"), { code: "RC_NATIVE_ATTEMPT_ENDED" }));
          return;
        }
        // Only wait for queue acceptance, never for a same-session start.
        void handoffNativeStop(state).catch(error => {
          if (current() && stopChains.get(state) === chain) chain?.expire();
          try { api.logger.warn(`[runtime-corrector] Stop handoff unavailable: ${error.code ?? error.name}`); } catch {}
        });
        return;
      }
      const receipt = await findFollowup(state, runId);
      if (receipt?.admission) await nativeStart.finish({ state, runId });
      if (!current()) {
        if (receipt && !receipt.finishedAt) await followups.finish({ projectRoot: state.projectRoot, state, runId, status: "SUPERSEDED" });
        return;
      }
      if (event.success === false || event.error || event.aborted) {
        const reason = "RC_NATIVE_ATTEMPT_ENDED";
        state.nativeInvalidated = true;
        state.nativeTerminalAbortRunId = runId;
        if (chain?.runs.has(runId)) chain.cancel(reason);
        controller.abort(Object.assign(new Error(reason), { code: reason }));
        // Terminal cleanup is run/Stop-scoped; a later admitted task must not
        // be cancelled while an old ledger operation is awaiting I/O.
        if (receipt?.admission) {
          const stopId = receipt.admission.stopId;
          void cancelStopScope(state, reason, stopId).catch(() => {});
          await nativeStart.cancel({ state, reason, stopId });
        }
        if (receipt) {
          await followups.finish({ projectRoot: state.projectRoot, state, runId, status: "CANCELLED", reasonCode: "RC_NATIVE_ATTEMPT_ENDED" });
          // assessment mode has no waiting chain. The owned receipt still needs
          // a terminal task result; the same run/task guards forbid late writes.
          await settleIncompleteStop({ projectRoot: state.projectRoot, taskId: receipt.taskId, runId,
            reasonCode: "RC_NATIVE_ATTEMPT_ENDED", startedAt: receipt.createdAt,
            isCurrent: () => state.nativeRunId === runId && state.nativeTerminalAbortRunId === runId && !state.scopeClosed });
        }
        return;
      }
      // agent RPC with deliver:false bypasses reply_payload_sending. Only our
      // acknowledged business continuation gets this terminal checkpoint.
      if (!receipt || receipt.finishedAt || receipt.status === "CANCELLED") return;
      state.nativeTerminalRuns ??= new Set();
      if (state.nativeTerminalRuns.has(runId)) return;
      state.nativeTerminalRuns.add(runId);
      state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
      state.nativeInvalidated = false;
      const last = (event.messages ?? []).findLast(message => message.role === "assistant");
      const text = typeof last?.content === "string" ? last.content : (last?.content ?? [])
        .filter(block => block.type === "text").map(block => block.text).join("\n");
      await scheduleNativeStop(state, { text, runId, ctx, receipt });
    },
    async dispose() {
      if (nativeHooks) for (const state of states.values()) await cancelNative({ sessionId: state.sessionId, sessionKey: state.sessionKey });
      await nativeStart?.dispose();
    },
    async sessionEnd(event, ctx) {
      if (nativeHooks) {
        await cancelNative(event, ctx);
        const key = `${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`;
        const state = states.get(key) ?? pausedScopes.get(key);
        if (state) {
          await handleRuntimeV2SessionEnd({ projectRoot: state.projectRoot,
            env: { ...process.env, RUNTIME_CORRECTOR_TASK_ID: state.scopeTaskId },
            input: inputFor(state, "SessionEnd", { reason: event.reason ?? "unknown" }) });
          states.delete(state.key);
          pausedScopes.delete(state.key);
        }
        return;
      }
      if (workers.has(event.sessionId ?? ctx.sessionId)) return;
      return withState(event, ctx, async (state) => {
        await handleRuntimeV2SessionEnd({ projectRoot: state.projectRoot,
          env: { ...process.env, RUNTIME_CORRECTOR_TASK_ID: state.scopeTaskId },
          input: inputFor(state, "SessionEnd", { reason: event.reason ?? "unknown" }) });
        states.delete(state.key);
        for (const [id, bindings] of toolBindings) {
          for (const [key, binding] of bindings) if (binding.sessionId === state.sessionId && (binding.agentId ?? "main") === state.agentId) bindings.delete(key);
          if (!bindings.size) toolBindings.delete(id);
        }
      });
    },
  };
  const publicHandlers = { ...handlers };
  if (nativeHooks) for (const name of ["beforeDispatch", "beforeModelResolve", "sessionStart", "prompt", "beforeTool", "toolResult", "finalize", "reply", "compact"]) {
    publicHandlers[name] = async (event, ctx = {}) => {
      if (ctx.abortSignal?.aborted) return;
      const stateForHook=()=>event.sessionId??ctx.sessionId?states.get(`${ctx.agentId??'main'}:${event.sessionId??ctx.sessionId}`)
        :[...states.values()].find(state=>state.sessionKey===(event.sessionKey??ctx.sessionKey)&&state.agentId===(ctx.agentId??'main'));
      const previous = stateForHook(),previousController=previous?.reviewController;
      try {
        const hook = { beforeDispatch: "reply_dispatch", beforeModelResolve: "before_model_resolve", prompt: "before_prompt_build",
          beforeTool: "before_tool_call", reply: "reply_payload_sending", finalize: "before_agent_finalize" }[name] ?? name;
        const budget = name === "beforeModelResolve" ? 1000 : name === "beforeDispatch" ? Math.min(hookBudget(hook), 3599000) : hookBudget(hook);
        const deadlineAt=Date.now()+budget;
        return await beforeStopDeadline(() => handlers[name](event, {...ctx,runtimeCorrectorHookDeadlineAt:deadlineAt}), { deadlineAt, signal: ctx.abortSignal });
      }
      catch (error) {
        if (ctx.abortSignal?.aborted) return; // Cancelling a waiter does not cancel the task it was waiting for.
        if (previous?.scopeClosed || error.code === "RC_SESSION_DISABLED") return;
        const state = stateForHook();
        if(previous&&(state!==previous||state?.reviewController!==previousController))return;
        if (state?.scopeClosed) return;
        if (name === "finalize" && state && (state.nativeRunId !== (ctx.runId ?? event.runId)
          || state.reviewController.signal.aborted)) return;
        const feedback = `${FEEDBACK} RC_REVIEW_UNVERIFIED: ${error.code ?? error.name}`;
        if (state) {
          state.nativeInvalidated = true;
          stopChains.get(state)?.cancel("RC_HOOK_UNAVAILABLE");
          // Release first. Disk writes and backend cleanup are best effort.
          void failure(state, error, name).catch(() => {});
          state.reviewController?.abort(error);
        }
        if (state) { state.finalRunId = ctx.runId ?? event.runId; state.finalNotice = feedback; }
        // RC health is not host authorization. Preserve native approvals,
        // questions, errors and execution; never turn our exception into veto.
        if (name === "toolResult" && event.result && !isInteraction(event.result)) return { result: { ...event.result,
          content: [...event.result.content ?? [], { type: "text", text: feedback }] } };
        if (name === "reply" && event.payload) return { payload: { ...event.payload, text: joined(event.payload.text, feedback) } };
        if (name === "beforeTool" && state) state.seen.set(`feedback:${event.toolCallId ?? ctx.toolCallId}`, feedback);
        return undefined;
      }
    };
  }
  return { ...publicHandlers, internalSessions,
    projects,
    async reconcileSessionControl(ctx) {
      const scope = await projects.resolve({}, ctx);
      await reconcilePausedScope(scope);
      for (const state of [...states.values()]) {
        if (state.agentId === scope.identity?.agentId && state.sessionId === scope.identity?.sessionId
          || scope.projectRoot && state.projectRoot === scope.projectRoot) await scopeCurrent(state);
      }
      return scope;
    },
    async manualCheck(ctx, subject, { toolCallId, signal } = {}) {
      if (nativeHooks && toolCallId) {
        // Tool factory contexts lack runId in the native host. Recover only
        // the exact pre-execution binding, never the latest run in a workspace.
        const matches = [...(toolBindings.get(toolCallId)?.values() ?? [])].filter(binding =>
          (!ctx.sessionId || binding.sessionId === ctx.sessionId)
          && (!ctx.sessionKey || binding.sessionKey === ctx.sessionKey)
          && (!ctx.agentId || binding.agentId === ctx.agentId)
          && (!ctx.runId || binding.runId === ctx.runId));
        if (matches.length !== 1 || !matches[0].runId) throw new Error("RC_CHECK_INVOCATION_UNAVAILABLE");
        const binding = matches[0];
        ctx = { ...binding, ...ctx, runId: binding.runId,
          runtimeCorrectorScopeFingerprint: binding.runtimeCorrectorScopeFingerprint,
          runtimeCorrectorEnabledRevision: binding.runtimeCorrectorEnabledRevision,
          abortSignal: AbortSignal.any([binding.abortSignal, ctx.abortSignal, signal].filter(Boolean)) };
      } else if (signal) ctx = { ...ctx, abortSignal: AbortSignal.any([ctx.abortSignal, signal].filter(Boolean)) };
      ctx.assertInvocationCurrent?.();
      if (ctx.abortSignal?.aborted) throw new Error("RC_CHECK_CANCELLED");
      const scope = await projects.resolve({}, ctx);
      if (!scope.enabled) throw new Error(scope.reason ?? "RC_PROJECT_NOT_ENABLED");
      if (ctx.runtimeCorrectorScopeFingerprint && ctx.runtimeCorrectorScopeFingerprint !== scope.fingerprint)
        throw new Error("RC_CHECK_SCOPE_CHANGED");
      const state = states.get(`${ctx.agentId ?? "main"}:${ctx.sessionId}`);
      if (nativeHooks && (staleStopRun(state, {}, ctx) || state?.nativeInvalidated || state?.reviewController?.signal.aborted
        || !ctx.runId && (stopChains.get(state ?? {})?.pending || state && stopReviews.pending(state).length)))
        throw new Error("RC_CHECK_INVOCATION_UNAVAILABLE");
      const file = await fs.realpath(path.resolve(scope.projectRoot, subject));
      if (!evidencePath(scope.projectRoot, file)) throw new Error("RC_CHECK_OUTSIDE_PROJECT");
      const result = await withState({}, ctx, async state => {
        ctx.assertInvocationCurrent?.();
        if (ctx.abortSignal?.aborted) throw new Error("RC_CHECK_CANCELLED");
        const value = await context(state, "tool_result");
        const prepared = await checkArtifact({ filePath: file, cwd: state.projectRoot, config: value.plan,
          projectRootSource: "session-project", deferPersistence: true, pluginRoot });
        if (!prepared.matched) throw new Error("RC_CHECK_UNMATCHED_ARTIFACT");
        const review = prepared.reviewContext.enabled ? await semanticArtifactReview(state, value,
          inputFor(state, "ManualCheck"), prepared) : null;
        return finalizeScopedArtifact(state, prepared, review);
      });
      ctx.assertInvocationCurrent?.();
      if (ctx.abortSignal?.aborted) throw new Error("RC_CHECK_CANCELLED");
      if (!result) throw new Error("RC_CHECK_SCOPE_OR_EVIDENCE_UNAVAILABLE");
      return result;
    },
    waitForNativeReviews: async options => {
      await Promise.all([...states.values()].map(state => state.nativePreparingStop?.catch(() => {})));
      const results = await (stopReviews?.wait({ settle: true, ...options }) ?? Promise.resolve([]));
      await Promise.all([...(sharedState.stopWaitChains?.values() ?? [])].map(chain => chain.cleanup));
      return results;
    },
    async evidenceFiles(state) {
      const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
      const observed = [...state.observedPaths ?? []], files = new Set();
      // Past reads/writes are a discovery list, not a required-file contract.
      // Capture current artifacts; explicitly declared paths are added below
      // even when missing. Deletion during assessment still invalidates bytes.
      for (const file of observed) if (await fingerprint(file) !== "missing") files.add(file);
      const userText = (state.entries ?? []).filter((entry) => entry.type === "user" && !entry.isMeta)
        .map((entry) => JSON.stringify(entry.message.content)).join("\n");
      const artifacts = plan.artifacts ?? [];
      const captures = [];
      for (const file of observed) for (const artifact of artifacts) {
        const match = matchPathTemplates(path.relative(state.projectRoot, file), artifact.pathMatcher?.templates);
        if (match) captures.push(match.captures);
      }
      for (const artifact of artifacts) for (const template of artifact.pathTemplates ?? []) {
        if (!userText.includes(path.basename(template))) continue;
        for (const instance of captures) {
          const resolved = template.replace(/\{([a-zA-Z][\w]*)\}/gu, (all, key) => instance[key] ?? all);
          if (!resolved.includes("{")) files.add(path.resolve(state.projectRoot, resolved));
        }
      }
      for (const file of [plan.configPath, ...artifacts.flatMap((artifact) => [artifact.reviewerFile, artifact.simpleRulesFile])]) {
        if (file) files.add(file);
      }
      return [...files];
    },
    async restoreBinding(binding) {
      const state = await stateFor({}, { ...binding, modelProviderId: binding.provider, modelId: binding.modelId });
      if (!state) throw new Error("RC_SESSION_PROJECT_NOT_ENABLED");
      await persistTranscript(state);
      restoreObservedPaths(state);
      return state;
    },
    async effectiveReviewTimeout(binding) {
      const plan = await loadConfig({ cwd: binding.workspaceDir, pluginRoot });
      return Math.max(1, directReviewBudget(plan, "before_agent_finalize"));
    },
    isWorker: (sessionId, projectRoot) => workers.has(sessionId) || isPersistedWorker(projectRoot, sessionId),
    async beginSupervised(params, abortSignal, { deadlineAt, continuation = false } = {}) {
      // Validate host-specific project settings before a worker can perform
      // side effects, rather than discovering a CLI reviewer at finalization.
      await loadConfig({ cwd: params.workspaceDir, pluginRoot });
      const ctx = { ...params, modelProviderId: params.provider, modelId: params.modelId };
      const state = await stateFor({}, ctx);
      if (!state) throw new Error("Cannot create a controller inside an internal review.");
      state.abortSignal = abortSignal;
      state.supervised = true;
      state.runDeadlineAt = deadlineAt;
      state.observedPaths = new Set();
      await bindInteraction(params);
      if (!continuation) await handlers.prompt({ prompt: params.transcriptPrompt ?? params.prompt }, { ...ctx, trigger: "user", runtimeCorrectorDirectReview: true });
      return state;
    },
    bindWorker(sessionId, state) {
      if (workers.has(sessionId)) throw new Error("OpenClaw worker identity is already registered.");
      const binding = { state, closed: false };
      workers.set(sessionId, binding);
      return { binding, setRun(runId) { binding.runId = runId; binding.settled = false; },
        endRun() { binding.settled = true; }, close() { binding.closed = true; } };
    },
    async commitRequirement(state, text, receipt, abortSignal, deadlineAt) {
      const prior = state.abortSignal;
      state.abortSignal = abortSignal;
      try {
        await persistTranscript(state, { prompt: text, realUser: true, runId: `${receipt.commandId}/${receipt.actionId}` });
        const value = await context(state, "before_agent_finalize", { assessmentId: `${receipt.key}:baseline`,
          guard: receipt.guard, pendingRequirement: receipt.key, abortSignal, deadlineAt }, { direct: true });
        return await refreshRuntimeRequirements({ ...value, input: inputFor(state, "UserPromptSubmit", { prompt: text }) });
      } finally { state.abortSignal = prior; }
    },
    async acceptRequirement(state, text, id) {
      return queue(state, async () => {
        await persistTranscript(state, { prompt: text, realUser: true, runId: id });
        return run(state, "UserPromptSubmit", { prompt: text, hook_event_id: id }, await context(state, "before_prompt_build", null, { direct: true }));
      });
    },
    async assessSupervised(state, { transcriptPath, text, assessmentId, stopHookActive, abortSignal = state.abortSignal,
      assessmentContext = {}, mode = "execute_and_correct", deadlineAt }) {
      return queue(state, async () => {
        const parentSignal = state.abortSignal;
        state.abortSignal = abortSignal;
        try {
        abortSignal?.throwIfAborted();
        await persistTranscript(state, { transcriptPath });
        const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
        const value = await context(state, "before_agent_finalize", { ...assessmentContext,
          guard: assessmentContext.guard ?? (task ? decisionGuard(task) : {}), mode, assessmentId,
          abortSignal, deadlineAt: deadlineAt ?? state.runDeadlineAt }, { direct: true });
        const outcome = await run(state, "Stop", { stop_hook_active: stopHookActive,
          last_assistant_message: text, hook_event_id: assessmentId }, value);
        abortSignal?.throwIfAborted();
        return { ...outcome, ...outcome.stop, shadowMode: value.plan.runtimeV2?.shadowMode === true };
        } finally { state.abortSignal = parentSignal; }
      });
    },
  };
}
