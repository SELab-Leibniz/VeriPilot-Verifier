import { sha256 } from './utils.mjs';

export const KNOWN_ORIGINAL_BINDING_VERSION = 'known-original-object-feedback-v5';
export const ORIGINAL_DUTY_ACCOUNTING_VERSION = 'pre-freeze-duty-accounting-v2';
export const knownOriginalOwner = state => ({ projectRoot: state.projectRoot, sessionId: state.sessionId,
  sessionKey: state.sessionKey, taskId: state.scopeTaskId,
  scopeFingerprint: state.projectScope?.fingerprint ?? state.scopeFingerprint,
  enabledRevision: state.enabledRevision ?? 0 });
export const knownOriginalId = (anchor, requirement) => `known-original-${sha256([anchor.anchorId, requirement])}`;
export const knownOriginalItems = rows => rows.map(row => ({ id: knownOriginalId(row.source, row.requirement.trim()),
  source: structuredClone(row.source), requirement: row.requirement.trim() }));
export const projectKnownOriginalCohort = ({ owner, sourceRunId, changeName, planRevision, items }) => ({
  schemaVersion: 2, bindingProtocol: KNOWN_ORIGINAL_BINDING_VERSION, owner: structuredClone(owner), sourceRunId,
  changeName, planRevision, provenance: 'HOST_DOCUMENT_OBSERVATIONS', exhaustive: false, items: structuredClone(items),
});
export function knownOriginalCapacity(cohort) {
  const bytes = Buffer.byteLength(JSON.stringify(cohort));
  const count = cohort.items.length;
  const requirementLimit = cohort.items.some(item => item.requirement.length > 600);
  return { withinLimits: count <= 48 && bytes <= 65536 && !requirementLimit,
    count, bytes, maximumCount: 48, maximumBytes: 65536, maximumRequirementCharacters: 600,
    ...(requirementLimit ? { requirementLimitExceeded: true } : {}) };
}
