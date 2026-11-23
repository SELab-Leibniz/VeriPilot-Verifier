import path from 'node:path';
import { CONDITION_ASSESSMENT_SCHEMA } from '../review-task/task-evidence.mjs';
import { readOpenSpecPlan } from '../openspec-plan.mjs';
import { createOriginalSourceAnchor } from './original-source-anchor.mjs';
import { sha256 } from './utils.mjs';
import { hostOriginalCoverageDiagnosticOnly } from './original-duty-publication.mjs';
import { KNOWN_ORIGINAL_BINDING_VERSION, ORIGINAL_DUTY_ACCOUNTING_VERSION, knownOriginalOwner as owner,
  knownOriginalId, projectKnownOriginalCohort, knownOriginalCapacity } from './known-original-capacity.mjs';
export { KNOWN_ORIGINAL_BINDING_VERSION, knownOriginalId } from './known-original-capacity.mjs';

// Host-owned observations, separate from approved plans and exhaustive inventories.
// The first complete cohort is immutable. Draft paraphrases never accumulate.
const cohorts = new WeakMap();
// Capacity uncertainty never occupies the immutable cohort. Every validated
// canonical observation remains protected; count overflow is sticky for this owner.
const pendingCapacity = new WeakMap();
const same = (a, b) => sha256(a) === sha256(b);
const anchorFrom = (source, text) => {
  const bytes = Buffer.from(text), line = offset => bytes.subarray(0, offset).reduce((n, byte) => n + Number(byte === 10), 1);
  if (!Number.isSafeInteger(source.byteStart) || !Number.isSafeInteger(source.byteEnd)
    || source.byteStart < 0 || source.byteEnd < source.byteStart || source.byteEnd > bytes.length) throw new Error('Invalid anchor bounds');
  return createOriginalSourceAnchor({ ...source, bytes, start: line(source.byteStart), end: line(source.byteEnd) });
};
export const forgetKnownOriginalObligations = state => { pendingCapacity.delete(state); return cohorts.delete(state); };
export function knownOriginalObligationReader(state) {
  const identity = owner(state), runId = state.nativeRunId, controller = state.reviewController;
  const id = knownOriginalObligations(state)?.id ?? null;
  return () => {
    const current = knownOriginalObligations(state);
    if (!same(identity, owner(state)) || state.nativeRunId !== runId || state.reviewController !== controller
      || controller?.signal.aborted || state.scopeClosed || state.nativeInvalidated || (current?.id ?? null) !== id)
      throw Object.assign(new Error('Known original observation owner or cohort changed.'), { code: 'STOP_TASK_INPUT_CHANGED' });
    return current;
  };
}
export function knownOriginalObligations(state) {
  const frozen = cohorts.get(state), pending = pendingCapacity.get(state);
  const cohort = frozen && same(frozen.owner, owner(state)) ? frozen : pending;
  return cohort && !state.scopeClosed && !state.nativeInvalidated && !state.reviewController?.signal.aborted
    && same(cohort.owner, owner(state)) ? structuredClone(cohort) : null;
}

