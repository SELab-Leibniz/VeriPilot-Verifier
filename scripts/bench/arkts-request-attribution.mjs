import { isDeepStrictEqual } from 'node:util';
import { sameApplyRecoveryScope, sameApplyWorkflowScope } from './business-checkpoint.mjs';
import { businessCompleted, pairedBusinessWorkflowFailure } from './business-completion.mjs';
import { compareOpenSpecApplyProgress } from './original-basis-workflow.mjs';

const traceHash = /^[a-f0-9]{64}$/u;
const gitCommit = /^[a-f0-9]{40}$/u;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const identity = value => typeof value === 'string' && value.length > 0;
const checklistPhase = 'business-apply-checklist-repair';
const checklistDrift = 'OPENSPEC_APPLY_CHECKLIST_CHANGED';
const terminalTypes = new Set(['model.call.completed', 'model.call.error']);
const finalEvents = new Set(['response_end', 'request_error', 'observation_end']);
const stages = new Map([
  ['business-proposal', 'proposal'],
  ['business-proposal-validation-repair', 'proposal'],
  ['business-proposal-transport-recovery', 'proposal'],
  ['business-codeing', 'apply'],
  ['business-apply-transport-recovery', 'apply'],
  [checklistPhase, 'apply'],
]);
const roles = new Map([['artifact-reviewer', 'document'], ['stop-reviewer', 'stop']]);
const runSession = ({ runId, sessionId }) => JSON.stringify([runId, sessionId]);

function uniqueIndex(rows, key) {
  const values = new Map();
  for (const row of rows) {
    const id = key(row);
    values.set(id, values.has(id) ? null : row);
  }
  return values;
}

function ownsRequest(request, finished, start, end) {
  if (!start || !end || !finished || finished.event === 'observation_end'
    || !['callId', 'runId', 'sessionId', 'sessionKey'].every(key => identity(start[key]))
    || !['callId', 'runId', 'sessionId', 'sessionKey', 'traceparentSha256'].every(key => start[key] === end[key])
    || !['traceparentSha256', 'phase', 'startedAt'].every(key => request[key] === finished[key])) return false;
  const wireStart = Date.parse(request.startedAt);
  const elapsed = count(finished.durationMs);
  return Number.isSafeInteger(start.seq) && Number.isSafeInteger(end.seq) && start.seq < end.seq
    && Number.isSafeInteger(start.ts) && Number.isSafeInteger(end.ts)
    && Number.isFinite(wireStart) && elapsed !== null && start.ts <= wireStart && wireStart + elapsed <= end.ts;
}

function observedRole(start, result, privateByRun, businessRuns) {
  const key = runSession(start);
  // Ambiguous private ownership must never fall back to a business label.
  if (privateByRun.has(key)) {
    const run = privateByRun.get(key);
    return run?.status === 'SETTLED' && start.sessionId !== result.sessionId && start.sessionKey !== result.sessionKey
      ? roles.get(run.role) : null;
  }
  return start.sessionId === result.sessionId && start.sessionKey === result.sessionKey && businessRuns.has(start.runId) ? 'business' : null;
}

export function hasArktsChecklistRecovery(result) {
  return Object.hasOwn(result?.openSpec ?? {}, 'applyChecklistCorrection')
    || (Array.isArray(result?.turns) && result.turns.some(turn => turn?.checklistRepair === true));
}

const completed = turn => turn?.settled === true && businessCompleted(turn.terminal, turn.finalRunId);
const validWindow = turn => count(turn?.startedAt) !== null && count(turn?.finishedAt) !== null && turn.startedAt <= turn.finishedAt;
const unique = (records, predicate) => {
  const matches = records.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
};

