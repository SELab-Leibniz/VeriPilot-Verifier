import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './arkts-dataset.mjs';
import { businessCompleted, knownBusinessTerminal } from './business-completion.mjs';

const inconclusive = reason => ({ status: 'inconclusive', reason });
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const localPath = value => typeof value === 'string' && !value.includes('\\') && !path.posix.isAbsolute(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

async function resolveEvidence(root, relative) {
  const file = await fs.realpath(path.join(root, relative));
  const relativeToRoot = path.relative(root, file);
  if (!relativeToRoot || path.isAbsolute(relativeToRoot) || relativeToRoot.split(path.sep)[0] === '..')
    throw new Error('Evidence must stay inside the business output.');
  return file;
}

async function evidenceBytes(root, relative) {
  const file = await resolveEvidence(root, relative);
  if (!(await fs.stat(file)).isFile()) throw new Error('Expected a business evidence file.');
  return fs.readFile(file);
}

async function evidenceJson(root, relative) {
  return JSON.parse(await evidenceBytes(root, relative));
}

const identity = value => typeof value === 'string' && value.length > 0;
const orderedTimes = times => times.every((at, index) => Number.isFinite(at) && (!index || at >= times[index - 1]));
const stopLedger = (root, sessionId) => evidenceJson(root,
  path.join('native-host/state/runtime-corrector-stop-sessions/sessions', `${digest(sessionId)}.json`));
const belongsToSession = (result, ledger) => ledger?.schemaVersion === 'runtime-corrector.stop-correction-session.v1'
  && ledger.sessionId === result.sessionId && Array.isArray(result.nativeStopRecords) && Array.isArray(ledger.events);

function nativeAdmission(result, ledger, review) {
  const stop = ledger.stops?.[review.occurrenceId];
  const admission = ledger.admissions?.[stop?.admissionId];
  const request = admission?.hostRequest;
  if (stop?.scope !== result.projectRoot || !admission || admission.id !== stop.admissionId
    || admission.stopId !== review.occurrenceId || admission.flowId !== stop.flowId
    || admission.accounting !== 'USED' || admission.startStatus !== 'STARTED' || admission.deliveryStatus !== 'DELIVERED'
    || !request?.runId || request.runId !== admission.executionId || request.sessionKey !== result.sessionKey
    || request.projectRoot !== result.projectRoot || !review.evaluationId || request.assessmentId !== review.evaluationId) return null;
  return { stop, admission, request };
}

function timelyNativeStart(result, ledger, review) {
  const match = nativeAdmission(result, ledger, review);
  if (!match) return null;
  const { stop, admission, request } = match;
  const { startedAt } = admission;
  if (stop.id !== review.occurrenceId || !identity(admission.id) || !identity(admission.flowId) || !identity(request.runId)
    || request.runId === review.runId || request.source?.runId !== review.runId || admission.lateConfirmation !== false) return null;

  const source = ledger.events.filter(row => row.type === 'STOP_REVIEW_SETTLED' && row.stopId === review.occurrenceId && row.status === 'DEVIATION');
  const starts = ledger.events.filter(row => row.type === 'CONTINUATION_STARTED'
    && (row.admissionId === admission.id || row.executionId === request.runId));
  if (source.length !== 1 || starts.length !== 1) return null;
  const [settlement] = source, [start] = starts;
  if (start.admissionId !== admission.id || start.executionId !== request.runId || start.valid !== true
    || start.lateConfirmation !== false || start.startedAt !== startedAt || ledger.events.indexOf(settlement) >= ledger.events.indexOf(start)) return null;

  // Native settlement is persisted independently of the request binding. Both
  // precede the model start, even if their receipt writes happen in either order.
  if (!orderedTimes([settlement.observedAt, review.settledAt, startedAt])
    || !orderedTimes([settlement.observedAt, admission.createdAt, request.createdAt, request.gate?.at,
      startedAt, admission.observedAt, start.observedAt])
    || !Number.isFinite(admission.deadlineAt) || admission.observedAt >= admission.deadlineAt) return null;
  if (stop.reviewStatus !== 'DEVIATION' && !(stop.reviewStatus === 'UNVERIFIED'
    && stop.invalidatedReview?.status === 'DEVIATION' && orderedTimes([start.observedAt, stop.invalidatedReview.at]))) return null;
  return { runId: request.runId, sourceRunId: review.runId, occurrenceId: review.occurrenceId,
    evaluationId: review.evaluationId, startedAt };
}

// An emitted start is positive evidence only. A partial or missing result can
// leave the count unknown, and this reader makes no claim about the repair outcome.
export async function readArktsVerifiedRepairStarts(businessRoot, { expectedResultSha256 } = {}) {
  try {
    const root = await fs.realpath(businessRoot);
    const bytes = await evidenceBytes(root, 'result.json');
    if (expectedResultSha256 !== undefined && digest(bytes) !== expectedResultSha256) return [];
    const result = JSON.parse(bytes);
    if (result.rcEnabled !== true || ![result.sessionId, result.sessionKey, result.projectRoot].every(identity)) return [];
    const [manifest, ledger] = await Promise.all([evidenceJson(root, 'manifest.json'), stopLedger(root, result.sessionId)]);
    if (manifest.rcEnabled !== true || manifest.projectRoot !== result.projectRoot || !isDigest(manifest.publicInputSha256)
      || manifest.publicInputSha256 !== result.publicInputSha256 || !belongsToSession(result, ledger)) return [];
    const starts = result.nativeStopRecords.filter(row => row.status === 'SETTLED' && row.reviewStatus === 'DEVIATION'
      && [row.runId, row.occurrenceId, row.evaluationId].every(identity)
      && !result.nativeStopRecords.some(other => other !== row
        && (other.occurrenceId === row.occurrenceId || other.evaluationId === row.evaluationId)))
      .map(review => timelyNativeStart(result, ledger, review)).filter(Boolean);
    return starts.filter(row => !starts.some(other => other !== row && other.runId === row.runId))
      .sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId));
  } catch {
    return [];
  }
}

