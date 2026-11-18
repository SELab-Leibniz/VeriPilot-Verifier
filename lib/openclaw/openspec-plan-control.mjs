import { isOpenSpecChangeName, readOpenSpecPlan, captureOpenSpecPlan, compareOpenSpecPlans } from "../openspec-plan.mjs";
import { assessStopCorrection } from "../runtime-v2/stop-correction-assessment.mjs";
import { createStopCorrectionStore } from "../runtime-v2/stop-correction-store.mjs";
import { createStopReviewStore } from "../runtime-v2/stop-review-store.mjs";
import { transcriptUserMessages } from "../runtime-v2/original-requirements.mjs";
import { createOriginalSourceAnchor } from "../runtime-v2/original-source-anchor.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";
import { authenticatedActor } from "./interaction-store.mjs";
import { currentApprovedPlanCoverage, proposalSourceBasis, sealRequiredProposalCoverage,
  selectApprovedPlanCoverage } from "./approved-plan-coverage.mjs";

const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 512
  && !/[\s\p{Cc}]/u.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const conflict = message => Object.assign(new Error(message), { code: "CONFLICT" });
const unverified = reason => ({ status: "UNVERIFIED", differences: [], reason });
export const PLAN_RESTORATION_PURPOSE = "openspec-plan-restoration";
const restorationProofMatches = (restoration, source) => Boolean(restoration && source?.purpose === PLAN_RESTORATION_PURPOSE
  && source.openSpecRestoration && sha256(source.openSpecRestoration) === sha256(restoration.proof));

// Scope belongs to the live host state rather than an assistant-writable file.
const approvals = new WeakMap();
const proposalReviews = new WeakMap();
const claimedProposalRuns = new WeakMap();
const prepareTimeoutMs = 10 * 60_000;
const prepareCapacity = 128;
const sessionIdentity = ({ sessionKey, sessionId }) => JSON.stringify([sessionKey, sessionId]);
const planSession = params => identifier(params?.sessionKey) && /^agent:[a-zA-Z0-9_-]+:.+$/u.test(params.sessionKey)
  && !/:rc-worker:|:runtime-corrector:/u.test(params.sessionKey) && identifier(params.sessionId) && identifier(params.runId);

function beginPreparedProposalReview(owner, state, runId) {
  claimedProposalRuns.delete(state);
  const sessions = proposalReviews.get(owner), key = sessionIdentity(state), session = sessions?.get(key);
  if (!session) return;
  const stage = session.pending;
  delete session.pending;
  delete session.active;
  if (stage?.projectScope && stage.projectScope === state.projectScope?.fingerprint
    && stage.runId === runId && Date.now() < stage.expiresAt
    && (stage.sourceRunId === runId || stage.sourceRunId === state.nativeRunId)) {
    session.active = stage;
    stage.state = new WeakRef(state);
    claimedProposalRuns.set(state, runId);
  } else sessions.delete(key);
}

function activePreparedReview(owner, state, runId = state.nativeRunId) {
  const stage = proposalReviews.get(owner)?.get(sessionIdentity(state))?.active;
  return stage?.state.deref() === state && stage.runId === runId && stage.projectScope === state.projectScope?.fingerprint
    && !state.scopeClosed && !state.nativeInvalidated ? stage : null;
}

export function hasPreparedOpenSpecProposalReview(owner, state) {
  return Boolean(activePreparedReview(owner, state));
}

export function openSpecProposalReviewRequirements(owner, state, { changeName, observed }) {
  const stage = activePreparedReview(owner, state);
  if (!stage || stage.changeName !== changeName || observed?.status !== "OBSERVED") return null;
  const records = observed.messages?.filter(record => record.message?.role === "user" && record.isMeta !== true
    && record.message.idempotencyKey === `${stage.sourceRunId}:user`);
  if (records?.length !== 1 || !identifier(records[0].id)) return null;
  const sources = transcriptUserMessages(observed), latest = sources.at(-1);
  if (latest?.ref !== `transcript:${records[0].id}`) return null;
  const bytes = Buffer.from(latest.text);
  if (sha256(bytes) !== stage.sourceSha256) return null;
  const basisSha256 = proposalSourceBasis(sources);
  if (!basisSha256 || stage.resolved && stage.resolved.basisSha256 !== basisSha256) return null;
  try {
    const requiredAtoms = stage.requirements.map(({ start, end, requirement }) => ({ start, end, requirement,
      source: createOriginalSourceAnchor({ ref: latest.ref, sha256: stage.sourceSha256, bytes, start, end }) }));
    stage.resolved ??= { basisSha256, requiredAtoms };
    return structuredClone({ requiredAtoms });
  } catch { return null; }
}

const preparedAtomKey = atom => JSON.stringify([atom.source.anchorId, atom.requirement]);

