import path from 'node:path';
import { sha256 } from './utils.mjs';
import { ORIGINAL_DUTY_ACCOUNTING_VERSION } from './known-original-capacity.mjs';

// Provenance lives only in this module. JSON fields, Symbols and error
// properties are diagnostics, never a substitute for these issued objects.
const coverageRecords = new WeakMap(), capacityErrors = new WeakMap(), reviews = new WeakMap();
const ownerKeys = ['projectRoot', 'sessionId', 'sessionKey', 'taskId', 'scopeFingerprint', 'enabledRevision'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
function digest(value) { try { return sha256(value); } catch { return null; } }
const same = (left, right) => { const value = digest([left]); return value !== null && value === digest([right]); };
function snapshot(value) {
  try {
    const copy = structuredClone(value), hash = digest(copy);
    return hash !== null && hash === digest(value) ? { copy, hash } : null;
  } catch { return null; }
}
const coverageShape = value => object(value) && value.schemaVersion === 1
  && Array.isArray(value.scope) && Array.isArray(value.rows);
function currentGuard(guard) {
  if (guard === null) return true;
  try { return guard() === true; } catch { return false; }
}
function coverageRecord(receipt) {
  if (!coverageShape(receipt)) return null;
  const record = coverageRecords.get(receipt);
  return record && digest(receipt) === record.hash ? record : null;
}
function issueCoverage(receipt, guard = null, mode = 'HOST_VERIFIED') {
  if (!coverageShape(receipt)) return null;
  const captured = snapshot(receipt);
  if (!captured) return null;
  coverageRecords.set(receipt, { hash: captured.hash, guard, mode });
  return receipt;
}

/** Issue only after host document verification; never call on model fields. */
export function retainHostOriginalCoverage(receipt) {
  if (!coverageShape(receipt)) return null;
  if (coverageRecords.has(receipt)) {
    const record = coverageRecord(receipt);
    return record && record.mode !== 'DIAGNOSTIC_ONLY' ? receipt : null;
  }
  return issueCoverage(receipt);
}

/** True only for an unchanged issued object whose private synchronous guard returns true. */
export function hostOriginalCoverageCurrent(receipt) {
  const record = coverageRecord(receipt);
  return Boolean(record && currentGuard(record.guard));
}

/** Cloning is intentional provenance transfer, including the private current guard. */
export function cloneHostOriginalCoverage(receipt) {
  const record = coverageRecord(receipt);
  if (!record || !currentGuard(record.guard)) return null;
  const captured = snapshot(receipt);
  return captured ? issueCoverage(captured.copy, record.guard, record.mode) : null;
}

// Ordinary coverage is checked host evidence, separate from duty publication.
// Its private mode survives host cloning and can never be rebound as authority.
function legacyCoverage(receipt) {
  const record = coverageRecord(receipt);
  if (!record || !currentGuard(record.guard) || record.mode === 'BOUND'
    || ['originalDutyOwnerBinding', 'runId', 'taskId', 'sessionId', 'sourceRunId', 'projectRoot',
      'sessionKey', 'scopeFingerprint', 'enabledRevision'].some(key => Object.hasOwn(receipt, key))
    || receipt.rows.some(row => !object(row) || Object.hasOwn(row, 'originalDutyId')
      || Object.hasOwn(row, 'originalDutyAccountingIssue'))
    || receipt.originalDutyAccounting != null && !methodOnly(receipt.originalDutyAccounting)) return null;
  return record;
}
export function cloneHostLegacyOriginalCoverage(receipt) {
  const record = legacyCoverage(receipt), captured = record && snapshot(receipt);
  if (!captured) return null;
  delete captured.copy.originalDutyAccounting;
  return issueCoverage(captured.copy, record.guard, 'DIAGNOSTIC_ONLY');
}
export const hostOriginalCoverageDiagnosticOnly = receipt => coverageRecords.get(receipt)?.mode === 'DIAGNOSTIC_ONLY';

function bindingFrom(context) {
  if (!object(context) || !object(context.owner) || !text(context.sourceRunId)) return null;
  const owner = Object.fromEntries(ownerKeys.map(key => [key, context.owner[key]]));
  if (!ownerKeys.slice(0, -1).every(key => text(owner[key])) || !path.isAbsolute(owner.projectRoot)
    || !Number.isSafeInteger(owner.enabledRevision) || owner.enabledRevision < 0) return null;
  return { owner, sourceRunId: context.sourceRunId };
}
/** Validate explicitly supplied host data; missing context selects legacy diagnostics. */
export function validateHostOriginalDutyContext(context) {
  if (context === null || context === undefined) return null;
  const binding = bindingFrom(context);
  if (!binding) throw Object.assign(new Error('DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID'),
    { code: 'DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID' });
  return structuredClone(binding);
}
/** Incomplete ordinary host lifecycle has no duty-publication capability. */
export function originalDutyContextFromCapture(captured) {
  if (!captured?.controller?.signal || captured.controller.signal.aborted) return null;
  const binding = bindingFrom(captured);
  return binding ? structuredClone(binding) : null;
}
function bindingMatchesReceipt(receipt, binding) {
  if (!binding) return false;
  const flat = { ...binding.owner, sourceRunId: binding.sourceRunId, runId: binding.sourceRunId };
  if (Object.entries(flat).some(([key, value]) => Object.hasOwn(receipt, key) && receipt[key] !== value)) return false;
  return !Object.hasOwn(receipt, 'originalDutyOwnerBinding') || same(receipt.originalDutyOwnerBinding, binding);
}
function boundCoverage(receipt) {
  if (!hostOriginalCoverageCurrent(receipt)) return false;
  const binding = bindingFrom(receipt.originalDutyOwnerBinding);
  return Boolean(coverageRecord(receipt)?.mode === 'BOUND' && binding && bindingMatchesReceipt(receipt, binding)
    && receipt.runId === binding.sourceRunId && receipt.taskId === binding.owner.taskId
    && receipt.sessionId === binding.owner.sessionId);
}

/** The caller supplies captured host context, never model-selected owner fields.
 *  isCurrent is private, synchronous, and must explicitly return true. */
export function bindHostOriginalCoverage(receipt, cohortContext, isCurrent = null) {
  const record = coverageRecord(receipt), binding = bindingFrom(cohortContext);
  if (!record || record.mode === 'DIAGNOSTIC_ONLY' || !currentGuard(record.guard) || !bindingMatchesReceipt(receipt, binding)
    || isCurrent !== null && typeof isCurrent !== 'function') return null;
  const guard = record.guard && isCurrent && record.guard !== isCurrent
    ? () => currentGuard(record.guard) && currentGuard(isCurrent) : isCurrent ?? record.guard;
  if (!currentGuard(guard)) return null;
  const captured = snapshot(receipt);
  if (!captured) return null;
  Object.assign(captured.copy, { runId: binding.sourceRunId, taskId: binding.owner.taskId,
    sessionId: binding.owner.sessionId, originalDutyOwnerBinding: binding });
  return issueCoverage(captured.copy, guard, 'BOUND');
}

function capacityReceipt(receipt) {
  const accounting = receipt?.originalDutyAccounting;
  return hostOriginalCoverageCurrent(receipt) && object(accounting)
    && accounting.version === ORIGINAL_DUTY_ACCOUNTING_VERSION && accounting.status === 'UNVERIFIED_CAPACITY'
    && Number.isSafeInteger(accounting.stagedCount) && accounting.stagedCount > 0 && accounting.stagedCount <= 48
    && object(accounting.capacity) && accounting.capacity.withinLimits === false;
}
const errorIdentity = error => ({ name: error.name ?? null, message: error.message ?? null, code: error.code ?? null });

/** Mark a genuine host rejection. The enumerable property is optional diagnostics only. */
export function markHostOriginalCapacityFailure(error, receipt) {
  if (!object(error) || !capacityReceipt(receipt)) return null;
  const issued = cloneHostOriginalCoverage(receipt), identity = snapshot(errorIdentity(error));
  if (!issued || !identity) return null;
  const existing = capacityErrors.get(error);
  if (existing) return existing.hash === identity.hash && same(existing.receipt, issued) ? error : null;
  capacityErrors.set(error, { hash: identity.hash, receipt: issued });
  try { error.originalDutyCapacityFailure = structuredClone(issued); } catch { /* Diagnostics grant no authority. */ }
  return error;
}

/** Plain error.originalDutyCapacityFailure values are deliberately ignored. */
export function hostOriginalCapacityFailure(error) {
  if (!object(error)) return null;
  const record = capacityErrors.get(error);
  return record && digest(errorIdentity(error)) === record.hash && capacityReceipt(record.receipt)
    ? cloneHostOriginalCoverage(record.receipt) : null;
}

function accountingFor(receipt) {
  if (!object(receipt.originalDutyAccounting)) return null;
  return { ...structuredClone(receipt.originalDutyAccounting), runId: receipt.runId,
    taskId: receipt.taskId, sessionId: receipt.sessionId,
    originalDutyOwnerBinding: structuredClone(receipt.originalDutyOwnerBinding) };
}
const matchingSubset = (value, expected) => value === undefined || value === null || object(value)
  && Object.entries(value).every(([key, item]) => Object.hasOwn(expected, key) && same(item, expected[key]));
function methodOnly(value) {
  if (!object(value) || value.version !== ORIGINAL_DUTY_ACCOUNTING_VERSION || value.status !== 'NOT_EXERCISED'
    || value.stagedCount !== 0 || value.exhaustive !== false || value.semanticsVerified !== false
    || Object.hasOwn(value, 'planRevision') && !text(value.planRevision)) return null;
  const keys = ['version', 'status', 'planRevision', 'stagedCount', 'exhaustive', 'semanticsVerified'];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
}
function metadataProjection(metadata) {
  if (!object(metadata)) return null;
  const receipt = metadata.originalRequirementCoverage;
  if (receipt !== undefined && receipt !== null) {
    if (!boundCoverage(receipt)) {
      const diagnostic = cloneHostLegacyOriginalCoverage(receipt);
      if (!diagnostic || metadata.originalDutyAccounting != null && !methodOnly(metadata.originalDutyAccounting)) return null;
      return { originalRequirementCoverage: diagnostic, originalRequirementCoverageAuthority: 'DIAGNOSTIC_ONLY' };
    }
    const accounting = accountingFor(receipt);
    if (metadata.originalDutyAccounting && (!accounting || !matchingSubset(metadata.originalDutyAccounting, accounting))) return null;
    const issued = cloneHostOriginalCoverage(receipt);
    if (!issued) return null;
    return { originalRequirementCoverage: issued,
      ...(accounting ? { originalDutyAccounting: accounting } : {}) };
  }
  const accounting = methodOnly(metadata.originalDutyAccounting);
  return accounting ? { originalDutyAccounting: accounting } : {};
}
const reviewIdentity = review => ({ status: review.status ?? null, semanticStatus: review.semanticStatus ?? null,
  patchStatus: review.patchStatus ?? null, parentSessionId: review.parentSessionId ?? null,
  forkSessionId: review.forkSessionId ?? null,
  originalRequirementCoverage: review.originalRequirementCoverage ?? null,
  originalDutyAccounting: review.originalDutyAccounting ?? null });

/** Seal the direct production result before merge. No JSON field can recreate this mark. */
export function sealHostOriginalReview(review, metadata = {}) {
  if (!object(review)) return review;
  const projection = metadataProjection(metadata), identity = snapshot(reviewIdentity(review));
  const existing = reviews.get(review);
  if (!projection || !identity) { reviews.set(review, { invalid: true }); return review; }
  const captured = snapshot(projection);
  if (!captured) { reviews.set(review, { invalid: true }); return review; }
  if (existing) {
    if (existing.invalid || existing.reviewHash !== identity.hash || existing.metadataHash !== captured.hash)
      reviews.set(review, { invalid: true });
    return review;
  }
  // Keep the issued receipt object, not the unbranded snapshot used for hashing.
  reviews.set(review, { reviewHash: identity.hash, metadataHash: captured.hash, metadata: projection });
  return review;
}

/** Merge only this projection; never spread arbitrary review/model metadata. */
export function hostOriginalReviewMetadata(review) {
  if (!object(review)) return {};
  const record = reviews.get(review);
  if (!record) {
    // Existing direct host merge callers may supply an issued ordinary receipt.
    // No plain model receipt, duty-accounting claim or bound receipt qualifies.
    if (!['completed', review.semanticStatus === 'completed' ? 'failed' : null].includes(review.status)
      || !review.originalRequirementCoverage || review.originalDutyAccounting != null
      && !methodOnly(review.originalDutyAccounting)) return {};
    const diagnostic = cloneHostLegacyOriginalCoverage(review.originalRequirementCoverage);
    return diagnostic ? { originalRequirementCoverage: diagnostic,
      originalRequirementCoverageAuthority: 'DIAGNOSTIC_ONLY' } : {};
  }
  if (record.invalid || digest(reviewIdentity(review)) !== record.reviewHash
    || digest(record.metadata) !== record.metadataHash) return {};
  const receipt = record.metadata.originalRequirementCoverage;
  const diagnostic = record.metadata.originalRequirementCoverageAuthority === 'DIAGNOSTIC_ONLY';
  if (receipt && !diagnostic && !boundCoverage(receipt)) return {};
  const issued = receipt ? (diagnostic ? cloneHostLegacyOriginalCoverage(receipt) : cloneHostOriginalCoverage(receipt)) : null;
  if (receipt && !issued) return {};
  return { ...(issued ? { originalRequirementCoverage: issued } : {}),
    ...(diagnostic ? { originalRequirementCoverageAuthority: 'DIAGNOSTIC_ONLY' } : {}),
    ...(record.metadata.originalDutyAccounting ? { originalDutyAccounting: structuredClone(record.metadata.originalDutyAccounting) } : {}) };
}

/** Isolate sibling results while transferring only a current host-issued seal.
 * Ordinary unsealed reviews without accounting keep their existing data-only
 * behavior. A JSON lookalike or a damaged issued review cannot acquire a seal. */
export function cloneHostOriginalReview(review) {
  if (!object(review)) return structuredClone(review);
  const record = reviews.get(review);
  const invalid = () => Object.assign(new Error('DOCUMENT_ORIGINAL_DUTY_HOST_REVIEW_INVALID'),
    { code: 'DOCUMENT_ORIGINAL_DUTY_HOST_REVIEW_INVALID' });
  if (!record) {
    const metadata = hostOriginalReviewMetadata(review);
    if (!metadata.originalRequirementCoverage) {
      if (review.originalRequirementCoverage != null || review.originalDutyAccounting != null) throw invalid();
      return structuredClone(review);
    }
    const copy = structuredClone(review);
    copy.originalRequirementCoverage = metadata.originalRequirementCoverage;
    delete copy.originalDutyAccounting;
    return sealHostOriginalReview(copy, metadata);
  }
  if (record.invalid || digest(reviewIdentity(review)) !== record.reviewHash
    || digest(record.metadata) !== record.metadataHash) throw invalid();
  const original = record.metadata.originalRequirementCoverage;
  if (original && record.metadata.originalRequirementCoverageAuthority !== 'DIAGNOSTIC_ONLY' && !boundCoverage(original)) throw invalid();
  const metadata = hostOriginalReviewMetadata(review);
  if (original && !metadata.originalRequirementCoverage) throw invalid();
  const copy = structuredClone(review);
  if (metadata.originalRequirementCoverage) {
    copy.originalRequirementCoverage = cloneHostOriginalCoverage(metadata.originalRequirementCoverage);
    if (!copy.originalRequirementCoverage) throw invalid();
  }
  return sealHostOriginalReview(copy, metadata);
}
