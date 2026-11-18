import path from 'node:path';
import { sha256 } from '../runtime-v2/utils.mjs';

const schemaVersion = 'runtime-corrector.stop-review-coverage-receipt.v1';
const ownerKeys = ['projectRoot', 'sessionId', 'sessionKey', 'runId', 'taskId', 'assessmentId', 'evaluationId', 'scopeFingerprint'];
const publications = new WeakMap();
const normalizedOwner = value => {
  if (!value || ownerKeys.some(key => typeof value[key] !== 'string' || !value[key]
    || Buffer.byteLength(value[key]) > 4096) || !path.isAbsolute(value.projectRoot)
    || !Number.isSafeInteger(value.enabledRevision) || value.enabledRevision < 0) return null;
  return { ...Object.fromEntries(ownerKeys.map(key => [key, value[key]])), enabledRevision: value.enabledRevision };
};
const coveragePresent = value => value && typeof value === 'object' && Array.isArray(value.items);
const boundDigest = ({ owner, reviewStatus, coverageSha256 }) => sha256({ schemaVersion, owner, reviewStatus, coverageSha256 });

/** This callback belongs only to withTaskDecision's fresh post-publication
 * observer. The token stays in host memory; a JSON copy cannot reproduce it. */
export function createStopReviewCoveragePublicationObserver(identity) {
  const captured = { ...identity }, token = Object.freeze({});
  return { token, onPublished({ projectRoot, taskId, assessmentId, result }) {
    if (projectRoot !== captured.projectRoot || taskId !== captured.taskId || assessmentId !== captured.assessmentId) return;
    const outcome = result?.stop ?? result, coverage = outcome?.review?.reviewCoverage;
    if ((result?.taskId !== undefined && result.taskId !== taskId)
      || (outcome?.taskId !== undefined && outcome.taskId !== taskId)) return;
    const owner = normalizedOwner({ ...captured, evaluationId: outcome?.evaluationId });
    if (!owner || !coveragePresent(coverage) || outcome?.reused === true || outcome?.savedReviewCollection) return;
    publications.set(token, { owner, coverage, reviewStatus: outcome.status, coverageSha256: sha256(coverage) });
  } };
}

/** Capture only the digest of a current in-memory assessment. Store this in the
 * host's committed summary, outside the actor workspace. A digest read back
 * from an actor-editable mirror has no authority, and matching is not PASS. */
export function createStopReviewCoverageReceipt({ owner: identity, reviewStatus, outcome, publication }) {
  const owner = normalizedOwner(identity);
  if (!owner) return { schemaVersion, status: 'UNAVAILABLE', reason: 'INVALID_OWNER' };
  const unavailable = reason => ({ schemaVersion, status: 'UNAVAILABLE', owner, reason });
  if (outcome?.savedReviewCollection) return unavailable('EXPIRED_OR_STALE_PUBLICATION');
  if (outcome?.reused === true) return unavailable('REUSED_ASSESSMENT_NOT_BOUND');
  if (typeof reviewStatus !== 'string' || !reviewStatus || reviewStatus !== outcome?.status)
    return unavailable('ASSESSMENT_STATUS_MISMATCH');
  const coverage = outcome?.review?.reviewCoverage;
  if (!coveragePresent(coverage)) return unavailable('REVIEW_COVERAGE_MISSING');
  const fresh = publication && publications.get(publication);
  if (!fresh || sha256(fresh.owner) !== sha256(owner) || fresh.reviewStatus !== reviewStatus || fresh.coverage !== coverage)
    return unavailable('FRESH_PUBLICATION_NOT_OBSERVED');
  if (sha256(coverage) !== fresh.coverageSha256) return unavailable('PUBLICATION_CONTENT_CHANGED');
  const receipt = { schemaVersion, status: 'RECORDED', owner, reviewStatus, coverageSha256: fresh.coverageSha256 };
  return { ...receipt, bindingSha256: boundDigest(receipt) };
}

/** Retain the actual native commit carrier at the host scheduler boundary.
 * This small allowlist excludes feedback, source bodies and private reasoning. */
