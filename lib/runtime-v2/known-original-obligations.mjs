import path from 'node:path';
import { CONDITION_ASSESSMENT_SCHEMA } from '../review-task/task-evidence.mjs';
import { readOpenSpecPlan } from '../openspec-plan.mjs';
import { createOriginalSourceAnchor } from './original-source-anchor.mjs';
import { sha256 } from './utils.mjs';
import { hostOriginalCoverageCurrent, hostOriginalCoverageDiagnosticOnly } from './original-duty-publication.mjs';
import { KNOWN_ORIGINAL_BINDING_VERSION, ORIGINAL_DUTY_ACCOUNTING_VERSION, knownOriginalOwner as owner,
  knownOriginalId, projectKnownOriginalCohort, knownOriginalCapacity } from './known-original-capacity.mjs';
export { KNOWN_ORIGINAL_BINDING_VERSION, knownOriginalId } from './known-original-capacity.mjs';

// Host-owned observations, separate from approved plans and exhaustive inventories.
// The first complete cohort is immutable. Draft paraphrases never accumulate.
const cohorts = new WeakMap();
// The evaluation cohort never grows. Later finalized host observations have a
// separate monotonic snapshot so Stop need not rediscover an already known atom.
const observations = new WeakMap();
const observationWrites = new WeakMap();
const observationGenerations = new WeakMap();
// Capacity uncertainty never occupies the immutable cohort. Every validated
// canonical observation remains protected; count overflow is sticky for this owner.
const pendingCapacity = new WeakMap();
const same = (a, b) => sha256(a) === sha256(b);
const observationOwnerMatches = (value, identity) => Boolean(value && (value.owner
  ? same(value.owner, identity) : value.capacityUnverified === true && value.ownerBindingSha256 === sha256(identity)));