function checkPreparedApproval(stage, snapshot, inventory) {
  if (!stage) return;
  if (stage.changeName !== snapshot.changeName || !stage.resolved || stage.resolved.basisSha256 !== inventory.sourceBasisSha256)
    throw conflict("The prepared Proposal requirement inventory has no current source binding.");
  const required = new Set(stage.resolved.requiredAtoms.map(preparedAtomKey));
  if (inventory.requiredAtoms.length !== required.size || !inventory.requiredAtoms.every(atom => required.has(preparedAtomKey(atom))))
    throw conflict("The approval differs from the prepared Proposal requirement inventory.");
}

export function releaseOpenSpecProposalSession(owner, state, { pending = true } = {}) {
  const sessions = proposalReviews.get(owner), key = sessionIdentity(state), session = sessions?.get(key);
  if (!session) return;
  if (session.active?.state.deref() === state) delete session.active;
  if (pending && session.pending && (!session.pending.projectScope || session.pending.projectScope === state.projectScope?.fingerprint))
    delete session.pending;
  if (!session.active && !session.pending) sessions.delete(key);
}

function validatePreparation(params) {
  const keys = ["sessionKey", "sessionId", "runId", "changeName", "sourceRunId", "sourceSha256", "requirements"];
  if (!planSession(params) || Object.keys(params).length !== keys.length || keys.some(key => !Object.hasOwn(params, key))
    || !isOpenSpecChangeName(params.changeName) || !identifier(params.sourceRunId) || !digest(params.sourceSha256)
    || [params.runId, params.sourceRunId].some(runId => runId.startsWith("rc-stop-"))
    || !Array.isArray(params.requirements) || !params.requirements.length || params.requirements.length > 48) return null;
  const rows = new Map();
  for (const row of params.requirements) {
    if (!row || Object.keys(row).length !== 3) return null;
    const { start, end, requirement } = row;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start
      || typeof requirement !== "string" || !requirement || requirement.length > 600 || requirement !== requirement.trim()
      || requirement.includes("\0") || Buffer.from(requirement).toString("utf8") !== requirement) return null;
    rows.set(JSON.stringify([start, end, requirement]), { start, end, requirement });
  }
  if (rows.size !== params.requirements.length) return null;
  return Array.from(rows.keys()).sort().map(key => rows.get(key));
}

function registerPrepare(api, runtime, owner) {
  // The host may refresh plugin registrations between an operator request
  // and the associated turn. Keep the reservation with the host runtime.
  const sessions = proposalReviews.get(owner) ?? new Map();
  proposalReviews.set(owner, sessions);
  api.registerGatewayMethod("runtime-corrector.openspec.prepare", async ({ params, client, respond }) => {
    try {
      authenticatedActor(client, true);
      const requirements = validatePreparation(params);
      if (!requirements) throw new Error("Invalid prepared Proposal requirement inventory.");
      const { sessionKey, sessionId, runId, changeName, sourceRunId, sourceSha256 } = params;
      const key = sessionIdentity(params), now = Date.now();
      for (const [id, session] of sessions) {
        if (session.pending?.expiresAt <= now) delete session.pending;
        if (session.active && !session.active.state.deref()) delete session.active;
        if (!session.pending && !session.active) sessions.delete(id);
      }
      const inventorySha256 = sha256([changeName, sourceRunId, sourceSha256, requirements]);
      const receipt = { status: "PREPARED", runId, sourceRunId, changeName, requirementCount: requirements.length };
      const session = sessions.get(key) ?? {};
      const { pending, active } = session;
      const existing = [pending, active].find(stage => stage?.runId === runId);
      if (existing) {
        if (existing.inventorySha256 !== inventorySha256 || !existing.projectScope)
          throw conflict("The Proposal preparation is already reserved.");
        respond(true, receipt);
        return;
      }
      if (pending || active?.sourceRunId === sourceRunId && active.inventorySha256 !== inventorySha256
        || !sessions.has(key) && sessions.size >= prepareCapacity
        || [...sessions].some(([id, entry]) => id !== key && [entry.pending, entry.active].some(stage => stage?.runId === runId)))
        throw conflict("A new Proposal preparation cannot be reserved for this session.");
      const stage = { runId, changeName, sourceRunId, sourceSha256, requirements, inventorySha256, expiresAt: now + prepareTimeoutMs };
      session.pending = stage;
      sessions.set(key, session);
      let projectScope;
      try { projectScope = await runtime.openSpecProposalSession?.({ sessionKey, sessionId, runId }); } catch {}
      if (sessions.get(key) !== session || session.pending !== stage || typeof projectScope !== "string" || !projectScope
        || Date.now() >= stage.expiresAt) {
        if (session.pending === stage) delete session.pending;
        if (sessions.get(key) === session && !session.active && !session.pending) sessions.delete(key);
        throw conflict("The named Proposal session could not be verified.");
      }
      stage.projectScope = projectScope;
      respond(true, receipt);
    } catch (error) {
      const code = ["CONFLICT", "FORBIDDEN"].includes(error.code) ? error.code : "INVALID_REQUEST";
      respond(false, undefined, { code, message: String(error.message).slice(0, 600) });
    }
  }, { scope: "operator.write" });
}

