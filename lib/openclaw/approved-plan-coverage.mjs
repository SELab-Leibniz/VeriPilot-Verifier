import { createOriginalSourceAnchor } from '../runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';

// Entries come from successfully published native document reviews. The
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

export function sealRequiredProposalCoverage(requiredAtoms, sources, coverage) {
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
  const ordered = [...atoms.values()].sort((left, right) => left.id < right.id ? -1 : 1);
  return { inventorySha256: sha256(ordered), sourceBasisSha256: sourceBasis(indexed), requiredAtoms: ordered };
}

export function recordProposalCoverage(state, file, receipt) {
  let current = coverageBySession.get(state);
  if (current?.runId !== state.nativeRunId) {
    current = { runId: state.nativeRunId, byFile: new Map() };
    coverageBySession.set(state, current);
  }
  current.byFile.delete(file);
  if (receipt?.rows?.length && receipt.runId === current.runId && receipt.taskId === state.scopeTaskId
    && receipt.sessionId === state.sessionId) current.byFile.set(file, structuredClone(receipt));
  if (current.byFile.size > 16) current.byFile.delete(current.byFile.keys().next().value);
}

export function selectApprovedPlanCoverage(state, runId, snapshot) {
  const current = coverageBySession.get(state);
  if (current?.runId !== runId) return null;
  const documents = new Map(snapshot.documents.map(file => [file.path, file.sha256]));
  for (const receipt of [...current.byFile.values()].reverse()) {
    const scope = new Map(receipt.scope.map(file => [file.path, file.sha256]));
    if (receipt.scope.length !== documents.size || scope.size !== documents.size
      || [...scope].some(([file, digest]) => documents.get(file) !== digest)
      || !receipt.rows.every(row => row.targets.every(target => scope.get(target.path) === target.sha256))) continue;
    return { changeName: snapshot.changeName, proposalRunId: runId, approvedRevision: snapshot.revision,
      taskId: receipt.taskId, sessionId: receipt.sessionId, rows: receipt.rows };
  }
  return null;
}

export function currentApprovedPlanCoverage(coverage, verdict) {
  if (!coverage || verdict?.status !== 'PRESERVED' || verdict.changeName !== coverage.changeName
    || verdict.proposalRunId !== coverage.proposalRunId || verdict.approvedRevision !== coverage.approvedRevision) return null;
  const checklist = `openspec/changes/${verdict.changeName}/tasks.md`;
  const rows = verdict.currentRevision === coverage.approvedRevision ? coverage.rows
    : coverage.rows.filter(row => row.targets.length && row.targets.every(target => target.path !== checklist));
  return rows.length ? { ...coverage, applyRunId: verdict.applyRunId, rows } : null;
}