const anchorFrom = (source, text) => {
  const bytes = Buffer.from(text), line = offset => bytes.subarray(0, offset).reduce((n, byte) => n + Number(byte === 10), 1);
  if (!Number.isSafeInteger(source.byteStart) || !Number.isSafeInteger(source.byteEnd)
    || source.byteStart < 0 || source.byteEnd < source.byteStart || source.byteEnd > bytes.length) throw new Error('Invalid anchor bounds');
  return createOriginalSourceAnchor({ ...source, bytes, start: line(source.byteStart), end: line(source.byteEnd) });
};
export const forgetKnownOriginalObligations = state => {
  observationGenerations.set(state, (observationGenerations.get(state) ?? 0) + 1);
  pendingCapacity.delete(state); observations.delete(state); return cohorts.delete(state);
};
export function knownOriginalObservationSnapshot(state) {
  const first = knownOriginalObligations(state), live = observations.get(state);
  return first && live && live.observationLedger.initialCohortId === first.id && observationOwnerMatches(live, owner(state))
    ? structuredClone(live) : first;
}
export function knownOriginalObligationReader(state) {
  const identity = owner(state), runId = state.nativeRunId, controller = state.reviewController;
  const id = knownOriginalObservationSnapshot(state)?.id ?? null;
  return () => {
    const current = knownOriginalObservationSnapshot(state);
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
  // Concurrent finalized callbacks must not discard the publication that loses
  // the first-cohort race. Recheck its existing owner/current guards in order.
  const identity = owner(state), runId = state.nativeRunId, controller = state.reviewController;
  const generation = observationGenerations.get(state) ?? 0;
  const current = () => same(identity, owner(state)) && state.nativeRunId === runId
    && state.reviewController === controller && !controller?.signal.aborted
    && !state.scopeClosed && !state.nativeInvalidated && (observationGenerations.get(state) ?? 0) === generation;
  const previous = observationWrites.get(state) ?? Promise.resolve();
  const writing = previous.catch(() => {}).then(() => current()
    ? observeOriginalPublication(state, { file, receipt, publication, sources }, current) : false);
  observationWrites.set(state, writing);
  try { return await writing; }
  finally { if (observationWrites.get(state) === writing) observationWrites.delete(state); }
}
async function observeOriginalPublication(state, { file, receipt, publication, sources }, enqueuedCurrent) {
  if (hostOriginalCoverageDiagnosticOnly(receipt)) return false;
  const identity = owner(state), existing = cohorts.get(state), controller = state.reviewController;
  const later = existing && same(existing.owner, identity);
  const staged = receipt?.originalDutyAccounting?.version === ORIGINAL_DUTY_ACCOUNTING_VERSION
    && receipt.originalDutyAccounting.stagedCount > 0;
  const capacityFailure = staged && receipt.originalDutyAccounting.status === 'UNVERIFIED_CAPACITY';
  const laterCurrent = () => hostOriginalCoverageCurrent(receipt)
    && publication?.result?.metadata?.semanticReview?.originalRequirementCoverage === receipt
    && receipt?.originalDutyOwnerBinding?.sourceRunId === publication.runId
    && same(receipt.originalDutyOwnerBinding.owner, identity);
  // Raw stage output, JSON lookalikes and the old direct-observation seam have
  // no late-publication capability. Keep their first-cohort compatibility only.
  // A completed source-valid review can report a business gap. Its artifact
  // verdict does not revoke the original duties validated by that review.
  if (later && (!staged || !laterCurrent()
    || publication.result.metadata.bundleComplete !== true
    || !capacityFailure && receipt.originalDutyAccounting.status !== 'STAGED')) return false;
  if (later && existing.unavailableReason) return false;
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
    // The verified canonical union can include duties discovered after staging.
    // A supplied stage ID must still match; absence is not a stage claim.
    if (later && Object.hasOwn(row, 'originalDutyId') && row.originalDutyId !== id.slice('known-original-'.length)) return false;
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
  if (!enqueuedCurrent() || !same(identity, owner(state)) || controller !== state.reviewController || publication.runId !== state.nativeRunId
    || state.scopeClosed || state.nativeInvalidated || state.reviewController?.signal.aborted
    || cohorts.get(state) !== existing || later && !laterCurrent()) return false;
  if (later) {
    const previous = observations.get(state);
    if (previous?.capacityUnverified && observationOwnerMatches(previous, identity)
      && previous.observationLedger.initialCohortId === existing.id) return false;
    const retained = previous && observationOwnerMatches(previous, identity)
      && previous.observationLedger.initialCohortId === existing.id ? previous : existing;
    const merged = new Map(retained.items.map(item => [item.id, item]));
    let conflict = false;
    const added = [];
    for (const item of items) {
      if (merged.has(item.id)) { if (!same(merged.get(item.id), item)) conflict = true; }
      else { merged.set(item.id, item); added.push(item.id); }
    }
    if (!added.length && !unsupported && !capacityFailure && !conflict) return false;
    const liveSnapshot = { ...structuredClone(existing), items: [...merged.values()],
      observationLedger: { schemaVersion: 1, initialCohortId: existing.id,
        initialCandidateIds: existing.items.map(item => item.id),
        revision: (previous?.observationLedger.revision ?? 0) + 1,
        publications: [...previous?.observationLedger.publications ?? [], {
          sourceRunIdSha256: sha256(publication.runId), planRevision: snapshot.revision,
          publicationDigest: sha256({ owner: identity, runId: publication.runId, scope: receipt.scope, rows: receipt.rows }), addedCandidateIds: added }] } };
    // Include ledger provenance in the same unchanged byte/count envelope.
    delete liveSnapshot.id;
    const mergedCapacity = knownOriginalCapacity(liveSnapshot);
    if (unsupported || capacityFailure || conflict || !mergedCapacity.withinLimits) {
      liveSnapshot.observedCandidateCount = merged.size;
      liveSnapshot.observationsDigest = sha256([...merged.values()]);
      liveSnapshot.items = []; liveSnapshot.capacityUnverified = true; liveSnapshot.capacity = mergedCapacity;
      liveSnapshot.unavailableReason = conflict ? 'OBSERVATION_LEDGER_CONFLICT' : 'OBSERVATION_LEDGER_LIMIT';
      // The complete initial cohort and committed publication remain intact;
      // the fail-closed Stop summary must not duplicate an oversized run token.
      liveSnapshot.ownerBindingSha256 = sha256(identity);
      liveSnapshot.taskBindingSha256 = sha256([identity.projectRoot, identity.taskId, identity.sessionId]);
      delete liveSnapshot.owner; delete liveSnapshot.sourceRunId; delete liveSnapshot.changeName; delete liveSnapshot.planRevision;
      // Long owner strings can already occupy nearly the whole first-cohort
      // envelope. The live reader checks their complete binding in host memory;
      // this aggregate-U projection must stay bounded even in that case.
      if (Buffer.byteLength(JSON.stringify(liveSnapshot)) + 80 > 65536) {
        const detail = liveSnapshot.observationLedger;
        liveSnapshot.observationLedger = { schemaVersion: 1, initialCohortId: existing.id,
          initialCandidateCount: existing.items.length, initialCandidatesDigest: sha256(existing.items),
          revision: detail.revision, publicationsDigest: sha256(detail.publications) };
      }
    }
    liveSnapshot.id = sha256(liveSnapshot);
    if (liveSnapshot.capacityUnverified && Buffer.byteLength(JSON.stringify(liveSnapshot)) > 65536)
      throw Object.assign(new Error('Known original observation uncertainty exceeds its bounded representation.'), { code: 'STOP_TASK_INPUT_CHANGED' });
    observations.set(state, structuredClone(liveSnapshot));
    return !liveSnapshot.capacityUnverified;
  }
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
  observations.delete(state);
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