export function beginOpenSpecRun(state, runId, { proposalOwner } = {}) {
  if (proposalOwner) beginPreparedProposalReview(proposalOwner, state, runId);
  const approval = approvals.get(state);
  const apply = approval?.apply;
  if (!apply) return;
  if (apply.runId === runId && state.nativeRunId === approval.runId) apply.activeRunId = runId;
  else if (apply.pendingRepair?.runId === runId && apply.pendingRepair.sourceRunId === state.nativeRunId) {
    apply.activeRunId = runId;
    apply.activeRepair = apply.pendingRepair;
    delete apply.pendingRepair;
  } else delete approval.apply;
}

export const hasArmedOpenSpecApply = (state, runId) => {
  return approvals.get(state)?.apply?.activeRunId === runId && typeof runId === "string";
};

export function hasApprovedApplyInventory(state, runId) {
  return hasArmedOpenSpecApply(state, runId) && Boolean(approvals.get(state).inventory);
}

export function reserveApprovedApplyRepair(state, receipt) {
  const approved = approvals.get(state), apply = approved?.apply;
  const repairId = receipt?.admissionId ?? receipt?.admission?.id;
  const restoration = receipt?.source?.purpose === PLAN_RESTORATION_PURPOSE;
  if (!(restoration ? apply?.restoration?.admissionId === repairId
      && restorationProofMatches(apply.restoration, receipt.source) : approved?.inventory)
    || receipt?.source?.purpose && !restoration || !apply?.usersDigest || state.nativeRunId !== apply.activeRunId
    || receipt?.source?.runId !== apply.activeRunId || receipt.source.usersDigest !== apply.usersDigest
    || receipt.taskId !== (approved.coverage?.taskId ?? state.scopeTaskId) || receipt.taskId !== state.scopeTaskId
    || !identifier(repairId) || receipt.admission?.id !== repairId || receipt.runId !== `rc-stop-${repairId}` || apply.pendingRepair) return false;
  apply.pendingRepair = { runId: receipt.runId, admissionId: repairId, sourceRunId: receipt.source.runId,
    ...(restoration ? { purpose: PLAN_RESTORATION_PURPOSE } : {}) };
  return true;
}

export async function approvedApplyRepairCurrent(state, request) {
  const runId = state.nativeRunId;
  if (!hasArmedOpenSpecApply(state, runId)) return false;
  const { apply } = approvals.get(state);
  const repair = runId === request.runId ? apply.activeRepair : apply.pendingRepair;
  if (repair?.runId !== request.runId || repair.sourceRunId !== request.source.runId
    || request.source.usersDigest !== apply.usersDigest || request.taskId !== state.scopeTaskId) return false;
  if (repair.purpose === PLAN_RESTORATION_PURPOSE || request.source.purpose)
    return repair.purpose === PLAN_RESTORATION_PURPOSE && await openSpecRestorationCurrent(state, request);
  if (!hasApprovedApplyInventory(state, runId)) return false;
  const current = await inspectArmedOpenSpecApply(state, runId);
  return current?.status === "PRESERVED" && current.currentRevision === request.source.openSpecPlanRevision;
}

function isStartedRepair(receipt, apply, state, runId) {
  const admission = receipt?.admission;
  return receipt?.status === "STARTED" && receipt.runId === runId && receipt.admissionId === apply.activeRepair.admissionId
    && admission?.id === receipt.admissionId && admission.hostRequest?.runId === runId
    && admission.hostRequest.source && receipt.source && sha256(admission.hostRequest.source) === sha256(receipt.source)
    && (apply.activeRepair.purpose === PLAN_RESTORATION_PURPOSE
      ? apply.restoration?.admissionId === receipt.admissionId && restorationProofMatches(apply.restoration, receipt.source)
        && Number.isFinite(admission.createdAt) && admission.startedAt >= admission.createdAt && admission.startedAt < admission.deadlineAt
      : !receipt.source?.purpose)
    && receipt.source?.runId === apply.activeRepair.sourceRunId && receipt.source.usersDigest === apply.usersDigest
    && receipt.sessionKey === state.sessionKey && receipt.taskId === state.scopeTaskId
    && receipt.projectRoot === state.projectRoot && receipt.agentId === state.agentId
    && admission?.accounting === "USED" && admission.startStatus === "STARTED" && admission.deliveryStatus === "DELIVERED"
    && admission.executionId === runId && admission.lateConfirmation === false && admission.invalidatedAt === undefined
    && Number.isFinite(receipt.gate?.at) && Number.isFinite(admission.startedAt) && receipt.gate.at <= admission.startedAt;
}