function checklistRecovery(result, evidence) {
  if (!hasArktsChecklistRecovery(result)) return null;
  const report = { request: 'UNVERIFIED', dispatch: 'UNOBSERVED', start: 'UNOBSERVED',
    restoration: 'UNVERIFIED', applyCompletion: 'UNVERIFIED', requests: null };
  const { manifest, checkpoints = [] } = evidence ?? {};
  const openSpec = result.openSpec ?? {}, receipt = openSpec.applyChecklistCorrection;
  if (!receipt || !manifest || result.rcEnabled !== true || receipt.reason !== checklistDrift
    || !identity(receipt.changeName) || receipt.changeName !== manifest.changeName || !gitCommit.test(manifest.preparedHead)
    || !identity(result.sessionId) || !identity(result.sessionKey) || receipt.sessionId !== result.sessionId
    || !identity(receipt.proposalRunId) || !identity(receipt.beforeRunId) || typeof receipt.verified !== 'boolean'
    || receipt.repairRunId !== null && !identity(receipt.repairRunId)
    || receipt.afterCheckpointSha256 !== null && !traceHash.test(receipt.afterCheckpointSha256)
    || receipt.verified && (!receipt.repairRunId || !receipt.afterCheckpointSha256)
    || ![receipt.approvedChecklistSha256, receipt.observedChecklistSha256, receipt.beforeCheckpointSha256,
      receipt.instructionSha256].every(hash => traceHash.test(hash))
    || receipt.approvedChecklistSha256 === receipt.observedChecklistSha256 || count(manifest.deadline) === null) return { report };

  const turns = Array.isArray(result.turns) ? result.turns : [];
  const proposal = unique(turns, turn => turn?.stage === 'proposal' && turn.finalRunId === receipt.proposalRunId);
  const before = unique(turns, turn => turn?.stage === 'codeing' && turn.finalRunId === receipt.beforeRunId);
  if (!completed(proposal) || !completed(before) || !validWindow(proposal) || !validWindow(before)
    || proposal.finishedAt > before.startedAt || proposal.openSpec?.readyToApply !== true
    || !isDeepStrictEqual(proposal.openSpec, openSpec.proposal)
    || compareOpenSpecApplyProgress(proposal.openSpec, before.openSpec, receipt.changeName) === null) return { report };

  const checkpoint = (turn, reason, patchSha256, checklistSha256) => unique(checkpoints, entry => entry.runId === turn.finalRunId
    && reason.includes(entry.stopReason) && entry.sessionId === result.sessionId && entry.success === true
    && entry.preparedHead === manifest.preparedHead && traceHash.test(entry.patchSha256)
    && (patchSha256 === undefined || entry.patchSha256 === patchSha256)
    && (checklistSha256 === undefined || entry.proposalRepairScope?.tasksMdSha256 === checklistSha256)
    && entry.proposalRepairScope?.changeName === receipt.changeName && Date.parse(entry.capturedAt) >= turn.finishedAt
    && entry.proposalRepairScope.policy?.status === 'CAPTURED'
    && [entry.proposalRepairScope.tasksMdSha256, entry.proposalRepairScope.taskTextSha256,
      entry.proposalRepairScope.workflowFilesSha256, entry.proposalRepairScope.policy.sha256].every(hash => traceHash.test(hash))
    && Date.parse(entry.capturedAt) < manifest.deadline);
  const approved = checkpoint(proposal, ['openspec_proposal_boundary', 'openspec_proposal_transport_after', 'openspec_validation_repair_after'],
    undefined, receipt.approvedChecklistSha256);
  const rewritten = checkpoint(before, ['openspec_apply_checklist_before'], receipt.beforeCheckpointSha256, receipt.observedChecklistSha256);
  if (!sameApplyWorkflowScope(approved?.proposalRepairScope, rewritten?.proposalRepairScope)
    || approved.proposalRepairScope.taskTextSha256 === rewritten.proposalRepairScope.taskTextSha256
    || Date.parse(approved.capturedAt) > before.startedAt) return { report };
  Object.assign(report, { request: 'RECORDED', sourceRunId: receipt.beforeRunId, instructionSha256: receipt.instructionSha256 });

  const marked = turns.filter(turn => turn?.checklistRepair === true);
  const repair = marked.length === 1 ? marked[0] : null;
  if (!identity(receipt.repairRunId) || receipt.repairRunId === before.runId || receipt.repairRunId === receipt.beforeRunId
    || repair?.runId !== receipt.repairRunId || repair.stage !== 'codeing' || !identity(repair.finalRunId) || !validWindow(repair)
    || repair.startedAt < Date.parse(rewritten.capturedAt) || repair.startedAt >= manifest.deadline) return { report };
  Object.assign(report, { dispatch: 'FORMED', repairRunId: repair.runId });

  const starts = Array.isArray(result.gateway?.modelStarts) ? result.gateway.modelStarts.filter(entry => entry?.runId === repair.runId) : [];
  if (starts.length && starts.every(entry => entry.sessionId === result.sessionId && entry.sessionKey === result.sessionKey
    && Number.isSafeInteger(entry.seq) && entry.seq > 0 && count(entry.ts) !== null && entry.ts >= repair.startedAt && entry.ts <= repair.finishedAt
    && entry.ts < manifest.deadline)) report.start = 'OBSERVED';
  const restored = completed(repair) && traceHash.test(receipt.afterCheckpointSha256)
    ? checkpoint(repair, ['openspec_apply_checklist_after'], receipt.afterCheckpointSha256) : null;
  if (report.start === 'OBSERVED' && receipt.verified === true && turns.at(-1) === repair && result.nativeStopSettled === true
    && sameApplyRecoveryScope(approved.proposalRepairScope, restored?.proposalRepairScope)
    && compareOpenSpecApplyProgress(proposal.openSpec, repair.openSpec, receipt.changeName) === true
    && isDeepStrictEqual(repair.openSpec, openSpec.codeing)) {
    const reason = pairedBusinessWorkflowFailure(repair, openSpec);
    report.restoration = 'VERIFIED';
    if (reason === null) report.applyCompletion = 'COMPLETE';
    if (reason === 'OPENSPEC_APPLY_INCOMPLETE') report.applyCompletion = 'INCOMPLETE';
  }
  return { report, turn: repair };
}