export async function observeKnownOriginalObligations(state, { file, receipt, publication, sources }) {
  if (hostOriginalCoverageDiagnosticOnly(receipt)) return false;
  const identity = owner(state), existing = cohorts.get(state), controller = state.reviewController;
  if (existing && same(existing.owner, identity)) return false;
  const staged = receipt?.originalDutyAccounting?.version === ORIGINAL_DUTY_ACCOUNTING_VERSION
    && receipt.originalDutyAccounting.stagedCount > 0;
  const capacityFailure = staged && receipt.originalDutyAccounting.status === 'UNVERIFIED_CAPACITY';
  if (state.nativeProposalCoveragePolicy?.required === true || state.nativeProposalCoveragePolicy?.requirePlanReadiness === true
    || !identity.taskId || !identity.sessionId || !identity.sessionKey || !identity.scopeFingerprint
    || state.scopeClosed || state.nativeInvalidated || state.reviewController?.signal.aborted
    || publication?.runId !== state.nativeRunId || publication.taskId !== identity.taskId
    || publication.sessionId !== identity.sessionId || !(['completed', ...(capacityFailure ? ['failed'] : [])]
      .includes(publication.result?.metadata?.semanticReview?.status))
    || receipt?.runId !== publication.runId || receipt.taskId !== identity.taskId || receipt.sessionId !== identity.sessionId
    || !Array.isArray(receipt.rows) || !receipt.rows.length) return false;
  const trigger = publication.result.metadata.triggerFile ?? (path.isAbsolute(file) ? path.relative(identity.projectRoot, file).split(path.sep).join('/') : file);
  const changeName = /^openspec\/changes\/([^/]+)\/(?:proposal\.md|design\.md|tasks\.md|specs\/.+\/spec\.md)$/u.exec(trigger)?.[1];
  if (!changeName) return false;
  const snapshot = await readOpenSpecPlan(identity.projectRoot, changeName).catch(() => null);
  const inputs = publication.result.metadata.inputs;
  const scope = value => Array.isArray(value) && value.length && new Set(value.map(f => f.path)).size === value.length
    ? value.map(({ path, sha256 }) => [path, sha256]).sort(([a], [b]) => a.localeCompare(b)) : null;
  const expected = scope(snapshot?.documents);
  if (!expected || !same(expected, scope(inputs)) || !same(expected, scope(receipt.scope))) return false;
  const originals = new Map((sources ?? []).map(source => [source.ref, source]));
  const items = [], used = new Set();
  let unsupported = receipt.rows.length > 48;
  for (const row of receipt.rows) {
    const source = originals.get(row.source?.ref), requirement = typeof row.requirement === 'string' ? row.requirement.trim() : null;
    if (!source || !requirement || requirement.includes('\0') || !['COVERED', 'GAP', 'UNVERIFIED'].includes(row.disposition)
      || !Array.isArray(row.targets) || row.targets.some(target => !expected.some(([file, hash]) => file === target.path && hash === target.sha256))) return false;
    let anchor;
    try { anchor = anchorFrom(row.source, source.text); } catch { return false; }
    if (sha256(source.text) !== row.source.sha256 || !same(anchor, row.source)) return false;
    if (requirement.length > 600) unsupported = true;
    const id = knownOriginalId(anchor, requirement);
    if (used.has(id)) return false;
    used.add(id); items.push({ id, source: anchor, requirement });
  }
  const cohort = projectKnownOriginalCohort({ owner: identity, sourceRunId: publication.runId,
    changeName, planRevision: snapshot.revision, items });
  const capacity = knownOriginalCapacity(cohort);
  const retainedPending = pendingCapacity.get(state);
  if (unsupported || !capacity.withinLimits) {
    cohort.observedCandidateCount = items.length; cohort.observationsDigest = sha256(items);
    cohort.items = []; cohort.unavailableReason = 'OBSERVATION_COHORT_LIMIT';
  }
  // Revalidate after I/O; stale callbacks cannot win the first cohort.
  if (!same(identity, owner(state)) || controller !== state.reviewController || publication.runId !== state.nativeRunId
    || state.scopeClosed || state.nativeInvalidated || state.reviewController?.signal.aborted || cohorts.has(state)
      && same(cohorts.get(state).owner, identity)) return false;
  if (staged && !capacity.withinLimits) {
    // Preserve aggregate UNVERIFIED to Stop, but leave the first valid cohort
    // unclaimed. Complete rejected canonical rows remain in the host receipt.
    cohort.capacity = capacity;
    // A prior impossible union cannot become a clean cohort by omission.
    if (retainedPending && same(retainedPending.owner, identity) && retainedPending.protectionLimitExceeded) return false;
    cohort.capacityUnverified = true;
    const previousIds = retainedPending && same(retainedPending.owner, identity)
      ? retainedPending.requiredCanonicalCandidateIds : [];
    const protectedIds = [...new Set([...previousIds, ...items.map(item => item.id)])].sort();
    cohort.protectedCanonicalCountWithinLimit = protectedIds.length <= 48;
    if (protectedIds.length > 48) {
      // Represent the full impossible union by a bounded sticky summary. The
      // individually retained prior IDs are diagnostic only once this is set;
      // no later subset can freeze a cohort or erase any observed duty.
      cohort.requiredCanonicalCandidateIds = [...previousIds];
      cohort.protectionLimitExceeded = true;
      cohort.observedProtectedCandidateCount = protectedIds.length;
      cohort.protectedCandidatesDigest = sha256(protectedIds);
    } else cohort.requiredCanonicalCandidateIds = protectedIds;
    cohort.id = sha256(cohort);
    pendingCapacity.set(state, structuredClone(cohort));
    return false;
  }
  if (retainedPending && same(retainedPending.owner, identity)
    && (retainedPending.protectionLimitExceeded || !staged
      || retainedPending.requiredCanonicalCandidateIds.some(id => !items.some(item => item.id === id)))) return false;
  if (capacityFailure) return false;
  cohort.id = sha256(cohort);
  pendingCapacity.delete(state);
  cohorts.set(state, structuredClone(cohort));
  return true;
}