export function observeApprovedApplyRepairStart(state, receipt) {
  const apply = approvals.get(state)?.apply;
  if (!hasArmedOpenSpecApply(state, state.nativeRunId) || apply.activeRepair?.purpose !== PLAN_RESTORATION_PURPOSE
    || !isStartedRepair(receipt, apply, state, state.nativeRunId)) return false;
  apply.restoration.consumedAt ??= receipt.admission.startedAt;
  return true;
}

async function openSpecRestorationCurrent(state, request) {
  const approved = approvals.get(state), apply = approved?.apply, restoration = apply?.restoration;
  if (!restorationProofMatches(restoration, request.source)
    || state.projectScope?.fingerprint !== restoration.proof.scopeFingerprint
    || approved.snapshot.revision !== restoration.proof.approvedRevision
    || (approved.inventory?.inventorySha256 ?? null) !== restoration.proof.inventorySha256) return false;
  const current = await inspectArmedOpenSpecApply(state, state.nativeRunId);
  return current?.status === "CHANGED" && current.currentRevision === restoration.proof.changedRevision
    && sha256(current.differences) === sha256(restoration.proof.differences);
}

// This predicate is used only by the host's closed-purpose native admission
// path. Agent-written review records cannot supply or reconstruct its proof.
export async function openSpecRestorationFeedbackCurrent(state, request, deviations) {
  const restoration = approvals.get(state)?.apply?.restoration;
  return restoration && request.source?.usersDigest === approvals.get(state).apply.usersDigest
    && request.taskId === state.scopeTaskId && await openSpecRestorationCurrent(state, request)
    && sha256(deviations) === sha256(restoration.deviations) ? deviations : [];
}

/** A deterministic plan check uses the same session/flow quota, opaque
 * admission and native start fence as semantic corrections. No model verdict
 * or caller-supplied document can authorize a new approved plan. */