// Native cleanup can invalidate the original Stop after its repair and the
// next native occurrence settle. Recover only that completed lineage.
function closedOriginalDeviation(result, ledger, review, stop, admission) {
  const invalidated = stop.invalidatedReview;
  const flow = ledger.flows?.[admission.flowId];
  if (stop.reviewStatus !== 'UNVERIFIED' || invalidated?.status !== 'DEVIATION'
    || !stop.reviewScopeId || !Array.isArray(invalidated.currentDeviations) || !invalidated.currentDeviations.length
    || admission.invalidationReason !== 'RC_NATIVE_CANCELLED' || flow?.closeReason !== 'RC_NATIVE_CANCELLED'
    || !Array.isArray(result.stopReviews) || !result.stopReviews.some(row => row.runId === review.runId
      && row.evaluationId === review.evaluationId && row.status === 'DEVIATION')) return false;

  const next = result.nativeStopRecords.filter(row => row.runId === admission.executionId
    && row.occurrenceId === stop.scopeEndedByStopId && row.occurrenceId !== review.occurrenceId
    && row.status === 'SETTLED' && row.reviewStatus && row.evaluationId && row.evaluationId !== review.evaluationId);
  if (next.length !== 1) return false;
  const [followup] = next;
  const nextStop = ledger.stops?.[followup.occurrenceId];
  if (nextStop?.scope !== stop.scope || nextStop.flowId !== stop.flowId || nextStop.reviewScopeId !== stop.reviewScopeId
    || nextStop.reviewStatus !== followup.reviewStatus) return false;

  const event = predicate => {
    const matches = ledger.events.filter(predicate);
    return matches.length === 1 ? matches[0] : null;
  };
  const originalSettlement = event(row => row.type === 'STOP_REVIEW_SETTLED' && row.stopId === review.occurrenceId && row.status === 'DEVIATION');
  const start = event(row => row.type === 'CONTINUATION_STARTED' && row.admissionId === admission.id
    && row.executionId === admission.executionId && row.valid === true && row.lateConfirmation === false && row.startedAt === admission.startedAt);
  const finalSettlement = event(row => row.type === 'STOP_REVIEW_SETTLED' && row.stopId === followup.occurrenceId && row.status === followup.reviewStatus);
  const release = event(row => row.type === 'STOP_RELEASED' && row.stopId === review.occurrenceId
    && row.reasonCode === 'RC_NATIVE_CANCELLED' && row.accounting === 'USED');
  const sequence = [originalSettlement, start, finalSettlement, release].map(row => ledger.events.indexOf(row));
  if (sequence[0] < 0 || !sequence.slice(1).every((index, i) => index > sequence[i])) return false;
  const times = [originalSettlement.observedAt, review.settledAt, admission.startedAt, start.observedAt,
    admission.endedAt, finalSettlement.observedAt, followup.settledAt, admission.invalidatedAt,
    invalidated.at, flow.closedAt, release.observedAt];
  return orderedTimes(times);
}