export const KNOWN_ORIGINAL_DISPOSITIONS = { type: 'array', maxItems: 48, items: {
  type: 'object', additionalProperties: false, required: ['id', 'disposition', 'reason'], properties: {
    id: { type: 'string' }, disposition: { enum: ['CURRENT', 'UNVERIFIED', 'NOT_BINDING', 'SUPERSEDED', 'PHASE_DEFERRED'] },
    conditionAssessment: { ...CONDITION_ASSESSMENT_SCHEMA,
      description: 'For CURRENT accounting of a canonical CONDITIONAL duty, supply its current activation, original-condition reason and evidenceKind. Missing or invalid proof remains UNVERIFIED. Unconditional duties do not need this field; saved deviations and explicit UNVERIFIED keep their existing evidence rules.' },
    verdict: { enum: ['NO_CONFIRMED_DEVIATION', 'DEVIATION', 'UNVERIFIED', 'NOT_APPLICABLE', 'NOT_YET_APPLICABLE'] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 }, objectId: { type: 'string',
      description: 'Required on every CURRENT or PHASE_DEFERRED row: the actual current checklist objectId returned by set_original_checklist or review_checklist, including knownObligations.bindings/formedAssociation. A known candidate id is a different namespace. A prior knownCandidateId association does not replace this explicit objectId. Other dispositions do not need it.' },
    citeIds: { type: 'array', maxItems: 16, items: { type: 'string' } },
    corroboration: { type: 'object', additionalProperties: false,
      description: 'Only CURRENT or PHASE_DEFERRED may use current duty corroboration, alongside an explicit current objectId. NOT_BINDING, SUPERSEDED and UNVERIFIED must omit corroboration; exclusions use their applicable original-source citeIds instead. For a retained candidate whose prior anchor or wording differs from the selected frozen item, read and cite the exact current original duty span. This is a reviewer judgment, not semantic equivalence proved by the host.',
      required: ['citeId', 'start', 'end', 'reason'], properties: {
        citeId: { type: 'string', minLength: 1 }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
      } },
  },
} };

// Individual source identities survive appended ordinary user approvals. The
// entire conversation digest intentionally is not the retention identity.
export function currentKnownOriginalSources(cohort, originalRequirements) {
  return (cohort?.items ?? []).map(item => {
    const message = originalRequirements?.userMessages?.find(source => source.ref === item.source.ref);
    let current = false;
    try { current = Boolean(message && message.sha256 === item.source.sha256 && sha256(message.text) === message.sha256
      && same(anchorFrom(item.source, message.text), item.source)); } catch { /* item remains unknown */ }
    return { ...structuredClone(item), sourceCurrent: current };
  });
}