export async function assessOpenSpecPlanRestoration({ state, runId, openSpecPlan, observed, nativeReceipt, sourceInputId,
  sourceSha256, sourceCurrent, directory, stopId, config, hostDeadlineAt, signal, isCurrent,
  admissionSupported = false }) {
  const approved = approvals.get(state), apply = approved?.apply;
  if (openSpecPlan?.status !== "CHANGED" || !hasArmedOpenSpecApply(state, runId)
    || state.nativeRunId !== runId || !identifier(state.scopeTaskId) || !identifier(sourceInputId)
    || !digest(sourceSha256) || observed?.status !== "OBSERVED" || !digest(observed.externalUsersDigest)
    || !state.projectScope?.fingerprint || !approved.contents?.length
    || approved.contents.some(row => typeof row.text !== "string"
      || row.text.split("\n").some(line => Buffer.byteLength(JSON.stringify(line)) > 20 * 1024))) return null;
  if (approved.inventory && !approvedInventoryForApply(state, runId, observed, nativeReceipt)) return null;
  if (apply.activeRepair && !isStartedRepair(nativeReceipt, apply, state, runId)) return null;
  observeApprovedApplyRepairStart(state, nativeReceipt);
  if (apply.usersDigest && apply.usersDigest !== observed.externalUsersDigest) return null;
  if (apply.restoration?.assessing) return null;
  apply.usersDigest ??= observed.externalUsersDigest;
  const captured = await captureOpenSpecPlan(state.projectRoot, approved.snapshot.changeName).catch(() => null);
  if (!captured || !await isCurrent() || approvals.get(state) !== approved
    || !hasArmedOpenSpecApply(state, runId) || captured.plan.revision !== openSpecPlan.currentRevision
    || sha256(compareOpenSpecPlans(approved.snapshot, captured.plan).differences) !== sha256(openSpecPlan.differences)) return null;
  const proof = Object.freeze({ purpose: PLAN_RESTORATION_PURPOSE, approvedRevision: approved.snapshot.revision,
    changedRevision: captured.plan.revision, differences: Object.freeze([...openSpecPlan.differences]),
    initialApplyRunId: apply.runId, sourceSha256, scopeFingerprint: state.projectScope.fingerprint,
    inventorySha256: approved.inventory?.inventorySha256 ?? null });
  const key = sha256(proof), history = apply.restorations ??= new Map();
  const previous = history.get(key);
  // Only a verified actual start consumes this exact evidence. A new proof
  // shares the original flow/quota; duplicate Stop events keep one admission.
  if (previous?.consumedAt !== undefined || previous?.admissionId && (previous.stopId !== stopId || previous.sourceRunId !== runId)
    || apply.pendingRepair && (apply.pendingRepair.admissionId !== previous?.admissionId
    || previous.stopId !== stopId || previous.sourceRunId !== runId)
    || !previous && history.size >= 128) return null;
  const restoration = previous ?? { proof };
  apply.restoration = restoration;
  const source = { runId, leafId: observed.messages.at(-1)?.id, usersDigest: observed.externalUsersDigest,
    evidenceDigest: observed.evidenceDigest, purpose: PLAN_RESTORATION_PURPOSE,
    openSpecPlanRevision: captured.plan.revision, openSpecRestoration: structuredClone(proof),
    ...(Number.isFinite(hostDeadlineAt) ? { deadlineAt: hostDeadlineAt } : {}) };
  const request = { taskId: state.scopeTaskId, source };
  const current = async () => !signal?.aborted && state.nativeRunId === runId && await isCurrent()
    && await sourceCurrent(sourceSha256) && await openSpecRestorationCurrent(state, request);
  const objectId = `approved-plan-${sha256(proof).slice(0, 24)}`, revisionId = sha256(proof);
  const finding = { judgement: "DEVIATION", reason: "Restore the authenticated approved OpenSpec plan; do not amend or approve it.",
    evidence: [`approved:${proof.approvedRevision}`, `changed:${proof.changedRevision}`] };
  const scopeId = `${state.projectRoot}:${state.scopeTaskId}:${PLAN_RESTORATION_PURPOSE}`;
  const review = createStopReviewStore({ directory, sessionId: state.sessionId, scopeId,
    dependenciesCurrent: current,
    validateResult: async ({ result }) => {
      if (sha256(result) !== sha256(finding) || !await current()) throw conflict("The restoration evidence changed.");
      return { result, purpose: PLAN_RESTORATION_PURPOSE, snapshotKey: sha256(proof) };
    } });
  let core;
  restoration.assessing = true;
  history.set(key, restoration);
  try { core = await assessStopCorrection({ sessionStore: createStopCorrectionStore({ directory }),
    reviewStoreFor: () => review, sessionId: state.sessionId, flowId: sha256([state.sessionId, sourceInputId]),
    sourceInput: { origin: "HUMAN", id: sourceInputId }, stopId, config, hostDeadlineAt, signal, isCurrent: current,
    scope: state.projectRoot, reviewOwner: { pid: process.pid }, admissionSupported,
    prepare: async () => ({ scopeId, classification: { stopClassification: "INTERMEDIATE" },
      items: [{ objectId, metricId: "M09", revisionId, basis: { purpose: PLAN_RESTORATION_PURPOSE, proof }, dependencies: [] }] }),
    reviewGroup: async ({ submit }) => submit({ objectId, revisionId, result: finding }),
    feedbackBasisCurrent: async deviations => await current() ? deviations : [] }); }
  finally {
    restoration.assessing = false;
    if (!core?.admission && !restoration.admissionId && history.get(key) === restoration) history.delete(key);
  }
  if (!core.admission) return { core, source, outcome: null };
  history.set(key, restoration);
  restoration.admissionId = core.admission.id;
  restoration.stopId = stopId;
  restoration.sourceRunId = runId;
  restoration.deviations = structuredClone(core.stop.currentDeviations);
  restoration.deadlineAt = core.stop.deadlineAt;
  const checklist = `openspec/changes/${approved.snapshot.changeName}/tasks.md`;
  const keepProgress = approved.snapshot.taskTextSha256 === captured.plan.taskTextSha256
    && compareOpenSpecPlans(approved.snapshot, { ...captured.plan,
      documents: approved.snapshot.documents }).status === "PRESERVED";
  restoration.documents = Object.freeze(approved.contents.map(row => {
    const preserve = row.path === checklist && keepProgress;
    const document = preserve ? captured.contents.find(item => item.path === checklist) : row;
    const expected = (preserve ? captured.plan : approved.snapshot).documents.find(item => item.path === row.path).sha256;
    return Object.freeze({ ...document, sha256: expected,
      approvedSha256: approved.snapshot.documents.find(item => item.path === row.path).sha256 });
  }));
  return { core, source, outcome: { taskId: state.scopeTaskId, admission: core.admission,
    stopCorrection: { evaluationId: `plan-restoration-${sha256([state.sessionId, stopId]).slice(0, 24)}`,
      deadlineAt: core.stop.deadlineAt, waitMode: core.stop.config.waitMode } } };
}

