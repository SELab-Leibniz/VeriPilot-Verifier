import assert from 'node:assert/strict';
import path from 'node:path';
import { digest } from './arkts-dataset.mjs';
import { sha256 } from '../../lib/runtime-v2/utils.mjs';

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

export async function prepareNativeOpenSpecProposal({ request, sessionKey, sessionId, runId, sourceRunId,
  changeName, sourceSha256, requirements, deadlineAt }) {
  try {
    const remaining = deadlineAt - Date.now();
    assert(remaining > 0 && isHash(sourceSha256) && Array.isArray(requirements) && requirements.length > 0);
    const result = await request('runtime-corrector.openspec.prepare',
      { sessionKey, sessionId, runId, sourceRunId, changeName, sourceSha256, requirements }, { timeoutMs: Math.min(10_000, remaining) });
    assert(result?.status === 'PREPARED' && result.runId === runId && result.sourceRunId === sourceRunId
      && result.changeName === changeName && result.requirementCount === requirements.length);
    return { status: 'PREPARED', runId, sourceRunId, requirementCount: result.requirementCount };
  } catch {
    return { status: 'UNVERIFIED', runId, sourceRunId };
  }
}

// The runner and plugin inspect the same settled Proposal independently.
// Authenticate the frozen plan the runner already accepted, before sending Apply.
export async function armNativeOpenSpecApply({ request, sessionKey, sessionId, proposalRunId, applyRunId,
  changeName, proposalCheckpoint, taskCount, deadlineAt, requiredAtoms }) {
  const address = { sessionKey, sessionId, runId: proposalRunId, changeName };
  const strict = requiredAtoms !== undefined;
  let step = 'preview';
  const call = (action, params) => {
    step = action;
    const remaining = deadlineAt - Date.now();
    assert(remaining > 0, 'OpenSpec approval deadline expired.');
    return request(`runtime-corrector.openspec.${action}`, params, { timeoutMs: Math.min(10_000, remaining) });
  };
  try {
    assert(!strict || Array.isArray(requiredAtoms) && requiredAtoms.length > 0 && requiredAtoms.length <= 48);
    const scope = proposalCheckpoint?.proposalRepairScope;
    assert(proposalCheckpoint?.success === true && proposalCheckpoint.sessionId === sessionId
      && proposalCheckpoint.runId === proposalRunId && scope?.complete === true && scope.changeName === changeName
      && isHash(scope.tasksMdSha256) && isHash(scope.taskTextSha256) && isHash(scope.approvedDocumentsSha256)
      && Array.isArray(scope.draftFiles) && Number.isSafeInteger(taskCount) && taskCount > 0);
    const preview = await call('preview', address);
    assert(preview?.runId === proposalRunId && preview.changeName === changeName
      && (preview.requireProposalCoverage === true) === strict
      && isHash(preview.revision) && preview.taskCount === taskCount && preview.completedTaskCount === 0
      && preview.taskTextSha256 === scope.taskTextSha256 && Array.isArray(preview.documents));
    const checklist = `openspec/changes/${changeName}/tasks.md`;
    const inventory = new Map(preview.documents.map(({ path, sha256 }) => [path, sha256]));
    assert.equal(inventory.size, preview.documents.length);
    assert.equal(inventory.size, scope.draftFiles.length + 1);
    assert.equal(inventory.get(checklist), scope.tasksMdSha256);
    const drafts = scope.draftFiles.map(({ path }) => [path, inventory.get(path)]);
    assert(drafts.every(([, hash]) => isHash(hash)));
    assert.equal(digest(JSON.stringify(drafts)), scope.approvedDocumentsSha256);
    const canonical = [...inventory].sort(([left], [right]) => left < right ? -1 : Number(left > right))
      .map(([path, sha256]) => ({ path, sha256 }));
    assert.equal(digest(JSON.stringify({ changeName, documents: canonical })), preview.revision);
    const approve = { ...address, expectedRevision: preview.revision };
    const granted = await call('approve', { ...approve, ...(strict ? { requiredAtoms } : {}) });
    assert(granted?.status === 'APPROVED' && granted.runId === proposalRunId && granted.changeName === changeName
      && granted.revision === preview.revision);
    assert(!strict || isHash(granted.inventorySha256) && granted.requiredAtomCount === requiredAtoms.length);
    const armed = await call('arm', { ...approve, applyRunId, ...(strict ? { expectedInventorySha256: granted.inventorySha256 } : {}) });
    assert(armed?.status === 'ARMED' && armed.runId === proposalRunId && armed.applyRunId === applyRunId
      && armed.changeName === changeName && armed.revision === preview.revision
      && (!strict || armed.inventorySha256 === granted.inventorySha256));
    return { status: 'ARMED', sessionId, sessionKey, changeName, proposalRunId, applyRunId, approvedRevision: preview.revision, taskCount,
      ...(strict ? { inventorySha256: granted.inventorySha256, requiredAtomCount: granted.requiredAtomCount } : {}) };
  } catch {
    return { status: 'UNVERIFIED', step, sessionId, sessionKey, changeName, proposalRunId, applyRunId };
  }
}