// Report physical provider dispatches. One owned model call may have more than
// one wire attempt. Request timing locates the outer workflow stage only.
export function attributeArktsProviderRequests(result, timings = null, checklistEvidence) {
  const providerRequests = count(result?.modelRequests);
  const recordedTimingRequests = count(result?.requestTimingCount);
  const rows = Array.isArray(timings) ? timings : [];
  const requests = rows.filter(row => row?.event === 'request');
  const observedTimingRequests = Array.isArray(timings) ? requests.length : null;
  const byStage = Object.fromEntries(['proposal', 'apply', 'other'].map(stage =>
    [stage, { business: 0, document: 0, stop: 0, unknown: 0 }]));
  const recovery = checklistRecovery(result, checklistEvidence);
  const recoveryProjection = recovery ? { checklistRecovery: recovery.report } : {};
  const byRequestId = uniqueIndex(requests, row => row.id);
  const conserved = providerRequests !== null && requests.length <= providerRequests
    && (recordedTimingRequests === null || requests.length <= recordedTimingRequests)
    && requests.every(row => Number.isSafeInteger(row.id) && row.id > 0 && byRequestId.get(row.id));

  if (!conserved) return { status: 'UNAVAILABLE', providerRequests, recordedTimingRequests, observedTimingRequests,
    attributedRequests: 0, unknownRequests: providerRequests, logicalCallsWithAttributedRequests: 0,
    additionalWireAttempts: 0, missingTimingRequests: null, byStage: null, ...recoveryProjection };

  const calls = Array.isArray(result.gateway?.modelCalls) ? result.gateway.modelCalls.filter(Boolean) : [];
  const starts = calls.filter(row => row.type === 'model.call.started');
  const byTrace = uniqueIndex(starts, row => row.traceparentSha256);
  const byCallId = uniqueIndex(starts, row => row.callId);
  const ends = uniqueIndex(calls.filter(row => terminalTypes.has(row.type)), row => row.callId);
  const finished = uniqueIndex(rows.filter(row => finalEvents.has(row?.event)), row => row.id);
  const privateByRun = uniqueIndex(Array.isArray(result.privateRuns) ? result.privateRuns.filter(Boolean) : [], runSession);
  const businessRuns = new Set(Array.isArray(result.turns)
    ? result.turns.flatMap(turn => [turn?.runId, turn?.finalRunId]).filter(identity) : []);
  const logicalCalls = new Set();
  const checklistRequests = { business: 0, document: 0, stop: 0, unknown: 0 };
  let attributedRequests = 0;
  for (const request of requests) {
    const stage = stages.get(request.phase) ?? 'other';
    const start = typeof request.traceparentSha256 === 'string' && traceHash.test(request.traceparentSha256)
      ? byTrace.get(request.traceparentSha256) : null;
    const role = start && byCallId.get(start.callId) === start
      && ownsRequest(request, finished.get(request.id), start, ends.get(start.callId))
      ? observedRole(start, result, privateByRun, businessRuns) : null;
    byStage[stage][role ?? 'unknown']++;
    if (recovery && request.phase === checklistPhase) {
      const turn = recovery.turn, wireStart = Date.parse(request.startedAt);
      const inScope = turn && wireStart >= turn.startedAt && wireStart <= turn.finishedAt
        && (role !== 'business' || [turn.runId, turn.finalRunId].includes(start.runId));
      checklistRequests[(inScope && role) || 'unknown']++;
    }
    if (role) {
      attributedRequests++;
      logicalCalls.add(start.callId);
    }
  }
  const unknownRequests = providerRequests - attributedRequests;
  if (recovery && Array.isArray(timings)) recovery.report.requests = { ...checklistRequests,
    observed: Object.values(checklistRequests).reduce((sum, value) => sum + value, 0),
    timingComplete: requests.length === providerRequests && (recordedTimingRequests === null || recordedTimingRequests === requests.length) };
  return { status: !unknownRequests ? 'COMPLETE' : attributedRequests ? 'PARTIAL' : 'UNAVAILABLE',
    providerRequests, recordedTimingRequests, observedTimingRequests, attributedRequests, unknownRequests,
    logicalCallsWithAttributedRequests: logicalCalls.size,
    additionalWireAttempts: attributedRequests - logicalCalls.size,
    missingTimingRequests: providerRequests - requests.length, byStage, ...recoveryProjection };
}