export function openSpecRestorationFeedback(state, request, deviations) {
  const restoration = approvals.get(state)?.apply?.restoration;
  if (!restorationProofMatches(restoration, request.source)
    || sha256(deviations) !== sha256(restoration.deviations)) throw conflict("The restoration feedback is unavailable.");
  return `[runtime-corrector:stop-feedback]\nRestore only the existing authenticated approved OpenSpec plan. This is runtime feedback, not a new user request or approval. Do not amend or approve the plan, or change production code/tests during this restoration.\nApproved revision: ${restoration.proof.approvedRevision}\nUse runtime_corrector command approved-plan to page the sealed file list and exact changed paths (without subject), or read one listed file with subject and startLine/endLine. Copy the provided bytes exactly. Remove an added OpenSpec artifact only when its listed action is REMOVE. Completion markers are retained only when the entire original task text/order was unchanged; otherwise the approved checklist is supplied without inferring progress. Verify the original obligations and remaining tasks honestly. Restoration alone does not pass the normal implementation review.\nChanged paths (first eight):\n${restoration.proof.differences.slice(0, 8).map(file => `- ${file}`).join("\n")}`;
}

export function readApprovedOpenSpecRestoration(state, { runId, observed, receipt, path: file, startLine = 1, endLine = 120 }) {
  const approved = approvals.get(state), apply = approved?.apply, restoration = apply?.restoration;
  if (!hasArmedOpenSpecApply(state, runId) || state.nativeRunId !== runId
    || apply.activeRepair?.purpose !== PLAN_RESTORATION_PURPOSE || !isStartedRepair(receipt, apply, state, runId)
    || state.projectScope?.fingerprint !== restoration?.proof.scopeFingerprint
    || observed?.status !== "OBSERVED" || observed.externalUsersDigest !== apply.usersDigest
    || Date.now() >= restoration.deadlineAt) throw conflict("No current admitted plan restoration can read approved documents.");
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine - startLine >= 200) throw conflict("Invalid approved document page.");
  if (!file) {
    const total = Math.max(restoration.documents.length, restoration.proof.differences.length);
    const page = { approvedRevision: approved.snapshot.revision, documents: [], changes: [],
      totalDocuments: restoration.documents.length, totalChanges: restoration.proof.differences.length };
    let index = startLine - 1;
    for (; index < Math.min(endLine, total); index++) {
      const row = restoration.documents[index], changed = restoration.proof.differences[index];
      if (row && sha256(row.text) !== row.sha256) throw conflict("The approved document snapshot is unavailable.");
      const document = row && { path: row.path, sha256: row.sha256,
        approvedSha256: row.approvedSha256, lines: row.text.split("\n").length };
      const change = changed && { path: changed, action: restoration.documents.some(item => item.path === changed) ? "RESTORE" : "REMOVE" };
      const next = { ...page, documents: [...page.documents, ...(document ? [document] : [])], changes: [...page.changes, ...(change ? [change] : [])] };
      if (Buffer.byteLength(JSON.stringify(next)) > 24 * 1024) break;
      Object.assign(page, next);
    }
    return { ...page, startLine, nextStartLine: index < total ? index + 1 : null };
  }
  const document = restoration.documents.find(row => row.path === file);
  if (!document) throw conflict("Invalid approved document page.");
  if (sha256(document.text) !== document.sha256) throw conflict("The approved document snapshot is unavailable.");
  const lines = document.text.split("\n"), text = lines.slice(startLine - 1, endLine).join("\n");
  const page = { path: file, sha256: document.sha256, approvedRevision: approved.snapshot.revision,
    approvedSha256: document.approvedSha256,
    startLine, endLine: Math.min(endLine, lines.length), totalLines: lines.length, text };
  if (Buffer.byteLength(JSON.stringify(page)) > 24 * 1024) throw conflict("The approved document page exceeds its bound.");
  return page;
}

export function approvedInventoryForApply(state, runId, observed, nativeReceipt) {
  if (!hasApprovedApplyInventory(state, runId) || state.nativeRunId !== runId
    || observed?.status !== "OBSERVED" || !digest(observed.externalUsersDigest)) return null;
  const { apply, inventory, coverage } = approvals.get(state);
  if (state.scopeTaskId !== coverage.taskId || state.sessionId !== coverage.sessionId
    || apply.usersDigest && apply.usersDigest !== observed.externalUsersDigest
    || apply.activeRepair && !isStartedRepair(nativeReceipt, apply, state, runId)) return null;
  const sources = transcriptUserMessages(observed);
  if (proposalSourceBasis(sources) !== inventory.sourceBasisSha256) {
    // The armed native chat.send adds exactly one external host-attributed
    // user entry. Only that entry may follow the sealed Proposal sources.
    const dispatch = observed.messages?.find(record => record.id && `transcript:${record.id}` === sources.at(-1)?.ref
      && record.message?.idempotencyKey === `${apply.runId}:user`);
    if (!dispatch || proposalSourceBasis(sources.slice(0, -1)) !== inventory.sourceBasisSha256) return null;
  }
  observeApprovedApplyRepairStart(state, nativeReceipt);
  apply.usersDigest ??= observed.externalUsersDigest;
  return { inventorySha256: inventory.inventorySha256, requiredAtoms: structuredClone(inventory.requiredAtoms),
    taskId: coverage.taskId, sessionId: coverage.sessionId };
}