function observePlan(approval, records, runId) {
  const matching = records.filter(record => record.status === 'SETTLED' && record.sessionId === approval.sessionId
    && record.sessionKey === approval.sessionKey && record.runId === runId && record.openSpecPlan);
  if (!matching.length) return { verdict: { status: 'NOT_OBSERVED' } };
  const [record] = matching;
  const plan = record.openSpecPlan;
  if (matching.length !== 1 || plan.changeName !== approval.changeName || plan.proposalRunId !== approval.proposalRunId
    || plan.applyRunId !== approval.applyRunId || plan.approvedRevision !== approval.approvedRevision
    || plan.continuationRunId !== (runId !== approval.applyRunId ? runId : undefined)
    || typeof record.occurrenceId !== 'string' || !record.occurrenceId
    || !['PRESERVED', 'CHANGED', 'UNVERIFIED'].includes(plan.status) || !Array.isArray(plan.differences)
    || (plan.status === 'CHANGED') !== (plan.differences.length > 0)
    || plan.differences.some(file => typeof file !== 'string' || !file.startsWith(`openspec/changes/${approval.changeName}/`))
    || plan.status === 'PRESERVED' && plan.taskCount !== approval.taskCount
    || plan.status !== 'UNVERIFIED' && (!isHash(plan.currentRevision) || !Number.isSafeInteger(plan.taskCount)
      || !Number.isSafeInteger(plan.completedTaskCount) || plan.completedTaskCount < 0 || plan.completedTaskCount > plan.taskCount))
    return { verdict: { status: 'UNVERIFIED' } };
  return { record, verdict: { status: 'OBSERVED', occurrenceId: record.occurrenceId, reviewStatus: record.reviewStatus ?? null, plan } };
}

function validInventory(approval, { record, verdict: { plan } }) {
  const summary = record?.reviewSummary, inventory = summary?.approvedProposalInventory, atoms = inventory?.requiredAtoms;
  return plan?.status === 'PRESERVED' && plan.completedTaskCount === approval.taskCount
    && ['PASS', 'NO_DEVIATION_FOUND', 'COMPLETED_WITH_HISTORICAL_DEVIATIONS', 'DEVIATION', 'UNVERIFIED'].includes(record.reviewStatus)
    && typeof record.evaluationId === 'string' && record.evaluationId.length > 0
    && summary?.evaluationId === record.evaluationId && summary.status === record.reviewStatus
    && isHash(approval.inventorySha256) && inventory?.inventorySha256 === approval.inventorySha256
    && Array.isArray(atoms) && atoms.length === approval.requiredAtomCount && atoms.length > 0 && atoms.length <= 48
    && atoms.every(atom => isHash(atom?.id) && typeof atom?.objectId === 'string' && atom.objectId.length > 0)
    && new Set(atoms.map(atom => atom.id)).size === atoms.length && new Set(atoms.map(atom => atom.objectId)).size === atoms.length;
}