export function stopReviewCoverageCarrier(record) {
  if (!record?.reviewSummary?.reviewCoverageReceipt) return null;
  const keys = ['status', 'sessionId', 'sessionKey', 'runId', 'occurrenceId', 'enabledRevision', 'reviewStatus',
    'evaluationId', 'assessmentCompletedAt', 'reused', 'reasonCode'];
  return { ...Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]])),
    reviewSummary: structuredClone({ evaluationId: record.reviewSummary.evaluationId, assessmentId: record.reviewSummary.assessmentId, status: record.reviewSummary.status,
      reviewCoverageReceipt: record.reviewSummary.reviewCoverageReceipt }) };
}

/** The caller must obtain record and owner from the trusted host boundary.
 * This verifies a retained coverage body, not source semantics or execution. */
export function verifyStopReviewCoverageReceipt({ record, owner: identity, reviewStatus, coverage }) {
  if (record?.reviewCoverageCarrier) {
    const owner = normalizedOwner(identity), outer = record;
    if (!owner || !['IDLE', 'CLOSED'].includes(outer.phase) || outer.projectRoot !== owner.projectRoot
      || outer.sessionId !== owner.sessionId || outer.sessionKey !== owner.sessionKey || outer.runId !== owner.runId
      || outer.scopeTaskId !== owner.taskId || outer.scopeFingerprint !== owner.scopeFingerprint
      || (outer.controlRevision ?? 0) !== owner.enabledRevision) return { status: 'MISMATCH', reason: 'HOST_RECORD_OWNER_MISMATCH' };
    if (outer.reviewStatus !== reviewStatus) return { status: 'MISMATCH', reason: 'HOST_RECORD_STATUS_MISMATCH' };
    record = outer.reviewCoverageCarrier;
    if (outer.reviewSummary?.evaluationId !== owner.evaluationId || outer.reviewSummary.assessmentId !== owner.assessmentId || outer.reviewSummary.status !== reviewStatus
      || !outer.reviewSummary.reviewCoverageReceipt || !record.reviewSummary?.reviewCoverageReceipt
      || sha256(outer.reviewSummary.reviewCoverageReceipt) !== sha256(record.reviewSummary.reviewCoverageReceipt))
      return { status: 'MISMATCH', reason: 'HOST_RECORD_SUMMARY_MISMATCH' };
  }
  if (record?.status !== 'SETTLED' || record.reused === true || record.reasonCode === 'REVIEW_OWNER_LOST'
    || !Number.isFinite(record.assessmentCompletedAt)) return { status: 'UNAVAILABLE', reason: 'NO_FRESH_COMMITTED_CARRIER' };
  const receipt = record.reviewSummary?.reviewCoverageReceipt;
  if (receipt?.schemaVersion !== schemaVersion || receipt.status !== 'RECORDED')
    return { status: 'UNAVAILABLE', reason: 'NO_COMMITTED_COVERAGE_DIGEST' };
  const owner = normalizedOwner(identity);
  const retainedOwner = normalizedOwner(receipt.owner);
  if (!owner || !retainedOwner || sha256(owner) !== sha256(retainedOwner)) return { status: 'MISMATCH', reason: 'OWNER_MISMATCH' };
  if (record.sessionId !== owner.sessionId || record.sessionKey !== owner.sessionKey || record.runId !== owner.runId
    || (record.enabledRevision ?? 0) !== owner.enabledRevision || record.evaluationId !== owner.evaluationId
    || record.reviewSummary.evaluationId !== owner.evaluationId || record.reviewSummary.assessmentId !== owner.assessmentId)
    return { status: 'MISMATCH', reason: 'CARRIER_OWNER_MISMATCH' };
  if (record.reviewStatus !== reviewStatus || record.reviewSummary.status !== reviewStatus)
    return { status: 'MISMATCH', reason: 'CARRIER_STATUS_MISMATCH' };
  if (reviewStatus !== receipt.reviewStatus) return { status: 'MISMATCH', reason: 'ASSESSMENT_STATUS_MISMATCH' };
  if (receipt.bindingSha256 !== boundDigest(receipt)) return { status: 'MISMATCH', reason: 'RECEIPT_BINDING_MISMATCH' };
  if (!coveragePresent(coverage)) return { status: 'UNAVAILABLE', reason: 'REVIEW_COVERAGE_MISSING' };
  if (sha256(coverage) !== receipt.coverageSha256) return { status: 'MISMATCH', reason: 'COVERAGE_CONTENT_MISMATCH' };
  return { status: 'MATCHED', reviewStatus: receipt.reviewStatus, coverageSha256: receipt.coverageSha256 };
}