function verdict(approved, runId, snapshot) {
  const initialApplyRunId = approved.apply?.activeRepair?.runId === runId ? approved.apply.runId : runId;
  return { changeName: approved.snapshot.changeName, proposalRunId: approved.runId, applyRunId: initialApplyRunId,
    ...(initialApplyRunId !== runId ? { continuationRunId: runId } : {}),
    approvedRevision: approved.snapshot.revision,
    ...(snapshot ? { ...compareOpenSpecPlans(approved.snapshot, snapshot), currentRevision: snapshot.revision,
      taskCount: snapshot.taskCount, completedTaskCount: snapshot.completedTaskCount }
      : unverified("CURRENT_PLAN_UNAVAILABLE")) };
}

export async function inspectArmedOpenSpecApply(state, runId) {
  if (!hasArmedOpenSpecApply(state, runId)) return null;
  const approved = approvals.get(state);
  const snapshot = await readOpenSpecPlan(state.projectRoot, approved.snapshot.changeName).catch(() => null);
  if (approvals.get(state) !== approved || !hasArmedOpenSpecApply(state, runId)) return null;
  return verdict(approved, runId, snapshot);
}

export function approvedCoverageForApply(state, runId, verdict) {
  if (!hasArmedOpenSpecApply(state, runId) || (verdict?.continuationRunId ?? verdict?.applyRunId) !== runId) return null;
  return currentApprovedPlanCoverage(approvals.get(state).coverage, verdict);
}

export function openSpecApplyFinding(openSpecPlan) {
  if (!openSpecPlan) return null;
  if (openSpecPlan.status === "CHANGED") {
    const { differences } = openSpecPlan;
    const paths = differences.slice(0, 8).map(file => `- ${file}`).join("\n");
    return { reviewStatus: "DEVIATION", reasonCode: "OPENSPEC_APPLY_PLAN_CHANGED",
      verificationFeedback: `Apply changed the approved OpenSpec plan. Restore the approved scope or get approval for an amended Proposal.\n${paths}${differences.length > 8 ? "\nAdditional changed paths appear in the Stop record." : ""}` };
  }
  if (openSpecPlan.status === "UNVERIFIED") return { reviewStatus: "UNVERIFIED", reasonCode: "OPENSPEC_APPLY_PLAN_UNVERIFIED",
    verificationFeedback: "The plugin could not read the current OpenSpec plan. Restore access to the approved change and verify again." };
  if (openSpecPlan.completedTaskCount < openSpecPlan.taskCount) return { reviewStatus: "UNVERIFIED", reasonCode: "OPENSPEC_APPLY_PLAN_INCOMPLETE",
    verificationFeedback: `Apply completed ${openSpecPlan.completedTaskCount}/${openSpecPlan.taskCount} approved tasks. Verify the remaining work before recording completion.` };
  return null;
}