const orderedTimes = times => times.every((value, index) => Number.isFinite(value) && (!index || value >= times[index - 1]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const restorationPurpose = 'openspec-plan-restoration';

function confirmedPartialFeedback(record, stop, admission, settled, projectRoot, taskId) {
  if (!stop || record.reviewStatus !== 'UNVERIFIED' || record.feedbackOnly !== true || settled?.status !== 'UNVERIFIED'
    || !Number.isSafeInteger(settled.currentDeviationCount) || settled.currentDeviationCount < 1
    || (stop.feedbackRevision ?? 0) !== admission.feedbackRevision) return false;
  const admitted = admission.currentDeviations;
  const retained = stop.currentDeviations?.length ? stop.currentDeviations : stop.invalidatedReview?.currentDeviations;
  if (!Array.isArray(admitted) || !admitted.length || !Array.isArray(retained) || retained.length !== admitted.length
    || settled.currentDeviationCount < admitted.length) return false;
  const typed = row => {
    if (!row || typeof row.objectId !== 'string' || !row.objectId || !isHash(row.revisionId)
      || row.result?.judgement !== 'DEVIATION' || typeof row.result.reason !== 'string' || !row.result.reason.trim()
      || !Array.isArray(row.result.evidence) || !row.result.evidence.length
      || row.result.evidence.some(ref => typeof ref !== 'string' || !ref.trim()) || row.result.citationFailure === true) return false;
    if (row.findingPath) {
      const root = path.join(projectRoot, '.runtime-correction', 'tasks', taskId, 'review-components');
      const relative = path.relative(root, row.findingPath);
      return isHash(row.receiptId) && relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..');
    }
    return /^M(?:0[1-9]|1[0-6])$/u.test(row.metricId ?? '') && isHash(row.basisKey)
      && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(row.receiptId ?? '');
  };
  // These are the immutable, host-protected rows accepted by native
  // stopFeedbackCurrent at prepare AND the input gate, not a model flag.
  // Their original sources can legitimately change during the repair itself.
  if (!admitted.every(typed) || !retained.every(typed) || new Set(admitted.map(row => row.receiptId)).size !== admitted.length) return false;
  const expected = new Set(retained.map(sha256));
  return expected.size === admitted.length && admitted.every(row => expected.has(sha256(row)));
}

// The caller reads this ledger from the host state directory, never the agent
// workspace. Project-local Stop summaries alone cannot attest a native start.
function restoredContinuations(approval, records, original, final, ledger, projectRoot) {
  if (!projectRoot || ledger?.schemaVersion !== 'runtime-corrector.stop-correction-session.v1'
    || ledger.sessionId !== approval.sessionId || !Array.isArray(ledger.events) || !ledger.admissions || !ledger.stops
    || original.verdict.plan?.status !== 'CHANGED' || final.record?.runId === approval.applyRunId
    || !validInventory(approval, final)) return null;
  const expectedAtoms = final.record.reviewSummary.approvedProposalInventory.requiredAtoms.map(atom => atom.id).sort();
  const steps = [], seen = new Set();
  let target = final, flowId, taskId, usersDigest, scopeFingerprint;
  while (target.record.runId !== approval.applyRunId) {
    const targetRunId = target.record.runId;
    if (seen.has(targetRunId)) return null;
    seen.add(targetRunId);
    const matches = Object.values(ledger.admissions).filter(row => row?.hostRequest?.runId === targetRunId);
    if (matches.length !== 1) return null;
    const admission = matches[0], request = admission.hostRequest, source = request.source;
    if (typeof source?.runId !== 'string' || !source.runId) return null;
    const stop = ledger.stops[admission.stopId], targetStop = ledger.stops[target.record.occurrenceId];
    const previous = source?.runId === approval.applyRunId ? original : observePlan(approval, records, source?.runId);
    const record = previous.record, plan = previous.verdict.plan;
    const unique = predicate => { const rows = ledger.events.filter(predicate); return rows.length === 1 ? rows[0] : null; };
    const settled = unique(row => row.type === 'STOP_REVIEW_SETTLED' && row.stopId === admission.stopId);
    const started = unique(row => row.type === 'CONTINUATION_STARTED' && (row.admissionId === admission.id || row.executionId === targetRunId));
    // The last permitted repair receives a read-only final assessment; that
    // assessment is on the admission, not a new quota-bearing Stop entry.
    const targetSettled = targetStop ? unique(row => row.type === 'STOP_REVIEW_SETTLED' && row.stopId === target.record.occurrenceId)
      : unique(row => row.type === 'FINAL_REPAIR_REVIEW' && row.admissionId === admission.id);
    const targetBound = targetStop ? targetStop.scope === projectRoot && targetStop.id === target.record.occurrenceId
      && targetStop.flowId === admission.flowId
      && targetStop.reviewScopeId === `${projectRoot}:${request.taskId}${target.verdict.plan?.status === 'CHANGED' ? `:${restorationPurpose}` : ''}`
      : target === final && admission.finalReview?.evaluationId === target.record.evaluationId
        && admission.finalReview?.status === target.record.reviewStatus && targetSettled?.evaluationId === target.record.evaluationId
        && targetSettled?.observedAt === admission.finalReview.at;
    const partial = record && confirmedPartialFeedback(record, stop, admission, settled, projectRoot, request.taskId);
    if (!record || previous.verdict.status !== 'OBSERVED' || record.reviewStatus !== 'DEVIATION' && !partial
      || !isHash(admission.id) || request.runId !== `rc-stop-${admission.id}` || admission.executionId !== request.runId
      || ledger.admissions[admission.id] !== admission
      || admission.accounting !== 'USED' || admission.startStatus !== 'STARTED' || admission.deliveryStatus !== 'DELIVERED'
      || admission.lateConfirmation !== false || admission.stopId !== record.occurrenceId
      || stop?.admissionId !== admission.id || stop.id !== record.occurrenceId || stop.scope !== projectRoot
      || !targetBound
      || stop.flowId !== admission.flowId || request.sessionKey !== approval.sessionKey || request.projectRoot !== projectRoot
      || typeof request.taskId !== 'string' || !request.taskId || typeof record.evaluationId !== 'string' || !record.evaluationId
      || request.assessmentId !== record.evaluationId || typeof request.agentId !== 'string' || !request.agentId
      || !approval.sessionKey.startsWith(`agent:${request.agentId}:`) || typeof source.leafId !== 'string' || !source.leafId
      || ![`${projectRoot}:${request.taskId}`, `${projectRoot}:${request.taskId}:${restorationPurpose}`].includes(stop.reviewScopeId)
      || !isHash(source.usersDigest) || !isHash(source.evidenceDigest) || source.openSpecPlanRevision !== plan.currentRevision
      || !request.gate || !isHash(request.gate.messageHash) || request.gate.feedbackRevision !== admission.feedbackRevision
      || settled?.status !== record.reviewStatus || targetSettled?.status !== target.record.reviewStatus
      || started?.admissionId !== admission.id || started.executionId !== targetRunId || started.valid !== true
      || started.lateConfirmation !== false || started.startedAt !== admission.startedAt
      || ledger.events.indexOf(settled) >= ledger.events.indexOf(started) || ledger.events.indexOf(started) >= ledger.events.indexOf(targetSettled)
      || !orderedTimes([settled.observedAt, admission.createdAt, record.assessmentCompletedAt, request.createdAt,
        request.gate.at, admission.startedAt, admission.observedAt, admission.endedAt, target.record.assessmentCompletedAt, target.record.settledAt])
      || !orderedTimes([admission.startedAt, started.observedAt, admission.endedAt])
      || !orderedTimes([admission.endedAt, targetSettled.observedAt, target.record.settledAt])
      || !Number.isFinite(admission.deadlineAt) || admission.observedAt >= admission.deadlineAt
      || flowId && flowId !== admission.flowId || taskId && taskId !== request.taskId || usersDigest && usersDigest !== source.usersDigest) return null;
    // Closing the host after final settlement may invalidate earlier records.
    // Preserve only the immutable completed start, never a cancelled queued run.
    if (admission.invalidatedAt !== undefined || stop.reviewStatus !== record.reviewStatus) {
      const release = unique(row => row.type === 'STOP_RELEASED' && row.stopId === admission.stopId);
      if (admission.invalidationReason !== 'RC_NATIVE_CANCELLED' || stop.reviewStatus !== 'UNVERIFIED'
        || stop.invalidatedReview?.status !== record.reviewStatus || release?.reasonCode !== 'RC_NATIVE_CANCELLED' || release.accounting !== 'USED'
        || !orderedTimes([final.record.settledAt, admission.invalidatedAt, stop.invalidatedReview.at, release.observedAt])) return null;
    }
    let purpose = 'code-repair';
    if (source.purpose === restorationPurpose) {
      const proof = source.openSpecRestoration, summary = record.reviewSummary;
      if (partial || plan.status !== 'CHANGED' || record.reasonCode !== 'OPENSPEC_APPLY_PLAN_CHANGED'
        || summary?.purpose !== restorationPurpose || summary.approvedRevision !== approval.approvedRevision
        || summary.changedRevision !== plan.currentRevision || proof?.purpose !== restorationPurpose
        || proof.approvedRevision !== approval.approvedRevision || proof.initialApplyRunId !== approval.applyRunId
        || proof.inventorySha256 !== approval.inventorySha256 || proof.changedRevision !== plan.currentRevision
        || !same(proof.differences, plan.differences) || new Set(plan.differences).size !== plan.differences.length
        || !isHash(proof.sourceSha256) || typeof proof.scopeFingerprint !== 'string' || !proof.scopeFingerprint
        || scopeFingerprint && scopeFingerprint !== proof.scopeFingerprint) return null;
      scopeFingerprint = proof.scopeFingerprint;
      purpose = restorationPurpose;
    } else if (source.purpose !== undefined || source.openSpecRestoration !== undefined || !validInventory(approval, previous)
      || !same(previous.record.reviewSummary.approvedProposalInventory.requiredAtoms.map(atom => atom.id).sort(), expectedAtoms)) return null;
    steps.unshift({ runId: targetRunId, sourceRunId: record.runId, occurrenceId: record.occurrenceId,
      admissionId: admission.id, purpose, startedAt: admission.startedAt, ...(partial ? { partialFeedback: true } : {}) });
    flowId = admission.flowId; taskId = request.taskId; usersDigest = source.usersDigest;
    target = previous;
  }
  const flow = ledger.flows?.[flowId];
  return steps[0]?.purpose === restorationPurpose && Number.isSafeInteger(ledger.used) && ledger.used >= steps.length
    && flow?.id === flowId && Number.isSafeInteger(flow.used) && flow.used >= steps.length ? { status: 'OBSERVED',
    planRestorations: steps.filter(row => row.purpose === restorationPurpose).length,
    codeRepairs: steps.filter(row => row.purpose === 'code-repair').length, steps } : null;
}

function observeInventory(approval, original, final, continuations) {
  if (original.verdict.status === 'NOT_OBSERVED' || final.verdict.status === 'NOT_OBSERVED') return { status: 'NOT_OBSERVED' };
  if (continuations) return { status: 'OBSERVED', finalRunId: final.record.runId, occurrenceId: final.record.occurrenceId,
    evaluationId: final.record.evaluationId, inventorySha256: approval.inventorySha256,
    requiredAtomCount: approval.requiredAtomCount, reviewStatus: final.record.reviewStatus };
  if (!validInventory(approval, original) || final !== original && !validInventory(approval, final)) return { status: 'UNVERIFIED' };
  if (final !== original) {
    const ids = new Set(original.record.reviewSummary.approvedProposalInventory.requiredAtoms.map(atom => atom.id));
    if (!final.record.reviewSummary.approvedProposalInventory.requiredAtoms.every(atom => ids.has(atom.id))) return { status: 'UNVERIFIED' };
  }
  return { status: 'OBSERVED', finalRunId: final.record.runId, occurrenceId: final.record.occurrenceId,
    evaluationId: final.record.evaluationId, inventorySha256: approval.inventorySha256,
    requiredAtomCount: approval.requiredAtomCount, reviewStatus: final.record.reviewStatus };
}

export function observeNativeOpenSpecApply(approval, records, { finalRunId = approval?.applyRunId, ledger, projectRoot } = {}) {
  if (approval?.status !== 'ARMED') return null;
  const original = observePlan(approval, records, approval.applyRunId);
  if (!Object.hasOwn(approval, 'inventorySha256')) return original.verdict;
  const final = finalRunId === approval.applyRunId ? original : observePlan(approval, records, finalRunId);
  let continuations;
  try { continuations = restoredContinuations(approval, records, original, final, ledger, projectRoot); } catch { continuations = null; }
  return { ...original.verdict, inventory: observeInventory(approval, original, final, continuations), ...(continuations ? { continuations } : {}) };
}
