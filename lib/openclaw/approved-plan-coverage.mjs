import { createOriginalSourceAnchor } from '../runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';

// Entries come from published native document reviews, including failures. The
// workspace copy is an audit artifact and supplies no approval authority.
const coverageBySession = new WeakMap();

const hash = /^[a-f0-9]{64}$/u;
const isExactText = (value, max) => typeof value === 'string' && value.length <= max
  && Boolean(value.trim()) && !value.includes('\0') && Buffer.from(value).toString('utf8') === value;
const isRef = value => isExactText(value, 512) && value === value.trim() && !/\p{Cc}/u.test(value);
const hasFields = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' });
const badInventory = () => Object.assign(new Error('Invalid required Proposal atom inventory.'), { code: 'INVALID_REQUEST' });

function indexProposalSources(sources) {
  if (!Array.isArray(sources) || !sources.length) return null;
  const ordered = new Map();
  for (const source of sources) {
    const { ref, text } = source ?? {};
    if (!isRef(ref) || ordered.has(ref) || typeof text !== 'string' || !text.trim() || text.includes('\0')) return null;
    const bytes = Buffer.from(text);
    if (bytes.toString('utf8') !== text) return null;
    ordered.set(ref, { bytes, sha256: sha256(bytes) });
  }
  return ordered;
}

const sourceBasis = indexed => sha256([...indexed].map(([ref, source]) => [ref, source.sha256]));

export function proposalSourceBasis(sources) {
  const indexed = indexProposalSources(sources);
  return indexed ? sourceBasis(indexed) : null;
}

const atomId = (anchorId, requirement) => sha256([anchorId, requirement]);

function validAtomRequest(atom) {
  if (!hasFields(atom, ['source', 'requirement']) || !isExactText(atom.requirement, 600)
    || !hasFields(atom.source, ['ref', 'sha256', 'start', 'end'])) return false;
  const { ref, sha256: digest, start, end } = atom.source;
  return isRef(ref) && typeof digest === 'string' && hash.test(digest)
    && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start;
}

export function sealRequiredProposalCoverage(requiredAtoms, sources, coverage, options) {
  if (!Array.isArray(requiredAtoms) || !requiredAtoms.length || requiredAtoms.length > 48
    || !requiredAtoms.every(validAtomRequest)) throw badInventory();
  const indexed = indexProposalSources(sources);
  if (!indexed) throw conflict('Native original Proposal sources are unavailable.');
  const atoms = new Map();
  for (const atom of requiredAtoms) {
    const { ref, sha256: digest, start, end } = atom.source;
    const message = indexed.get(ref);
    if (message?.sha256 !== digest) throw conflict('A required Proposal atom has a stale or foreign source.');
    let source;
    try { source = createOriginalSourceAnchor({ ref, sha256: digest, bytes: message.bytes, start, end }); }
    catch { throw conflict('A required Proposal atom source range could not be verified.'); }
    const requirement = atom.requirement.trim(), id = atomId(source.anchorId, requirement);
    if (atoms.has(id)) throw badInventory();
    atoms.set(id, { id, source, requirement });
  }

  const ordered = [...atoms.values()].sort((left, right) => left.id < right.id ? -1 : 1);
  assertRequiredProposalCoverage(ordered, coverage, options);
  return { inventorySha256: sha256(ordered), sourceBasisSha256: sourceBasis(indexed), requiredAtoms: ordered };
}

