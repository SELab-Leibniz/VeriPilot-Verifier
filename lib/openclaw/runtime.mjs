import { createRepairStepBudget } from './repair-step-budget.mjs';
import { matchPathTemplates } from "../path-template.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { observeNativeTranscript, observeNativeToolPolicy, nativeToolPolicyDigest } from "./native-transcript.mjs";
import { hostDeviceVerifier, captureCommand, sourceDigest, isInteraction } from "./native-evidence.mjs";
import { renderNativeSummary } from "./native-summary.mjs";
import { createNativeFollowups } from "./native-followup.mjs";
import { createNativeStopReviews } from "./native-stop-review.mjs";
import { createStopReviewCoveragePublicationObserver, createStopReviewCoverageReceipt } from "./stop-review-coverage-receipt.mjs";
import { summarizeStopReviewCoverage, currentStopReviewMethodScope } from '../runtime-v2/stop-review-coverage.mjs';
import { prepareMaterialBasis, invalidateMaterialBasis, fixedMaterialRoots } from "./material-basis.mjs";
import { createPostRunDispatcher } from "./post-run-dispatch.mjs";
import { waitPostRunTerminal, completedToolWarningTerminal, createPostRunHostRequester, readAutopilotStatus } from "./post-run-host.mjs";
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
import { documentArtifactPaths } from "../document-tools.mjs";
import { groupDocumentReviews, documentReviewBundleKey, documentReviewBundleCurrent } from './document-review-bundle.mjs';
import { readOpenSpecPlan } from "../openspec-plan.mjs";
import { handleRuntimeV2Event, handleRuntimeV2SessionEnd, refreshRuntimeRequirements, finalizeArtifactRuntimeV2 } from "../runtime-v2/orchestrator.mjs";
import { createAcceptanceFeedback } from "../runtime-v2/acceptance-feedback.mjs";
import { archivesUserMessages, buildOriginalRequirements, recordUserMessages, transcriptUserMessages } from "../runtime-v2/original-requirements.mjs";
import { materialManifest } from "../runtime-v2/onboarding.mjs";
import { frameReproduction, requirementFrameEnabled, startRequirementFrame, takeFrameBrief } from "../runtime-v2/requirement-frame.mjs";
import { recordFailOpenWarning, countOuterStopFailure, clearOuterStopFailures } from "../runtime-v2/fail-open.mjs";
import { createOpenClawReviewerFactory, INTERNAL_SESSION_MARKER } from "./reviewer.mjs";
import { persistTranscript } from "./transcript.mjs";
import { changedFiles, isNoopToolRequest, selectedSkillRead, sessionSkillPlan, toolName, isDocumentCommand, snapshotDocumentFiles, documentCommandChanges } from "./tools.mjs";
import { checkEvidenceDistinctness } from "../evidence-distinctness.mjs";
import { isInternalExecution, isManagedExecution, observeInternalTool, isHostMaintenanceRun } from "./internal-context.mjs";
import { bindInteraction } from "./interaction-store.mjs";
import { evidencePath, fingerprint, createEvidenceLedger, matchesEvidence } from "./evidence.mjs";
import { findTask, decisionGuard, appendTaskJournal, taskDirectory, ensureTask, withTaskDecision, withTaskState } from "../runtime-v2/task-store.mjs";
import { captureTaskStart } from "../runtime-v2/task-changes.mjs";
import { recordObservation } from '../runtime-v2/response-record.mjs';
import { privateJson } from "./controller-store.mjs";
import { isPersistedWorker } from "./controller-store.mjs";
import { createSessionProjects } from "./session-projects.mjs";
import { sessionIdentity, currentSession } from "./project-compat.mjs";
import { hookReviewBudgetMs, resolveHookTimeoutMs, hotHookTimeoutMs, isHotHook } from "./hook-timeout.mjs";
import { DEFAULT_REVIEW_TIMEOUT_MS } from "../review-timeout.mjs";
import { outsideDecision, decisionScope } from "../runtime-v2/decision-scope.mjs";
import { createStopCorrectionStore } from "../runtime-v2/stop-correction-store.mjs";
import { collectSourceManifest } from "../runtime-v2/impl-review.mjs";
import { createStopStartProtocol, loadStopStartCompatibility } from "./stop-start-protocol.mjs";
import { admissionTiming } from "./admission-timing.mjs";
import { beforeStopDeadline } from "../runtime-v2/stop-deadline.mjs";
import { releaseDocumentSessions } from '../document-session.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';
import { isSkillFileName } from "../runtime-v2/skill-source.mjs";
import { approvedApplyRepairCurrent, approvedCoverageForApply, approvedInventoryForApply, approvedTaskProgressForApply, assessOpenSpecPlanRestoration, beginOpenSpecRun, hasApprovedApplyInventory,
  hasArmedOpenSpecApply, inspectArmedOpenSpecApply, openSpecApplyFinding,
  observeApprovedApplyRepairStart, openSpecProposalReviewRequirements, openSpecRestorationFeedback, openSpecRestorationFeedbackCurrent, PLAN_RESTORATION_PURPOSE,
  readApprovedOpenSpecRestoration, releaseOpenSpecProposalSession, reserveApprovedApplyRepair } from "./openspec-plan-control.mjs";
import { knownOriginalObligationReader, forgetKnownOriginalObligations } from '../runtime-v2/known-original-obligations.mjs';
import { bindHostOriginalCoverage, cloneHostLegacyOriginalCoverage, cloneHostOriginalReview,
  originalDutyContextFromCapture } from '../runtime-v2/original-duty-publication.mjs';
import { captureOriginalDutyPublication, originalDutyPublicationCurrent,
  publishOriginalDutyArtifact } from '../runtime-v2/original-duty-artifact-publication.mjs';
import { recordProposalCoverage } from "./approved-plan-coverage.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const joined = (...items) => items.filter(Boolean).join("\n\n");
const FEEDBACK = "[runtime-corrector:feedback]";
// Only the task-store producer's typed timeout receives this static diagnostic.
// Catch labels describe our phase; lock paths and error messages stay out of it.
const TASK_LOCK_PHASES = Object.freeze({
  toolResult: 'while observing a host tool result', POST_TOOL: 'while observing a host tool result',
  beforeTool: 'during the pre-tool check', PRE_TOOL: 'during the pre-tool check',
  prompt: 'while preparing prompt context', PROMPT: 'while preparing prompt context',
  BACKGROUND_REVIEW: 'during deferred review', NATIVE_STOP_REVIEW: 'during Stop review',
  agentEnd: 'during end-of-run bookkeeping',
  finalize: 'during final review bookkeeping', FINALIZE: 'during final review bookkeeping',
  reply: 'while preparing response feedback',
  sessionStart: 'during session setup', SESSION_START: 'during session setup',
  compact: 'during review compaction', COMPACT: 'during review compaction',
  beforeDispatch: 'before response dispatch', beforeModelResolve: 'before model selection',
});
function taskLockFeedback(error, phase) {
  if (error?.code !== 'TASK_STATE_LOCK_TIMEOUT') return '';
  const context = Object.hasOwn(TASK_LOCK_PHASES, phase) ? TASK_LOCK_PHASES[phase] : 'during review bookkeeping';
  const retained = phase === 'toolResult' || phase === 'POST_TOOL' ? ' The original host tool result is retained.' : '';
  return `${FEEDBACK} RC_REVIEW_UNVERIFIED: TASK_STATE_LOCK_TIMEOUT. Runtime Corrector could not acquire its state lock within the existing wait limit ${context}.${retained} This check did not finish.`;
}

const approvedCoverage = Symbol("approved OpenSpec coverage");
const approvedInventory = Symbol("approved OpenSpec production inventory");
const COMPACTION_RESTORE_LIMIT = 24 * 1024;
const COMPACTION_RESTORE_HEADER = "[runtime-corrector:internal]\n压缩前用户原文，供恢复本会话需求：\n\n";
const COMPACTION_RESTORE_TRUNCATED = "\n\n[原文超过长度上限，已截断]";
const EDIT_OLD_TEXT_MISMATCH = /^Could not find (?:the exact text|edits\[\d+\]) in [^\r\n]+\. The old text must match exactly including all whitespace and newlines\.(?:$|\r?\n)/u;
// Match the shared correction barrier before context captures the first
// originals; a detached barrier must never create the task after execution.
const CORRECTION_ENTRY_TOOLS = new Set(["Write", "Edit", "Bash", "PowerShell", "NotebookEdit", "Skill", "Monitor"]);
// Pre-checks of other calls capture no pre-change evidence; PostToolUse and Stop
// re-derive the run from the transcript. A Skill read is recognized only after
// an asynchronous source lookup, so its file name counts as an entry here.
function observationOnlyCall(name, args) {
  const tool = toolName(name), file = args?.path ?? args?.file_path ?? args?.filePath;
  return !CORRECTION_ENTRY_TOOLS.has(tool) && !(tool === "Read" && typeof file === "string" && isSkillFileName(path.basename(file)));
}
const materialGuards = new WeakMap();
function guardMaterialPublication(context, basis) {
  if (!context || !basis || materialGuards.get(context) === basis.taskId) return;
  const previous = context.evidenceMatches;
  context.evidenceMatches = async () => {
    if (previous && !await previous()) return false;
    if (await basis.current()) return true;
    context.evidenceFailure = { code: "MATERIAL_BASIS_UNVERIFIED", reason: "Initial original material bytes or declared scope changed." };
    return false;
  };
  materialGuards.set(context, basis.taskId);
}