export function registerOpenSpecPlanControl(api, runtime) {
  if (typeof api.registerGatewayMethod !== "function") return;
  const owner = runtime.openSpecProposalOwner ?? api;
  registerPrepare(api, runtime, owner);
  for (const action of ["preview", "approve", "arm", "verify"]) {
    const arm = action === "arm", write = action === "approve" || arm;
    api.registerGatewayMethod(`runtime-corrector.openspec.${action}`, async ({ params, client, respond }) => {
      try {
        authenticatedActor(client, write);
        const allowed = ["sessionKey", "sessionId", "runId", "changeName", ...(write ? ["expectedRevision"] : []),
          ...(arm ? ["applyRunId", "expectedInventorySha256"] : action === "approve" ? ["requiredAtoms"] : [])];
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key))
          || !planSession(params)
          || !isOpenSpecChangeName(params.changeName)
          || arm && (!identifier(params.applyRunId) || params.runId === params.applyRunId || params.applyRunId.startsWith("rc-stop-"))
          || write && !digest(params.expectedRevision)
          || Object.hasOwn(params, "expectedInventorySha256") && !digest(params.expectedInventorySha256)) {
          throw new Error("Invalid OpenSpec plan parameters.");
        }
        const { sessionKey, sessionId, runId, changeName } = params;
        const target = await runtime.openSpecPlanTarget({ sessionKey, sessionId, runId });
        if (!target) throw conflict("The named session run is no longer current or has not settled.");
        const approved = approvals.get(target.state);
        const prior = approved?.runId === runId ? approved : null;
        const claimed = claimedProposalRuns.get(target.state) === runId;
        const strict = target.requireProposalCoverage === true || Boolean(prior?.inventory) || claimed;
        if (arm && (approved?.runId !== runId || approved.snapshot.changeName !== changeName
          || approved.snapshot.revision !== params.expectedRevision))
          throw conflict("Arm requires the current approved Proposal revision.");
        if (action === "verify" && (approved?.snapshot.changeName !== changeName || approved.runId === runId)) {
          respond(true, unverified("DISTINCT_APPROVED_PROPOSAL_REQUIRED"));
          return;
        }
        if (write && strict && prior && !prior.inventory)
          throw conflict("This Proposal already has an approval without a requirement inventory. Review a new Proposal run.");
        if (!strict && (Object.hasOwn(params, "requiredAtoms") || Object.hasOwn(params, "expectedInventorySha256")))
          throw new Error("This Proposal was not started with the requirement coverage policy.");
        if (arm && strict && params.expectedInventorySha256 !== prior.inventory.inventorySha256)
          throw conflict("Arm requires the approved requirement inventory digest.");
        const sources = write && strict ? await target.readProposalSources?.() : null;
        let snapshot, captured;
        try {
          if (action === "approve" && !prior) {
            captured = await captureOpenSpecPlan(target.projectRoot, changeName);
            snapshot = captured.plan;
          } else snapshot = await readOpenSpecPlan(target.projectRoot, changeName);
        }
        catch (error) {
          if (action !== "verify") throw error;
          if (!await target.current() || approvals.get(target.state) !== approved) throw conflict("OpenSpec plan target changed.");
          respond(true, unverified("CURRENT_PLAN_UNAVAILABLE"));
          return;
        }
        if (!await target.current() || approvals.get(target.state) !== approved) throw conflict("OpenSpec plan target changed.");
        if (action === "preview") {
          respond(true, { ...snapshot, runId, ...(strict ? { requireProposalCoverage: true } : {}) });
          return;
        }
        if (write) {
          if (params.expectedRevision !== snapshot.revision) throw conflict("Plan changed after preview. Review the current revision.");
          if (arm) {
            if (strict && proposalSourceBasis(sources) !== prior.inventory.sourceBasisSha256)
              throw conflict("The original user source changed after Proposal approval. Review a new Proposal run.");
            if (approved.apply && approved.apply.runId !== params.applyRunId)
              throw conflict("A different Apply run was already armed for this Proposal.");
            approved.apply ??= { runId: params.applyRunId };
            respond(true, { status: "ARMED", changeName, revision: snapshot.revision, runId, applyRunId: params.applyRunId,
              ...(strict ? { inventorySha256: prior.inventory.inventorySha256 } : {}) });
            return;
          }
          if (prior && prior.snapshot.revision !== snapshot.revision)
            throw conflict("A different revision was already approved on this run.");
          const prepared = activePreparedReview(owner, target.state);
          if (!prepared && claimed)
            throw conflict("The prepared Proposal requirement inventory is no longer current.");
          const coverage = strict || !prior ? selectApprovedPlanCoverage(target.state, runId, snapshot) : prior.coverage;
          const inventory = strict ? sealRequiredProposalCoverage(params.requiredAtoms, sources, coverage) : null;
          if (prepared && !inventory) throw conflict("The prepared Proposal requires strict approval.");
          checkPreparedApproval(prepared, snapshot, inventory);
          if (prior?.inventory && (inventory.inventorySha256 !== prior.inventory.inventorySha256
            || inventory.sourceBasisSha256 !== prior.inventory.sourceBasisSha256))
            throw conflict("A different requirement inventory or original source was already approved on this run.");
          approvals.set(target.state, prior ?? { snapshot, contents: captured && Object.freeze(captured.contents.map(Object.freeze)),
            runId, coverage, ...(inventory ? { inventory } : {}) });
          if (prepared) {
            releaseOpenSpecProposalSession(owner, target.state, { pending: false });
            claimedProposalRuns.delete(target.state);
          }
          respond(true, { status: "APPROVED", changeName, revision: snapshot.revision, runId,
            ...(inventory ? { inventorySha256: inventory.inventorySha256, requiredAtomCount: inventory.requiredAtoms.length } : {}) });
          return;
        }
        respond(true, verdict(approved, runId, snapshot));
      } catch (error) {
        const code = ["CONFLICT", "FORBIDDEN"].includes(error.code) ? error.code : "INVALID_REQUEST";
        respond(false, undefined, { code, message: String(error.message).slice(0, 600) });
      }
    }, { scope: write ? "operator.write" : "operator.read" });
  }
}