export function assertRequiredProposalCoverage(requiredAtoms, coverage, { requirePlanReadiness = false, checklistInventory } = {}) {
  if (coverage?.reviewStatus === 'BLOCKED')
    throw conflict('A current Proposal plan review has blocking errors. Complete a clean full-plan re-review before approval.');
  const passed = coverage?.reviewStatus === 'PASSED';
  const diagnoseReadiness = requirePlanReadiness && coverage?.reviewStatus === 'UNVERIFIED'
    && coverage.readinessOnlyUnverified === true;
  if (!passed && !diagnoseReadiness)
    throw conflict('The current full-plan Proposal review is unavailable or incomplete. Approval remains unverified.');
  const atoms = new Map(requiredAtoms.map(atom => [atom.id, atom]));
  const covered = new Set();
  const rows = Array.isArray(coverage?.rows) ? coverage.rows : [];
  for (const row of rows) {
    if (typeof row?.source?.anchorId !== 'string' || typeof row.requirement !== 'string') continue;
    const id = atomId(row.source.anchorId, row.requirement.trim()), atom = atoms.get(id);
    if (!atom) continue;
    if (covered.has(id) || row.disposition !== 'COVERED' || !Array.isArray(row.targets) || !row.targets.length
      || !Object.entries(atom.source).every(([key, value]) => row.source[key] === value))
      throw conflict('A required Proposal atom lacks unambiguous current coverage.');
    covered.add(id);
  }
  if (covered.size !== atoms.size) throw conflict(`Required Proposal coverage is incomplete (${covered.size}/${atoms.size}).`);
  if (requirePlanReadiness) {
    const readiness = coverage.planReadiness, tasks = checklistInventory?.tasks;
    if (!Array.isArray(tasks) || !tasks.length || !hash.test(checklistInventory.sha256)
      || readiness?.status !== 'READY' || readiness.inventorySha256 !== checklistInventory.sha256
      || !Array.isArray(readiness.tasks) || sha256(readiness.tasks) !== sha256(tasks) || !Array.isArray(readiness.rows)
      || readiness.rows.length !== tasks.length || new Set(readiness.rows.map(row => row.taskId)).size !== tasks.length
      || !tasks.every(task => readiness.rows.some(row => row.taskId === task.id && row.status === 'READY')))
      throw conflict('The exact complete Proposal task inventory is not READY. Resolve blocked or unverified prerequisites and re-review.');
  }
  // The diagnostic exception above never authorizes a pending publication,
  // even if its readiness body is later changed to READY by a caller.
  if (!passed)
    throw conflict('The current full-plan Proposal review is unavailable or incomplete. Approval remains unverified.');
}

function reviewStatus(result) {
  if (result?.metadata?.semanticReview?.status !== 'completed') return 'UNVERIFIED';
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const unavailable = diagnostic => ['AGENT-SEMANTIC-REVIEW-FAILED', 'RUNTIME-PATCH-VALIDATION-FAILED'].includes(diagnostic.ruleId)
    || diagnostic.ruleId?.startsWith('GROUND-TRUTH-') || diagnostic.ruleId?.startsWith('EXTERNAL-');
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error' && !unavailable(diagnostic))) return 'BLOCKED';
  if (!['passed', 'warning'].includes(result.status) || !Array.isArray(result.diagnostics)
    || diagnostics.some(diagnostic => ['error', 'pending'].includes(diagnostic.severity))
    || ['CHECKER_FAILURE', 'GROUND_TRUTH_UNRESOLVED', 'EXTERNAL_UNAVAILABLE', 'UNVERIFIED'].includes(result.classification))
    return 'UNVERIFIED';
  return 'PASSED';
}

function scopeIndex(files) {
  if (!Array.isArray(files) || !files.length || files.length > 259) return null;
  const scope = new Map();
  for (const file of files) {
    if (!isExactText(file?.path, 4096) || typeof file.sha256 !== 'string'
      || !hash.test(file.sha256) || scope.has(file.path)) return null;
    scope.set(file.path, file.sha256);
  }
  return scope;
}

const sameScope = (left, right) => left && right && left.size === right.size
  && [...left].every(([file, digest]) => right.get(file) === digest);

function onlyReadinessUnverified(result, readiness) {
  return result?.status === 'pending' && result.classification === 'UNVERIFIED'
    && result.metadata?.semanticReview?.status === 'completed'
    && Array.isArray(result.diagnostics) && result.diagnostics.length === 1
    && result.diagnostics[0].ruleId === 'PLAN_READINESS_UNVERIFIED' && result.diagnostics[0].severity === 'pending'
    && readiness?.schemaVersion === 1 && ['BLOCKED', 'UNVERIFIED'].includes(readiness.status)
    && hash.test(readiness.inventorySha256) && Array.isArray(readiness.tasks) && readiness.tasks.length > 0
    && new Set(readiness.tasks.map(task => task?.id)).size === readiness.tasks.length
    && Array.isArray(readiness.rows) && readiness.rows.length === readiness.tasks.length
    && new Set(readiness.rows.map(row => row?.taskId)).size === readiness.tasks.length
    && readiness.tasks.every(task => hash.test(task?.id) && readiness.rows.some(row => row?.taskId === task.id
      && ['READY', 'BLOCKED', 'UNVERIFIED'].includes(row.status)))
    && readiness.status === (readiness.rows.some(row => row.status === 'BLOCKED') ? 'BLOCKED'
      : readiness.rows.some(row => row.status === 'UNVERIFIED') ? 'UNVERIFIED' : 'READY');
}