function createLateCandidateBridge({ states, getDispatcher, postIdentity, stateFor, scopeCurrent,
  findTask, withTaskState, appendTaskJournal, sha256, hash, readAutopilotStatus, api, postHostRequest }) {
  const identityKeys = ['agentId', 'sessionId', 'sessionKey', 'projectRoot', 'scopeFingerprint', 'scopeTaskId', 'controlRevision'];
  const sameIdentity = (a, b) => identityKeys.every(key => key === 'controlRevision'
    ? (a?.[key] ?? 0) === (b?.[key] ?? 0) : a?.[key] === b?.[key]);
  const identityOf = value => Object.fromEntries(identityKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const stateKey = value => `${value.agentId ?? 'main'}:${value.sessionId}`;
  const cache = new WeakMap(), recovered = new WeakMap();
  function entryFor(state, identity = postIdentity(state)) {
    const key = sha256(identityOf(identity));
    let entry = cache.get(state);
    if (!entry || entry.key !== key) {
      entry = { key, version: 0, digest: null, pending: new Set(), tainted: false, batchFailed: false };
      cache.set(state, entry);
    }
    return entry;
  }
  function fingerprint(checkpoint) {
    // Keep the existing 24hex text digest. This independent full SHA256 binds
    // EVERY original checkpoint field, not just the terminal reply text.
    const { status, adoption, checkpointDigest, ...immutable } = checkpoint;
    return sha256(immutable);
  }
  function invalidate(state) {
    const entry = entryFor(state), token = { entry, controller: state.reviewController, committed: false };
    if (!entry.pending.size) entry.batchFailed = false;
    entry.pending.add(token); entry.version++; entry.digest = null;
    return token;
  }
  function persisted(state, checkpoint, token) {
    if (!token?.entry.pending.has(token) || cache.get(state) !== token.entry || state.reviewController !== token.controller) return;
    // Never publish a writer's captured snapshot. A concurrent writer may
    // still be waiting for the task lock; a later lease reads actual disk.
    fingerprint(checkpoint); token.committed = true;
  }
  function settled(state, token) {
    if (!token?.entry.pending.delete(token)) return;
    const entry = token.entry;
    if (!token.committed && state.reviewController === token.controller) entry.batchFailed = true;
    entry.version++; entry.digest = null;
    if (!entry.pending.size) entry.tainted = entry.batchFailed;
  }
  async function write(state, persist) {
    const token = invalidate(state);
    try {
      const checkpoint = await persist();
      if (checkpoint) persisted(state, checkpoint, token);
      return checkpoint;
    } finally { settled(state, token); }
  }
  function checkpointValid(checkpoint, identity, predecessorRunId) {
    return checkpoint && ['UNVERIFIED', 'ADOPTED'].includes(checkpoint.status)
      && checkpoint.reasonCode === 'POST_RUN_CANDIDATE_OWNER_CONFLICT'
      && typeof checkpoint.runId === 'string' && checkpoint.runId.length > 0 && checkpoint.runId.length <= 512
      && checkpoint.runId !== predecessorRunId && checkpoint.ownerRunId === predecessorRunId
      && checkpoint.identity && !Object.keys(checkpoint.identity).some(key => !identityKeys.includes(key))
      && sameIdentity(checkpoint.identity, identity) && typeof checkpoint.text === 'string'
      && checkpoint.text.length <= 200000 && checkpoint.truncated === false
      && checkpoint.digest === hash(checkpoint.text) && typeof checkpoint.needsReview === 'boolean'
      && [checkpoint.reviewBudgetMs, checkpoint.terminalBudgetMs].every(ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 2147483647)
      && Number.isFinite(checkpoint.recordedAt);
  }
  function taskCanRegister(task, checkpoint) {
    if (task?.control?.cancelled || task?.control?.pendingRequirement) return false;
    return task?.status === 'ACTIVE' || task?.status === 'STOPPED_UNVERIFIED'
      && task.verification?.status === 'UNVERIFIED' && task.verification.terminalRunId === checkpoint?.runId
      && task.verification.reasonCode === 'POST_RUN_CANDIDATE_OWNER_CONFLICT'
      && task.verification.reasonCode === checkpoint?.reasonCode;
  }
  const promotionMatches = (record, provenance) => record?.promotion && provenance
    && sameIdentity(record, provenance.identity) && sameIdentity(record.promotion.identity, provenance.identity)
    && ['predecessorRunId', 'runId', 'checkpointDigest', 'adoptedVersion', 'terminalRunId', 'terminalStatus', 'terminalConfirmedAt']
      .every(key => record.promotion[key] === provenance[key]);
  function eligible(record) {
    if (getDispatcher()?.closed || record?.successorAdmissionClosed || record?.reconciliation?.status === 'UNKNOWN'
      || record?.correctionRunId || record?.dispatching || record?.terminalRelease) return false;
    if (['FINALIZING', 'COEXIST_WAIT'].includes(record?.phase)) return record.candidate?.runId === record.runId;
    return record?.phase === 'IDLE' && record.lastTerminal?.runId === record.runId
      && ['ok', 'error'].includes(record.lastTerminal.status) && Number.isFinite(record.lastTerminal.confirmedAt);
  }
  function liveState(state, controller, identity) {
    return states.get(stateKey(identity)) === state && state.reviewController === controller && !controller.signal.aborted
      && !state.scopeClosed && !state.nativeInvalidated && sameIdentity(postIdentity(state), identity);
  }
  async function source(state, record, predecessorRunId = record.runId) {
    const identity = identityOf(record), entry = entryFor(state, identity), version = entry.version;
    if (entry.pending.size || entry.tainted) return null;
    const task = await findTask({ projectRoot: record.projectRoot, sessionId: record.sessionId, explicitTaskId: record.scopeTaskId });
    const checkpoint = task?.stop?.postRunCandidate;
    if (!taskCanRegister(task, checkpoint) || (task.control?.enabledRevision ?? 0) !== (record.controlRevision ?? 0)
      || !checkpointValid(checkpoint, identity, predecessorRunId) || cache.get(state) !== entry || entry.version !== version
      || entry.pending.size || entry.tainted) return null;
    const digest = fingerprint(checkpoint);
    // A concurrent producer invalidates before its write starts, then publishes
    // a new cache generation after success; an old read cannot overwrite it.
    entry.digest = digest;
    return { taskId: task.taskId, checkpoint: structuredClone(checkpoint), identity, digest, version };
  }
  function mayUseSource(state, controller, lease, predecessorRunId) {
    if (!liveState(state, controller, lease.identity)) return false;
    const entry = cache.get(state);
    if (!entry || entry.key !== sha256(identityOf(lease.identity)) || entry.pending.size || entry.tainted
      || entry.version !== lease.version || entry.digest !== lease.digest) return false;
    if (state.nativeRunId === lease.checkpoint.runId) return true;
    const recovery = recovered.get(state);
    return state.nativeRunId === predecessorRunId && recovery?.runId === predecessorRunId && recovery.controller === controller;
  }
  async function acknowledge(record, provenance, state, controller) {
    const dispatcher = getDispatcher(), actual = dispatcher?.snapshot(record);
    if (!promotionMatches(actual, provenance) || actual.phase === 'CLOSED' || actual.successorAdmissionClosed
      || actual.runId !== provenance.runId || !liveState(state, controller, provenance.identity)) return false;
    const recovery = recovered.get(state);
    if (state.nativeRunId !== provenance.runId) {
      // Only a state built explicitly by postState during recovery may move
      // from the durable predecessor to its promoted successor. Never call
      // stateFor with a runId or rewrite a real admitted business controller.
      if (recovery?.runId !== provenance.predecessorRunId || recovery.controller !== controller
        || state.hotReviewWork) return false;
      state.nativeRunId = provenance.runId;
      state.nativeNeedsStop = actual.candidate?.needsReview === true;
      state.postRunEnabled = true;
      recovered.set(state, { runId: provenance.runId, controller });
    }
    // Run restoration follows the already committed scheduler owner; it must
    // not depend on task ACK storage being available. Actual review still has
    // its normal terminal/source/publication guards.
    const lease = await source(state, actual, provenance.predecessorRunId);
    if (!lease || lease.checkpoint.runId !== provenance.runId || lease.digest !== provenance.checkpointDigest
      || !mayUseSource(state, controller, lease, provenance.predecessorRunId)) return false;
    if (recovered.get(state)?.runId === provenance.runId) {
      state.nativeNeedsStop = lease.checkpoint.needsReview; state.postRunEnabled = true;
    }
    let marked = false;
    await withTaskState({ projectRoot: actual.projectRoot, taskId: lease.taskId }, saved => {
      const latest = getDispatcher()?.snapshot(actual), checkpoint = saved.stop?.postRunCandidate;
      if (!liveState(state, controller, provenance.identity) || state.nativeRunId !== provenance.runId
        || !taskCanRegister(saved, checkpoint) || saved.taskId !== lease.taskId
        || (saved.control?.enabledRevision ?? 0) !== (provenance.identity.controlRevision ?? 0)
        || !promotionMatches(latest, provenance) || latest.phase === 'CLOSED' || latest.successorAdmissionClosed
        || latest.runId !== provenance.runId || !checkpointValid(checkpoint, provenance.identity, provenance.predecessorRunId)
        || checkpoint.runId !== provenance.runId || fingerprint(checkpoint) !== provenance.checkpointDigest) return;
      if (checkpoint.status === 'ADOPTED' && checkpoint.adoption?.checkpointDigest === provenance.checkpointDigest) return;
      checkpoint.status = 'ADOPTED'; checkpoint.adoption = structuredClone(provenance); marked = true;
      // Registration is acknowledged, not task acceptance. Do not change
      // saved.verification or clear any independent UNVERIFIED protection.
    });
    if (marked) {
      const entry = entryFor(state, provenance.identity); entry.version++; entry.digest = null;
      await appendTaskJournal(actual.projectRoot, lease.taskId, { type: 'POST_RUN_CANDIDATE_ADOPTED',
        runId: provenance.runId, predecessorRunId: provenance.predecessorRunId,
        checkpointDigest: provenance.checkpointDigest, adoptedVersion: provenance.adoptedVersion });
    }
    return marked;
  }
  async function postState(record) {
    let state = states.get(stateKey(record));
    if (!state) {
      state = await stateFor({}, { agentId: record.agentId, sessionId: record.sessionId,
        sessionKey: record.sessionKey, workspaceDir: record.projectRoot });
      // stateFor awaited scope resolution. A real run may have won that race.
      if (state && state.nativeRunId === undefined && states.get(stateKey(record)) === state
        && !state.reviewController.signal.aborted && !state.scopeClosed && sameIdentity(postIdentity(state), record)) {
        state.nativeRunId = record.runId; state.postRunEnabled = true;
        recovered.set(state, { runId: record.runId, controller: state.reviewController });
      }
    }
    if (state && record.promotion) {
      // Covers a process ending after scheduler commit but before callback.
      // The persisted adoptedVersion is stable; current record.version can grow.
      try { await acknowledge(record, record.promotion, state, state.reviewController); }
      catch (error) { api.logger?.warn?.(`[runtime-corrector] Candidate acknowledgement unavailable: ${error.code ?? error.name}`); }
    }
    return state;
  }
  async function beforeReview(record) {
    const state = await postState(record), controller = state?.reviewController;
    const coexistence = await readAutopilotStatus(api, record, { request: postHostRequest });
    const result = { hold: coexistence.status === 'RUNNING', coexistence };
    if (!state || !eligible(record) || !await scopeCurrent(state) || !liveState(state, controller, record)) return result;
    const lease = await source(state, record);
    if (!lease || lease.checkpoint.status !== 'UNVERIFIED' || !mayUseSource(state, controller, lease, record.runId)) return result;
    const checkpoint = lease.checkpoint;
    return { ...result,
      successorCandidate: { identity: lease.identity, predecessorRunId: record.runId, checkpointDigest: lease.digest,
        runId: checkpoint.runId, text: checkpoint.text, needsReview: checkpoint.needsReview,
        reviewBudgetMs: checkpoint.reviewBudgetMs, terminalBudgetMs: checkpoint.terminalBudgetMs },
      // LOCK-TIME: synchronous memory only. No disk, RPC, await or scope probe.
      isSuccessorCurrent: () => eligible(getDispatcher()?.get(record)) && mayUseSource(state, controller, lease, record.runId),
      onSuccessorAdopted: ({ provenance }) => acknowledge(record, provenance, state, controller) };
  }
  return { postState, beforeReview,
    write,
    admittedNativeRun: state => recovered.delete(state),
    fingerprint };
}

export function createOpenClawRuntime(api, { pluginRoot, reviewerFactory: injectedFactory, sharedState = {}, compatibility, nativeHooks = false, projectScopes, stopWorkOwner,
  stopStartCompatibility = loadStopStartCompatibility, postRunTerminal } = {}) {
  const states = sharedState.states ??= new Map();
  const hotReviewTasks = sharedState.hotReviewTasks ??= new Set();
  const queues = sharedState.queues ??= new Map();
  const hotReviewGates = sharedState.hotReviewGates ??= new Map();
  const internalSessions = sharedState.internalSessions ??= new Set();
  const hostMaintenanceRuns = sharedState.hostMaintenanceRuns ??= new Map();
  const toolBindings = sharedState.toolBindings ??= new Map();
  const workers = sharedState.workers ??= new Map();
  const pausedScopes = sharedState.pausedScopes ??= new Map();
  const settings = api.pluginConfig ?? {};
  const postHostRequest = createPostRunHostRequester(api);
  const projects = projectScopes ?? createSessionProjects(api, { pluginRoot, compatibility });
  let postRuns;
  const repairStepBudgets = sharedState.repairStepBudgets ??= new Map();
  const postIdentity = state => ({ agentId: state.agentId ?? "main", sessionId: state.sessionId,
    sessionKey: state.sessionKey, projectRoot: state.projectRoot,
    scopeFingerprint: state.projectScope?.fingerprint ?? state.scopeFingerprint, controlRevision: state.enabledRevision ?? 0,
    scopeTaskId: state.scopeTaskId });
  async function coexistenceFor(state, signal) {
    const coexistence = await readAutopilotStatus(api, state, { signal, request: postHostRequest });
    state.coexistence = coexistence;
    const record = postRuns?.get(postIdentity(state));
    if (record) try { await postRuns.noteCoexistence?.({ ...postIdentity(state), runId: record.runId }, coexistence); }
    catch (error) { api.logger.warn(`[runtime-corrector] Coexistence note unavailable: ${error.code ?? error.name}`); }
    return coexistence;
  }
  const postHeld = state => {
    const record = postRuns?.get(postIdentity(state));
    return record && !["IDLE", "RUNNING", "CLOSED"].includes(record.phase);
  };
  const stopOccurrenceId = (runId, enabledRevision = 0) => enabledRevision
    ? hash(JSON.stringify({ runId, enabledRevision })) : runId;
  const followups = nativeHooks ? createNativeFollowups(api, { isCurrent: scopeCurrent, onObserved: ({ projectRoot, receipt }) =>
    markStopFeedbackDelivered({ projectRoot, taskId: receipt.taskId, evaluationId: receipt.assessmentId,
      deliveredAt: new Date(receipt.modelObservedAt).toISOString() }),
    onReserved: ({ state, receipt }) => reservePostCorrection(state, receipt) }) : null;
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
    isCurrent: async (identity, request, measure = (_stage, operation) => operation()) => {
      const state = states.get(`${request.agentId ?? "main"}:${identity.sessionId}`);
      if (!state || state.projectRoot !== request.projectRoot || state.nativeInvalidated || !await measure('basis.scope', () => scopeCurrent(state))) return false;
      const observed = await measure('basis.transcript', () => observeNativeTranscript(api, state));
      if (request.source.purpose && request.source.purpose !== PLAN_RESTORATION_PURPOSE) return false;
      return observed.status === "OBSERVED" && observed.externalUsersDigest === request.source.usersDigest
        && (!request.source.purpose || await measure('basis.source', () => restorationSourceDigest(state)) === request.source.openSpecRestoration?.sourceSha256)
        && (!request.source.openSpecPlanRevision || await measure('basis.openspec', () => approvedApplyRepairCurrent(state, request)));
    },
    feedbackCurrent: async (identity, request, deviations) => {
      const state = states.get(`${request.agentId ?? "main"}:${identity.sessionId}`);
      if (!state || !await scopeCurrent(state)) return [];
      const valid = await openSpecRestorationFeedbackCurrent(state, request, deviations);
      const observed = await observeNativeTranscript(api, state);
      return valid.length && observed.status === "OBSERVED" && observed.externalUsersDigest === request.source.usersDigest
        && await restorationSourceDigest(state) === request.source.openSpecRestoration?.sourceSha256 && await scopeCurrent(state) ? valid : [];
    },
    renderFeedback: (identity, request, deviations) => {
      const state = states.get(`${request.agentId ?? "main"}:${identity.sessionId}`);
      if (!state) throw new Error("The restoration scope is unavailable.");
      return openSpecRestorationFeedback(state, request, deviations);
    },
    onReserved: async (state, receipt) => {
      const reserved = reserveApprovedApplyRepair(state, receipt);
      if (receipt.source?.purpose && !reserved) throw new Error("The restoration admission is no longer current.");
      await reservePostCorrection(state, receipt);
      const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
      repairStepBudgets.set(receipt.runId, { state, stopId: receipt.stopId,
        budget: createRepairStepBudget({ ...state, runId: receipt.runId,
          maxSteps: plan.runtimeV2.stopCorrection.maxRepairSteps }) });
    },
    onModelCall: event => {
      const state = states.get(`${event.agentId ?? "main"}:${event.sessionId}`);
      if (state?.nativeRunId === event.runId) {
        state.nativeCallSequence = Math.max(state.nativeCallSequence ?? 0, event.seq);
        const entry = repairStepBudgets.get(event.runId);
        if (entry?.state === state && entry.budget.observe(event).firstExceeded)
          void nativeStart.cancel({ state, stopId: entry.stopId, reason: "STOP_REPAIR_STEP_LIMIT" })
            .catch(error => api.logger.warn(error.message));
      }
    },
    onStarted: async (identity, receipt) => {
      const state = [...states.values()].find(value => value.sessionId === identity.sessionId && value.sessionKey === identity.sessionKey);
      if (state) {
        observeApprovedApplyRepairStart(state, receipt);
        if (receipt.taskId && receipt.assessmentId) await markStopFeedbackDelivered({ projectRoot: state.projectRoot,
          taskId: receipt.taskId, evaluationId: receipt.assessmentId, deliveredAt: new Date(receipt.modelObservedAt).toISOString() });
        if (receipt.taskId) {
          const ledger = await createStopCorrectionStore({ directory: state.stopSessionDirectory ?? sessionStopDirectory(state) }).inspect(state.sessionId);
          await withTaskState({ projectRoot: state.projectRoot, taskId: receipt.taskId }, task => {
            task.stop.correctionAttempts = ledger.flows[receipt.flowId].used;
          });
        }
        if (postRuns?.get(postIdentity(state)) && !receipt.original)
          await postRuns.started(postIdentity(state), receipt.runId,
            settings.businessRunTimeoutMs === 0 ? null : settings.businessRunTimeoutMs ?? resolveHookTimeoutMs(settings.hookTimeoutMs));
        if (receipt.original) { state.nativePendingStop = null; state.nativeNeedsStop = true; }
      }
    },
    onReleased: (identity, reason) => {
      if (["RC_NATIVE_ATTEMPT_ENDED", "HOST_RUN_NOT_COMPLETED"].includes(reason)) return;
      const state = [...states.values()].find(value => value.sessionId === identity.sessionId && value.sessionKey === identity.sessionKey);
      const record = state && postRuns?.get(postIdentity(state));
      if (record && !postRuns.closed && (!identity.stopId || identity.stopId === record.correctionStopId))
        void postRuns.release(postIdentity(state), reason).catch(error => api.logger.warn(error.message));
    },
  })) : null;
  const findFollowup = async (state, runId) => await nativeStart.findRun({ state, runId })
    ?? followups.findRun({ projectRoot: state.projectRoot, state, runId });
  async function reservePostCorrection(state, receipt) {
    if (postRuns?.get(postIdentity(state))) await postRuns.correction(postIdentity(state), receipt.runId,
      receipt.admission?.deadlineAt ?? Date.now() + 30000, receipt.stopId, receipt.source?.runId);
  }
  const dispatchDirectory = state => {
    const root = sessionStopDirectory(state);
    return root ? path.join(root, "post-run") : null;
  };
  const lateCandidates = createLateCandidateBridge({ states, getDispatcher: () => postRuns,
    postIdentity, stateFor, scopeCurrent, findTask, withTaskState, appendTaskJournal,
    sha256, hash, readAutopilotStatus, api, postHostRequest });
  async function postState(record) { return lateCandidates.postState(record); }
  async function waitNativeTerminal(identity, runId, deadlineAt, signal) {
    const observed = await (postRunTerminal
      ? postRunTerminal(identity, runId, deadlineAt, signal)
      : waitPostRunTerminal(api, identity, runId, deadlineAt, signal, postHostRequest));
    const completedState = [...states.values()].find(state => state.sessionId === identity.sessionId
      && state.sessionKey === identity.sessionKey && state.nativeRunId === runId && !state.scopeClosed);
    const completion = completedState && Object.hasOwn(completedState, 'nativeCompletion')
      ? completedState.nativeCompletion : identity.candidate?.completion;
    const terminal = completedToolWarningTerminal(observed, completion);
    if (terminal?.runId !== runId || terminal.status !== "error") return terminal;
    // This cleanup owns only corrective receipts. Looking up an ordinary
    // predecessor must not reconstruct/abort the pending successor's state.
    const receipt = await findFollowup(identity, runId);
    if (!receipt || receipt.status === "CANCELLED" || receipt.admission?.invalidatedAt !== undefined) return terminal;
    const state = await postState(identity);
    if (!state || state.scopeClosed || state.nativeInvalidated || state.nativeRunId !== runId) return terminal;
    const reason = "HOST_RUN_NOT_COMPLETED";
    state.nativeInvalidated = true; state.nativeTerminalAbortRunId = runId;
    state.reviewController.abort(Object.assign(new Error(reason), { code: reason }));
    await nativeStart.finish({ state, runId });
    await nativeStart.cancel({ state, reason, stopId: receipt.stopId ?? receipt.admission?.stopId });
    await followups.finish({ projectRoot: state.projectRoot, state, runId, status: "CANCELLED", reasonCode: reason });
    await settleIncompleteStop({ projectRoot: state.projectRoot, taskId: receipt.taskId, runId,
      reasonCode: reason, startedAt: receipt.createdAt,
      isCurrent: () => state.nativeRunId === runId && state.nativeTerminalAbortRunId === runId && !state.scopeClosed });
    return terminal;
  }
  function rearmNativeAttempt(state, runId) {
    if (state && !state.scopeClosed && state.nativeRunId === runId && !state.nativeTerminalAbortRunId
      && state.reviewController.signal.aborted && state.reviewController.signal.reason?.code === "RC_NATIVE_ATTEMPT_ENDED") {
      state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
      state.nativeAssessment = null;
    }
  }
  if (sharedState.postRunDispatcher?.closed) delete sharedState.postRunDispatcher;
  const validatePostSession = async record => {
    const state = await postState(record);
    return Boolean(state && !state.scopeClosed && state.sessionKey === record.sessionKey
      && state.projectScope.fingerprint === record.scopeFingerprint && state.scopeTaskId === record.scopeTaskId
      && (state.enabledRevision ?? 0) === (record.controlRevision ?? 0) && await scopeCurrent(state));
  };
  async function openSpecProposalSession({ sessionKey, sessionId, runId }) {
    if (!nativeHooks || settings.enabled === false) return null;
    const agentId = /^agent:([\w-]+):/u.exec(sessionKey)?.[1];
    if (!agentId) return null;
    const scope = await projects.resolve({}, { agentId, sessionId, sessionKey });
    if (!scope.enabled || scope.plan?.runtimeV2?.artifactCorrection?.requireOpenSpecProposalCoverage !== true
      || states.get(`${agentId}:${sessionId}`)?.nativeRunId === runId) return null;
    return scope.fingerprint;
  }
  async function openSpecPlanTarget({ sessionKey, sessionId, runId }) {
    if (!nativeHooks || settings.enabled === false) return null;
    const agentId = /^agent:([\w-]+):/u.exec(sessionKey)?.[1];
    const key = `${agentId}:${sessionId}`;
    const state = states.get(key);
    if (!state || state.sessionKey !== sessionKey || state.nativeRunId !== runId) return null;
    const controller = state.reviewController, revision = state.enabledRevision;
    const bound = () => states.get(key) === state && state.nativeRunId === runId
      && state.sessionKey === sessionKey && state.reviewController === controller && state.enabledRevision === revision
      && !state.scopeClosed && !state.nativeInvalidated && !controller.signal.aborted;
    const settled = () => {
      const post = postRuns?.snapshot(postIdentity(state));
      return bound() && state.nativeCompletion?.runId === runId && state.nativeCompletion.success === true
        && state.nativeProposalCoveragePolicy?.runId === runId
        && (!post || ["IDLE", "CLOSED"].includes(post.phase)) && !stopReviews?.pending(state).length;
    };
    const current = async () => settled() && await scopeCurrent(state) && settled();
    if (!bound() || !await scopeCurrent(state) || !bound()) return null;
    const deadlineAt = Date.now() + 2500;
    try {
      const terminal = await waitPostRunTerminal(api, postIdentity(state), runId, deadlineAt, controller.signal, postHostRequest);
      if (completedToolWarningTerminal(terminal, state.nativeCompletion)?.status !== "ok") return null;
      if (state.nativePreparingStop) {
        await beforeStopDeadline(() => state.nativePreparingStop, { deadlineAt, signal: controller.signal });
      }
    } catch { return null; }
    if (!await current()) return null;
    const requireProposalCoverage = state.nativeProposalCoveragePolicy.required;
    return { state, projectRoot: state.projectRoot, current, requireProposalCoverage,
      requirePlanReadiness: state.nativeProposalCoveragePolicy.requirePlanReadiness === true,
      ...(requireProposalCoverage ? { async readProposalSources() {
        const observed = await observeNativeTranscript(api, state).catch(() => null);
        return observed?.status === "OBSERVED" && await current() ? transcriptUserMessages(observed) : null;
      } } : {}) };
  }
  if (nativeHooks) postRuns = sharedState.postRunDispatcher ??= createPostRunDispatcher({
    directoryFor: dispatchDirectory, defaultDirectory: dispatchDirectory({}),
    concurrency: settings.stopReviewConcurrency ?? 3,
    validate: validatePostSession,
    beforeReview: record => lateCandidates.beforeReview(record),
    waitTerminal: waitNativeTerminal,
    review: async (record, { deadlineAt, signal }) => {
      const state = await postState(record);
      if (!state || signal.aborted || state.nativeRunId !== record.runId) return { reviewStatus: "CANCELLED" };
      const admittedController = state.reviewController;
      const current = () => !signal.aborted && state.nativeRunId === record.runId
        && state.reviewController === admittedController && !admittedController.signal.aborted;
      await hotReviewSettled(state, admittedController);
      if (!current() || !await scopeCurrent(state) || !current()) return { reviewStatus: "CANCELLED" };
      state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
      const reviewController = state.reviewController;
      const abort = () => reviewController.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const current = () => !signal.aborted && !reviewController.signal.aborted
          && state.nativeRunId === record.runId && state.reviewController === reviewController && !state.scopeClosed;
        const openSpecPlan = hasArmedOpenSpecApply(state, record.runId)
          ? await beforeStopDeadline(() => inspectArmedOpenSpecApply(state, record.runId),
            { deadlineAt, signal: reviewController.signal }) : null;
        const nativeReceipt = await nativeStart.findRun({ state, runId: record.runId });
        const receipt = nativeReceipt ?? await followups.findRun({ projectRoot: state.projectRoot, state, runId: record.runId });
        if (!current() || openSpecPlan && (!await scopeCurrent(state) || !current())) return { reviewStatus: "CANCELLED" };
        await scheduleNativeStop(state, { text: record.candidate.text, runId: record.runId,
          ctx: { ...postIdentity(state), runtimeCorrectorReviewDeadlineAt: deadlineAt }, receipt, nativeReceipt, openSpecPlan });
        const reviewed = await stopReviews.waitRun(state, record.runId);
        return reviewed && openSpecPlan ? { ...reviewed, reviewSummary: { ...reviewed.reviewSummary, openSpecPlan } } : reviewed;
      } finally { signal.removeEventListener("abort", abort); }
    },
    sendUser: async (record, task) => {
      const attachments = await Promise.all((task.options.media ?? []).map(async media => ({
        fileName: path.basename(media.filePath), mimeType: media.mimeType,
        content: (await fs.readFile(media.filePath)).toString("base64"),
      })));
      const response = await beforeStopDeadline(() => postHostRequest("chat.send", {
        sessionKey: record.sessionKey, agentId: record.agentId, sessionId: record.sessionId,
        message: task.text, idempotencyKey: task.runId, ...(attachments.length ? { attachments } : {}),
      }, { timeoutMs: 15000 }), { deadlineAt: Date.now() + 15000 });
      return response?.result ?? response;
    },
    cancelCorrection: async (record, runId, reason) => {
      const state = await postState(record);
      if (state) {
        const receipt = await findFollowup(state, runId);
        if ([runId, record.runId].includes(state.nativeRunId))
          state.reviewController?.abort(Object.assign(new Error(reason), { code: reason }));
        await nativeStart.cancel({ state, reason, stopId: record.correctionStopId });
        await cancelStopScope(state, reason, record.correctionStopId);
        if (receipt?.taskId) await settleIncompleteStop({ projectRoot: state.projectRoot, taskId: receipt.taskId, runId,
          reasonCode: reason, startedAt: receipt.createdAt, isCurrent: () => state.nativeRunId === runId && !state.scopeClosed });
      }
    },
    onError: error => api.logger.warn(`[runtime-corrector] post-run: ${error.code ?? error.message}`),
  });
  function internal(event, ctx) {
    if (isHostMaintenanceRun(event, ctx, hostMaintenanceRuns)) return true;
    const id = event.sessionId ?? ctx.sessionId;
    const worker = workers.get(id), runId = ctx.runId ?? event.runId;
    return (!worker && isPersistedWorker(ctx.workspaceDir ?? event.cwd, id))
      || worker?.closed === true || worker?.settled === true
      || Boolean(worker?.runId && runId && worker.runId !== runId)
      || isInternalExecution() || ctx.runtimeCorrectorInternal === true || internalSessions.has(id)
      || [ctx.sessionKey, event.sessionKey].some((key) => String(key ?? "").includes(INTERNAL_SESSION_MARKER));
  }
  async function retire(state, reason = "RC_PROJECT_SCOPE_CHANGED", deactivate = true) {
    state.requirementFrameWork?.controller.abort();
    state.scopeClosed = true;
    forgetKnownOriginalObligations(state);
    state.nativeInvalidated = true;
    releaseOpenSpecProposalSession(sharedState, state);
    await postRuns?.close(postIdentity(state), reason);
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
  function nativeHistoryReadiness(record, sessionId, reasonCode = "SESSION_HISTORY_RETAINED") {
    const initialization = record?.initialization;
    const startIdentity = value => typeof value === "string" && value.trim() && !Object.hasOwn(Object.prototype, value);
    if (record?.schemaVersion !== "runtime-corrector.stop-correction-session.v1" || record.sessionId !== sessionId
      || !Number.isSafeInteger(record.used) || record.used < 0
      || !initialization?.evidence || typeof initialization.evidence !== "object" || Array.isArray(initialization.evidence)
      || !["NEW_SESSION", "VERIFIED_HISTORY"].includes(initialization.kind)
      || initialization.evidence.sessionId !== undefined && initialization.evidence.sessionId !== sessionId
      || initialization.kind === "NEW_SESSION" && initialization.starts !== undefined
      || initialization.kind === "VERIFIED_HISTORY" && (!Array.isArray(initialization.starts)
        || initialization.starts.some(start => !startIdentity(start?.executionId) || !startIdentity(start?.flowId)
          || !Number.isFinite(start.startedAt))))
      return { status: "UNVERIFIED", reasonCode: "SESSION_HISTORY_STORE_UNVERIFIED" };
    if (initialization.kind === "VERIFIED_HISTORY") {
      const observedAt = Date.now(), starts = new Map();
      for (const start of initialization.starts) {
        if (start.startedAt > observedAt)
          return { status: "UNVERIFIED", reasonCode: "SESSION_HISTORY_TIME_UNVERIFIED" };
        const prior = starts.get(start.executionId);
        if (prior && (prior.flowId !== start.flowId || prior.startedAt !== start.startedAt))
          return { status: "UNVERIFIED", reasonCode: "SESSION_HISTORY_STORE_UNVERIFIED" };
        starts.set(start.executionId, start);
      }
    }
    return { status: "VERIFIED", reasonCode, initializationKind: initialization.kind };
  }
  async function initializeNativeHistory(state, measure = (_stage, operation) => operation()) {
    const directory = sessionStopDirectory(state);
    if (!directory || api.runtime.version !== "2026.7.1-2")
      return { status: "UNAVAILABLE", reasonCode: "SESSION_HISTORY_ADAPTER_UNAVAILABLE" };
    try {
      const store = createStopCorrectionStore({ directory });
      const existing = await measure('history.inspect', () => store.inspect(state.sessionId));
      if (existing) return nativeHistoryReadiness(existing, state.sessionId);
      const observed = await measure('history.transcript', () => observeNativeTranscript(api, state));
      const evidence = observed.emptySessionEvidence ?? observed.initialTurnEvidence;
      api.logger.debug?.(`[runtime-corrector] Stop session history: ${observed.status}, verifiedZero=${Boolean(evidence)}, reason=${observed.reason ?? "none"}`);
      if (observed.status === "OBSERVED" && evidence) {
        const initialized = await measure('history.initialize', () => store.initializeSession({ sessionId: state.sessionId,
          initialize: { kind: "VERIFIED_HISTORY", starts: [], evidence } }));
        return nativeHistoryReadiness(initialized, state.sessionId, "SESSION_HISTORY_CAPTURED");
      }
      return { status: "UNVERIFIED", reasonCode: observed.reason ?? "SESSION_HISTORY_NOT_VERIFIABLE" };
    } catch (error) {
      api.logger.warn(`[runtime-corrector] Session history remains unverified: ${error.code ?? error.name}`);
      return { status: "UNVERIFIED", reasonCode: "SESSION_HISTORY_READ_UNAVAILABLE" };
    }
  }
  async function observeCommandHistory(ctx = {}) {
    const scopes = ctx.gatewayClientScopes;
    if (internal({}, ctx) || isManagedExecution() || ctx.isAuthorizedSender !== true
      || !(scopes ? Array.isArray(scopes) && scopes.some(scope => ["operator.admin", "operator.read", "operator.write"].includes(scope))
        : ctx.senderIsOwner === true))
      return { status: "UNAVAILABLE", reasonCode: "SESSION_HISTORY_COMMAND_UNAUTHORIZED" };
    if (!nativeHooks || settings.enabled === false)
      return { status: "UNAVAILABLE", reasonCode: settings.enabled === false ? "RC_PLUGIN_DISABLED" : "SESSION_HISTORY_ADAPTER_UNAVAILABLE" };
    try {
      const identity = sessionIdentity({}, ctx);
      // This path is global and precedes project binding/enrollment. The host
      // command supplies identity; the latest public entry must still own it.
      await currentSession(api, identity);
      // The newer host supplies lifecycle initialization directly. Expose an
      // existing record there, without extending the older fallback protocol.
      const directory = sessionStopDirectory(identity);
      const result = api.runtime.version === "2026.10.3" && directory
        ? nativeHistoryReadiness(await createStopCorrectionStore({ directory }).inspect(identity.sessionId), identity.sessionId)
        : await initializeNativeHistory(identity);
      await currentSession(api, identity);
      return result;
    } catch {
      return { status: "UNVERIFIED", reasonCode: "SESSION_HISTORY_CURRENT_IDENTITY_UNAVAILABLE" };
    }
  }
  async function pauseControl(state, reason = "RC_SESSION_DISABLED") {
    if (state.controlPause) return state.controlPause;
    const dispatchIdentity = postIdentity(state);
    state.controlPaused = true;
    state.scopeClosed = true;
    forgetKnownOriginalObligations(state);
    state.nativeInvalidated = true;
    state.enabledRevision = (state.enabledRevision ?? 0) + 1;
    pausedScopes.set(state.key, state);
    // Release the old execution queue even if a backend ignores cancellation.
    // New work has a separate state/controller and still restores the same task.
    queues.delete(state.key);
    state.controlPause = (async () => {
      await postRuns?.close(dispatchIdentity, reason);
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
        await retiring;
        await releaseDocumentSessions(state.projectRoot);
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
    const record = state && postRuns?.get(postIdentity(state));
    return Boolean(record && runId && record.completedRuns.includes(runId) && record.runId !== runId);
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
          let projected = await nativeStart.project({ state, records: await followups.project({ projectRoot: state.projectRoot, state, records }) });
          projected = postRuns.project(postIdentity(state), projected);
          // MA persists the admitted input after before_prompt_build. A failed
          // precheck can enter FINALIZING before any tool sees that input. Use
          // the host's run-bound identity even while holding the review prefix;
          // otherwise a retry keeps the previous user's already closed flow.
          const admittedUser = projected.findLast(record => !record.isMeta && record.message?.role === 'user'
            && record.message.idempotencyKey === `${state.nativeRunId}:user`);
          if (admittedUser?.id) state.nativeActiveUserId = admittedUser.id;
          // Later queued inputs belong to their next admitted turn. Freeze only
          // this flow's user-input prefix, without changing the host transcript.
          const boundary = postHeld(state) && state.nativeActiveUserId
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
    if (nativeHooks && runId) lateCandidates.admittedNativeRun(state);
    if (nativeHooks && runId && state.nativeRunId !== runId) {
      beginOpenSpecRun(state, runId, { proposalOwner: sharedState });
      state.reviewController.abort(new Error("Native run replaced."));
      state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
      state.nativeRunId = runId; state.nativeInvalidated = false; state.nativePostRunReview = false; state.nativeAssessment = null;
      state.nativeCallSequence = 0;
      state.nativeEndedRun = null; state.nativePendingStop = null; state.nativePreparingStop = null;
      state.hotReviewFeedback = [];
      state.acceptanceFeedback = null;
      state.nativeTerminalAbortRunId = null;
      state.nativeNeedsStop = false; state.nativeFollowupReceipt = null;
      state.nativeRetryUnverifiedStop = false;
      state.nativeRetryEvidenceStop = false;
      const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
      if (state.nativeRunId === runId) state.nativeProposalCoveragePolicy = {
        runId, required: plan.runtimeV2.artifactCorrection.requireOpenSpecProposalCoverage === true,
        requirePlanReadiness: plan.runtimeV2.artifactCorrection.requireOpenSpecPlanReadiness === true,
      };
      state.stopFrameReproduction = frameReproduction(plan.runtimeV2);
      state.materialRoots = plan.runtimeV2.dynamicGroundTruth.materialRoots;
      state.materialReference = plan.runtimeV2.dynamicGroundTruth.enabled !== true;
      if (!state.materialReference && state.materialRoots.length && (state.reviewController.signal.aborted
        || ctx.runtimeCorrectorHookDeadlineAt && Date.now() >= ctx.runtimeCorrectorHookDeadlineAt)) {
        const taskId = state.scopeTaskId ?? (await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId }))?.taskId;
        if (taskId) await invalidateMaterialBasis({ projectRoot: state.projectRoot, taskId,
          reason: "MATERIAL_BASIS_HOOK_UNAVAILABLE", onlyUncaptured: true });
      }
      const held = postRuns?.get(postIdentity(state));
      state.postRunEnabled = plan.runtimeV2.stopCorrection.waitMode === "until_pass"
        || held?.phase === "COEXIST_WAIT" || held?.coexistence?.status === "RUNNING";
      if (state.postRunEnabled) {
        const coexistence = await coexistenceFor(state, ctx.abortSignal);
        try {
          if (held?.phase === "COEXIST_WAIT" && postRuns.externalStarted)
            await postRuns.externalStarted(postIdentity(state), runId, coexistence);
          else await postRuns.started(postIdentity(state), runId, undefined, false);
        } catch (error) {
            if (coexistence.status !== "RUNNING" && held?.phase !== "COEXIST_WAIT") throw error;
            state.coexistence = { ...coexistence, reason: "RC_OWNER_RECONCILIATION_REQUIRED",
              message: "旧 RC 运行尚未安全解除；保持待核对记录，请查看控制页。", updatedAt: Date.now() };
            try { await postRuns.noteCoexistence?.(postIdentity(state), state.coexistence); } catch {}
            api.logger.warn(`[runtime-corrector] Autopilot handoff unavailable: ${error.code ?? error.name}`);
        }
      }
    }
    return state;
  }
  function queue(state, callback) {
    const previous = queues.get(state.key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(callback);
    queues.set(state.key, next);
    return next.finally(() => { if (queues.get(state.key) === next) queues.delete(state.key); });
  }
  // Deferred hot reviews share the event loop with this session's pre-tool
  // checks, and parallel calls share one host hook deadline. A review starts
  // once no check is pending or a caller waits for it. Every waiter demands
  // it, so a check queued behind that waiter cannot stall the review.
  function hotReviewGate(key) {
    let gate = hotReviewGates.get(key);
    if (!gate) hotReviewGates.set(key, gate = { prechecks: 0, demands: 0, waiters: [] });
    return gate;
  }
  function openHotReviews(key, gate) {
    if (gate.prechecks && !gate.demands) return;
    for (const resolve of gate.waiters.splice(0)) resolve();
    if (!gate.prechecks && !gate.demands && hotReviewGates.get(key) === gate) hotReviewGates.delete(key);
  }
  async function withPrecheck(event, ctx, run) {
    const sessionId = event.sessionId ?? ctx.sessionId;
    if (!sessionId) return run();
    const key = `${ctx.agentId ?? "main"}:${sessionId}`, gate = hotReviewGate(key);
    gate.prechecks++;
    try { return await run(); } finally { gate.prechecks--; openHotReviews(key, gate); }
  }
  async function prechecksSettled(key, signal) {
    const gate = hotReviewGates.get(key);
    if (!gate?.prechecks || gate.demands || signal.aborted) return;
    let abort;
    try {
      await new Promise(resolve => { abort = resolve; gate.waiters.push(resolve); signal.addEventListener("abort", abort, { once: true }); });
    } finally { signal.removeEventListener("abort", abort); }
  }
  async function hotReviewSettled(state, controller) {
    const work = state.hotReviewWork;
    if (!work || work.controller !== controller) return;
    const gate = hotReviewGate(state.key);
    gate.demands++; openHotReviews(state.key, gate);
    try { await work.promise; } finally { gate.demands--; openHotReviews(state.key, gate); }
  }
  function hookBudget(name) {
    const policy = (api.runtime.config?.current?.() ?? api.config)?.plugins?.entries?.[api.id]?.hooks;
    // reply_dispatch retains its one-hour default and honors a larger configured wait. Its caller
    // spans review -> repair -> re-review; a single phase's hookTimeoutMs
    // must not abort a healthy later phase at the original cutoff.
    return hookReviewBudgetMs(name === "reply_dispatch" ? Math.max(3600000, settings.hookTimeoutMs ?? 0) : settings.hookTimeoutMs,
      policy?.timeouts?.[name] ?? policy?.timeoutMs ?? Infinity,
      settings.baselineLimits?.timeoutMs ? settings.baselineLimits.timeoutMs + 60000 : undefined);
  }
  function directReviewBudget(plan, hookName) {
    const runtime = plan.runtimeV2;
    const roleBudget = name => Math.min((name === 'groundTruthExtractor' ? settings.baselineLimits?.timeoutMs : null)
      ?? runtime?.reviewers?.[name]?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
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
    const materialTask = nativeHooks
      ? await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId }) : null;
    // Original-basis mode fixes a task's material roots at capture; later
    // discovery neither reruns nor changes them.
    const fixedRoots = materialTask ? await fixedMaterialRoots(state.projectRoot, materialTask.taskId) : null;
    let plan = sessionSkillPlan(await loadConfig({ cwd: state.projectRoot, pluginRoot, ...(fixedRoots ? { derivedMaterialRoots: fixedRoots } : {}) }),
      state.executionDirectory);
    state.materialReference = plan.runtimeV2.dynamicGroundTruth.enabled !== true;
    if (state.materialReference && fixedRoots) plan = { ...plan, runtimeV2: { ...plan.runtimeV2,
      dynamicGroundTruth: Object.freeze({ ...plan.runtimeV2.dynamicGroundTruth, materialRoots: Object.freeze([...fixedRoots]) }) } };
    state.materialRoots = plan.runtimeV2.dynamicGroundTruth.materialRoots;
    const capturesMaterial = ["before_prompt_build", "before_tool_call"].includes(hookName);
    let materialBasis;
    if (materialTask) {
      state.materialBasisTaskId = materialTask.taskId;
      try {
        materialBasis = await prepareMaterialBasis({ projectRoot: state.projectRoot, taskId: materialTask.taskId,
          roots: state.materialRoots, mode: capturesMaterial ? "capture" : ["session_start", "before_compaction"].includes(hookName) ? "optional" : "verify",
          signal: controller.signal, active: () => state.reviewController === controller && !controller.signal.aborted,
          authority: state.materialReference ? "reference" : "strict",
          ...(capturesMaterial ? { deadlineAt: state.materialCaptureDeadlineAt } : {}) });
      } catch (error) { error.materialBasisTaskId = materialTask.taskId; throw error; }
      state.materialBasis = materialBasis;
      guardMaterialPublication(decisionScope.getStore()?.context, materialBasis);
    }
    const required=[...new Set([
      ...(plan.runtimeV2?.stopCorrection?.enabled&&hasStopReviews(plan.runtimeV2.stopCorrection)||plan.runtimeV2?.artifactCorrection?.stageMetricsEnabled?TASK_TOOL_NAMES:[]),
      ...(plan.runtimeV2?.stopCorrection?.enabled&&hasStopReviews(plan.runtimeV2.stopCorrection)&&plan.runtimeV2?.dynamicGroundTruth?.enabled?BASELINE_TOOL_NAMES:[]),
    ])];
    assertRequiredReviewerTools(api.runtime.config?.current?.()??api.config??{},state.agentId??'main',required,{provider:state.provider,model:state.model});
    const reviewDeadlineAt = Math.min(Date.now() + (direct ? directReviewBudget(plan, hookName) : hookBudget(hookName)),
      assessmentContext?.deadlineAt ?? state.runDeadlineAt ?? Infinity);
    const currentReviewerSettings = (api.runtime.config?.current?.() ?? api.config)?.plugins?.entries?.['runtime-corrector']?.config;
    const baseReviewerFactory = injectedFactory ?? createOpenClawReviewerFactory(api, {
      agentId: state.agentId, provider: state.provider, model: state.model,
      pluginRoot, skillRoots: plan.runtimeV2?.skillCorrection?.skillRoots,
      reviewerModel: currentReviewerSettings ? currentReviewerSettings.reviewerModel : settings.reviewerModel,
      reviewerTimeoutMs: settings.reviewerTimeoutMs,
      ...(settings.baselineWireMode ? { baselineWireMode: settings.baselineWireMode } : {}),
      ...(settings.baselineLimits ? { baselineLimits: settings.baselineLimits } : {}),
      stopReviewEngine: settings.stopReviewEngine ?? "task",
      stopMaxReviewSteps: plan.runtimeV2.stopCorrection.maxReviewSteps,
      // Controller-owned calls are not host Hooks. Worker tool Hooks still use
      // the native policy window; neither path may outlive its parent deadline.
      deadlineAt: reviewDeadlineAt, internalSessions,
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
      const current = () => controller === state.reviewController && !controller.signal.aborted && !state.scopeClosed;
      if (!current() || !await scopeCurrent(state) || !current()) throw Object.assign(new Error("RC scope is no longer active."), { code: "RC_SESSION_DISABLED" });
      await materialBasis?.assert();
      if (!current()) throw Object.assign(new Error("RC scope is no longer active."), { code: "RC_SESSION_DISABLED" });
      const handle = await invoke(materialBasis ? { ...options, readOriginalMaterial: materialBasis.readOriginalMaterial } : options);
      if (!current() || !await scopeCurrent(state) || !current()) {
        await handle.close?.();
        throw Object.assign(new Error("RC scope was disabled during review."), { code: "RC_SESSION_DISABLED" });
      }
      try { await materialBasis?.assert(); }
      catch (error) { await handle.close?.(); throw error; }
      try { if (materialBasis) await materialBasis.validateCitations(await handle.getSourceCitations?.() ?? handle.sourceCitations ?? []); }
      catch (error) { await handle.close?.(); throw error; }
      if (!current()) { await handle.close?.(); throw Object.assign(new Error("RC scope is no longer active."), { code: "RC_SESSION_DISABLED" }); }
      return handle;
    };
    const reviewerFactory = Object.assign(guardedReview(options => baseReviewerFactory(options)), baseReviewerFactory);
    if (baseReviewerFactory.handoff) reviewerFactory.handoff = guardedReview(options => baseReviewerFactory.handoff(options));
    if (materialBasis) {
      reviewerFactory.materialManifest = materialBasis.materialManifest;
      reviewerFactory.readOriginalMaterial = materialBasis.readOriginalMaterial;
      if (materialBasis.referenceMaterials) reviewerFactory.referenceMaterials = materialBasis.referenceMaterials;
    }
    state.stopSessionDirectory = sessionStopDirectory(state);
    await nativeStart?.recover(state);
    return { input: null, plan, projectRoot: state.projectRoot, pluginRoot, reviewerFactory, reviewDeadlineAt, materialBasis,
      deferHotReview: nativeHooks && !direct && ["before_prompt_build", "before_tool_call"].includes(hookName),
      stopHost: { directory: state.stopSessionDirectory, openClaw: true,
        readKnownOriginalObligations: knownOriginalObligationReader(state),
        effectiveToolPolicy: () => observeNativeToolPolicy(api, state),
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
  async function artifactProposalBinding(state, prepared, outcome = {}, semantic = null) {
    let requiredProposalReview, requiredPlanReadiness, planRevision;
    if (outcome.originalRequirements && state.nativeProposalCoveragePolicy?.required === true) {
      const runId = state.nativeRunId;
      const changeName = /^openspec\/changes\/([^/]+)\/(?:proposal\.md|design\.md|tasks\.md|specs\/.+\/spec\.md)$/u.exec(
        prepared.result.metadata.triggerFile)?.[1];
      if (changeName) {
        const root = `openspec/changes/${changeName}`;
        const files = new Set(documentArtifactPaths(semantic ?? { artifactFiles: prepared.result.metadata.artifactFiles,
          workflow: prepared.reviewContext.workflow }));
        if (files.has(`${root}/tasks.md`) && files.has(`${root}/proposal.md`)) {
          const plan = await readOpenSpecPlan(state.projectRoot, changeName).catch(() => null);
          if (plan?.documents.length === files.size && plan.documents.every(({ path: file }) => files.has(file))) {
            planRevision = plan.revision;
            const observed = await observeNativeTranscript(api, state).catch(() => null);
            if (state.nativeRunId === runId)
              requiredProposalReview = openSpecProposalReviewRequirements(sharedState, state, { changeName, observed, snapshot: plan });
            if (state.nativeRunId === runId && !hasArmedOpenSpecApply(state, runId)
              && (state.nativeProposalCoveragePolicy.requirePlanReadiness === true
              || requiredProposalReview?.requirePlanReadiness === true)) requiredPlanReadiness = { changeName };
          }
        }
      }
    }
    return { requiredProposalReview: requiredProposalReview ?? null, requiredPlanReadiness: requiredPlanReadiness ?? null,
      planRevision: planRevision ?? null };
  }
  async function semanticArtifactReview(state, value, input, prepared, outcome = {}, bundle = null) {
    const owner = { taskId: outcome.taskId ?? state.scopeTaskId, runId: state.nativeRunId, sessionId: state.sessionId };
    const publicationCapture = captureOriginalDutyPublication(state);
    const cohortContext = originalDutyContextFromCapture(publicationCapture);
    const publicationCurrent = () => originalDutyPublicationCurrent(state, publicationCapture);
    return runSemanticReview({ input, prepared, pluginRoot, runtimeV2Handle: outcome.reviewerHandle,
      runtimeV2Context: outcome.artifactReviewContext, runtimeV2ExecutionContext: outcome.reviewerExecutionContext,
      runtimeV2Evidence: outcome.reviewerEvidence, runtimeV2ReviewerFactory: value.reviewerFactory,
      originalDutyCohortContext: cohortContext, originalDutyPublicationGuard: publicationCurrent,
      ...(cohortContext ? { originalObservationReader: knownOriginalObligationReader(state) } : {}),
      originalRequirements: outcome.originalRequirements ?? null,
      invokeFork: async request => {
        const semanticReviewRequestPath = request.prompt.match(/--request "([^"]+)"/u)?.[1];
        if (!semanticReviewRequestPath) throw new Error("Semantic review request path is missing.");
        const binding = await artifactProposalBinding(state, prepared, outcome, request.semanticRequest);
        if (owner.runId !== state.nativeRunId || bundle && !isDeepStrictEqual(binding, bundle.proposalBinding))
          throw new Error('DOCUMENT_BUNDLE_BASIS_CHANGED');
        const { requiredProposalReview, requiredPlanReadiness } = binding;
        const reviewerModel = value.plan.runtimeV2?.reviewers?.artifactReviewer?.model;
        const handle = await value.reviewerFactory({ projectRoot: state.projectRoot, sessionCwd: state.projectRoot,
          taskId: outcome.taskId ?? state.scopeTaskId ?? `openclaw-${hash(state.sessionId)}`, parentSessionId: state.sessionId,
          role: "artifact-reviewer", reviewer: { timeoutMs: request.timeoutMs, session: "detached", maxOutputTokens: request.maxOutputTokens,
            ...(reviewerModel ? { model: reviewerModel } : {}) },
          ...(cohortContext ? { originalObservationReader: knownOriginalObligationReader(state) } : {}),
          reviewerRuntime: request.reviewerRuntime, evidence: { snapshot: { entries: state.entries,
            invocation: { runId: owner.runId, sessionId: owner.sessionId } }, semanticRequest: request.semanticRequest,
            originalDutyCohortContext: cohortContext,
            ...(requiredProposalReview ? { requiredProposalReview } : {}), ...(requiredPlanReadiness ? { requiredPlanReadiness } : {}) },
          schema: REVIEW_SCHEMA, request: { semanticReviewRequestPath,
            instructions: "Read semanticReviewRequestPath and review all available artifacts according to the semantic-review protocol, project criteria and deterministic diagnostics." }, pluginRoot });
        try {
          const coverage = cohortContext
            ? bindHostOriginalCoverage(handle.originalRequirementCoverage, cohortContext, publicationCurrent)
            : cloneHostLegacyOriginalCoverage(handle.originalRequirementCoverage);
          if (!cohortContext && (handle.originalRequirementCoverage && !coverage
            || handle.originalDutyAccounting && (handle.originalDutyAccounting.status !== 'NOT_EXERCISED'
              || handle.originalDutyAccounting.stagedCount !== 0))) throw new Error('DOCUMENT_ORIGINAL_LEGACY_COVERAGE_INVALID');
          return { sessionId: handle.sessionId, review: handle.result,
            ...(cohortContext && handle.originalDutyAccounting ? { originalDutyAccounting: { ...handle.originalDutyAccounting, ...owner } } : {}),
            ...(handle.planReadiness ? { planReadiness: { ...handle.planReadiness, ...owner } } : {}), ...(coverage ? {
            originalRequirementCoverage: coverage,
          } : {}) };
        } finally { await handle.close(); }
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
  async function approvedApplyArtifactDrift(state, runId, files) {
    const controller = state.reviewController;
    if (!nativeHooks || runId !== state.nativeRunId || controller.signal.aborted
      || !hasArmedOpenSpecApply(state, runId)
      || !files.some(file => path.relative(state.projectRoot, file).replaceAll("\\", "/").startsWith("openspec/changes/"))) return null;
    const observed = await inspectArmedOpenSpecApply(state, runId);
    const current = () => state.nativeRunId === runId && state.reviewController === controller
      && !controller.signal.aborted && !state.nativeInvalidated && !state.scopeClosed;
    if (!current() || !await scopeCurrent(state) || !current()) return { stale: true };
    if (observed?.status !== "CHANGED") return null;
    const differences = new Set(observed.differences);
    const changedFiles = files.filter(file => differences.has(path.relative(state.projectRoot, file).replaceAll("\\", "/")));
    return changedFiles.length ? { plan: observed, files: changedFiles } : null;
  }
  function approvedProgressBasis(state, prepared, plan) {
    const metadata = prepared?.result?.metadata, context = prepared?.reviewContext;
    const node = plan.configuredArtifacts?.find(value => value.nodeId === context?.artifact?.nodeId);
    if (!prepared?.matched || node?.reviewPolicy?.skipApprovedTaskProgress !== true
      || !context.nodeReviewEnabled || !metadata?.bundleComplete || prepared.result.status !== 'passed'
      || prepared.result.diagnostics.length || context.runtimeV2Enabled || context.artifact.metricCheckpoint
      || context.artifact.metrics?.length || context.workflow?.incomingEdges?.length
      || context.workflow?.groundTruthInputs?.length || node.reviewPolicy.copyFrom
      || plan.runtimeV2.dynamicGroundTruth.enabled || plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled
      || plan.runtimeV2.artifactCorrection.stageMetricsEnabled || !/^[a-f0-9]{64}$/u.test(metadata.policyDigest)
      || !Array.isArray(metadata.policyFiles) || !Array.isArray(metadata.inputs)
      || typeof (state.projectScope?.fingerprint ?? state.scopeFingerprint) !== 'string') return null;
    const scopePaths = metadata.inputs.map(file => file.path).sort();
    if (!scopePaths.length || scopePaths.length > 259 || new Set(scopePaths).size !== scopePaths.length) return null;
    return { nodeId: context.artifact.nodeId, scopePaths, policyDigest: metadata.policyDigest,
      policyFiles: structuredClone(metadata.policyFiles), owner: { projectRoot: state.projectRoot,
        taskId: state.scopeTaskId, sessionId: state.sessionId, sessionKey: state.sessionKey,
        scopeFingerprint: state.projectScope?.fingerprint ?? state.scopeFingerprint, enabledRevision: state.enabledRevision ?? 0 } };
  }
  async function run(state, eventName, fields, contextValue) {
    const input = inputFor(state, eventName, fields), controller = state.reviewController, runId = state.nativeRunId;
    const execute = async () => {
      await contextValue.materialBasis?.assert();
      guardMaterialPublication(decisionScope.getStore()?.context, contextValue.materialBasis);
      guardMaterialPublication(contextValue.assessmentContext, contextValue.materialBasis);
      const outcome = await handleRuntimeV2Event({ ...contextValue, input });
      if (state.onTaskState) {
        const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
        if (task) await state.onTaskState(task);
      }
      return outcome;
    };
    if (contextValue.deferHotReview) {
      // This review reads the transcript when it starts, so a pending one also
      // covers later observation-only calls.
      const coalesces = eventName === "PreToolUse" && observationOnlyCall(fields.tool_name, fields.tool_input);
      const pending = state.hotReviewWork?.controller === controller ? state.hotReviewWork : null;
      if (coalesces && pending?.coalesces && !pending.started) return { handled: true, status: "PENDING", feedback: null };
      const previous = pending?.promise ?? Promise.resolve();
      const submitted = state.hotHookCompletion ?? Promise.resolve();
      const work = { controller, coalesces, started: false };
      // A model request cannot retain the hot hook's staged decision or session
      // lane. Reopen a current guarded decision when the background event runs.
      const promise = outsideDecision(() => previous.catch(() => {}).then(async () => {
        await submitted;
        await prechecksSettled(state.key, controller.signal);
        work.started = true;
        if (state.reviewController !== controller || state.nativeRunId !== runId || controller.signal.aborted || !await scopeCurrent(state)) return;
        const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
        const outcome = task ? await withTaskDecision({ projectRoot: state.projectRoot, taskId: task.taskId, context: {
          kind: "hook", assessmentId: `hot:${input.hook_event_id}`, guard: decisionGuard(task),
          abortSignal: controller.signal, deadlineAt: contextValue.reviewDeadlineAt,
          maxCorrections: contextValue.plan.runtimeV2?.stopCorrection?.maxCorrectionsPerFlow,
          evidenceMatches: async () => await scopeAllowed(state, controller) && (!contextValue.materialBasis || await contextValue.materialBasis.current()),
        } }, execute) : await execute();
        if (outcome?.feedback && state.reviewController === controller && !controller.signal.aborted)
          (state.hotReviewFeedback ??= []).push(outcome.feedback);
      }).catch(async error => {
        if (state.reviewController !== controller || controller.signal.aborted) return;
        const feedback = await failure(state, error, "BACKGROUND_REVIEW").catch(() => "");
        if (feedback) (state.hotReviewFeedback ??= []).push(feedback);
      }));
      work.promise = promise;
      state.hotReviewWork = work;
      hotReviewTasks.add(promise);
      void promise.finally(() => {
        hotReviewTasks.delete(promise);
        if (state.hotReviewWork?.promise === promise) state.hotReviewWork = null;
      });
      return { handled: true, status: "PENDING", feedback: null };
    }
    await hotReviewSettled(state, controller);
    const outcome = await execute();
    const feedback = state.hotReviewFeedback?.splice(0).join("\n\n");
    return feedback ? { ...outcome, feedback: joined(feedback, outcome.feedback) } : outcome;
  }
  async function failure(state, error, label) {
    if (state.scopeClosed || state.controlPaused || state.abortSignal?.aborted || error.code === "RC_SESSION_DISABLED") return "";
    if (typeof error.code === "string" && error.code.startsWith("MATERIAL_BASIS_")) {
      const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
      if (task && (!error.materialBasisTaskId || error.materialBasisTaskId === task.taskId)) await outsideDecision(() => withTaskState({ projectRoot: state.projectRoot, taskId: task.taskId }, current => {
        current.materialBasis = { status: "UNVERIFIED", reason: error.code, recordedAt: Date.now() };
        current.verification = { ...current.verification, status: "UNVERIFIED", reasonCode: error.code };
      }));
    }
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
    return taskLockFeedback(error, label) || `${FEEDBACK} 本次纠偏检查未完成：${message}`;
  }
  async function syncNative(state) {
    const observed = await observeNativeTranscript(api, state);
    state.nativeSourceStatus = observed.status;
    if (observed.status === "OBSERVED") {
      await persistTranscript(state, { messages: observed.messages });
      restoreObservedPaths(state);
      state.nativeUserDigest = observed.externalUsersDigest;
      if (!postHeld(state)) state.nativeActiveUserId = observed.lastExternalUser?.uuid;
    }
    return observed;
  }
  // The host persists a user message only after before_prompt_build, and a
  // manual compaction holds back admitted work until it finishes. This
  // read-only capture keeps every message in the requirement log regardless.
  async function recordNativeUserMessages(state) {
    try {
      if (state.scopeClosed) return;
      const scope = await projects.resolve({}, { agentId: state.agentId, sessionId: state.sessionId,
        sessionKey: state.sessionKey, workspaceDir: state.executionDirectory });
      if (!scope.enabled || scope.fingerprint !== state.projectScope.fingerprint) return;
      const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
      if (!archivesUserMessages(plan.runtimeV2)) return;
      const observed = await observeNativeTranscript(api, state);
      if (observed.status === "OBSERVED") await recordUserMessages({ projectRoot: state.projectRoot, sessionId: state.sessionId,
        snapshot: { entries: observed.entries } });
    } catch (error) {
      try { api.logger.warn(`[runtime-corrector] User message log unavailable: ${error.code ?? error.name}`); } catch {}
    }
  }
  async function restoreCompactedRequirements(state, observed, signal) {
    const compacted = observed?.messages.findLast(record => record.type === "compaction" && record.id);
    if (!compacted || signal?.aborted || state.compactionRestoreId === compacted.id) return;
    try {
      const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
      if (plan.runtimeV2?.compactionRestore?.enabled !== true || plan.runtimeV2.shadowMode) return;
      state.compactionRestoreId = compacted.id;
      // The archive is supplied by the original-requirements feature. An
      // unavailable archive is advisory and must not interrupt prompt build.
      const { recordUserMessages } = await import("../runtime-v2/original-requirements.mjs");
      const originals = await recordUserMessages({ projectRoot: state.projectRoot, sessionId: state.sessionId });
      if (!originals.length || signal?.aborted) return;
      const bytes = Buffer.from(COMPACTION_RESTORE_HEADER + originals.map(message => message.text).join("\n\n"));
      const truncated = bytes.length > COMPACTION_RESTORE_LIMIT;
      let end = truncated ? COMPACTION_RESTORE_LIMIT - Buffer.byteLength(COMPACTION_RESTORE_TRUNCATED) : bytes.length;
      // Keep a complete UTF-8 character at the truncation boundary.
      while ((bytes[end] & 0xc0) === 0x80) end--;
      const text = bytes.subarray(0, end).toString() + (truncated ? COMPACTION_RESTORE_TRUNCATED : "");
      const claim = path.join(path.dirname(state.transcriptPath), `compaction-restore-${hash(compacted.id)}`);
      await fs.writeFile(claim, "", { flag: "wx", mode: 0o600 });
      api.logger.info?.(`[runtime-corrector] compaction_restore ${JSON.stringify({ compactedAt: compacted.timestamp ?? null,
        bytes: Buffer.byteLength(text), characters: text.length, truncated })}`);
      return text;
    } catch {
      return;
    }
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
      const postRecord = postRuns?.get(postIdentity(state));
      if (postRecord && !postRuns.closed) await postRuns.close(postIdentity(state), reason);
      if (invalidated) state.nativeInvalidated = true;
      // Only the exact current run's terminal abort may close its task after
      // invalidation. Reset, replacement and scope retirement keep their fence.
      state.nativeTerminalAbortRunId = reason === "RC_NATIVE_ATTEMPT_ENDED" ? runId : null;
      state.reviewController?.abort(Object.assign(new Error("Native review lifecycle ended."), { code: reason }));
      state.requirementFrameWork?.controller.abort();
      await cancelStopScope(state, reason);
      await nativeStart.cancel({ state, reason });
      await followups.cancel({ projectRoot: state.projectRoot, state, reason });
    }
  }
  async function withState(event, ctx, callback, finishResult = result => result) {
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
    const admittedController = state.reviewController, admittedRunId = state.nativeRunId;
    const currentAdmission = () => !nativeHooks || state.reviewController === admittedController
      && state.nativeRunId === admittedRunId && !admittedController.signal.aborted;
    const executeScoped = async () => {
      if (!currentAdmission() || !await scopeCurrent(state) || !currentAdmission()) return;
      const ordinaryRead = toolName(event.toolName) === "Read"
        && !state.seen.has(`skill-read:${event.toolCallId ?? ctx.toolCallId}`);
      if (Object.hasOwn(event, "result") && !ordinaryRead || ctx.runtimeCorrectorIndependentStop === true)
        await hotReviewSettled(state, admittedController);
      if (!currentAdmission()) return;
      state.hookRunId = ctx.runId ?? event.runId;
      let observed;
      if (nativeHooks) {
        if (!currentAdmission()) return;
        observed = await syncNative(state);
        if (observed.status !== "OBSERVED") {
          state.finalRunId = ctx.runId ?? event.runId;
          state.finalNotice = `UNVERIFIED：RC 无法读取本次原生会话依据：${observed.reason ?? observed.status}。宿主继续执行。`;
          return;
        }
      }
      if (!currentAdmission()) return;
      if ((!state.supervised && !nativeHooks) || !event.toolName) {
        const result = await callback(state, observed);
        return await scopeCurrent(state) ? finishResult(result) : undefined;
      }
      admittedController.signal.throwIfAborted();
      const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
      if (!plan.runtimeV2?.enabled) return finishResult(await callback(state, observed));
      let task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
      if (!task && CORRECTION_ENTRY_TOOLS.has(toolName(event.toolName))) {
        task = await ensureTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
        if (!Object.hasOwn(event, "result")) await captureTaskStart({ projectRoot: state.projectRoot, taskId: task.taskId,
          deadlineAt: (ctx.runtimeCorrectorHookDeadlineAt ?? Infinity) - 1000 });
      }
      if (!task) return finishResult(await callback(state, observed));
      await state.onTaskState?.(task);
      task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
      if (!currentAdmission()) return;
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
        guard: decisionGuard(task), abortSignal: admittedController.signal, deadlineAt: state.runDeadlineAt,
        maxCorrections: plan.runtimeV2?.stopCorrection?.maxCorrectionsPerFlow,
        evidenceMatches: async () => await scopeAllowed(state, admittedController) && await ledger.matches(),
      } }, () => callback(state, observed)); }
      finally { state.observeReviewTool = previousObserver; state.artifactEvidence = previousEvidence; }
      if (result?.stale || !await scopeCurrent(state)) return undefined;
      return finishResult(result);
    };
    const execute = () => {
      let complete;
      const completed = new Promise(resolve => { complete = resolve; });
      return queue(state, async () => {
        state.hotHookCompletion = completed;
        const previousMaterialDeadline = state.materialCaptureDeadlineAt;
        state.materialCaptureDeadlineAt = ctx.runtimeCorrectorHookDeadlineAt;
        try { return await executeScoped(); }
        finally {
          state.materialCaptureDeadlineAt = previousMaterialDeadline;
          complete();
          if (state.hotHookCompletion === completed) state.hotHookCompletion = null;
        }
      });
    };
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
    if (!state || !runId || runId === state.nativeRunId || nativeStart?.knowsRun(state, runId) || postRuns?.get(postIdentity(state))) return;
    for (const job of stopReviews?.pending(state, runId) ?? []) job.expire();
  }
  async function waitForStop(event = {}, ctx = {}, hookName = "reply_dispatch") {
    if (!nativeHooks || settings.enabled === false || internal(event, ctx)) return;
    const state = [...states.values()].find(value => value.sessionKey === (event.sessionKey ?? ctx.sessionKey));
    if (!state || staleStopRun(state, event, ctx)) return;
    const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
    if (plan.runtimeV2.stopCorrection.waitMode === "until_pass") return;
    const runId = ctx.runId ?? event.runId;
    const pending = stopReviews.pending(state, runId);
    if (!pending.length || !await scopeCurrent(state) || await findFollowup(state, runId)) return;
    const deadlineAt = Math.min(...pending.map(job => job.record.deadlineAt), Date.now() + hookBudget(hookName));
    let heartbeat;
    const current = () => !state.scopeClosed && !ctx.abortSignal?.aborted;
    const pulse = async () => {
      const healthy = await stopStatus({ state, runId, phase: "waiting", deadlineAt,
        signal: ctx.abortSignal, waiting: true, isCurrent: current, text: "后续任务暂缓，正在等待 RC 审查结算和反馈交付。" });
      if (healthy === false) for (const job of pending) job.expire("RC_STOP_KEEPALIVE_UNAVAILABLE");
    };
    try {
      await pulse(); heartbeat = setInterval(() => { void pulse(); }, 30000);
      await beforeStopDeadline(() => Promise.all(pending.map(job => job.released)), { deadlineAt, signal: ctx.abortSignal });
    } catch { if (!ctx.abortSignal?.aborted) for (const job of pending) job.expire(); }
    finally { clearInterval(heartbeat); stopStatus.close(state, runId); }
  }
  async function registerPostCandidate(state, event, ctx, text, awaitGatewayTerminal = false) {
    const runId = ctx.runId ?? event.runId, controller = state.reviewController;
    const current = () => state.nativeRunId === runId && state.reviewController === controller && !state.scopeClosed;
    const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
    const identity = postIdentity(state);
    const held = postRuns.get(identity);
    // Reply draining can include native context compaction after agent_end.
    // Keep waiting for the public terminal; a short tool-hook budget is not
    // a reliable upper bound for that host work.
    const terminalBudgetMs = Math.max(resolveHookTimeoutMs(settings.hookTimeoutMs), 300000);
    const armedApply = hasArmedOpenSpecApply(state, runId);
    if (!armedApply && !awaitGatewayTerminal && !state.postRunEnabled && plan.runtimeV2.stopCorrection.waitMode !== "until_pass"
      && state.coexistence?.status !== "RUNNING" && held?.phase !== "COEXIST_WAIT") return false;
    if (!current()) return { status: "STALE" };
    state.postRunEnabled = true;
    let registrationError;
    try {
      const registered = await postRuns.register(identity);
      if (registered.phase === "IDLE") await postRuns.started(identity, runId, undefined, false);
      if (held?.phase === "COEXIST_WAIT" && held.runId !== runId && postRuns.externalStarted)
        await postRuns.externalStarted(identity, runId, state.coexistence);
      if (state.coexistence) await postRuns.noteCoexistence?.(identity, state.coexistence);
      await postRuns.candidate(identity, { runId,
        completion: event.success === true && !event.error && !event.aborted
          ? { runId, success: true, event: 'agent_end' } : state.nativeCompletion?.runId === runId ? state.nativeCompletion : undefined,
        text: text ?? "", needsReview: armedApply || Boolean(state.nativeNeedsStop && plan.runtimeV2.stopCorrection.enabled),
        reviewBudgetMs: directReviewBudget(plan, "before_agent_finalize"),
        terminalBudgetMs });
      const admitted = postRuns.snapshot(identity);
      if (admitted?.runId === runId && (admitted.candidate?.runId === runId || admitted.completedRuns.includes(runId)))
        return { status: "REGISTERED" };
    } catch (error) { registrationError = error.code ?? error.name; }
    // A newer native run may finish before the old owner reaches a safe held
    // state. Never release that unresolved owner or claim the new Stop was
    // registered: retain an exact-run failure and bounded candidate for review.
    if (!current()) return { status: "STALE" };
    const owner = postRuns.snapshot(identity), reasonCode = owner?.runId !== runId
      ? "POST_RUN_CANDIDATE_OWNER_CONFLICT" : "POST_RUN_CANDIDATE_REGISTRATION_FAILED";
    const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
    if (task && current()) await outsideDecision(async () => {
      let changed = false;
      await lateCandidates.write(state, async () => {
        let persistedCheckpoint;
        await withTaskState({ projectRoot: state.projectRoot, taskId: task.taskId }, saved => {
          if (!current()) return;
          const candidateText = text ?? "", digest = hash(candidateText), previous = saved.stop?.postRunCandidate;
          if (previous?.runId === runId && previous.digest === digest && ["UNVERIFIED", "ADOPTED"].includes(previous.status)) {
            persistedCheckpoint = structuredClone(previous); return;
          }
          saved.stop ??= {};
          saved.stop.postRunCandidate = { status: "UNVERIFIED", runId, reasonCode, digest,
            text: candidateText.slice(0, 200000), truncated: candidateText.length > 200000,
            identity, needsReview: Boolean(state.nativeNeedsStop && plan.runtimeV2.stopCorrection.enabled),
            reviewBudgetMs: directReviewBudget(plan, "before_agent_finalize"),
            terminalBudgetMs,
            ownerRunId: owner?.runId ?? null, ownerPhase: owner?.phase ?? null, registrationError, recordedAt: Date.now() };
          persistedCheckpoint = structuredClone(saved.stop.postRunCandidate);
          changed = true;
        });
        return current() ? persistedCheckpoint : null;
      });
      if (changed) await appendTaskJournal(state.projectRoot, task.taskId, { type: "POST_RUN_CANDIDATE_UNVERIFIED",
        runId, reasonCode, ownerRunId: owner?.runId ?? null, ownerPhase: owner?.phase ?? null });
      await settleIncompleteStop({ projectRoot: state.projectRoot, taskId: task.taskId, runId, reasonCode, isCurrent: current });
    });
    api.logger.warn(`[runtime-corrector] ${reasonCode}: ${runId}; prior owner retained.`);
    return { status: "UNVERIFIED", reasonCode };
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
  async function submitNativeFollowup(state, expectedRunId, saved, deadlineAt = Infinity, openSpecPlanRevision = null) {
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
      evidenceDigest: observed.evidenceDigest, ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}),
      ...(openSpecPlanRevision ? { openSpecPlanRevision } : {}) };
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
  async function restorationSourceDigest(state) {
    // Reuse the generic production discovery and the host's exact observed
    // paths. Navigation does not authorize new scope or substitute for the
    // fresh original-requirement review after the restoration.
    const manifest = await collectSourceManifest(state.projectRoot, null, { includeTestSources: true });
    if (manifest.length >= 400) throw Object.assign(new Error("The restoration source snapshot is incomplete."), { code: "OPENSPEC_RESTORATION_SOURCE_LIMIT" });
    const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
    const paths = [...state.observedPaths ?? [], plan.configPath,
      ...(plan.artifacts ?? []).flatMap(artifact => [artifact.reviewerFile, artifact.simpleRulesFile])]
      .filter(file => evidencePath(state.projectRoot, file));
    const fingerprints = await Promise.all([...new Set(paths)].sort().map(async file => [file, await fingerprint(file)]));
    return sha256({ manifest, fingerprints, policy: sha256(plan) });
  }
  async function requestPlanRestoration(state, { runId, controller, ownerSignal, openSpecPlan, nativeReceipt,
    occurrenceId, deadlineAt, config, commit, finding }) {
    if (openSpecPlan?.status !== "CHANGED" || config.runtimeV2?.shadowMode
      || !config.runtimeV2?.stopCorrection?.enabled) return finding;
    const signal = AbortSignal.any([controller.signal, ownerSignal].filter(Boolean));
    const current = async () => !signal.aborted && state.nativeRunId === runId && state.reviewController === controller
      && !state.nativeInvalidated && !state.scopeClosed && await scopeCurrent(state);
    try {
      const observed = await observeNativeTranscript(api, state);
      const sourceInputId = state.entries?.findLast(entry => entry.type === "user" && !entry.isMeta)?.uuid;
      const sourceSha256 = await restorationSourceDigest(state);
      const assessment = await assessOpenSpecPlanRestoration({ state, runId, openSpecPlan, nativeReceipt,
        observed, sourceInputId, sourceSha256, directory: sessionStopDirectory(state), stopId: occurrenceId,
        config: config.runtimeV2.stopCorrection, hostDeadlineAt: deadlineAt, signal, isCurrent: current,
        admissionSupported: await nativeStart.ready(),
        sourceCurrent: async expected => {
          if (!await current()) return false;
          const latest = await observeNativeTranscript(api, state);
          return latest.status === "OBSERVED" && latest.externalUsersDigest === observed.externalUsersDigest
            && await restorationSourceDigest(state) === expected && await current();
        } });
      if (!assessment) {
        const result = { ...finding, restorationStatus: "UNVERIFIED", restorationReason: "OPENSPEC_RESTORATION_BASIS_UNVERIFIED" };
        await commit(result);
        return result;
      }
      const result = { ...finding, evaluationId: assessment.outcome?.stopCorrection.evaluationId,
        restorationStatus: assessment.core.admission ? "ADMITTED" : "NOT_ADMITTED",
        restorationReason: assessment.core.failure?.code ?? assessment.core.stop.releaseReason ?? null,
        reviewSummary: { purpose: PLAN_RESTORATION_PURPOSE, approvedRevision: openSpecPlan.approvedRevision,
          changedRevision: openSpecPlan.currentRevision } };
      await commit(result);
      if (assessment.outcome && await current()) {
        const receipt = await nativeStart.submit({ state, outcome: assessment.outcome,
          source: { ...assessment.source, deadlineAt: assessment.core.stop.deadlineAt } });
        if (state.nativeRunId === runId) state.nativeFollowupReceipt = receipt;
        result.followupStatus = receipt.status;
      }
      return result;
    } catch (error) {
      const result = { ...finding, restorationStatus: "UNVERIFIED", restorationReason: error.code ?? error.name };
      await commit(result);
      return result;
    }
  }
  async function scheduleNativeStop(state, { text, runId, ctx, receipt = null, nativeReceipt = null, opportunity = null, preparedAssessment = null, openSpecPlan = null }) {
    const controller = state.reviewController;
    const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
    if (state.nativeRunId !== runId || state.nativeInvalidated || state.reviewController !== controller) return;
    const occurrenceId = ctx.runtimeCorrectorStopId ?? stopOccurrenceId(runId, state.enabledRevision);
    const waitMode = plan.runtimeV2.stopCorrection.waitMode;
    const planFinding = openSpecApplyFinding(openSpecPlan);
    const strictApply = hasApprovedApplyInventory(state, runId);
    return stopReviews.schedule({ projectRoot: state.projectRoot, sessionId: state.sessionId,
      sessionKey: state.sessionKey, runId, occurrenceId, enabledRevision: state.enabledRevision, signal: controller.signal, openSpecPlan,
      budgetMs: Math.max(1, Math.min(directReviewBudget(plan, "before_agent_finalize"), (ctx.runtimeCorrectorReviewDeadlineAt ?? Infinity) - Date.now())), waitMode,
      onCancel: reason => controller.abort(reason),
      onSettled: async record => {
        let terminal;
        try {
          if (!planFinding && record.reasonCode && (!record.assessmentCompletedAt || record.reviewStatus === 'UNVERIFIED' && !record.evaluationId)) {
            try {
              await followups.finish({ projectRoot: state.projectRoot, state, runId, status: "UNVERIFIED", reasonCode: record.reasonCode });
            } finally {
              const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
              if (task) terminal = await settleIncompleteStop({ projectRoot: state.projectRoot, taskId: task.taskId, runId,
                reasonCode: record.reasonCode, startedAt: record.createdAt,
                 isCurrent: () => state.nativeRunId === runId && state.reviewController === controller && !state.scopeClosed && !state.nativeInvalidated });
            }
          }
        } catch (error) { api.logger.warn(`RC Stop termination metadata: ${error.message}`); }
        finally {
          if (terminal) Object.assign(record, { verificationFeedback: terminal.feedback, terminalIndex: terminal.indexPath });
          await stopStatus({ state, runId, phase: "settled", text: stopWaitText(record),
             isCurrent: () => state.nativeRunId === runId && state.reviewController === controller && !state.scopeClosed });
        }
        const noticeTask=await findTask({projectRoot:state.projectRoot,sessionId:state.sessionId,explicitTaskId:state.scopeTaskId});
        if(!plan.runtimeV2?.shadowMode)await publishReviewNotice({state,record,taskId:noticeTask?.taskId ?? (planFinding ? state.scopeTaskId : null),
          isCurrent:()=>state.nativeRunId===runId&&state.reviewController===controller&&!state.scopeClosed});
        return terminal ? { verificationFeedback: terminal.feedback, terminalIndex: terminal.indexPath } : undefined;
      },
      run: async ({ deadlineAt, ownerSignal, commit }) => {
        if (state.nativeRunId !== runId || controller.signal.aborted) return { reviewStatus: "CANCELLED" };
        if (planFinding) return requestPlanRestoration(state, { runId, controller, ownerSignal, openSpecPlan, nativeReceipt,
          occurrenceId, deadlineAt, config: plan, commit, finding: planFinding });
        if (!strictApply && openSpecPlan && !(state.nativeNeedsStop && plan.runtimeV2.stopCorrection.enabled)) return { reviewStatus: "DISABLED" };
        const ownerClosed = () => controller.abort(ownerSignal.reason);
        if (ownerSignal?.aborted) ownerClosed();
        else ownerSignal?.addEventListener("abort", ownerClosed, { once: true });
        state.nativePostRunReview = true;
        let result;
        try {
          let inventory, inventoryCurrent;
          if (strictApply) {
            const readInventory = async receipt => approvedInventoryForApply(state, runId,
              await observeNativeTranscript(api, state), receipt);
            inventory = openSpecPlan?.status === "PRESERVED" && await beforeStopDeadline(() => readInventory(nativeReceipt),
              { deadlineAt, signal: controller.signal });
            if (!inventory) return { reviewStatus: "UNVERIFIED", reasonCode: "OPENSPEC_APPLY_INVENTORY_BASIS_UNVERIFIED" };
            inventoryCurrent = async () => {
              if (state.nativeRunId !== runId || controller.signal.aborted) return false;
              const receipt = openSpecPlan.continuationRunId ? await nativeStart.findRun({ state, runId }) : nativeReceipt;
              const [currentPlan, currentInventory] = await Promise.all([inspectArmedOpenSpecApply(state, runId), readInventory(receipt)]);
              return currentPlan?.status === "PRESERVED" && currentPlan.currentRevision === openSpecPlan.currentRevision
                && currentInventory?.inventorySha256 === inventory.inventorySha256;
            };
          }
          const ledger = state.stopSessionDirectory && await createStopCorrectionStore({ directory: state.stopSessionDirectory }).inspect(state.sessionId);
          const repair = Object.values(ledger?.admissions ?? {}).findLast(value => value.accounting === "USED"
            && (value.hostRequest?.runId === runId || value.originalRequest?.runId === runId));
          const finalVerification = repair && (ledger.used >= plan.runtimeV2.stopCorrection.maxCorrectionsPerSession
            || ledger.flows[repair.flowId].used >= (waitMode === "assessment" ? 1 : plan.runtimeV2.stopCorrection.maxCorrectionsPerFlow));
          const cached = !inventory && preparedAssessment && await nativeStopSource(state, runId, preparedAssessment, deadlineAt);
          const assessed = cached ? preparedAssessment : await handlers.finalize({ lastAssistantMessage: text, stopHookActive: Boolean(receipt || state.nativeRetryEvidenceStop) }, {
              ...ctx, sessionId: state.sessionId, sessionKey: state.sessionKey, workspaceDir: state.executionDirectory,
              agentId: state.agentId, runId, runtimeCorrectorIndependentStop: true,
              runtimeCorrectorReviewDeadlineAt: deadlineAt,
              runtimeCorrectorVerificationOnly: Boolean(finalVerification || state.nativeRetryUnverifiedStop),
              [approvedCoverage]: approvedCoverageForApply(state, runId, openSpecPlan),
              ...(inventory ? { [approvedInventory]: { inventory, isCurrent: inventoryCurrent,
                revision: openSpecPlan.currentRevision, runId } } : {}),
            });
          if (state.nativeRunId !== runId || controller.signal.aborted) return { reviewStatus: "CANCELLED" };
          const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
          const current = assessed?.runId === runId && ["allow", "block"].includes(assessed.outcome?.decision)
            && task?.verification?.assessmentId === assessed.assessmentId;
          const reviewMethodScope = current ? currentStopReviewMethodScope(assessed.outcome.review?.reviewMethodScope,
            { taskId: task.taskId, evaluationId: task.verification.evaluationId, assessmentId: assessed.assessmentId }) : null;
          result = { reviewStatus: current ? task.verification.status : "UNVERIFIED",
            evaluationId: current ? task.verification.evaluationId : null,
            ...(current ? { reviewSummary: { evaluationId: task.verification.evaluationId, assessmentId: assessed.assessmentId,
              groundTruthVersion: assessed.outcome.review?.groundTruthVersion,
              scopeSelection: assessed.outcome.review?.scopeSelection, status: task.verification.status,
              reviewCoverage: summarizeStopReviewCoverage(assessed.outcome.review?.reviewCoverage, plan.runtimeV2.locale),
              ...(reviewMethodScope ? { reviewMethodScope } : {}),
              reviewCoverageReceipt: createStopReviewCoverageReceipt({ reviewStatus: task.verification.status, outcome: assessed.outcome,
                publication: assessed.coveragePublication,
                owner: { projectRoot: state.projectRoot, sessionId: state.sessionId, sessionKey: state.sessionKey, runId,
                  taskId: task.taskId, assessmentId: assessed.assessmentId, evaluationId: task.verification.evaluationId,
                  scopeFingerprint: state.projectScope?.fingerprint ?? state.scopeFingerprint, enabledRevision: state.enabledRevision ?? 0 } }),
              ...(assessed.outcome.review?.approvedProposalInventory ? { approvedProposalInventory: assessed.outcome.review.approvedProposalInventory } : {}),
              reviewedObjectCount: assessed.outcome.review?.metricObjectJudgements?.length ?? 0 } } : {}),
            ...(!current ? { reasonCode: assessed?.outcome?.reasonCode ?? assessed?.outcome?.reason ?? 'STOP_ASSESSMENT_NOT_PUBLISHED' }
              : assessed.outcome.reasonCode ? { reasonCode: assessed.outcome.reasonCode } : {}),
            ...(current && stopFeedbackNotice(assessed.outcome) ? { verificationFeedback: stopFeedbackNotice(assessed.outcome) } : {}),
            ...(assessed?.outcome?.correctionBudgetExhausted && !assessed.outcome.stopCorrection ? { reasonCode: "CORRECTION_BUDGET_EXHAUSTED" } : {}) };
          if(current&&assessed.outcome.partialFeedbackEligible)result.feedbackOnly=true;
          if (finalVerification && !["PASS", "NO_DEVIATION_FOUND", "COMPLETED_WITH_HISTORICAL_DEVIATIONS"].includes(result.reviewStatus))
            result.reasonCode = "CORRECTION_BUDGET_EXHAUSTED";
          await commit(result); // Persist the old run's assessment before the host can start a new run.
          if (finalVerification && current && result.evaluationId) await createStopCorrectionStore({ directory: state.stopSessionDirectory })
            .finishRepairReview({ sessionId: state.sessionId, admissionId: repair.id, status: result.reviewStatus, evaluationId: result.evaluationId });
          let followup;
          if (opportunity) {
            const source = await nativeStopSource(state, runId, assessed, deadlineAt);
            if (source && opportunity.isOpen() && !state.nativeOriginalOffered?.has(runId)) {
              const decision = await nativeStart.offerOriginal({ state, outcome: assessed.outcome, source, isOpen: opportunity.isOpen,
                reproduction: frameReproduction(plan.runtimeV2) });
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
          } else if (!inventoryCurrent || await inventoryCurrent()) followup = await submitNativeFollowup(state, runId, assessed,
            deadlineAt, inventory ? openSpecPlan.currentRevision : null);
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
      const postState = states.get(`${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`);
      const coexistence = postState && await coexistenceFor(postState, ctx.abortSignal);
      if (postState && postState.nativeRunId === runId) {
        try { if (await registerPostCandidate(postState, event, ctx, event.lastAssistantMessage)) return; }
        catch (error) { try { api.logger.warn(`[runtime-corrector] Stop registration: ${error.message}`); } catch {} return; }
      }
      const state = states.get(`${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`);
      if (!state || state.nativeRunId !== runId || !state.nativeNeedsStop || state.nativeInvalidated) return;
      if (coexistence?.status === "RUNNING") {
        state.autopilotCandidate = { runId, text: event.lastAssistantMessage ?? "" };
        return;
      }
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
          void postRuns?.release(postIdentity(state), "STOP_REGISTRATION_FAILED").catch(() => {});
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
      const active = [...states.values()].find(s => s.sessionId === state.sessionId && s.sessionKey === state.sessionKey);
      const post = active && postRuns?.get(postIdentity(active));
      const knownContinuation = nativeStart.knowsRun(state, runId);
      const owned = knownContinuation || /^rc-stop-[a-f0-9]{64}$/u.test(runId ?? "");
      const coexistence = active && await coexistenceFor(active, ctx.abortSignal);
      const heldTerminal = post?.phase === "COEXIST_WAIT" && post.candidate?.runId === post.runId
        && Number.isFinite(post.candidate.terminalConfirmedAt) && post.reconciliation?.status !== "UNKNOWN"
        && !post.correctionRunId && !post.dispatching;
      if (post && post.phase !== "CLOSED" && post.phase !== "IDLE" && post.runId !== runId && post.correctionRunId !== runId
        && !((coexistence?.status === "RUNNING" || heldTerminal) && !owned))
        return { outcome: "block", reason: "RC_PENDING_TASK_NOT_ADMITTED", message: "该会话正在审查或纠偏，请通过 RC 控制页管理待执行任务。" };
      // The reserved ID namespace may deny an unverifiable continuation, but
      // never grants admission. A persisted, checked receipt is still required.
      const deny = { outcome: "block", reason: "RC_STOP_ADMISSION_CLOSED", message: "RC 续修准入未能核实，未启动本次自动纠偏。" };
      const measure = admissionTiming(api.logger);
      const gateAbort = new AbortController();
      const gateSignal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, gateAbort.signal]) : gateAbort.signal;
      try {
        if (!nativeHooks || internal(event, ctx)) return;
        return await beforeStopDeadline(async () => {
          const directory = sessionStopDirectory(state);
          // Remembered navigation skips only redundant initialization. The
          // gate below still reads current durable ownership and invalidation.
          if (directory && !knownContinuation) await initializeNativeHistory(state, measure);
          const decision = await nativeStart.gate({ state, event, runId, signal: gateSignal, measure });
          return owned && !decision ? deny : decision;
        }, { deadlineAt: Date.now() + 1000, signal: gateSignal });
      } catch (error) {
        measure.snapshot();
        try { api.logger.warn(`[runtime-corrector] Input check unavailable: ${error.code ?? error.name}`); } catch {}
        // MA fails this hook closed on throws/timeouts. RC's own health must
        // never veto ordinary input. Only a known RC continuation is denied.
        return owned ? deny : undefined;
      } finally {
        gateAbort.abort(Object.assign(new Error('Input admission gate ended.'), { code: 'STOP_ADMISSION_GATE_ENDED' }));
        measure.flush();
      }
    },
    // These public awaited hooks run before our stateFor can replace the run.
    async beforeDispatch(event, ctx = {}) {
      if (!nativeHooks || settings.enabled === false || internal(event, ctx)) return;
      const sessionKey = event.sessionKey ?? event.ctx?.SessionKey ?? ctx.sessionKey;
      const state = [...states.values()].find(s => s.sessionKey === sessionKey);
      const post = state && postRuns.get(postIdentity(state));
      const runId = event.runId ?? ctx.runId;
      if (post && post.phase !== "CLOSED" && post.phase !== "IDLE"
        && !(runId && [post.runId, post.correctionRunId, post.dispatching?.runId].includes(runId))) {
        const source = event.ctx;
        if (!source || source.InputProvenance?.kind && source.InputProvenance.kind !== "external_user") return;
        if (ctx.abortSignal?.aborted || event.isTailDispatch) return;
        if (!await scopeCurrent(state)) return;
        const scopes = source.GatewayClientScopes ?? [];
        if (!scopes.includes("operator.write") && !scopes.includes("operator.admin")) return;
        const text = source.RawBody ?? source.BodyForCommands;
        if (!source.MessageSid || typeof text !== "string" || !text.trim()) return;
        const media = (source.MediaPaths ?? []).map((filePath, index) => ({ filePath,
          ...(source.MediaTypes?.[index] ? { mimeType: source.MediaTypes[index] } : {}) }));
        await postRuns.defer(postIdentity(state), { sourceId: source.MessageSid, text,
          options: media.length ? { media } : {} });
        const queuedFinal = event.sendPolicy !== "deny" && !event.suppressUserDelivery
          ? ctx.dispatcher.sendFinalReply({ text: "已保存为该会话的待执行任务，可在 RC 控制页编辑或删除。" }) : false;
        ctx.recordProcessed(queuedFinal ? "completed" : "skipped"); ctx.markIdle("runtime-corrector-pending-task");
        return { handled: true, queuedFinal: Boolean(queuedFinal), counts: ctx.dispatcher.getQueuedCounts() };
      }
      await waitForStop(event, ctx, "reply_dispatch");
    },
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
      let frameStart;
      return withState(event, ctx, async (state, nativeObservation) => {
        state.businessToolPolicyDigest = nativeToolPolicyDigest(api, state);
        let restored;
        const promptContext = feedback => {
          const prependContext = joined(restored, feedback);
          return prependContext ? { prependContext } : undefined;
        };
        try {
          const runId = ctx.runId ?? event.runId;
          if (nativeHooks) {
            restored = await restoreCompactedRequirements(state, nativeObservation, ctx.abortSignal);
            const ownedRun = await findFollowup(state, runId);
            if (ownedRun) {
              state.nativeNeedsStop = true;
              const prepared = await nativeStart.prepare({ state, runId, signal: ctx.abortSignal, reproduction: state.stopFrameReproduction });
              return promptContext(prepared?.prependContext);
            }
            const observed = await syncNative(state);
            if (observed.status !== "OBSERVED" || !observed.lastExternalUser) return promptContext();
            if (state.preparedNativeUsers === observed.externalUsersDigest) {
              if (state.requirementFrameRunId && runId && runId !== state.requirementFrameRunId
                && ["user", "manual"].includes(ctx.trigger)) {
                const value = await context(state, "before_prompt_build");
                if (startRequirementFrame(state, value.plan, value.reviewerFactory.requirementFrame, hotReviewTasks, runId, observed.externalUsersDigest))
                  frameStart = () => takeFrameBrief(state, value.plan, runId, "run_start", ctx);
              }
              return promptContext();
            }
            await followups.cancel({ projectRoot: state.projectRoot, state, reason: "NEW_USER_TURN" });
            await cancelStopScope(state, "NEW_USER_TURN");
            state.preparedNativeUsers = observed.externalUsersDigest;
            const previousTask = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
            // A registered Stop interrupted by missing history or changed
            // search evidence still needs acceptance on a genuine new turn.
            // Ordinary read-only chats after PASS do not re-arm review.
            if (previousTask?.verification?.status === "UNVERIFIED"
              && ["STOP_SESSION_MIGRATION_REQUIRED", "BASELINE_INPUT_CHANGED"].includes(previousTask.verification.reasonCode)) {
              state.nativeNeedsStop = true;
              state.nativeRetryUnverifiedStop = previousTask.verification.reasonCode === "STOP_SESSION_MIGRATION_REQUIRED";
              state.nativeRetryEvidenceStop = previousTask.verification.reasonCode === "BASELINE_INPUT_CHANGED";
            }
            const previousNotice = savedStopFeedbackNotice(previousTask);
            state.finalNotice = null; state.nativeAssessment = null;
            const prompt = observed.lastExternalUser.message.content.filter(x => x.type === "text").map(x => x.text).join("\n");
            const value = await context(state, "before_prompt_build");
            const frameTurn = startRequirementFrame(state, value.plan, value.reviewerFactory.requirementFrame, hotReviewTasks, runId, observed.externalUsersDigest);
            const outcome = await run(state, "UserPromptSubmit", { prompt }, value);
            if (frameTurn) frameStart = () => takeFrameBrief(state, value.plan, runId, "run_start", ctx);
            if (previousNotice && state.lastVerificationNotice !== previousNotice.evaluationId) {
              state.lastVerificationNotice = previousNotice.evaluationId;
              return promptContext(boundHostFeedback([outcome.feedback, previousNotice.feedback].filter(Boolean).join("\n\n"), {
                prefix: `${FEEDBACK}\n以下包含本轮反馈和上次 Stop 保留事项。历史评审及依据位置仅供定位，请结合当前文件和原要求核对；它不新增用户需求，也不证明当前文件仍有同一问题。`,
              }));
            }
            return promptContext(outcome.feedback ? `${FEEDBACK}\n${outcome.feedback}` : undefined);
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
          startRequirementFrame(state, value.plan, value.reviewerFactory.requirementFrame, hotReviewTasks, runId);
          const outcome = await run(state, "UserPromptSubmit", { prompt: event.prompt }, value);
          if (state.frameBrief) frameStart = () => takeFrameBrief(state, value.plan, runId, "run_start", ctx);
          if (outcome.feedback) return { prependContext: `${FEEDBACK}\n${outcome.feedback}` };
        } catch (error) { return promptContext(await failure(state, error, "PROMPT")); }
      }, async result => {
        const brief = await frameStart?.();
        return brief ? { prependContext: joined(result?.prependContext, brief) } : result;
      });
    },
    async beforeTool(event, ctx) {
      const snapshotDeadline = performance.now() + Math.min(1000, hookBudget("before_tool_call"));
      if (isInternalExecution()) {
        const decision = await observeInternalTool(event.toolName, event.params, { toolCallId: event.toolCallId ?? ctx.toolCallId,
          runId: ctx.runId ?? event.runId, sessionId: ctx.sessionId ?? event.sessionId, sessionKey: ctx.sessionKey ?? event.sessionKey, agentId: ctx.agentId });
        if (decision) return decision;
      }
      if (isHostMaintenanceRun(event, ctx, hostMaintenanceRuns)) return;
      // The pinned native runtime supplies only {runtime:"openclaw"} to
      // result middleware. Bind the exact call before execution; never infer
      // a session from cwd (several conversations can share one workspace).
      const callId = event.toolCallId ?? ctx.toolCallId;
      if (callId && ctx.sessionId) {
        const scope = await projects.resolve(event, ctx);
        const owner = states.get(`${ctx.agentId ?? "main"}:${ctx.sessionId}`), runId = ctx.runId ?? event.runId ?? owner?.nativeRunId ?? owner?.hookRunId ?? null;
        const bindingKey = `${ctx.agentId ?? "main"}:${ctx.sessionId}:${ctx.runId ?? ""}`;
        const captured = toolBindings.get(callId)?.has(bindingKey);
        const documentSnapshot = !captured && settings.enabled !== false && scope.enabled && !internal(event, ctx) && isDocumentCommand(event.toolName)
          ? await snapshotDocumentFiles(scope.plan ?? await loadConfig({ cwd: scope.projectRoot, pluginRoot }), scope.projectRoot,
            { observedPaths: owner?.observedPaths, active: () => ctx.abortSignal?.throwIfAborted(), deadlineAt: snapshotDeadline }) : null;
        if (documentSnapshot && !runId) documentSnapshot.unverified.push("DOCUMENT_RUN_ID_UNAVAILABLE");
        const bindings = toolBindings.get(callId) ?? new Map(), prior = bindings.get(bindingKey);
        bindings.set(bindingKey, {
          ...ctx, runtimeCorrectorScopeFingerprint: scope.fingerprint,
          runtimeCorrectorControlEnabled: scope.enabled,
          runtimeCorrectorEnabledRevision: states.get(`${ctx.agentId ?? "main"}:${ctx.sessionId}`)?.enabledRevision
            ?? pausedScopes.get(`${ctx.agentId ?? "main"}:${ctx.sessionId}`)?.enabledRevision ?? 0,
          runtimeCorrectorVerification: prior?.runtimeCorrectorVerification,
          runtimeCorrectorApprovedPlanRead: prior ? prior.runtimeCorrectorApprovedPlanRead
            : !internal(event, ctx) && scope.enabled && event.toolName === "runtime_corrector" && event.params?.command === "approved-plan"
              ? { runId, controller: owner?.reviewController, argsSha256: sha256(event.params) } : null,
          // Duplicate hook delivery cannot replace a command's original bytes
          // or transfer its ownership to a later controller in the same run.
          runtimeCorrectorDocumentSnapshot: prior ? prior.runtimeCorrectorDocumentSnapshot : documentSnapshot ? { snapshot: documentSnapshot, runId,
            controller: (owner?.nativeRunId ?? owner?.hookRunId) === runId ? owner?.reviewController : null, admitted: false } : null,
          runtimeCorrectorDocumentProcess: prior ? prior.runtimeCorrectorDocumentProcess : scope.enabled && runId && String(event.toolName).split(".").at(-1).toLowerCase() === "process"
            && ["poll", "kill"].includes(event.params?.action) && typeof event.params.sessionId === "string" ? { action: event.params.action, sessionId: event.params.sessionId, runId,
              controller: (owner?.nativeRunId ?? owner?.hookRunId) === runId ? owner?.reviewController : null, admitted: false } : null,
          ...(internal(event, ctx) ? { runtimeCorrectorInternal: true } : {}),
        });
        toolBindings.set(callId, bindings);
        if (toolBindings.size > 5000) toolBindings.delete(toolBindings.keys().next().value);
      }
      return withState(event, ctx, async (state, observed) => {
        const id = event.toolCallId ?? ctx.toolCallId;
        if (!id) return;
        // The first event after a restart can be this tool call. Bind the
        // restored task revision rather than the pre-activation fallback zero.
        for (const binding of toolBindings.get(id)?.values() ?? []) {
          if (binding.sessionId === state.sessionId && (binding.agentId ?? "main") === state.agentId
            && (!binding.runId || binding.runId === (ctx.runId ?? event.runId))) {
            binding.runtimeCorrectorEnabledRevision = state.enabledRevision;
            for (const receipt of [binding.runtimeCorrectorDocumentSnapshot, binding.runtimeCorrectorDocumentProcess]) {
              if (!receipt || receipt.runId !== (ctx.runId ?? event.runId ?? state.nativeRunId ?? state.hookRunId)) continue;
              // stateFor may have created this controller after capture. Only
              // this admitted before-hook may claim an unbound receipt.
              if (receipt.controller == null) receipt.controller = state.reviewController;
              if (receipt.controller === state.reviewController) receipt.admitted = true;
            }
          }
        }
        const key = `pre:${id}`;
        if (state.seen.has(key)) return state.seen.get(key);
        try {
          const value = await context(state, "before_tool_call");
          const runId = ctx.runId ?? event.runId;
          // The first user message may not exist until after prompt build.
          if (nativeHooks && runId && !state.requirementFrameRunId && observed?.initialTurnEvidence && observed.lastExternalUser
            && [undefined, "user", "manual"].includes(ctx.trigger) && requirementFrameEnabled(value.plan.runtimeV2)
            && !value.plan.runtimeV2.shadowMode && !await findFollowup(state, runId).catch(() => true))
            startRequirementFrame(state, value.plan, value.reviewerFactory.requirementFrame, hotReviewTasks, runId, observed.externalUsersDigest);
          if (nativeHooks) await initializeNativeHistory(state);
          const args = event.params ?? {};
          if (nativeHooks && state.nativeRunId && event.toolName === value.plan.runtimeV2?.acceptanceFeedback?.tool) {
            for (const binding of toolBindings.get(id)?.values() ?? []) {
              if (binding.sessionId === state.sessionId && (binding.agentId ?? "main") === state.agentId
                && (!binding.runId || binding.runId === state.nativeRunId))
                binding.runtimeCorrectorVerification ??= { runId: state.nativeRunId, controller: state.reviewController,
                  tool: event.toolName, args: structuredClone(args) };
            }
          }
          if (nativeHooks && CORRECTION_ENTRY_TOOLS.has(toolName(event.toolName))) state.nativeNeedsStop = true;
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
            value.plan.runtimeV2?.skillCorrection?.skillRoots, { config: api.runtime.config?.current?.() ?? api.config });
          if (skill) state.seen.set(`skill-read:${id}`, skill);
          const name = skill ? "Skill" : toolName(event.toolName);
          if (!nativeHooks) state.entries.push({ type: "assistant", uuid: `oc-tool-${id}`, message: { id: `oc-tool-${id}`,
            content: [{ type: "tool_use", id, name, input: args }] } });
          await persistTranscript(state);
          // Reserve this invocation identity for the successful Skill read;
          // a preceding Read event would consume its idempotency key.
          const outcome = skill ? { feedback: null } : await run(state, "PreToolUse", { tool_name: toolName(event.toolName),
            tool_input: args, tool_use_id: id }, value);
          // Advisory skill feedback travels with the read's tool result.
          if (outcome.feedback) state.seen.set(`feedback:${id}`, outcome.feedback);
          let decision;
          if (nativeHooks && api.runtime.version === '2026.7.1-2' && settings.noopToolCallGuard !== false
            && await isNoopToolRequest(event.toolName, args, state.projectRoot, event.cwd ?? state.executionDirectory, state.reviewController.signal))
            decision = { block: true, blockReason: 'RC_NOOP_TOOL_REQUEST. The requested file content already matches, or every replacement is identical. This call was not executed. Continue the remaining task without retrying the unchanged request. Reread the file if another writer may have changed it.' };
          state.seen.set(key, decision);
          return decision;
        } catch (error) { await failure(state, error, "PRE_TOOL"); }
      });
    },
    async toolResult(event, ctx) {
      // Check before resolving a bare call id: reviewer calls must never be
      // attached to a main task's binding, including after reviewer cleanup.
      if (internal(event, ctx)) {
        await observeInternalTool("read:result", event, { runId: ctx.runId ?? event.runId,
          sessionId: ctx.sessionId ?? event.sessionId, sessionKey: ctx.sessionKey ?? event.sessionKey, agentId: ctx.agentId });
        return;
      }
      if (!ctx.sessionId && !event.sessionId) {
        const bindings = [...(toolBindings.get(event.toolCallId)?.values() ?? [])];
        if (bindings.length !== 1) {
          if (bindings.length > 1) api.logger.warn("[runtime-corrector] Ambiguous tool call identity; result review skipped.");
          return;
        }
        ctx = { ...bindings[0], ...ctx, runtimeCorrectorDocumentSnapshot: bindings[0].runtimeCorrectorDocumentSnapshot,
          runtimeCorrectorDocumentProcess: bindings[0].runtimeCorrectorDocumentProcess,
          runtimeCorrectorVerification: bindings[0].runtimeCorrectorVerification };
      } else if (toolBindings.has(event.toolCallId)) {
        const matches = [...toolBindings.get(event.toolCallId).values()].filter(binding =>
          binding.sessionId === (ctx.sessionId ?? event.sessionId)
          && (!ctx.agentId || binding.agentId === ctx.agentId)
          && (!ctx.runId || !binding.runId || binding.runId === ctx.runId));
        if (matches.length !== 1) return;
        ctx = { ...matches[0], ...ctx, runtimeCorrectorScopeFingerprint: matches[0].runtimeCorrectorScopeFingerprint,
          runtimeCorrectorControlEnabled: matches[0].runtimeCorrectorControlEnabled,
          runtimeCorrectorEnabledRevision: matches[0].runtimeCorrectorEnabledRevision,
          runtimeCorrectorDocumentSnapshot: matches[0].runtimeCorrectorDocumentSnapshot,
          runtimeCorrectorDocumentProcess: matches[0].runtimeCorrectorDocumentProcess,
          runtimeCorrectorVerification: matches[0].runtimeCorrectorVerification };
      }
      const verification = ctx.runtimeCorrectorVerification;
      const receipt = event.result?.details?.runtimeCorrectorVerification;
      if (verification && receipt && (verification.controller.signal.aborted
        || (ctx.runId ?? event.runId ?? verification.runId) !== verification.runId)) return;
      let appendBrief;
      const coveragePublications = [];
      return withState(event, ctx, async (state) => {
        const id = event.toolCallId;
        if (!id || nativeHooks && isInteraction(event.result)) return;
        const key = `post:${id}`;
        if (state.seen.has(key)) return state.seen.get(key);
        let value;
        try {
          value = await context(state, "tool_result");
          const content = event.result?.content ?? [];
          const details = event.result?.details;
          // The pinned host sets isError for this receipt after middleware. Its edit matches all old text before writing.
          const rejectedNativeEdit = nativeHooks && api.runtime.version === "2026.7.1-2" && event.toolName === "edit"
            && details?.status === "error" && details.tool === "edit"
            && typeof details.error === "string" && EDIT_OLD_TEXT_MISMATCH.test(details.error);
          state.entries.push({ type: "user", isMeta: true, uuid: `oc-result-${id}`, message: {
            content: [{ type: "tool_result", tool_use_id: id, content, is_error: event.isError === true || rejectedNativeEdit }] } });
          await persistTranscript(state);
          // A discovery read is only an invocation once the host actually
          // delivered its result. Permission errors must not start a watcher.
          const selectedSkill = state.seen.get(`skill-read:${id}`);
          state.seen.delete(`skill-read:${id}`);
          if (selectedSkill && !event.isError && !event.result?.isError) {
            await run(state, "PreToolUse", { tool_name: "Skill", tool_input: { skill: selectedSkill.skillId,
              sourceIdentity: selectedSkill.sourceIdentity }, tool_use_id: id }, value);
          }
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
          let feedback = joined(state.seen.get(`feedback:${id}`), state.hotReviewFeedback?.splice(0).join("\n\n"));
          let verificationAdvice;
          if (nativeHooks && verification && receipt?.runId === verification.runId && verification.runId === state.nativeRunId
            && verification.controller === state.reviewController && verification.tool === event.toolName
            && verification.tool === value.plan.runtimeV2?.acceptanceFeedback?.tool && !event.isError && !event.result?.isError
            && isDeepStrictEqual(event.args ?? {}, verification.args)) {
            state.acceptanceFeedback ??= createAcceptanceFeedback();
            verificationAdvice = state.acceptanceFeedback(receipt, verification.args);
            feedback = joined(feedback, verificationAdvice?.text);
          }
          const invocation = ctx.runtimeCorrectorDocumentSnapshot;
          const processCall = ctx.runtimeCorrectorDocumentProcess;
          if (invocation?.controller && invocation.controller !== state.reviewController
            || invocation?.runId && ctx.runId && invocation.runId !== ctx.runId
            || processCall?.controller && processCall.controller !== state.reviewController
            || processCall?.runId && ctx.runId && processCall.runId !== ctx.runId) return;
          let artifactTask = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
          const previousCoverage = artifactTask?.documentCoverage, terminal = event.result?.details;
          const pendingCommands = [...previousCoverage?.pendingCommands ?? []];
          const resolvedCommand = processCall?.admitted === true && processCall.action === "poll" && String(event.toolName).split(".").at(-1).toLowerCase() === "process"
            && terminal?.sessionId === processCall.sessionId && ["completed", "failed"].includes(terminal.status)
            && (Number.isInteger(terminal.exitCode) || typeof terminal.exitSignal === "string")
            ? pendingCommands.find(command => command.sessionId === processCall.sessionId) : null;
          // A kill acknowledgement is not a terminal process receipt. Offer
          // the ordinary next tool step only for this admitted, still-owned
          // invocation and the exact persisted pending document process.
          const pendingKill = processCall?.admitted === true && processCall.action === "kill"
            && processCall.controller === state.reviewController && processCall.runId === (ctx.runId ?? event.runId)
            && String(event.toolName).split(".").at(-1).toLowerCase() === "process"
            && event.args?.action === "kill" && event.args?.sessionId === processCall.sessionId
            && typeof processCall.sessionId === "string" && processCall.sessionId.length > 0 && processCall.sessionId.length <= 200
            && previousCoverage?.status === "UNVERIFIED" && previousCoverage.unverified?.includes("DOCUMENT_EXECUTION_PENDING")
            ? pendingCommands.filter(command => command.sessionId === processCall.sessionId) : [];
          if (pendingKill.length === 1 && pendingKill[0].toolCallId && pendingKill[0].runId
            && pendingKill[0].snapshot?.projectRoot === state.projectRoot) feedback = joined(feedback,
            `DOCUMENT_EXECUTION_PENDING: This kill receipt does not prove the document process has ended. Use the normal process tool with ${JSON.stringify({ action: "poll", sessionId: processCall.sessionId, timeout: 0 })} to obtain its terminal receipt. Keep this scope UNVERIFIED until that receipt is available and all declared documents have been freshly rechecked. A running, unavailable or denied poll does not settle it.`);
          const documents = invocation || isDocumentCommand(event.toolName) || resolvedCommand ? await documentCommandChanges(invocation?.snapshot ?? resolvedCommand?.snapshot,
            value.plan, state.projectRoot, { observedPaths: state.observedPaths,
              active: () => { state.reviewController.signal.throwIfAborted(); },
              pending: event.result?.details?.status === "running" || event.result?.status === "running" }) : null;
          if (documents && invocation && invocation.admitted !== true) {
            documents.status = "UNVERIFIED";
            documents.unverified = [...new Set([...documents.unverified, "DOCUMENT_INVOCATION_UNADMITTED"])];
          }
          if (documents && !artifactTask) artifactTask = await ensureTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
          if (documents) {
            if (resolvedCommand) {
              pendingCommands.splice(pendingCommands.indexOf(resolvedCommand), 1);
              documents.resolvedProcess = { sessionId: processCall.sessionId, toolCallId: id, runId: processCall.runId,
                originToolCallId: resolvedCommand.toolCallId, originRunId: resolvedCommand.runId, status: terminal.status,
                ...(Number.isInteger(terminal.exitCode) ? { exitCode: terminal.exitCode } : {}),
                ...(typeof terminal.exitSignal === "string" ? { exitSignal: terminal.exitSignal } : {}) };
            }
            let untrackedPending = previousCoverage?.untrackedPending === true
              || previousCoverage?.unverified?.includes("DOCUMENT_EXECUTION_PENDING") && !(previousCoverage.pendingCommands?.length);
            if (terminal?.status === "running" || event.result?.status === "running") {
              if (pendingCommands.length >= 32) untrackedPending = true;
              else pendingCommands.push({ toolCallId: id, runId: invocation?.runId ?? ctx.runId ?? null,
                sessionId: typeof terminal?.sessionId === "string" && terminal.sessionId.length > 0 && terminal.sessionId.length <= 200 ? terminal.sessionId : null,
                snapshot: invocation?.snapshot ?? null });
            }
            documents.pendingCommands = pendingCommands; documents.untrackedPending = Boolean(untrackedPending);
            if (pendingCommands.length || untrackedPending) {
              documents.status = "UNVERIFIED";
              documents.unverified = [...new Set([...documents.unverified, "DOCUMENT_EXECUTION_PENDING"])];
            }
          }
          const recheckDocuments = documents?.status === "VERIFIED" && artifactTask?.documentCoverage?.status === "UNVERIFIED";
          const files = [...new Set([...(event.isError || event.result?.isError || rejectedNativeEdit ? [] : changedFiles(event.toolName, event.args ?? {}, state.projectRoot, event.cwd ?? state.executionDirectory)),
            ...(documents?.files ?? []), ...(recheckDocuments ? documents.currentFiles.map(entry => entry.file) : [])])];
          if (state.observedPaths) for (const file of files) state.observedPaths.add(file);
          let documentRecheckPassed = true;
          let documentUnverified = documents?.unverified ?? [];
          if (documents && artifactTask) {
            const { currentFiles, ...coverage } = documents;
            if (recheckDocuments) { coverage.status = "UNVERIFIED"; coverage.unverified = ["DOCUMENT_SCOPE_REREVIEW_REQUIRED"]; }
            documentUnverified = coverage.unverified;
            await withTaskState({ projectRoot: state.projectRoot, taskId: artifactTask.taskId }, task => {
              task.documentCoverage = { ...coverage, toolCallId: id, runId: ctx.runId ?? event.runId ?? null };
              if (files.length || coverage.status === "UNVERIFIED") task.verification = { ...task.verification, status: "STALE", reasonCode: "DOCUMENT_EXECUTION_CHANGED" };
            });
            await appendTaskJournal(state.projectRoot, artifactTask.taskId, { type: coverage.status === "UNVERIFIED"
              ? "OPENCLAW_DOCUMENT_SCOPE_UNVERIFIED" : "OPENCLAW_DOCUMENT_COMMAND", status: coverage.status,
              toolCallId: id, runId: ctx.runId ?? event.runId, files, reason: coverage.unverified.join(", "), checkedFiles: coverage.checkedFiles,
              ...(documents.resolvedProcess ? { processTerminal: documents.resolvedProcess } : {}) });
          }
          const existing = [];
          for (const file of files) { try { if ((await fs.stat(file)).isFile()) existing.push(file); } catch { /* Deleted file: covered by terminal review. */ } }
          if (artifactTask) for (const file of existing) {
            const contents = await fs.readFile(file);
            const snapshotFile = path.join(taskDirectory(state.projectRoot, artifactTask.taskId), "artifact-snapshots", `${hash(id + file)}.json`);
            await privateJson(snapshotFile, { file, toolCallId: id, recordedAt: Date.now(), fingerprint: await fingerprint(file),
              contents: contents.length <= 1024 * 1024 ? contents.toString("utf8") : null, omitted: contents.length > 1024 * 1024 });
            await appendTaskJournal(state.projectRoot, artifactTask.taskId, { type: "OPENCLAW_ARTIFACT_SNAPSHOT", file, toolCallId: id,
              snapshotPath: path.relative(state.projectRoot, snapshotFile) });
          }
          const applyRunId = ctx.runId ?? event.runId;
          const drift = (!ctx.runId || !event.runId || ctx.runId === event.runId)
            && !event.isError && !event.result?.isError && !rejectedNativeEdit
            ? await approvedApplyArtifactDrift(state, applyRunId, existing) : null;
          if (drift?.stale) return;
          const planDriftFiles = new Set(drift?.files ?? []), applyPlanDrift = drift?.plan;
          if (applyPlanDrift) {
            feedback = joined(feedback, openSpecApplyFinding(applyPlanDrift).verificationFeedback);
            if (artifactTask) await withTaskState({ projectRoot: state.projectRoot, taskId: artifactTask.taskId }, task => {
              task.verification = { ...task.verification, status: "STALE", reasonCode: "DOCUMENT_EXECUTION_CHANGED" };
            });
          }
          const documentReviews = [];
          const coalesceDocuments = nativeHooks && documents?.status === 'VERIFIED' && !recheckDocuments
            && !documents.resolvedProcess && !event.isError && !event.result?.isError && !rejectedNativeEdit
            && !value.plan.runtimeV2.dynamicGroundTruth.enabled && !value.plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled
            && !(value.plan.runtimeV2.artifactCorrection.stageMetricsEnabled
              && value.plan.configuredArtifacts.some(artifact => artifact.metricCheckpoint));
          const documentOwner = () => ({ runId: state.nativeRunId, taskId: state.scopeTaskId, sessionId: state.sessionId,
            scopeFingerprint: state.projectScope?.fingerprint ?? state.scopeFingerprint,
            enabledRevision: state.enabledRevision, proposalPolicy: state.nativeProposalCoveragePolicy ?? null });
          for (const file of existing.length ? existing : [null]) {
            if (planDriftFiles.has(file)) {
              documentRecheckPassed = false;
              if (artifactTask) await appendTaskJournal(state.projectRoot, artifactTask.taskId, {
                type: "OPENCLAW_ARTIFACT_REVIEW_SKIPPED", file, toolCallId: id, runId: applyRunId,
                reasonCode: "OPENSPEC_APPLY_PLAN_CHANGED", openSpecPlan: applyPlanDrift,
              });
              continue;
            }
            if (file) await state.onProgress?.({ phase: "REVIEWING_ARTIFACT", file, toolCallId: id, startedAt: Date.now() });
            const input = inputFor(state, "PostToolUse", { ...fields, ...(file ? {
              tool_name: "Edit", tool_input: { ...fields.tool_input, file_path: file },
            } : {}) });
            const prepared = file ? await checkArtifact({ filePath: file, cwd: state.projectRoot, config: value.plan,
              projectRootSource: "session-project", deferPersistence: true, pluginRoot }) : { matched: false };
            const outcome = nativeHooks && fields.tool_name === "Read" && !selectedSkill && !file
              ? await run(state, "PostToolUse", fields, { ...value, deferHotReview: true })
              : await handleRuntimeV2Event({ ...value, input, artifact: prepared.matched ? prepared.reviewContext.artifact : null });
            feedback = joined(feedback, outcome.feedback);
            if (!prepared.matched) { if (file) documentRecheckPassed = false; continue; }
            prepared.reviewContext.enabled = prepared.reviewContext.nodeReviewEnabled
              || (prepared.reviewContext.workflow?.incomingEdges?.length ?? 0) > 0 || Boolean(outcome.artifactReviewContext)
              || Boolean(outcome.originalRequirements);
            const entry = { file, input, prepared, outcome, owner: structuredClone(documentOwner()),
              proposalBinding: await artifactProposalBinding(state, prepared, outcome) };
            const progress = await skipApprovedTaskProgress(entry);
            if (progress?.stale) return;
            if (progress === true) continue;
            if (coalesceDocuments) documentReviews.push(entry);
            else await reviewDocumentGroups([entry]);
          }
          // No sharing across tool results, pending commands, process continuations,
          // uncertain inventories, runtime reviewer handles or metric contexts.
          await reviewDocumentGroups(documentReviews);
          async function skipApprovedTaskProgress(entry) {
            const { file, prepared, outcome } = entry, runId = applyRunId, controller = state.reviewController;
            const current = () => state.nativeRunId === runId && state.reviewController === controller
              && !controller.signal.aborted && !state.nativeInvalidated && !state.scopeClosed
              && isDeepStrictEqual(entry.owner, documentOwner());
            const basis = approvedProgressBasis(state, prepared, value.plan);
            if (!basis || !nativeHooks) return false;
            if (!current()) return { stale: true };
            if (drift || !hasApprovedApplyInventory(state, runId)
              || ctx.runId && event.runId && ctx.runId !== event.runId
              || event.isError || event.result?.isError || rejectedNativeEdit || recheckDocuments
              || documents && (documents.status !== 'VERIFIED' || documents.resolvedProcess
                || documents.pendingCommands?.length || documents.untrackedPending)
              || !documents && !['Write', 'Edit'].includes(fields.tool_name)
                && String(event.toolName).split('.').at(-1) !== 'apply_patch'
              || outcome.handled !== true || outcome.internal || outcome.skipped || outcome.reason || outcome.reasonCode
              || outcome.error || outcome.feedback || outcome.status || outcome.decision || outcome.stop || outcome.watcher
              || outcome.artifactReviewContext || outcome.reviewerHandle || outcome.reviewerExecutionContext
              || outcome.groundTruthChanged || outcome.groundTruthError) return false;
            const observedPlan = await inspectArmedOpenSpecApply(state, runId);
            if (file !== path.join(state.projectRoot, 'openspec/changes', observedPlan?.changeName ?? '', 'tasks.md')) return false;
            const observed = await observeNativeTranscript(api, state).catch(() => null);
            const authority = approvedTaskProgressForApply(state, runId, { basis, verdict: observedPlan, observed });
            if (!current() || !await scopeCurrent(state) || !current()) return { stale: true };
            if (!authority || !await documentReviewBundleCurrent(prepared, { projectRoot: state.projectRoot, pluginRoot }))
              return current() ? false : { stale: true };
            const fresh = await checkArtifact({ filePath: file, cwd: state.projectRoot, config: value.plan,
              projectRootSource: 'session-project', deferPersistence: true, pluginRoot });
            if (!current()) return { stale: true };
            if (!isDeepStrictEqual(approvedProgressBasis(state, fresh, value.plan), basis)) return false;
            const latestPlan = await inspectArmedOpenSpecApply(state, runId);
            const latest = approvedTaskProgressForApply(state, runId, { basis, verdict: latestPlan,
              observed: await observeNativeTranscript(api, state).catch(() => null) });
            if (!current() || !await scopeCurrent(state) || !current()) return { stale: true };
            if (!latest || latest.currentRevision !== authority.currentRevision
              || !await documentReviewBundleCurrent(fresh, { projectRoot: state.projectRoot, pluginRoot }))
              return current() ? false : { stale: true };
            if (!current()) return { stale: true };
            if (artifactTask) await appendTaskJournal(state.projectRoot, artifactTask.taskId, {
              type: 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED', reasonCode: 'OPENSPEC_APPROVED_TASK_PROGRESS',
              file, toolCallId: id, runId, approvedPlanIntegrity: latest,
            });
            return true;
          }
          async function reviewDocumentGroups(entries) {
            const groups = groupDocumentReviews(entries, { enabled: coalesceDocuments });
            for (const group of groups) {
              const first = group.entries[0], shared = group.entries.length > 1;
              const assertBundleCurrent = async () => {
                if (!isDeepStrictEqual(first.owner, documentOwner()) || !await scopeCurrent(state)
                  || !await documentReviewBundleCurrent(first.prepared, { projectRoot: state.projectRoot, pluginRoot })
                  || !isDeepStrictEqual(first.proposalBinding, await artifactProposalBinding(state, first.prepared, first.outcome)))
                  throw new Error('DOCUMENT_BUNDLE_BASIS_CHANGED');
                // Old hashes alone cannot show that no matching sibling appeared.
                // Recollect the bounded artifact inventory with the same checker.
                const fresh = await checkArtifact({ filePath: first.file, cwd: state.projectRoot, config: value.plan,
                  projectRootSource: 'session-project', deferPersistence: true, pluginRoot });
                if (fresh.matched) fresh.reviewContext.enabled = first.prepared.reviewContext.enabled;
                if (documentReviewBundleKey({ ...first, prepared: fresh }) !== group.key)
                  throw new Error('DOCUMENT_BUNDLE_BASIS_CHANGED');
              };
              if (shared) {
                await assertBundleCurrent();
                const triggerFiles = group.entries.map(entry => entry.prepared.result.metadata.triggerFile).sort();
                const bundle = { id: first.prepared.result.metadata.roundId, triggerFiles };
                for (const entry of group.entries) {
                  entry.prepared.result.metadata.reviewBundle = structuredClone(bundle);
                  entry.prepared.result.metadata.triggerFiles = triggerFiles;
                }
              }
              const { input, prepared, outcome } = first;
              const review = prepared.reviewContext.enabled ? await semanticArtifactReview(state, value, input, prepared, outcome,
                shared ? { proposalBinding: first.proposalBinding } : null) : null;
              if (!prepared.reviewContext.enabled) await outcome.reviewerHandle?.close();
              if (shared) await assertBundleCurrent();
              const completed = [];
              for (const entry of group.entries) {
                const { file, prepared, outcome } = entry;
                const finalized = await finalizeScopedArtifact(state, prepared, shared ? cloneHostOriginalReview(review) : review);
                if (finalized.result.status !== "passed") documentRecheckPassed = false;
                if (artifactTask) await appendTaskJournal(state.projectRoot, artifactTask.taskId, {
                  type: "OPENCLAW_ARTIFACT_REVIEW", file, toolCallId: id,
                  fingerprint: await fingerprint(file), requirementVersion: artifactTask.groundTruth.version,
                  evidence: state.artifactEvidence?.() ?? null,
                  result: finalized.result, feedback: finalized.feedback,
                });
                completed.push({ file, finalized });
                if (!shared || entry === first) feedback = joined(feedback, finalized.feedback);
                if (outcome.artifactReviewContext) {
                  const metrics = await finalizeArtifactRuntimeV2({ runtimeV2: value.plan.runtimeV2,
                    projectRoot: state.projectRoot, taskId: outcome.taskId,
                    artifactReviewContext: outcome.artifactReviewContext, semanticReview: review,
                    delivered: !value.plan.runtimeV2?.shadowMode && Boolean(finalized.feedback) });
                  feedback = joined(feedback, metrics.feedback);
                  if (artifactTask) await recordObservation(state.projectRoot, artifactTask.taskId, {
                    type: 'OPENCLAW_ARTIFACT_METRICS', sessionId: state.sessionId, file, toolCallId: id,
                    evaluationId: metrics.persisted?.evaluationId ?? null,
                  });
                }
              }
              if (shared) await assertBundleCurrent();
              // One host publication for the actual worker, after every sibling is
              // finalized. A sibling failure cannot be hidden by the first PASS.
              const publication = completed.find(({ finalized }) => !['passed', 'warning'].includes(finalized.result.status)) ?? completed[0];
              if (nativeHooks && artifactTask && artifactTask.taskId === state.scopeTaskId) coveragePublications.push({
                state, runId: ctx.runId ?? event.runId, file: publication.file,
                originalDutyPublication: captureOriginalDutyPublication(state),
                sources: outcome.originalRequirements?.userMessages,
                ...(shared ? { isCurrent: async () => { try { await assertBundleCurrent(); return true; } catch { return false; } } } : {}),
                receipt: publication.finalized.result.metadata.semanticReview?.originalRequirementCoverage,
                publication: { runId: ctx.runId ?? event.runId, taskId: artifactTask.taskId,
                  sessionId: state.sessionId, result: publication.finalized.result,
                  approvedProgressBasis: approvedProgressBasis(state, first.prepared, value.plan) },
              });
            }
          }
          if (recheckDocuments && artifactTask && documentRecheckPassed
            && existing.length === documents.currentFiles.filter(entry => entry.sha256 !== "missing").length) {
            const { currentFiles, ...coverage } = documents;
            await withTaskState({ projectRoot: state.projectRoot, taskId: artifactTask.taskId }, task => {
              task.documentCoverage = { ...coverage, toolCallId: id, runId: ctx.runId ?? event.runId ?? null };
            });
            documentUnverified = [];
          }
          if (documentUnverified.length) feedback = joined(feedback, `UNVERIFIED：脚本写入的文档范围尚未核实（${documentUnverified.join(", ")}）。`);
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
            if (verificationAdvice) await appendTaskJournal(state.projectRoot, task.taskId, { type: verificationAdvice.type,
              toolCallId: id, runId: verification.runId, delivery: result ? "tool_result_middleware" : "shadow" });
            await state.onTaskState?.(task);
          }
          state.seen.set(key, result);
          await state.onProgress?.({ phase: "WAITING_FOR_WORKER", startedAt: Date.now() });
          if (state.seen.size > 3000) state.seen.clear();
          if (event.result && state.frameBrief?.frame && !state.frameBrief.delivered) {
            const runId = ctx.runId ?? event.runId ?? state.nativeRunId;
            appendBrief = async () => {
              const brief = await takeFrameBrief(state, value.plan, runId, "tool_result", ctx);
              return brief ? { result: { ...event.result,
                content: [...(result?.result.content ?? content), { type: "text", text: brief }] } } : result;
            };
          }
          return result;
        } catch (error) {
          const feedback = await failure(state, error, "POST_TOOL");
          if (value && !value.plan.runtimeV2?.shadowMode) return { result: { ...event.result,
            content: [...(event.result?.content ?? []), { type: "text", text: feedback }] } };
        }
      }, async result => {
        for (const { state, runId, file, receipt, publication, isCurrent, sources, originalDutyPublication } of coveragePublications)
          if (runId && state.nativeRunId === runId && (!isCurrent || await isCurrent())) {
            recordProposalCoverage(state, file, receipt, publication);
            await publishOriginalDutyArtifact(state, { file, finalized: { result: publication.result },
              captured: originalDutyPublication, sources });
          }
        return appendBrief ? appendBrief() : result;
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
          if (ctx[approvedCoverage]) value.stopHost.approvedPlanCoverage = ctx[approvedCoverage];
          const apply = ctx[approvedInventory];
          if (apply) {
            value.stopHost.approvedProposalInventory = apply.inventory;
            value.stopHost.approvedProposalBinding = { revision: apply.revision, runId: apply.runId };
            const scopeCurrent = value.stopHost.isCurrent;
            value.stopHost.isCurrent = async () => await scopeCurrent() && await apply.isCurrent();
          }
          const evidence = nativeHooks ? createEvidenceLedger(state.projectRoot) : null;
          const scopeDiagnostic = {};
          let coveragePublication;
          if (evidence) {
            for (const file of [value.plan.configPath, ...state.observedPaths]) if (file && await fingerprint(file) !== "missing") await evidence.observe(file);
            state.observeReviewTool = evidence.observeTool;
            const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
            if (task) value.assessmentContext = { ...value.assessmentContext, kind: "native-stop", mode: ctx.runtimeCorrectorVerificationOnly ? "verify_only" : "execute_and_correct",
              assessmentId: ctx.runtimeCorrectorStopId ?? `${expectedRunId}:stop${state.enabledRevision ? `:enabled-${state.enabledRevision}` : ""}${ctx.runtimeCorrectorReviewAttempt ? `:infra-${ctx.runtimeCorrectorReviewAttempt}` : ""}`, guard: decisionGuard(task), abortSignal: reviewController.signal,
              evidence: () => ({ ...evidence.snapshot(), scope: { ...scopeDiagnostic } }),
              evidenceMatches: async () => await scopeAllowed(state, reviewController, scopeDiagnostic) && await evidence.matches()
                && (!apply || await apply.isCurrent()),
              maxCorrections: value.plan.runtimeV2.stopCorrection.maxCorrectionsPerFlow };
            if (task) {
              coveragePublication = createStopReviewCoveragePublicationObserver({ projectRoot: state.projectRoot, sessionId: state.sessionId,
                sessionKey: state.sessionKey, runId: expectedRunId, taskId: task.taskId, assessmentId: value.assessmentContext.assessmentId,
                scopeFingerprint: state.projectScope?.fingerprint ?? state.scopeFingerprint, enabledRevision: state.enabledRevision ?? 0 });
              value.assessmentContext.onPublished = coveragePublication.onPublished;
            }
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
              coveragePublication: coveragePublication?.token,
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
        if (await registerPostCandidate(state, event, ctx, event.payload.text)) return;
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
        void preparing.catch(() => postRuns?.release(postIdentity(state), "STOP_REGISTRATION_FAILED"));
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
      const admitted = () => withState(event, ctx, async (state) => {
        try { const value = await context(state, "before_compaction");
          await run(state, "PreCompact", { trigger: "auto", custom_instructions: null }, value);
        } catch (error) { await failure(state, error, "COMPACT"); }
      });
      if (!nativeHooks) return admitted();
      const state = states.get(`${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`);
      if (state && (ctx.runId ?? event.runId) && state.nativeRunId !== (ctx.runId ?? event.runId)) return;
      if (state) await recordNativeUserMessages(state);
      if (ctx.runId ?? event.runId) return admitted();
      // A manual compaction holds the session lifecycle until it returns, so
      // its admitted checkpoint can only start afterwards.
      void admitted().catch(error => {
        try { api.logger.warn(`[runtime-corrector] Compaction checkpoint unavailable: ${error.code ?? error.name}`); } catch {}
      });
    },
    async reset(event, ctx) {
      if (nativeHooks) await cancelNative(event, ctx);
      const state = states.get(`${ctx.agentId ?? 'main'}:${event.sessionId ?? ctx.sessionId}`);
      if (state) forgetKnownOriginalObligations(state);
      state?.requirementFrameWork?.controller.abort();
      if (state?.projectRoot) await releaseDocumentSessions(state.projectRoot);
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
      const failedAttempt = event.success === false || event.error || event.aborted;
      // The host may admit a same-run compaction retry while this fire-and-forget
      // hook is still capturing its transcript. Fence the attempt before I/O,
      // and never acquire the retry's replacement controller afterwards.
      if (current() && failedAttempt && !controller.signal.aborted) {
        state.nativeCompletion = null;
        state.nativeEndedRun = runId;
        controller.abort(Object.assign(new Error("RC_NATIVE_ATTEMPT_ENDED"), { code: "RC_NATIVE_ATTEMPT_ENDED" }));
      }
      if (state.nativeRunId === runId && !state.scopeClosed)
        state.nativeCompletion = event.success === true && !event.error && !event.aborted
          ? { runId, success: true, event: 'agent_end' } : null;
      const progress = ctx.runtimeCorrectorHookProgress ?? {};
      progress.phase = 'transcript-capture';
      await recordNativeUserMessages(state);
      progress.phase = 'scope-check';
      const releasing = postRuns?.get(postIdentity(state));
      if (current() && releasing?.phase === "RELEASING" && releasing.terminalRelease?.runId === runId
        && await scopeCurrent(state) && current()) {
        // The review signal may already be cancelled by a failed hot hook.
        // Recheck only the old owner's real gateway terminal, independently
        // of that signal; the stage remains UNVERIFIED and no review restarts.
        void postRuns.hostEnded(postIdentity(state), runId).catch(error => api.logger.warn(error.message));
      }
      // A terminal event may arrive after replacement, or become stale while
      // its scope/receipt is being read. It never owns the latest controller.
      if (!current() || !await (failedAttempt && controller.signal.reason?.code === "RC_NATIVE_ATTEMPT_ENDED"
        ? scopeCurrent(state) : scopeAllowed(state, controller)) || !current()) return;
      if (failedAttempt) {
        state.nativeCompletion = null;
        progress.phase = 'followup-receipt';
        const receipt = await findFollowup(state, runId);
        if (!current()) return;
        // agent_end is an attempt boundary: auto-compaction can still retry
        // this exact run. Keep its admission and deadline until agent.wait
        // confirms a terminal error, or the existing watchdog expires it.
        progress.phase = 'terminal-candidate';
        if (state.postRunEnabled || hasArmedOpenSpecApply(state, runId) || receipt)
          await registerPostCandidate(state, event, ctx, state.nativeAssessmentText, true);
        return;
      }
      state.nativeCompletion = event.success === true ? { runId, success: true, event: 'agent_end' } : null;
      if (state.postRunEnabled || hasArmedOpenSpecApply(state, runId)) {
        state.nativeEndedRun = runId;
        progress.phase = 'native-start-drain';
        await nativeStart.finish({ state, runId });
        const last = (event.messages ?? []).findLast(message => message.role === "assistant");
        const text = typeof last?.content === "string" ? last.content : (last?.content ?? [])
          .filter(block => block.type === "text").map(block => block.text).join("\n");
        progress.phase = 'terminal-candidate';
        await registerPostCandidate(state, event, ctx, text || state.nativeAssessmentText);
        return;
      }
      if (state.nativeFinalizeHandledRun === runId) {
        state.nativeEndedRun = runId;
        void nativeStart.finish({ state, runId }).catch(() => {});
        // Only wait for queue acceptance, never for a same-session start.
        void handoffNativeStop(state).catch(error => {
          if (current()) state.reviewController.abort(error);
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
      for (const state of states.values()) state.requirementFrameWork?.controller.abort();
      await postRuns?.dispose();
      if (nativeHooks) for (const state of states.values()) await cancelNative({ sessionId: state.sessionId, sessionKey: state.sessionKey });
      await nativeStart?.dispose();
      repairStepBudgets.clear();
      for (const root of new Set([...states.values()].map(state => state.projectRoot).filter(Boolean))) await releaseDocumentSessions(root);
    },
    async sessionEnd(event, ctx) {
      if (nativeHooks) {
        await cancelNative(event, ctx);
        const key = `${ctx.agentId ?? "main"}:${event.sessionId ?? ctx.sessionId}`;
        const state = states.get(key) ?? pausedScopes.get(key);
        if (state) {
          releaseOpenSpecProposalSession(sharedState, state);
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
        state.requirementFrameWork?.controller.abort();
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
  if (nativeHooks) for (const name of ["beforeDispatch", "beforeModelResolve", "sessionStart", "prompt", "beforeTool", "toolResult", "finalize", "reply", "compact", "agentEnd"]) {
    publicHandlers[name] = async (event, ctx = {}) => {
      if (ctx.abortSignal?.aborted) return;
      // Private reviewer tool guards must remain active, including inside a
      // host-maintenance descendant. Business maintenance never owns RC state.
      if (name !== "beforeTool" && isHostMaintenanceRun(event, ctx, hostMaintenanceRuns)) return;
      const stateForHook=()=>event.sessionId??ctx.sessionId?states.get(`${ctx.agentId??'main'}:${event.sessionId??ctx.sessionId}`)
        :[...states.values()].find(state=>state.sessionKey===(event.sessionKey??ctx.sessionKey)&&state.agentId===(ctx.agentId??'main'));
      const previous = stateForHook();
      // A host-admitted retry may retain the runId after an attempt ended.
      // Reopen only its reviewer/checkpoint signal, before binding this hook's
      // error fence. Never reopen a reset, terminal or different host run.
      if (name === "prompt" || name === "compact")
        rearmNativeAttempt(previous, ctx.runId ?? event.runId ?? (name === "compact" ? previous?.nativeRunId : undefined));
      const previousController = previous?.reviewController;
      const progress = {};
      let deadlineAt;
      try {
        const hook = { beforeDispatch: "reply_dispatch", beforeModelResolve: "before_model_resolve", prompt: "before_prompt_build",
          beforeTool: "before_tool_call", reply: "reply_payload_sending", finalize: "before_agent_finalize", agentEnd: "agent_end" }[name] ?? name;
        const budget = name === "beforeModelResolve" ? 1000 : isHotHook(hook)
          ? Math.min(hookBudget(hook), Math.max(1, hotHookTimeoutMs(settings.hookTimeoutMs) - 1000)) : hookBudget(hook);
        deadlineAt=Date.now()+budget;
        const invoke = () => handlers[name](event, {...ctx,runtimeCorrectorHookDeadlineAt:deadlineAt,
          runtimeCorrectorHookProgress: progress});
        return await beforeStopDeadline(name === "beforeTool" ? () => withPrecheck(event, ctx, invoke) : invoke, { deadlineAt, signal: ctx.abortSignal });
      }
      catch (error) {
        if (!(error instanceof Error)) error = new Error(String(error));
        if (ctx.abortSignal?.aborted) return; // Cancelling a waiter does not cancel the task it was waiting for.
        if (previous?.scopeClosed || error.code === "RC_SESSION_DISABLED") return;
        const state = stateForHook();
        if(previous&&(state!==previous||state?.reviewController!==previousController))return;
        if (state?.scopeClosed) return;
        // The host can compact between a failed attempt and its admitted retry.
        // Native work admission rejects with our cancelled reviewer reason;
        // this expected lifecycle cancellation must not poison the whole run.
        if (state?.reviewController.signal.aborted && error === state.reviewController.signal.reason
          && error.code === "RC_NATIVE_ATTEMPT_ENDED") return;
        if (name === "agentEnd" && error.code === "STOP_DEADLINE_EXPIRED"
          && state?.reviewController.signal.reason?.code === "RC_NATIVE_ATTEMPT_ENDED") {
          void failure(state, Object.assign(new Error(`Ended native attempt bookkeeping exceeded the hot hook budget at ${progress.phase ?? 'unknown'}; its admitted retry remains valid.`),
            { code: "RC_NATIVE_ATTEMPT_BOOKKEEPING_DEADLINE" }), name).catch(() => {});
          return;
        }
        if (name === "agentEnd" && progress.phase) error.message += ` (agent_end phase: ${progress.phase})`;
        if (name === "finalize" && state && (state.nativeRunId !== (ctx.runId ?? event.runId)
          || state.reviewController.signal.aborted)) return;
        // Only this call goes unchecked; the late check keeps running and the
        // run review stays admitted.
        if (name === "beforeTool" && error.code === "STOP_DEADLINE_EXPIRED" && Date.now() >= deadlineAt
          && observationOnlyCall(event.toolName, event.params)) {
          if (state) void failure(state, Object.assign(new Error(`The pre-tool check for ${event.toolName} exceeded the hot hook budget; this call was not prechecked and the run review continues.`),
            { code: "RC_PRECHECK_DEADLINE" }), name).catch(() => {});
          return undefined;
        }
        const feedback = taskLockFeedback(error, name) || `${FEEDBACK} RC_REVIEW_UNVERIFIED: ${error.code ?? error.name}`;
        if (state) {
          if (["prompt", "beforeTool"].includes(name) && !state.materialReference && state.materialRoots?.length && (state.scopeTaskId || state.materialBasisTaskId))
            void invalidateMaterialBasis({ projectRoot: state.projectRoot, taskId: state.scopeTaskId ?? state.materialBasisTaskId,
              reason: "MATERIAL_BASIS_HOOK_UNAVAILABLE", onlyUncaptured: true }).catch(() => {});
          state.nativeInvalidated = true;
          void postRuns?.release(postIdentity(state), "RC_HOOK_UNAVAILABLE").catch(() => {});
          // Release first. Disk writes and backend cleanup are best effort.
          void failure(state, error, name).catch(() => {});
          state.reviewController?.abort(error);
        }
        if (state) { state.finalRunId = ctx.runId ?? event.runId; state.finalNotice = feedback; }
        // RC health is not host authorization. Preserve native approvals,
        // questions, errors and execution; never turn our exception into veto.
        if (name === "toolResult" && event.result && !isInteraction(event.result)) return { result: { ...event.result,
          content: [...event.result.content ?? [], { type: "text", text: feedback }] } };
        if (name === "reply" && event.payload && !state?.postRunEnabled) return { payload: { ...event.payload, text: joined(event.payload.text, feedback) } };
        if (name === "beforeTool" && state) state.seen.set(`feedback:${event.toolCallId ?? ctx.toolCallId}`, feedback);
        return undefined;
      }
    };
  }
  return { ...publicHandlers, internalSessions,
    projects,
    observeCommandHistory,
    async reconcileSessionControl(ctx) {
      const correctionHistory = await observeCommandHistory(ctx);
      const scope = await projects.resolve({}, ctx);
      await reconcilePausedScope(scope);
      for (const state of [...states.values()]) {
        if (state.agentId === scope.identity?.agentId && state.sessionId === scope.identity?.sessionId
          || scope.projectRoot && state.projectRoot === scope.projectRoot) await scopeCurrent(state);
      }
      return { ...scope, correctionHistory };
    },
    async readApprovedPlan(ctx, args, { toolCallId, signal } = {}) {
      const matches = [...(toolBindings.get(toolCallId)?.values() ?? [])].filter(binding =>
        binding.runtimeCorrectorApprovedPlanRead && !binding.runtimeCorrectorInternal
        && (!ctx.sessionId || binding.sessionId === ctx.sessionId)
        && (!ctx.sessionKey || binding.sessionKey === ctx.sessionKey)
        && (!ctx.agentId || binding.agentId === ctx.agentId)
        && (!ctx.runId || binding.runId === ctx.runId));
      if (matches.length !== 1) throw new Error("RC_APPROVED_PLAN_INVOCATION_UNAVAILABLE");
      const binding = matches[0], bound = binding.runtimeCorrectorApprovedPlanRead;
      const state = states.get(`${binding.agentId ?? "main"}:${binding.sessionId}`);
      const current = async () => state && state.nativeRunId === bound.runId && state.reviewController === bound.controller
        && !state.nativeInvalidated && !state.scopeClosed && !signal?.aborted && !binding.abortSignal?.aborted
        && !ctx.abortSignal?.aborted && !bound.controller?.signal.aborted && binding.runtimeCorrectorControlEnabled === true
        && binding.runtimeCorrectorEnabledRevision === state.enabledRevision
        && binding.runtimeCorrectorScopeFingerprint === state.projectScope?.fingerprint
        && sha256(args) === bound.argsSha256 && await scopeCurrent(state);
      binding.assertInvocationCurrent?.();
      ctx.assertInvocationCurrent?.();
      if (!await current()) throw new Error("RC_APPROVED_PLAN_INVOCATION_UNAVAILABLE");
      const [observed, receipt] = await Promise.all([observeNativeTranscript(api, state), nativeStart.findRun({ state, runId: bound.runId })]);
      const result = readApprovedOpenSpecRestoration(state, { runId: bound.runId, observed, receipt,
        path: args.subject, startLine: args.startLine, endLine: args.endLine });
      binding.assertInvocationCurrent?.();
      ctx.assertInvocationCurrent?.();
      if (!await current()) throw new Error("RC_APPROVED_PLAN_INVOCATION_UNAVAILABLE");
      return result;
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
        || !ctx.runId && (state && (postHeld(state) || stopReviews.pending(state).length))))
        throw new Error("RC_CHECK_INVOCATION_UNAVAILABLE");
      const file = await fs.realpath(path.resolve(scope.projectRoot, subject));
      if (!evidencePath(scope.projectRoot, file)) throw new Error("RC_CHECK_OUTSIDE_PROJECT");
      let coveragePublication;
      const result = await withState({}, ctx, async state => {
        ctx.assertInvocationCurrent?.();
        if (ctx.abortSignal?.aborted) throw new Error("RC_CHECK_CANCELLED");
        const reviewController = state.reviewController;
        const originalDutyPublication = captureOriginalDutyPublication(state);
        const reviewOwner = { runId: ctx.runId, taskId: state.scopeTaskId, sessionId: state.sessionId };
        const value = await context(state, "tool_result");
        const prepared = await checkArtifact({ filePath: file, cwd: state.projectRoot, config: value.plan,
          projectRootSource: "session-project", deferPersistence: true, pluginRoot });
        if (!prepared.matched) throw new Error("RC_CHECK_UNMATCHED_ARTIFACT");
        const drift = await approvedApplyArtifactDrift(state, ctx.runId, [file]);
        if (drift?.stale) throw new Error("RC_CHECK_INVOCATION_UNAVAILABLE");
        ctx.assertInvocationCurrent?.();
        if (ctx.abortSignal?.aborted) throw new Error("RC_CHECK_CANCELLED");
        if (drift) {
          const finding = openSpecApplyFinding(drift.plan);
          prepared.result.status = "failed";
          prepared.result.diagnostics.push({ ruleId: finding.reasonCode, severity: "error",
            path: prepared.result.metadata.triggerFile, message: "Apply changed the approved OpenSpec plan.",
            evidence: drift.plan.differences, suggestion: finding.verificationFeedback });
          prepared.result.metadata.openSpecPlan = drift.plan;
          if (state.scopeTaskId) {
            await withTaskState({ projectRoot: state.projectRoot, taskId: state.scopeTaskId }, task => {
              task.verification = { ...task.verification, status: "STALE", reasonCode: "DOCUMENT_EXECUTION_CHANGED" };
            });
            await appendTaskJournal(state.projectRoot, state.scopeTaskId, {
              type: "OPENCLAW_ARTIFACT_REVIEW_SKIPPED", source: "manual-check", file, toolCallId,
              runId: ctx.runId, reasonCode: finding.reasonCode, openSpecPlan: drift.plan,
            });
          }
          return finalizeScopedArtifact(state, prepared, { status: "deferred", reasonCode: finding.reasonCode });
        }
        const originalRequirements = value.plan.runtimeV2.artifactCorrection.originalRequirementsEnabled
          && !prepared.reviewContext.artifact.originalRequirementsReviewDisabled
          ? await buildOriginalRequirements({ projectRoot: state.projectRoot, sessionId: state.sessionId,
            snapshot: { entries: state.entries }, plan: value.plan,
            materials: await (value.reviewerFactory.materialManifest ?? materialManifest)(value.plan.runtimeV2.dynamicGroundTruth.materialRoots),
            referenceTier: value.plan.runtimeV2.dynamicGroundTruth.enabled !== true,
            readReferenceMaterials: value.reviewerFactory.referenceMaterials }) : null;
        const review = prepared.reviewContext.enabled || originalRequirements ? await semanticArtifactReview(state, value,
          inputFor(state, "ManualCheck"), prepared, { taskId: reviewOwner.taskId, originalRequirements }) : null;
        const finalized = await finalizeScopedArtifact(state, prepared, review);
        if (nativeHooks) coveragePublication = { state, controller: reviewController, originalDutyPublication,
          sources: originalRequirements?.userMessages,
          publication: { ...reviewOwner, result: finalized.result,
            approvedProgressBasis: approvedProgressBasis(state, prepared, value.plan) } };
        return finalized;
      }, async result => {
        ctx.assertInvocationCurrent?.();
        if (coveragePublication) {
          const { state, controller, publication, sources, originalDutyPublication } = coveragePublication;
          if (state.nativeRunId === publication.runId && state.reviewController === controller
            && !controller.signal.aborted && !ctx.abortSignal?.aborted && !state.nativeInvalidated && !state.scopeClosed)
            {
              const receipt = result?.result?.metadata.semanticReview?.originalRequirementCoverage;
              recordProposalCoverage(state, file, receipt, publication);
              await publishOriginalDutyArtifact(state, { file, finalized: result,
                captured: originalDutyPublication, sources });
            }
        }
        return result;
      });
      ctx.assertInvocationCurrent?.();
      if (ctx.abortSignal?.aborted) throw new Error("RC_CHECK_CANCELLED");
      if (!result) throw new Error("RC_CHECK_SCOPE_OR_EVIDENCE_UNAVAILABLE");
      return result;
    },
    waitForNativeReviews: async options => {
      await Promise.all([...states.values()].map(state => state.nativePreparingStop?.catch(() => {})));
      await postRuns?.drain();
      const results = await (stopReviews?.wait({ settle: true, ...options }) ?? Promise.resolve([]));
      return results;
    },
    // Explicit lifecycle drain for callers that own the workspace lifetime.
    // dispose cancels first and stays independent of uncooperative backends.
    async waitForBackgroundReviews() {
      while (hotReviewTasks.size) await Promise.allSettled([...hotReviewTasks,
        ...[...states.values()].map(state => hotReviewSettled(state, state.hotReviewWork?.controller))]);
    },
    postRuns,
    postRunReady: nativeHooks ? postRuns.load().catch(error => api.logger.warn(`[runtime-corrector] dispatch recovery: ${error.message}`)) : Promise.resolve(),
    validatePostSession,
    openSpecProposalOwner: sharedState,
    openSpecProposalSession,
    openSpecPlanTarget,
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
      const plan = await loadConfig({ cwd: params.workspaceDir, pluginRoot });
      const ctx = { ...params, modelProviderId: params.provider, modelId: params.modelId };
      const state = await stateFor({}, ctx);
      if (!state) throw new Error("Cannot create a controller inside an internal review.");
      state.abortSignal = abortSignal;
      state.supervised = true;
      state.maxOutputTokens = plan.maxOutputTokens;
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