function correctionLineage(result, ledger, coding) {
  if (!belongsToSession(result, ledger)) return null;
  const completed = new Set();
  const corrections = [];
  let runId = coding.runId;
  while (runId !== coding.finalRunId) {
    if (completed.has(runId)) return null;
    completed.add(runId);
    const matches = result.nativeStopRecords.filter(row => row.runId === runId && row.status === 'SETTLED'
      && row.reviewStatus === 'DEVIATION' && ledger.stops?.[row.occurrenceId]?.admissionId);
    if (matches.length !== 1) return null;
    const review = matches[0];
    const match = nativeAdmission(result, ledger, review);
    if (!match) return null;
    const { stop, admission, request } = match;
    const observedStart = ledger.events.some(event => event.type === 'CONTINUATION_STARTED'
      && event.admissionId === admission?.id && event.executionId === request?.runId
      && event.valid === true && event.startedAt === admission?.startedAt);
    if ((corrections.length && admission.flowId !== corrections[0].flowId)
      || !Number.isFinite(admission.startedAt) || !Number.isFinite(admission.endedAt) || admission.endedAt < admission.startedAt
      || (corrections.length && admission.startedAt < corrections.at(-1).endedAt) || !observedStart) return null;
    if (stop.reviewStatus !== 'DEVIATION' && !closedOriginalDeviation(result, ledger, review, stop, admission)) return null;
    corrections.push({ admissionId: admission.id, flowId: admission.flowId, stopId: admission.stopId,
      evaluationId: review.evaluationId, sourceRunId: runId, runId: request.runId,
      startedAt: admission.startedAt, endedAt: admission.endedAt });
    runId = request.runId;
  }
  return corrections;
}

async function readCheckpoints(root) {
  const directory = await resolveEvidence(root, 'checkpoints');
  const directories = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory());
  const checkpoints = await Promise.all(directories.map(async ({ name }) => {
    const receipt = await evidenceJson(root, path.join('checkpoints', name, 'checkpoint.json'))
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return receipt && { name, receipt };
  }));
  return checkpoints.filter(Boolean);
}

async function projectCheckpoint(root, checkpoints, result, { runId, startedAt, captureBy, completeBy, prefix }) {
  const reject = reason => inconclusive(`${prefix}_${reason}`);
  const matches = checkpoints.filter(({ receipt }) => receipt.runId === runId && receipt.sessionId === result.sessionId
    && receipt.preparedHead === result.frozen.preparedHead && receipt.stopReason === 'before_agent_finalize'
    && receipt.event === 'agent_end' && receipt.success === true);
  if (matches.length !== 1) return reject(matches.length ? 'CHECKPOINT_AMBIGUOUS' : 'CHECKPOINT_MISSING');
  const { name, receipt } = matches[0];
  const capturedAt = Date.parse(receipt.capturedAt);
  const completedAt = Date.parse(receipt.completedAt);
  if (!(startedAt <= capturedAt && capturedAt <= captureBy && capturedAt <= completedAt && completedAt <= completeBy))
    return reject('TIME_UNVERIFIED');
  const relative = path.join('checkpoints', name, 'candidate.patch');
  const patch = await evidenceBytes(root, relative);
  if (!isDigest(receipt.patchSha256) || digest(patch) !== receipt.patchSha256
    || !Array.isArray(receipt.paths) || !receipt.paths.every(localPath) || Boolean(patch.length) !== Boolean(receipt.paths.length))
    return reject('PATCH_UNVERIFIED');
  const workflowChanged = receipt.paths.some(file => /^(?:openspec|\.opencode)\//u.test(file));
  let file = relative, sha256 = receipt.patchSha256;
  if (receipt.businessPatchSha256 !== undefined) {
    const business = path.join('checkpoints', name, 'business-candidate.patch');
    const businessBytes = await evidenceBytes(root, business).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!businessBytes || !isDigest(receipt.businessPatchSha256) || digest(businessBytes) !== receipt.businessPatchSha256
      || (!workflowChanged && !businessBytes.equals(patch))) return reject('BUSINESS_PATCH_UNVERIFIED');
    file = business;
    sha256 = receipt.businessPatchSha256;
  } else if (workflowChanged) return reject('BUSINESS_PATCH_REQUIRED');
  return { file: path.join(root, file), sha256, runId: receipt.runId, capturedAt: receipt.capturedAt,
    observedFile: path.join(root, relative), observedSha256: receipt.patchSha256, completedAt: receipt.completedAt };
}