// The publication envelope is supplied by the host after finalization. A model's
// coverage rows cannot attest that the overall review passed, or erase failures.
export function recordProposalCoverage(state, file, receipt, publication) {
  let current = coverageBySession.get(state);
  if (current?.runId !== state.nativeRunId) {
    current = { runId: state.nativeRunId, reviews: [] };
    coverageBySession.set(state, current);
  }
  if (!publication || publication.runId !== current.runId || publication.taskId !== state.scopeTaskId
    || publication.sessionId !== state.sessionId) return;
  const scope = scopeIndex(publication.result?.metadata?.inputs);
  if (!scope) return;
  const boundReceipt = receipt?.runId === current.runId && receipt.taskId === state.scopeTaskId
    && receipt.sessionId === state.sessionId && sameScope(scopeIndex(receipt.scope), scope);
  const rows = boundReceipt && Array.isArray(receipt.rows) && receipt.rows.length
    && receipt.rows.every(row => Array.isArray(row?.targets)
      && row.targets.every(target => scope.get(target?.path) === target?.sha256)) ? receipt.rows : null;
  const status = reviewStatus(publication.result);
  const readiness = publication.result?.metadata?.semanticReview?.planReadiness;
  const boundReadiness = readiness?.runId === current.runId && readiness.taskId === state.scopeTaskId
    && readiness.sessionId === state.sessionId && sameScope(scopeIndex(readiness.scope), scope);
  // Keep chronology: another partial check of the same trigger cannot erase a
  // known blocker. Eviction drops older positive authority before newer errors.
  current.reviews.push({ scope: [...scope].map(([path, sha256]) => ({ path, sha256 })),
    taskId: publication.taskId, sessionId: publication.sessionId,
    reviewStatus: status === 'PASSED' && !rows ? 'UNVERIFIED' : status, rows: rows ? structuredClone(rows) : [],
    ...(status === 'UNVERIFIED' && rows && boundReadiness && onlyReadinessUnverified(publication.result, readiness)
      ? { readinessOnlyUnverified: true } : {}),
    ...(boundReadiness ? { planReadiness: structuredClone(readiness) } : {}) });
  if (current.reviews.length > 16) current.reviews.shift();
}

export function selectApprovedPlanCoverage(state, runId, snapshot) {
  const current = coverageBySession.get(state);
  if (current?.runId !== runId) return null;
  const documents = scopeIndex(snapshot.documents);
  for (const receipt of [...current.reviews].reverse()) {
    const scope = scopeIndex(receipt.scope);
    // A concrete current subset error holds approval; partial uncertainty does
    // not. A newer complete review supersedes earlier outcomes in either case.
    const currentSubsetBlocker = receipt.reviewStatus === 'BLOCKED' && scope && documents
      && [...scope].every(([file, digest]) => documents.get(file) === digest);
    if (!currentSubsetBlocker && !sameScope(scope, documents)) continue;
    return { changeName: snapshot.changeName, proposalRunId: runId, approvedRevision: snapshot.revision,
      taskId: receipt.taskId, sessionId: receipt.sessionId, reviewStatus: receipt.reviewStatus, rows: structuredClone(receipt.rows),
      ...(receipt.readinessOnlyUnverified === true ? { readinessOnlyUnverified: true } : {}),
      ...(receipt.planReadiness ? { planReadiness: structuredClone(receipt.planReadiness) } : {}) };
  }
  return null;
}

export function currentApprovedPlanCoverage(coverage, verdict) {
  if (coverage?.reviewStatus !== 'PASSED' || verdict?.status !== 'PRESERVED' || verdict.changeName !== coverage.changeName
    || verdict.proposalRunId !== coverage.proposalRunId || verdict.approvedRevision !== coverage.approvedRevision) return null;
  const checklist = `openspec/changes/${verdict.changeName}/tasks.md`;
  const rows = verdict.currentRevision === coverage.approvedRevision ? coverage.rows
    : coverage.rows.filter(row => row.targets.length && row.targets.every(target => target.path !== checklist));
  return rows.length ? { ...coverage, applyRunId: verdict.applyRunId, rows } : null;
}