async function codingCheckpoint(root, checkpoints, result, coding, firstCorrection) {
  const firstReview = result.stopReviews?.find(review => review.evaluationId === firstCorrection.evaluationId
    && review.status === 'DEVIATION');
  if (!Number.isFinite(firstReview?.startedAt) || !Number.isFinite(coding.startedAt) || firstReview.startedAt > firstCorrection.startedAt)
    return inconclusive('PRE_STOP_TIME_UNVERIFIED');
  return projectCheckpoint(root, checkpoints, result, { runId: coding.runId, startedAt: coding.startedAt,
    captureBy: firstReview.startedAt, completeBy: firstCorrection.startedAt, prefix: 'PRE_STOP' });
}

async function continuationCheckpoint(root, checkpoints, result, correction) {
  try {
    const checkpoint = await projectCheckpoint(root, checkpoints, result, { runId: correction.runId,
      startedAt: correction.startedAt, captureBy: correction.endedAt, completeBy: correction.endedAt, prefix: 'CONTINUATION' });
    return checkpoint.status === 'inconclusive' ? checkpoint : { status: 'captured', ...checkpoint };
  } catch (error) {
    return inconclusive(error.code === 'ENOENT' ? 'CONTINUATION_EVIDENCE_MISSING' : 'CONTINUATION_EVIDENCE_UNREADABLE');
  }
}

// The paired observer projects the checkpoint through the same Git pathspec as
// the final candidate. A legacy checkpoint can only serve as-is when its paths
// contain no OpenSpec or OpenCode workflow files.
export async function readArktsCorrectionEvidence(businessRoot, { includeIncompleteWorkflow = false, expectedResultSha256 } = {}) {
  try {
    const root = await fs.realpath(businessRoot);
    const resultBytes = await evidenceBytes(root, 'result.json');
    if (expectedResultSha256 !== undefined && digest(resultBytes) !== expectedResultSha256)
      return inconclusive('BUSINESS_RECEIPT_CHANGED');
    const result = JSON.parse(resultBytes);
    if (result.rcEnabled !== true) return inconclusive('CORRECTION_DISABLED');
    const workflowComplete = result.businessNatural === true && result.openSpec?.codeing?.applyComplete === true;
    const diagnostic = includeIncompleteWorkflow && result.businessNatural === false;
    if (result.state !== 'finished' || (!workflowComplete && !diagnostic) || result.frameworkError !== false || result.nativeStopSettled !== true
      || result.openSpec?.proposal?.readyToApply !== true
      || !result.sessionId || !result.sessionKey || !result.frozen) return inconclusive('PAIRED_BUSINESS_INCOMPLETE');
    const codingTurns = result.turns?.filter(turn => turn.stage === 'codeing') ?? [];
    let coding = codingTurns.length === 1 && !codingTurns[0].transportRecovery ? codingTurns[0] : null;
    const recovery = result.openSpec?.applyTransportRecovery;
    if (codingTurns.length === 2 && recovery?.verified === true) {
      const [interrupted, resumed] = codingTurns;
      const trigger = await evidenceJson(root, 'openspec-apply-transport-recovery.json');
      if (interrupted.runId === recovery.sourceRunId && interrupted.finalRunId === interrupted.runId && interrupted.settled === true
        && knownBusinessTerminal(interrupted.terminal, interrupted.runId) && interrupted.terminal.status === 'error'
        && resumed.transportRecovery === true && resumed.runId === recovery.retryRunId && resumed.startedAt >= interrupted.finishedAt
        && trigger.sourceRunId === recovery.sourceRunId && isDigest(recovery.checkpointSha256) && trigger.checkpointSha256 === recovery.checkpointSha256
        && isDigest(recovery.promptSha256) && trigger.promptSha256 === recovery.promptSha256) coding = resumed;
    }
    if (coding?.stage !== 'codeing' || coding.settled !== true || !coding.runId || !coding.finalRunId
      || !businessCompleted(coding.originalTerminal, coding.runId) || !businessCompleted(coding.terminal, coding.finalRunId))
      return inconclusive('CODING_TERMINALS_UNVERIFIED');
    if (coding.runId === coding.finalRunId) return inconclusive('NO_SEPARATE_CORRECTION');
    const finalReview = result.nativeStopVerification;
    if (finalReview?.runId !== coding.finalRunId || finalReview.status !== 'SETTLED' || !finalReview.evaluationId || !finalReview.reviewStatus
      || !Array.isArray(result.nativeStopRecords) || !result.nativeStopRecords.some(row => row.runId === coding.finalRunId
        && row.status === 'SETTLED' && row.evaluationId === finalReview.evaluationId && row.reviewStatus === finalReview.reviewStatus))
      return inconclusive('FINAL_STOP_UNVERIFIED');
    const [manifest, freeze, ledger] = await Promise.all([
      evidenceJson(root, 'manifest.json'), evidenceJson(root, 'freeze/freeze.json'),
      stopLedger(root, result.sessionId),
    ]);
    if (manifest.rcEnabled !== true || manifest.projectRoot !== result.projectRoot || manifest.publicInputSha256 !== result.publicInputSha256
      || !isDigest(manifest.publicInputSha256) || manifest.preparedHead !== freeze.preparedHead
      || !/^[0-9a-f]{40}$/u.test(freeze.preparedHead) || !isDigest(freeze.patchSha256)
      || !isDigest(freeze.workspacePatchSha256) || !isDigest(freeze.sessionSha256)
      || ['preparedHead', 'patchSha256', 'workspacePatchSha256', 'sessionSha256'].some(key => freeze[key] !== result.frozen[key]))
      return inconclusive('FREEZE_IDENTITY_MISMATCH');
    const [candidate, workspace, transcript] = await Promise.all(['candidate.patch', 'workspace.patch', 'session.jsonl']
      .map(file => evidenceBytes(root, path.join('freeze', file))));
    const session = JSON.parse(transcript.toString('utf8').split(/\r?\n/u, 1)[0]);
    if (digest(candidate) !== freeze.patchSha256 || digest(workspace) !== freeze.workspacePatchSha256
      || digest(transcript) !== freeze.sessionSha256 || session.type !== 'session' || session.id !== result.sessionId)
      return inconclusive('FREEZE_BYTES_MISMATCH');
    const corrections = correctionLineage(result, ledger, coding);
    if (!corrections) return inconclusive('CORRECTION_LINEAGE_UNVERIFIED');
    const checkpoints = await readCheckpoints(root);
    const before = await codingCheckpoint(root, checkpoints, result, coding, corrections[0]);
    if (before.status === 'inconclusive') return before;
    const steps = await Promise.all(corrections.map(async correction => ({ ...correction,
      finalizedCheckpoint: await continuationCheckpoint(root, checkpoints, result, correction) })));
    return { status: workflowComplete ? 'eligible' : 'diagnostic',
      ...(!workflowComplete ? { workflowReason: result.reason ?? null } : {}),
      preparedHead: freeze.preparedHead, sessionId: result.sessionId, corrections: steps, before,
      after: { file: path.join(root, 'freeze/candidate.patch'), sha256: freeze.patchSha256, runId: coding.finalRunId,
        evaluationId: finalReview.evaluationId, reviewStatus: finalReview.reviewStatus } };
  } catch (error) {
    return inconclusive(error.code === 'ENOENT' ? 'EVIDENCE_MISSING' : 'EVIDENCE_UNREADABLE');
  }
}
