import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJson, sha256 } from './runtime-v2/utils.mjs';
import { boundedLinePage } from './line-page.mjs';
import { hasLinkedPath, isSameFile } from './path-utils.mjs';
import { createOriginalSourceAnchor } from './runtime-v2/original-source-anchor.mjs';
import { ORIGINAL_DUTY_ACCOUNTING_VERSION, knownOriginalId, knownOriginalItems, projectKnownOriginalCohort,
  knownOriginalCapacity } from './runtime-v2/known-original-capacity.mjs';
import { retainHostOriginalCoverage, cloneHostOriginalCoverage,
  cloneHostLegacyOriginalCoverage, validateHostOriginalDutyContext,
  markHostOriginalCapacityFailure } from './runtime-v2/original-duty-publication.mjs';
export { ORIGINAL_DUTY_ACCOUNTING_VERSION } from './runtime-v2/known-original-capacity.mjs';
import { covers } from './review-task/evidence-utils.mjs';
import { isOpenSpecChangeName, openSpecChecklistInventory, openSpecReadinessSyntaxIssue, readOpenSpecPlan } from './openspec-plan.mjs';

const inside = (root, file) => { const r = path.relative(root, file); return r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const bindingsKey = Symbol.for('runtime-corrector.document-tools.v1');
const bindings = globalThis[bindingsKey] ??= new Map();
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const LIMIT = 8192;
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const sameAnchor = (verified, expected) => Object.entries(verified).every(([key, value]) => expected?.[key] === value);
const coverageKey = (anchorId, requirement) => JSON.stringify([anchorId, requirement]);
export function documentArtifactPaths(semantic) {
  const editable = semantic.workflow ? semantic.workflow.editableArtifactFiles ?? [] : semantic.artifactFiles ?? [];
  return [...(semantic.artifactFiles ?? []), ...editable, ...(semantic.workflow?.targetFiles ?? []),
    ...(semantic.workflow?.incomingEdges ?? []).flatMap(edge => edge.sourceFiles ?? edge.artifactFiles ?? [])];
}
export const ORIGINAL_DUTY_ACCOUNTING_INSTRUCTION = 'For this current whole-plan review, read original user spans first and stage the distinct full duties you discover with rc_document stage_original_duties before mapping them to plan lines. Keep complete clauses and conditions; different duties may share an original anchor. This is pre-freeze accounting of discovered duties, not proof that every duty was discovered. Use the returned originalDutyId for each final originalRequirementCoverage assessment and retain the exact canonical requirement. Assess whole duties against current plan ranges; use GAP or UNVERIFIED honestly. Only before the first known-original cohort is frozen can staged duties omitted or rewritten in final coverage be retained by that initial handoff as individually UNVERIFIED. Every fully validated canonical table protects all its final and staged duties across repairs in this worker; omitted prior duties remain individually UNVERIFIED. Capacity rejection protects them all, not only staged IDs; retain them on later attempts. More than 48 distinct observed duties leaves aggregate UNVERIFIED for this owner rather than accepting a trimmed subset. This remains discovered, non-exhaustive accounting. Later staging accounts only within its current document review; it does not replace, expand or add protection to an already frozen cohort. The action shares this worker and its original deadline; it grants no compliance, execution or correction authority. If unopened, this method is NOT_EXERCISED and remains non-exhaustive.';
export const originalRequirementCoverageSchema = {
  type: 'array', maxItems: 48,
  description: 'Coverage of original obligations by this review\'s declared current artifacts, not a whole-project implementation or execution verdict. Keep every required Proposal obligation. Omit an optional row only when the original does not require this artifact scope to represent it; otherwise retain UNVERIFIED when coverage cannot be established.',
  items: {
    type: 'object', additionalProperties: false,
    required: ['originalSourceAnchorId', 'requirement', 'disposition', 'reason', 'targets'],
    properties: {
      originalDutyId: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'For a pre-freeze staged duty, copy its current stage_original_duties ID and full canonical requirement. This is separate from requiredProposalId and grants no source read or semantic proof.' },
      requiredProposalId: { type: 'string', pattern: '^[a-f0-9]{64}$',
        description: 'For a required Proposal obligation, copy its current required_proposal ID. The host retains that obligation\'s canonical requirement; this ID does not grant a source read or plan coverage.' },
      originalSourceAnchorId: { type: 'string', pattern: '^original-source-[a-f0-9]{64}$' },
      requirement: { type: 'string', minLength: 1, maxLength: 600 },
      disposition: { type: 'string', enum: ['COVERED', 'GAP', 'UNVERIFIED'],
        description: 'COVERED requires at least one disclosed current artifact range that covers the obligation. GAP needs demonstrated artifact evidence. UNVERIFIED preserves uncertainty and does not waive a required Proposal obligation.' },
      reason: { type: 'string', minLength: 1, maxLength: 600 },
      targets: { type: 'array', maxItems: 8,
        description: 'Exact physical line ranges in the declared current artifact coverage scope, actually disclosed by rc_document during this review. Reading implementation or reference files does not add them to this scope.',
        items: {
          type: 'object', additionalProperties: false, required: ['path', 'start', 'end'],
          properties: { path: { type: 'string', description: 'A path in the declared current artifact coverage scope, not merely any readable project file.' },
            start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } },
        } },
    },
  },
};

export const planReadinessSchema = {
  type: 'object', additionalProperties: false, required: ['inventorySha256', 'status', 'rows'],
  properties: {
    inventorySha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    status: { type: 'string', enum: ['READY', 'BLOCKED', 'UNVERIFIED'] },
    rows: { type: 'array', maxItems: 128, items: {
      type: 'object', additionalProperties: false, required: ['taskId', 'status', 'reason', 'targets'],
      properties: {
        taskId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        status: { type: 'string', enum: ['READY', 'BLOCKED', 'UNVERIFIED'] },
        reason: { type: 'string', minLength: 1, maxLength: 600 },
        targets: originalRequirementCoverageSchema.items.properties.targets,
        originalSourceAnchorIds: { type: 'array', maxItems: 8, items: {
          type: 'string', pattern: '^original-source-[a-f0-9]{64}$' } },
      },
    } },
  },
};

// The complete declared scope is small and deterministic. Never inventory or
// copy the repository. Full file reads stay available through the host.
export async function createDocumentTools({ projectRoot, semantic, signal, active = () => {}, scopeIdentity = null,
  requestPath = null, requiredProposalReview = null, requiredPlanReadiness = null, originalDutyCohortContext = null,
  originalObservationReader = null }) {
  const root = await fs.realpath(projectRoot), files = new Map(), observed = new Map(), firstLines = new Map(), namesByPath = new Map();
  const cohortContext = validateHostOriginalDutyContext(originalDutyCohortContext);
  if (cohortContext) {
    const ownerRoot = await fs.realpath(cohortContext.owner.projectRoot).catch(() => null);
    if (ownerRoot !== root) throw Object.assign(new Error('DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID'),
      { code: 'DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID' });
  }
  const readRequests = new Map();
  const originals = new Map((semantic.originalRequirements?.userMessages ?? []).map(source => [source.ref, source]));
  const originalReads = new Map();
  const requiredAtoms = new Map();
  const requiredById = new Map();
  const originalSourceDirectory = requestPath && path.join(path.dirname(requestPath), 'user-sources');
  const nameFor = value => typeof value === 'string' ? namesByPath.get(pathKey(path.resolve(root, value))) : undefined;
  const editable = semantic.workflow ? semantic.workflow.editableArtifactFiles ?? [] : semantic.artifactFiles ?? [];
  const artifacts = documentArtifactPaths(semantic);
  const names = new Set([...artifacts,
    ...(semantic.workflow?.groundTruthInputs ?? []).filter(source => source.status === 'ready').flatMap(source => source.files ?? (source.path ? [source.path] : []))]);
  const assertActive = () => { signal?.throwIfAborted(); active(); };
  for (const name of names) {
    if (typeof name !== 'string') throw new Error('DOCUMENT_SOURCE_INVALID');
    const absolute = path.resolve(root, name);
    if (!inside(root, absolute) || name.split(/[\\/]/u).some(part => ['.git', 'node_modules', '.runtime-correction'].includes(part))) throw new Error('DOCUMENT_SOURCE_OUTSIDE_SCOPE');
    assertActive();
    const real = await fs.realpath(absolute);
    if (await hasLinkedPath(absolute) || !await isSameFile(real, absolute)) throw new Error('DOCUMENT_LINKED_SOURCE');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('DOCUMENT_SOURCE_TOO_LARGE');
    const bytes = await fs.readFile(real); assertActive();
    if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('DOCUMENT_SOURCE_NOT_TEXT');
    const lines = bytes.toString('utf8').split(/\r?\n/u), key = name.replaceAll('\\', '/');
    if (namesByPath.has(pathKey(absolute))) continue;
    namesByPath.set(pathKey(absolute), key);
    const first = `1: ${lines[0]}`, rawBytes = Buffer.byteLength(first);
    // Scheduling metadata only. Every disclosed page still reads and verifies
    // the current source; this stores neither a body nor reading authority.
    firstLines.set(key, { rawBytes, jsonBytes: rawBytes > LIMIT ? Infinity : Buffer.byteLength(JSON.stringify(first)) });
    files.set(key, { absolute, sha256: sha256(bytes), lines: lines.length,
      bytes: bytes.length, editable: editable.some(file => pathKey(path.resolve(root, file)) === pathKey(absolute)) });
  }
  const artifactFiles = new Set(artifacts.map(nameFor));
  // Staging is available only for one exact current whole OpenSpec plan. It
  // never creates an operator-supplied or approval-blocking inventory.
  let originalDutyPlan = null;
  const planPaths = [...artifactFiles];
  const changes = planPaths.map(file => /^openspec\/changes\/([^/]+)\/(?:proposal\.md|design\.md|tasks\.md|specs\/.+\/spec\.md)$/u.exec(file)?.[1]);
  if (cohortContext && originals.size && changes.length && changes.every(Boolean) && new Set(changes).size === 1) {
    const plan = await readOpenSpecPlan(root, changes[0]).catch(() => null); assertActive();
    if (plan && plan.documents.length === artifactFiles.size
      && plan.documents.every(file => artifactFiles.has(file.path) && files.get(file.path).sha256 === file.sha256))
      originalDutyPlan = { changeName: changes[0], revision: plan.revision };
  }
  // Only a live host reader crosses this boundary. Serialized prior tables do
  // not become a source of observation authority or current read receipts.
  if (originalObservationReader !== null && typeof originalObservationReader !== 'function')
    throw new Error('DOCUMENT_PRIOR_OBSERVATION_READER_INVALID');
  const priorNavigationEnabled = Boolean(originalDutyPlan && originalObservationReader);
  const priorSnapshot = priorNavigationEnabled ? originalObservationReader() : null;
  const originalObservationIdentity = priorSnapshot?.id ?? null;
  const currentPriorSnapshot = () => {
    assertActive();
    const current = originalObservationReader();
    if ((current?.id ?? null) !== originalObservationIdentity || current && (
      !/^[a-f0-9]{64}$/u.test(current.id) || !Array.isArray(current.items)
      || current.items.length > 48 || (current.owner ? sha256(current.owner) !== sha256(cohortContext.owner)
        : current.capacityUnverified !== true || current.ownerBindingSha256 !== sha256(cohortContext.owner))))
      throw new Error('DOCUMENT_PRIOR_OBSERVATIONS_CHANGED');
    return current;
  };
  if (priorNavigationEnabled) currentPriorSnapshot();
  let stagedOriginalDuties = null;
  let rejectedDutyCoverage = null;
  // Commit only complete validated tables. At most 48 retained canonical rows;
  // the first overflow witness is bounded by 48 prior+48 final+48 staged rows.
  // Once count-overflow is witnessed, this lease can never accept a subset.
  let retainedCanonicalDuties = new Map();
  const originalDutyAccounting = () => originalDutyPlan ? {
    version: ORIGINAL_DUTY_ACCOUNTING_VERSION,
    status: rejectedDutyCoverage ? 'UNVERIFIED_CAPACITY' : stagedOriginalDuties ? 'STAGED' : 'NOT_EXERCISED',
    planRevision: originalDutyPlan.revision, stagedCount: stagedOriginalDuties?.length ?? 0,
    ...(rejectedDutyCoverage ? { capacity: structuredClone(rejectedDutyCoverage.originalDutyAccounting.capacity) } : {}),
    exhaustive: false, semanticsVerified: false,
  } : null;

  let checklistInventory = null;
  if (requiredPlanReadiness !== null) {
    if (!isOpenSpecChangeName(requiredPlanReadiness?.changeName)) throw new Error('DOCUMENT_PLAN_READINESS_INVALID');
    const checklistPath = `openspec/changes/${requiredPlanReadiness.changeName}/tasks.md`;
    const item = files.get(checklistPath);
    if (!item || !artifactFiles.has(checklistPath)) throw new Error('DOCUMENT_PLAN_READINESS_INVALID');
    const bytes = await fs.readFile(item.absolute), syntaxIssue = openSpecReadinessSyntaxIssue(bytes);
    if (syntaxIssue) throw Object.assign(new Error('DOCUMENT_PLAN_READINESS_UNVERIFIED: Unsupported indented task syntax.'),
      { code: 'DOCUMENT_PLAN_READINESS_UNVERIFIED', reason: syntaxIssue });
    checklistInventory = openSpecChecklistInventory(bytes, checklistPath);
    if (!checklistInventory) throw new Error('DOCUMENT_PLAN_READINESS_LIMIT');
  }
  const disclosedRanges = [];
  const disclose = (file, start, end) => {
    if ((originals.size || checklistInventory) && artifactFiles.has(file)) disclosedRanges.push({ path: file, start, end });
  };
  const notePath = path.join(root, '.runtime-correction', 'document-agent', 'notes.json');
  // Policy, authority and task identities change the meaning of remembered
  // decisions even when artifact bytes are identical.
  const basis = sha256({ scopeIdentity, files: [...files].map(([file, item]) => [file, item.sha256]),
    stage: semantic.stage, reviewer: semantic.reviewer, specification: semantic.specification,
    workflow: semantic.workflow, runtimeV2: semantic.runtimeV2 && { taskId: semantic.runtimeV2.taskId,
      groundTruthDigest: semantic.runtimeV2.groundTruthDigest, groundTruthVersion: semantic.runtimeV2.groundTruthVersion },
    ...(semantic.originalRequirements ? { originalRequirements: semantic.originalRequirements.digest } : {}),
    ...(originalDutyPlan ? { originalDutyAccountingProtocol: ORIGINAL_DUTY_ACCOUNTING_VERSION } : {}),
    ...(originalDutyPlan && cohortContext ? { originalDutyCohortContext: cohortContext } : {}),
    ...(priorNavigationEnabled ? { originalObservationIdentity } : {}),
    ...(requiredProposalReview ? { requiredProposalReview } : {}),
    ...(requiredPlanReadiness ? { requiredPlanReadiness, checklistInventory } : {}) });
  const read = async name => {
    assertActive(); const entry = files.get(nameFor(name));
    if (!entry) throw new Error('DOCUMENT_FILE_NOT_DECLARED');
    if (await hasLinkedPath(entry.absolute) || !await isSameFile(await fs.realpath(entry.absolute), entry.absolute)) throw new Error('DOCUMENT_LINKED_SOURCE');
    const bytes = await fs.readFile(entry.absolute); assertActive();
    if (sha256(bytes) !== entry.sha256) throw new Error('DOCUMENT_EVIDENCE_CHANGED');
    return bytes.toString('utf8').split(/\r?\n/u);
  };
  const manifest = () => [...files].map(([file, entry]) => ({ path: file, ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'absolute')) }));
  async function originalBytes(source) {
    assertActive();
    let bytes;
    if (typeof source.text === 'string') bytes = Buffer.from(source.text);
    else {
      const file = source.path;
      if (!originalSourceDirectory || typeof file !== 'string' || !inside(originalSourceDirectory, file)
        || await hasLinkedPath(file)) throw new Error('DOCUMENT_ORIGINAL_SOURCE_UNAVAILABLE');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('DOCUMENT_ORIGINAL_SOURCE_UNAVAILABLE');
      bytes = await fs.readFile(file);
    }
    assertActive();
    if (sha256(bytes) !== source.sha256) throw new Error('DOCUMENT_ORIGINAL_SOURCE_CHANGED');
    return bytes;
  }
  async function priorOriginalObservations(args) {
    if (!priorNavigationEnabled) throw new Error('DOCUMENT_PRIOR_OBSERVATIONS_UNAVAILABLE');
    const start = args.start ?? 1, count = args.count ?? 8;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || count > 20)
      throw new Error('DOCUMENT_RANGE_INVALID');
    const snapshot = currentPriorSnapshot();
    await assertOriginalDutiesCurrent([]);
    const rows = snapshot?.items ?? [], items = [];
    const page = { navigationOnly: true, readProofGranted: false, stageProofGranted: false, assessmentGranted: false,
      exhaustive: false, snapshotId: originalObservationIdentity, total: rows.length, items, nextStart: null,
      status: snapshot?.unavailableReason ? 'UNAVAILABLE' : snapshot ? 'PRIOR_INTERPRETATIONS' : 'NO_PRIOR_OBSERVATIONS',
      ...(snapshot?.unavailableReason ? { reason: snapshot.unavailableReason } : {}) };
    for (const item of rows.slice(start - 1, start - 1 + count)) {
      const original = originals.get(item.source?.ref);
      if (!original || original.sha256 !== item.source.sha256 || typeof item.requirement !== 'string'
        || !item.requirement.trim() || item.requirement.length > 600
        || item.id !== knownOriginalId(item.source, item.requirement))
        throw new Error('DOCUMENT_PRIOR_OBSERVATION_SOURCE_CHANGED');
      const bytes = await originalBytes(original), source = item.source;
      if (!Number.isSafeInteger(source.byteStart) || !Number.isSafeInteger(source.byteEnd)
        || source.byteStart < 0 || source.byteEnd < source.byteStart || source.byteEnd > bytes.length)
        throw new Error('DOCUMENT_PRIOR_OBSERVATION_SOURCE_CHANGED');
      const line = offset => bytes.subarray(0, offset).reduce((n, byte) => n + Number(byte === 10), 1);
      const first = line(source.byteStart), last = line(source.byteEnd);
      const anchor = createOriginalSourceAnchor({ ref: original.ref, sha256: original.sha256, bytes, start: first, end: last });
      if (sha256(anchor) !== sha256(source) || last - first >= 200)
        throw new Error('DOCUMENT_PRIOR_OBSERVATION_SOURCE_CHANGED');
      const next = { knownCandidateId: item.id, requirement: item.requirement, sourceAnchor: structuredClone(source),
        readOriginal: { action: 'read_original', ref: original.ref, start: first, count: last - first + 1 } };
      const nextStart = start - 1 + items.length + 1 < rows.length ? start + items.length + 1 : null;
      if (jsonBytes({ ...page, items: [...items, next], nextStart }) > LIMIT) {
        if (!items.length) throw new Error('DOCUMENT_PRIOR_OBSERVATION_RESPONSE_LIMIT');
        break;
      }
      items.push(next); page.nextStart = nextStart;
    }
    currentPriorSnapshot();
    return page;
  }
  if (requiredProposalReview !== null) {
    const invalid = () => new Error('DOCUMENT_REQUIRED_PROPOSAL_INVALID');
    const atoms = requiredProposalReview?.requiredAtoms;
    if (!Array.isArray(atoms) || !atoms.length || atoms.length > 48) throw invalid();
    const sources = new Map();
    for (const atom of atoms) {
      const { source, start, end, requirement } = atom ?? {};
      const original = originals.get(source?.ref);
      if (!original || original.sha256 !== source.sha256 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 1 || end < start || end - start >= 200 || typeof requirement !== 'string' || !requirement.trim()
        || requirement.trim() !== requirement || requirement.length > 600 || requirement.includes('\0')
        || typeof source.ref !== 'string' || source.ref.length > 512 || /\p{Cc}/u.test(source.ref)) throw invalid();
      if (!sources.has(source.ref)) sources.set(source.ref, await originalBytes(original));
      let anchor;
      try { anchor = createOriginalSourceAnchor({ ref: original.ref, sha256: original.sha256,
        bytes: sources.get(original.ref), start, end }); }
      catch { throw invalid(); }
      const key = coverageKey(anchor.anchorId, requirement);
      if (!sameAnchor(anchor, source) || requiredAtoms.has(key)) throw invalid();
      const requiredProposalId = sha256([anchor.anchorId, requirement]);
      const required = { requiredProposalId, anchor, requirement,
        readOriginal: { action: 'read_original', ref: original.ref, start, count: end - start + 1 } };
      requiredAtoms.set(key, required);
      requiredById.set(requiredProposalId, required);
    }
  }
  // Validate explicit precision claims, not arbitrary semantic diagnoses.
  // Only declared current documents are readable through this boundary.
  async function validateFindings(findings = []) {
    const current = new Map(), issues = [];
    const load = name => {
      if (!current.has(name)) current.set(name, read(name));
      return current.get(name);
    };
    const aliases = [...files].flatMap(([name, entry]) => [name, entry.absolute.replaceAll('\\', '/')].map(alias => ({ name, alias })))
      .sort((a, b) => b.alias.length - a.alias.length);
    const issue = (index, name, line, reason, lines) => {
      if (issues.length < 8) issues.push({ index, path: name, line, reason,
        ...(lines && Number.isSafeInteger(line) && line >= 1 && line <= lines.length ? { currentLine: `${line}: ${lines[line - 1].slice(0, 240)}` } : {}) });
    };
    for (const [index, finding] of findings.entries()) {
      assertActive();
      if (finding.originalSourceAnchorId !== undefined) {
        const original = originalReads.get(finding.originalSourceAnchorId);
        if (!original) issue(index, finding.path, finding.line, 'Use rc_document read_original in this round before citing an originalSourceAnchorId.');
        else await originalBytes(original.source);
      }
      const target = nameFor(finding.path), targetQuotes = [];
      if (target && finding.line !== undefined) {
        const lines = await load(target);
        if (!Number.isSafeInteger(finding.line) || finding.line < 1 || finding.line > lines.length)
          issue(index, target, finding.line, 'Finding anchor is outside the current original line range.', lines);
      }
      for (const evidence of finding.evidence ?? []) {
        if (typeof evidence !== 'string') continue;
        let text = evidence.trim(); if (text.startsWith('`')) text = text.slice(1);
        const selected = aliases.find(({ alias }) => pathKey(text.slice(0, alias.length).replaceAll('\\', '/')) === pathKey(alias) && /^(?::|#L)[1-9]/u.test(text.slice(alias.length)));
        if (!selected) continue; // Narrative or an undeclared path grants no checked location.
        const range = /^(?::|#L)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?(?=$|[\s`]|:\s+["'“‘])/u.exec(text.slice(selected.alias.length));
        if (!range) continue;
        const start = Number(range[1]), end = Number(range[2] ?? range[1]), lines = await load(selected.name);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > lines.length) {
          issue(index, selected.name, start, 'Explicit evidence range is outside the current original.', lines); continue;
        }
        let remainder = text.slice(selected.alias.length + range[0].length).trim();
        if (remainder.startsWith('`')) remainder = remainder.slice(1).trim();
        remainder = remainder.replace(/^:\s+(?=["'“‘])/u, '');
        const closing = { '"': '"', "'": "'", '“': '”', '‘': '’' }[remainder[0]];
        if (!closing || remainder.length < 2) continue;
        const quoteEnd = remainder.lastIndexOf(closing);
        if (quoteEnd < 1 || !/^[.,;:!?。，；：！？]*$/u.test(remainder.slice(quoteEnd + 1).trim())) continue;
        const quote = remainder.slice(1, quoteEnd);
        if (!quote) continue;
        const original = lines.slice(start - 1, end).join('\n').replace(/\r\n/gu, '\n');
        if (!original.includes(quote.replace(/\r\n/gu, '\n'))) {
          issue(index, selected.name, start, 'The literal quotation is absent from its declared current line/range; do not move it automatically.', lines); continue;
        }
        if (selected.name === target) targetQuotes.push({ start, end });
      }
      if (target && finding.line !== undefined && targetQuotes.length && !targetQuotes.some(range => finding.line >= range.start && finding.line <= range.end))
        issue(index, target, finding.line, 'Finding anchor disagrees with its checked quoted target evidence.', await load(target));
    }
    assertActive();
    if (issues.length) throw Object.assign(new Error(`DOCUMENT_FINDING_LOCATION_INVALID: ${JSON.stringify(issues)}. Re-read the CURRENT numbered rc_document lines. Use physical 1-based lines, not sentence numbers or display wrapping. Return a corrected assessment preserving the grounded diagnosis and all valid findings; do not delete an issue merely to escape a location error. Only claim line precision and verbatim quotations supported by current reads. Paraphrases/document-level or absence findings need not invent a quote or line. The program never relocates your finding.`),
      { code: 'DOCUMENT_FINDING_LOCATION_INVALID', locationIssues: issues });
  }
  function assertRequiredProposalIdentities(used) {
    const missing = [...requiredAtoms].filter(([key]) => !used.has(key));
    if (!missing.length) return;
    assertActive();
    const issue = { kind: 'MISSING_REQUIRED_PROPOSAL_IDENTITIES', missingCount: missing.length, missing: [],
      navigation: { action: 'required_proposal', start: 1, count: 8 } };
    for (const [, { requiredProposalId, anchor, requirement, readOriginal }] of missing.slice(0, 4)) {
      const next = { requiredProposalId, originalSourceAnchorId: anchor.anchorId, requirement, readOriginal };
      if (jsonBytes({ ...issue, missing: [...issue.missing, next] }) > LIMIT / 2) break;
      issue.missing.push(next);
    }
    issue.remainingCount = missing.length - issue.missing.length;
    throw Object.assign(new Error(`Required Proposal identities are missing from originalRequirementCoverage: ${JSON.stringify(issue)}. `
      + 'Read the exact listed spans with read_original and retain every required anchor plus its listed obligation. Optional rows do not replace required identities. Preserve valid findings and rows; use GAP or UNVERIFIED honestly rather than inventing coverage or re-anchoring a requirement.'),
    { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID', coverageIssue: issue });
  }
  async function assertOriginalDutiesCurrent(duties = stagedOriginalDuties ?? []) {
    assertActive();
    for (const file of artifactFiles) await read(file);
    const currentPlan = await readOpenSpecPlan(root, originalDutyPlan.changeName); assertActive();
    if (currentPlan.revision !== originalDutyPlan.revision || currentPlan.documents.length !== artifactFiles.size
      || !currentPlan.documents.every(file => artifactFiles.has(file.path) && files.get(file.path).sha256 === file.sha256))
      throw new Error('DOCUMENT_ORIGINAL_DUTY_PLAN_CHANGED');
    const seen = new Set();
    for (const duty of duties) if (!seen.has(duty.source.ref)) {
      const source = originals.get(duty.source.ref);
      if (!source || source.sha256 !== duty.source.sha256) throw new Error('DOCUMENT_ORIGINAL_SOURCE_CHANGED');
      await originalBytes(source); seen.add(source.ref);
    }
    assertActive();
  }
  async function stageOriginalDuties(args) {
    if (!originalDutyPlan) throw new Error('DOCUMENT_ORIGINAL_DUTY_ACCOUNTING_UNAVAILABLE');
    if (!cohortContext?.owner || !cohortContext.owner.taskId
      || !cohortContext.owner.sessionId || !cohortContext.owner.sessionKey || !cohortContext.owner.scopeFingerprint
      || !cohortContext.sourceRunId) throw new Error('DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_REQUIRED');
    const start = args.start ?? 1, count = args.count ?? 8;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || count > 20)
      throw new Error('DOCUMENT_RANGE_INVALID');
    let proposed = stagedOriginalDuties ?? [];
    if (args.duties !== undefined) {
      if (!Array.isArray(args.duties) || !args.duties.length || args.duties.length > 48
        || Buffer.byteLength(JSON.stringify(args.duties)) > 65536) throw new Error('DOCUMENT_ORIGINAL_DUTY_LIMIT');
      const seen = new Set(); proposed = [];
      for (const row of args.duties) {
        if (!row || typeof row !== 'object' || Array.isArray(row)
          || Object.keys(row).length !== 2 || !Object.hasOwn(row, 'originalSourceAnchorId') || !Object.hasOwn(row, 'requirement')
          || typeof row.requirement !== 'string' || !row.requirement.trim() || row.requirement !== row.requirement.trim()
          || row.requirement.length > 600 || row.requirement.includes('\0')) throw new Error('DOCUMENT_ORIGINAL_DUTY_INVALID');
        const issued = originalReads.get(row.originalSourceAnchorId);
        if (!issued) throw new Error('DOCUMENT_ORIGINAL_DUTY_READ_REQUIRED');
        const originalDutyId = sha256([issued.anchor.anchorId, row.requirement]);
        if (seen.has(originalDutyId)) throw new Error('DOCUMENT_ORIGINAL_DUTY_DUPLICATE');
        seen.add(originalDutyId); proposed.push({ originalDutyId, source: structuredClone(issued.anchor),
          requirement: row.requirement, readOriginal: structuredClone(issued.readOriginal) });
      }
      proposed.sort((a, b) => a.originalDutyId.localeCompare(b.originalDutyId));
    }
    await assertOriginalDutiesCurrent(proposed);
    if (args.duties !== undefined) {
      // No await between the final guard and the atomic first-table commit.
      if (stagedOriginalDuties && sha256(stagedOriginalDuties) !== sha256(proposed))
        throw new Error('DOCUMENT_ORIGINAL_DUTIES_FROZEN');
      stagedOriginalDuties ??= structuredClone(proposed);
    }
    const items = (stagedOriginalDuties ?? []).slice(start - 1, start - 1 + count).map(duty => ({
      originalDutyId: duty.originalDutyId, originalSourceAnchorId: duty.source.anchorId,
      requirement: duty.requirement, readOriginal: duty.readOriginal }));
    const page = { ...originalDutyAccounting(), navigationOnly: true, readProofGranted: false, items, nextStart: null };
    while (items.length) {
      page.nextStart = start - 1 + items.length < stagedOriginalDuties.length ? start + items.length : null;
      if (jsonBytes(page) <= LIMIT) break;
      items.pop();
    }
    if (jsonBytes(page) > LIMIT) throw new Error('DOCUMENT_RESPONSE_LIMIT');
    return page;
  }
  async function verifyRequirementCoverage(rows) {
    if (!rows?.length) { assertRequiredProposalIdentities(new Set()); if (!stagedOriginalDuties) return null; rows = []; }
    if (stagedOriginalDuties) await assertOriginalDutiesCurrent();
    const declaredArtifacts = [...artifactFiles].map(file => ({ path: file, start: 1, end: files.get(file).lines }));
    const invalid = (index, reason, issue) => Object.assign(new Error(`Coverage row ${index + 1}: ${reason}`
      + (issue ? ` Declared current artifact coverage scope: ${JSON.stringify(declaredArtifacts)}. This table concerns coverage by these artifacts, not whole-project implementation or execution. Use UNVERIFIED when artifact coverage cannot be established; preserve required Proposal obligations and do not invent citations.` : '')),
      { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID', ...(issue ? { coverageIssue: { row: index + 1, ...issue, declaredArtifacts } } : {}) });
    if (stagedOriginalDuties && rows.length > 48) throw invalid(48, 'Keep the existing 48-row final assessment limit.');
    const verified = [], used = new Set(), usedStaged = new Set();
    const stagedById = new Map((stagedOriginalDuties ?? []).map(duty => [duty.originalDutyId, duty]));
    for (const [index, row] of rows.entries()) {
      const { originalSourceAnchorId, requirement, disposition, reason, targets } = row;
      const identified = Object.hasOwn(row, 'requiredProposalId') ? requiredById.get(row.requiredProposalId) : null;
      if (Object.hasOwn(row, 'requiredProposalId') && !identified)
        throw invalid(index, 'Use a requiredProposalId from the current required_proposal inventory.');
      const original = originalReads.get(originalSourceAnchorId);
      if (!original) throw invalid(index, 'Use an original source anchor issued by read_original in this review.');
      await originalBytes(original.source);
      // A known ID selects host-owned text, not a model rewrite of the duty.
      // The exact acknowledged source and every target check remain required.
      const staged = Object.hasOwn(row, 'originalDutyId') ? stagedById.get(row.originalDutyId)
        : (stagedOriginalDuties ?? []).find(duty => duty.source.anchorId === originalSourceAnchorId && duty.requirement === requirement.trim());
      if (Object.hasOwn(row, 'originalDutyId') && !staged) throw invalid(index, 'Use a current stage_original_duties ID.');
      if (staged && (!sameAnchor(original.anchor, staged.source) || identified && identified.requirement !== staged.requirement))
        throw invalid(index, 'Retain the exact staged source and do not mix distinct duty identities.');
      const canonicalRequirement = identified ? identified.requirement : staged ? staged.requirement : requirement;
      const key = coverageKey(originalSourceAnchorId, canonicalRequirement.trim());
      if (!requirement.trim() || !reason.trim() || used.has(key)) throw invalid(index, 'Supply a distinct obligation and a reason.');
      used.add(key);
      const required = identified ?? requiredAtoms.get(key);
      if (required && !sameAnchor(original.anchor, required.anchor))
        throw invalid(index, 'Read the exact original source span listed for this required Proposal obligation.');
      if (disposition === 'COVERED' && !targets.length) throw invalid(index,
        'Cite at least one reviewed plan range for COVERED; targets is empty.', { kind: 'EMPTY_COVERED_TARGETS', target: null });
      if (disposition === 'GAP' && !targets.length && (!artifactFiles.size ||
        [...artifactFiles].some(file => !covers(disclosedRanges, file, 1, files.get(file).lines))))
        throw invalid(index, 'Read the entire declared plan scope for a gap without a target. Use UNVERIFIED if that scope is incomplete.',
          { kind: 'INCOMPLETE_GAP_SCOPE', target: null });
      const checked = targets.map(({ path: name, start, end }) => {
        const file = nameFor(name), target = { path: name, start, end };
        if (!artifactFiles.has(file)) throw invalid(index,
          `Target ${JSON.stringify(target)} is outside the declared artifact coverage scope. A readable implementation or reference file is not automatically a plan target.`,
          { kind: 'OUTSIDE_ARTIFACT_SCOPE', target });
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > files.get(file).lines)
          throw invalid(index, `Target ${JSON.stringify(target)} is outside the current physical line range 1-${files.get(file).lines} of ${JSON.stringify(file)}.`,
            { kind: 'TARGET_OUT_OF_RANGE', target });
        if (!covers(disclosedRanges, file, start, end)) throw invalid(index,
          `Target ${JSON.stringify(target)} is not a plan range read by rc_document during this review. Read the current numbered artifact lines.`,
          { kind: 'TARGET_NOT_DISCLOSED', target });
        return { path: file, start, end, sha256: files.get(file).sha256 };
      });
      const changedCanonical = staged && requirement.trim() !== staged.requirement;
      if (staged) usedStaged.add(staged.originalDutyId);
      verified.push({ source: original.anchor, requirement: canonicalRequirement,
        disposition: changedCanonical ? 'UNVERIFIED' : disposition,
        reason: changedCanonical ? 'Final plan coverage changed a staged canonical duty; retain its complete original clauses and conditions for assessment.' : reason,
        targets: checked, ...(staged ? { originalDutyId: staged.originalDutyId } : {}),
        ...(changedCanonical ? { originalDutyAccountingIssue: 'CANONICAL_DUTY_CHANGED' } : {}) });
    }
    const scope = [...artifactFiles].map(file => ({ path: file, sha256: files.get(file).sha256, lines: files.get(file).lines }));
    for (const { path: file } of scope) await read(file);
    assertRequiredProposalIdentities(used);
    if (stagedOriginalDuties) {
      await assertOriginalDutiesCurrent();
      for (const duty of stagedOriginalDuties) if (!usedStaged.has(duty.originalDutyId)) verified.push({
        source: structuredClone(duty.source), requirement: duty.requirement, disposition: 'UNVERIFIED',
        reason: 'A pre-freeze staged original duty has no final current plan assessment; retain its complete clauses and conditions.',
        targets: [], originalDutyId: duty.originalDutyId, originalDutyAccountingIssue: 'FINAL_DUTY_ASSESSMENT_MISSING' });
    }
    if (stagedOriginalDuties) {
      const throwCapacityFailure = () => {
        const capacity = rejectedDutyCoverage.originalDutyAccounting.capacity;
        const failure = Object.assign(new Error('DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED: Keep every validated canonical final and staged duty across this worker and later reviews. '
          + 'The exact canonical union exceeds the unchanged 48-item or 65536-byte cohort capacity. '
          + 'Use current staged IDs for matching duties; do not trim, merge, narrow or silently discard additional duties. '
          + JSON.stringify(capacity)), { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED',
          originalDutyCapacityFailure: cloneHostOriginalCoverage(rejectedDutyCoverage) });
        throw markHostOriginalCapacityFailure(failure, rejectedDutyCoverage);
      };
      const retained = rejectedDutyCoverage?.originalDutyAccounting.capacity.count > 48
        ? rejectedDutyCoverage.rows : [...retainedCanonicalDuties.values()];
      for (const row of retained) {
        const acknowledged = originalReads.get(row.source.anchorId);
        if (!acknowledged || !sameAnchor(acknowledged.anchor, row.source)) throw new Error('DOCUMENT_ORIGINAL_SOURCE_CHANGED');
      }
      // Revalidate every retained source, including unkeyed rows omitted by
      // this attempt. An invalid table/source never adds a retained identity.
      await assertOriginalDutiesCurrent([...verified, ...retained]);
      if (rejectedDutyCoverage?.originalDutyAccounting.capacity.count > 48) throwCapacityFailure();
      const union = new Map(verified.map(row => [knownOriginalId(row.source, row.requirement.trim()), row]));
      for (const [id, row] of retainedCanonicalDuties) if (!union.has(id)) union.set(id, {
        ...structuredClone(row), disposition: 'UNVERIFIED', targets: [],
        reason: 'A fully validated canonical duty from an earlier assessment in this worker was omitted; retain its complete clauses and conditions.',
        originalDutyAccountingIssue: 'PRIOR_WORKER_DUTY_ASSESSMENT_MISSING' });
      const canonical = [...union.values()];
      const projection = projectKnownOriginalCohort({ ...cohortContext, changeName: originalDutyPlan.changeName,
        planRevision: originalDutyPlan.revision, items: knownOriginalItems(canonical) });
      const capacity = knownOriginalCapacity(projection);
      if (canonical.length <= 48) retainedCanonicalDuties = new Map([...union].map(([id, row]) => [id, structuredClone(row)]));
      verified.splice(0, verified.length, ...canonical);
      if (!capacity.withinLimits) {
        const accounting = { ...originalDutyAccounting(), status: 'UNVERIFIED_CAPACITY', capacity };
        rejectedDutyCoverage = retainHostOriginalCoverage({ schemaVersion: 1, scope,
          runId: cohortContext.sourceRunId, taskId: cohortContext.owner.taskId, sessionId: cohortContext.owner.sessionId,
          rows: canonical.map(row => ({ ...structuredClone(row), disposition: 'UNVERIFIED',
            reason: 'Canonical duty accounting exceeds unchanged host capacity; no first cohort was accepted.',
            rejectedAssessment: { disposition: row.disposition, reason: row.reason } })), originalDutyAccounting: accounting });
        throwCapacityFailure();
      }
      rejectedDutyCoverage = null;
    }
    const receipt = retainHostOriginalCoverage({ schemaVersion: 1, scope, rows: verified,
      ...(originalDutyPlan ? { originalDutyAccounting: { ...originalDutyAccounting(),
        unverifiedStagedCount: verified.filter(row => row.originalDutyId && row.disposition === 'UNVERIFIED').length } } : {}) });
    return cohortContext ? receipt : cloneHostLegacyOriginalCoverage(receipt);

  }
  async function verifyPlanReadiness(value) {
    if (!checklistInventory) return null;
    const invalid = message => Object.assign(new Error(message), { code: 'DOCUMENT_PLAN_READINESS_INVALID' });
    if (!value || value.inventorySha256 !== checklistInventory.sha256 || !Array.isArray(value.rows)
      || value.rows.length !== checklistInventory.tasks.length) throw invalid('Supply exactly one readiness row for every current checklist task.');
    const tasks = new Map(checklistInventory.tasks.map(task => [task.id, task])), used = new Set(), rows = [];
    for (const row of value.rows) {
      const task = tasks.get(row?.taskId);
      if (!task || used.has(task.id) || !['READY', 'BLOCKED', 'UNVERIFIED'].includes(row.status)
        || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 600
        || !Array.isArray(row.targets) || !row.targets.length || row.targets.length > 8)
        throw invalid('A readiness row is missing, duplicated, foreign or malformed.');
      used.add(task.id);
      const targets = row.targets.map(({ path: name, start, end }) => {
        const file = nameFor(name);
        if (!files.has(file) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1
          || end < start || end > files.get(file).lines || !covers(disclosedRanges, file, start, end))
          throw invalid('Cite current document ranges actually read during this review.');
        return { path: file, start, end, sha256: files.get(file).sha256 };
      });
      if (!targets.some(target => target.path === task.path && target.start <= task.line && target.end >= task.line))
        throw invalid('Read and cite the exact completion-blocking checkbox for this readiness row.');
      const anchors = row.originalSourceAnchorIds ?? [];
      if (!Array.isArray(anchors) || anchors.length > 8 || new Set(anchors).size !== anchors.length)
        throw invalid('Use distinct issued original source anchors.');
      const sources = [];
      for (const id of anchors) {
        const source = originalReads.get(id);
        if (!source) throw invalid('Use an original source anchor issued in this review.');
        await originalBytes(source.source); sources.push(source.anchor);
      }
      rows.push({ taskId: task.id, status: row.status, reason: row.reason, targets, sources });
    }
    const status = rows.some(row => row.status === 'BLOCKED') ? 'BLOCKED'
      : rows.some(row => row.status === 'UNVERIFIED') ? 'UNVERIFIED' : 'READY';
    if (value.status !== status) throw invalid('Readiness status must match the complete task rows.');
    const scope = [...artifactFiles].map(file => ({ path: file, sha256: files.get(file).sha256, lines: files.get(file).lines }));
    for (const { path: file } of scope) await read(file);
    return { schemaVersion: 1, inventorySha256: checklistInventory.sha256, status, scope,
      tasks: checklistInventory.tasks, rows };
  }
  const recall = async () => {
    const notes = await readJson(notePath, { entries: [] });
    const current = [], stale = []; let bytes = 0, omitted = 0;
    for (const note of [...notes.entries].reverse()) {
      const valid = note.basis === basis && note.refs.every(ref => files.get(ref.path)?.sha256 === ref.sha256);
      if (valid) {
        const size = Buffer.byteLength(JSON.stringify(note));
        if (bytes + size <= 4096) { current.push(note); bytes += size; } else omitted++;
      } else stale.push(note.key);
    }
    return { untrustedNavigationOnly: true, current, stale, omitted };
  };
  const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
  const openPage = (file, lines, budget) => {
    const page = { path: file, sha256: files.get(file).sha256, lines: [], nextLine: null };
    const overhead = jsonBytes(page); let encodedLines = 0;
    for (let index = 0; index < Math.min(lines.length, 200); index++) {
      const line = `${index + 1}: ${lines[index]}`, next = index + 1 < lines.length ? index + 2 : null;
      const size = jsonBytes(line) + (page.lines.length ? 1 : 0);
      if (overhead + encodedLines + size + jsonBytes(next) - 4 > budget) break;
      page.lines.push(line); encodedLines += size;
    }
    page.nextLine = page.lines.length < lines.length ? page.lines.length + 1 : null;
    return page;
  };
  const execute = async args => {
    assertActive();
    if (args.action === 'prior_original_observations') return priorOriginalObservations(args);
    if (args.action === 'stage_original_duties') return stageOriginalDuties(args);
    if (args.action === 'plan_checklist') {
      if (!checklistInventory) throw new Error('DOCUMENT_PLAN_READINESS_UNAVAILABLE');
      const start = args.start ?? 1, count = args.count ?? 8;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || count > 20)
        throw new Error('DOCUMENT_RANGE_INVALID');
      const items = checklistInventory.tasks.slice(start - 1, start - 1 + count);
      const page = { navigationOnly: true, inventorySha256: checklistInventory.sha256, total: checklistInventory.tasks.length, items, nextStart: null };
      if (!items.length) return page;
      while (items.length) {
        page.nextStart = start - 1 + items.length < checklistInventory.tasks.length ? start + items.length : null;
        if (jsonBytes(page) <= LIMIT) return page;
        items.pop();
      }
      throw new Error('DOCUMENT_PLAN_READINESS_LIMIT');
    }
    if (args.action === 'required_proposal') {
      if (!requiredAtoms.size) throw new Error('DOCUMENT_REQUIRED_PROPOSAL_UNAVAILABLE');
      const start = args.start ?? 1, count = args.count ?? 8;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || count > 20)
        throw new Error('DOCUMENT_RANGE_INVALID');
      const items = [...requiredAtoms.values()].slice(start - 1, start - 1 + count)
        .map(({ requiredProposalId, requirement, readOriginal }) => ({ requiredProposalId, requirement, readOriginal }));
      const page = { navigationOnly: true, total: requiredAtoms.size, items, nextStart: null };
      while (items.length) {
        page.nextStart = start - 1 + items.length < requiredAtoms.size ? start + items.length : null;
        if (jsonBytes(page) <= LIMIT) break;
        items.pop();
      }
      return page;
    }
    if (args.action === 'read_original') {
      const source = originals.get(args.ref);
      if (!source) throw new Error('DOCUMENT_ORIGINAL_SOURCE_UNDECLARED');
      const start = args.start ?? 1, count = args.count ?? 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || count > 200)
        throw new Error('DOCUMENT_RANGE_INVALID');
      const bytes = await originalBytes(source);
      let anchor;
      try { anchor = createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256, bytes, start, end: start + count - 1 }); }
      catch (error) {
        const lines = bytes.toString('utf8').split('\n');
        if (error.message !== 'Invalid text interval' || start + count - 1 <= lines.length
          || !Buffer.from(lines.join('\n')).equals(bytes)) throw error;
        let retryStart = Math.min(start, lines.length), retryCount = Math.min(count, lines.length - retryStart + 1);
        if (!lines.slice(retryStart - 1, retryStart - 1 + retryCount).join('\n').trim()) {
          while (retryStart > 0 && !lines[retryStart - 1].trim()) retryStart--;
          retryCount = 1;
        }
        const issue = { requested: { start, count }, validLineRange: { start: 1, end: lines.length },
          retryRange: retryStart ? { start: retryStart, count: retryCount } : null,
          reuseRequestedRef: true, navigationOnly: true, readProofGranted: false };
        throw Object.assign(new Error(`DOCUMENT_ORIGINAL_RANGE_INVALID: Valid original physical line range is 1-${lines.length}. `
          + `${JSON.stringify(issue)} ` + (issue.retryRange
          ? 'Retry read_original with the SAME exact ref from the rejected call and retryRange. This is in-bounds navigation; read the complete relevant clause before staging it. '
          : 'This original contains no nonempty line to suggest; blank text cannot produce a source anchor. ')
          + 'This rejected call issued no anchor or read/stage proof.'),
        { code: 'DOCUMENT_ORIGINAL_RANGE_INVALID', originalRangeIssue: issue });
      }
      const selected = { anchor, text: bytes.subarray(anchor.byteStart, anchor.byteEnd).toString('utf8') };
      if (jsonBytes(selected) > LIMIT) throw new Error('DOCUMENT_ORIGINAL_RANGE_TOO_LARGE');
      assertActive(); originalReads.set(anchor.anchorId, { source, anchor, readOriginal: { action: 'read_original', ref: source.ref, start, count } });
      return selected;
    }
    if (args.action === 'open') {
      const documents = [...files.keys()].map(file => ({ path: file, nextLine: 1, requiresRead: true,
        ...(firstLines.get(file).rawBytes > LIMIT ? { requiresHostRead: true } : {}) }));
      const opened = { requestPath, manifest: manifest(), notes: await recall(), documents,
        ...(priorNavigationEnabled ? { priorOriginalObservations: { navigationOnly: true,
          snapshotId: originalObservationIdentity, total: currentPriorSnapshot()?.items.length ?? 0,
          ...(priorSnapshot?.items.length ? { action: 'prior_original_observations' } : {}),
          ...(priorSnapshot?.unavailableReason ? { status: 'UNAVAILABLE', reason: priorSnapshot.unavailableReason } : {}) } } : {}),
        ...(requiredAtoms.size ? { requiredProposal: { total: requiredAtoms.size, navigationOnly: true, action: 'required_proposal' } } : {}),
        ...(checklistInventory ? { planReadiness: { inventorySha256: checklistInventory.sha256,
          total: checklistInventory.tasks.length, navigationOnly: true, action: 'plan_checklist' } } : {}) };
      assertActive();
      // Reserve complete inventory, notes and unread-file hints before I/O.
      // If that metadata alone exceeds LIMIT, return it without any bodies.
      let bytes = jsonBytes(opened); const disclosed = [];
      for (let index = 0; index < documents.length; index++) {
        const placeholder = documents[index], file = placeholder.path, entry = files.get(file);
        const budget = LIMIT - bytes + jsonBytes(placeholder);
        const firstPage = { path: file, sha256: entry.sha256, lines: [], nextLine: entry.lines > 1 ? 2 : null };
        if (jsonBytes(firstPage) + firstLines.get(file).jsonBytes > budget) continue;
        const page = openPage(file, await read(file), budget);
        documents[index] = page; bytes += jsonBytes(page) - jsonBytes(placeholder);
        if (page.lines.length) disclosed.push([file, page.lines.length]);
      }
      // Commit disclosure qualification only when the complete open succeeds.
      assertActive();
      for (const [file, count] of disclosed) {
        observed.set(file, files.get(file).sha256);
        disclose(file, 1, count);
      }
      return opened;
    }
    if (args.action === 'manifest') return manifest();
    if (args.action === 'recall') return recall();
    if (args.action === 'remember') {
      const paths = Array.isArray(args.paths) ? args.paths.map(file => nameFor(file)) : null;
      if (!/^[a-zA-Z0-9_.-]{1,80}$/u.test(args.key ?? '') || typeof args.note !== 'string' || Buffer.byteLength(args.note) > 1000
        || !Array.isArray(paths) || !paths.length || paths.some(file => !observed.has(file))) throw new Error('DOCUMENT_NOTE_REQUIRES_CURRENT_READS');
      const refs = paths.map(file => ({ path: file, sha256: observed.get(file) }));
      const notes = await readJson(notePath, { entries: [] });
      notes.entries = [...notes.entries.filter(note => note.key !== args.key), { key: args.key, note: args.note, basis, refs }].slice(-24);
      assertActive(); await atomicWriteJson(notePath, notes); return { saved: args.key };
    }
    if ((args.action === 'read' || args.action === 'search') && (typeof args.path !== 'string' || args.path.length === 0))
      throw new Error('DOCUMENT_PATH_REQUIRED: Supply the path of one document from the current open or manifest result.');
    const name = nameFor(args.path), lines = await read(name);
    if (args.action === 'read') {
      const start = args.start ?? 1, count = args.count ?? 60;
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 200) throw new Error('DOCUMENT_RANGE_INVALID');
      const requestKey = JSON.stringify([name, start, count]);
      const repeatedRequestCount = (readRequests.get(requestKey) ?? 0) + 1;
      const readProgress = repeatedRequestCount >= 3 ? {
        navigationOnly: true, repeatedRequestCount,
        message: 'This unchanged read request has already been completed in this review. Repeating it adds no source coverage. If the evidence is sufficient, return the required structured assessment; otherwise identify the specific unresolved evidence. This notice does not establish correctness or forbid a needed reread.',
      } : undefined;
      const envelope = { path: name, sha256: files.get(name).sha256, ...(readProgress ? { readProgress } : {}) };
      // Reserve the complete wrapper, including the optional notice and the
      // longest possible nextLine encoding. Never enlarge a source page.
      const overhead = jsonBytes({ ...envelope, lines: [], nextLine: Math.max(9999, lines.length + 1), requiresHostRead: true }) - 2;
      if (overhead + 2 > LIMIT) throw new Error('DOCUMENT_RESPONSE_LIMIT');
      const page = boundedLinePage(lines, { start, count, byteLimit: LIMIT - overhead - 2, separatorBytes: 1,
        render: (line, number) => JSON.stringify(`${number}: ${line}`) }).lines.map(line => JSON.parse(line));
      readRequests.delete(requestKey); readRequests.set(requestKey, repeatedRequestCount);
      if (readRequests.size > 256) readRequests.delete(readRequests.keys().next().value);
      if (page.length) {
        observed.set(name, files.get(name).sha256);
        disclose(name, start, start + page.length - 1);
      }
      return { ...envelope, lines: page,
        nextLine: start - 1 + page.length < lines.length ? start + page.length : null,
        ...(page.length === 0 && start <= lines.length ? { requiresHostRead: true } : {}) };
    }
    if (args.action === 'search') {
      if (typeof args.query !== 'string' || !args.query || args.query.length > 200) throw new Error('DOCUMENT_QUERY_INVALID');
      const matches = []; let bytes = 0, truncated = false;
      for (let i = 0; i < lines.length; i++) if (lines[i].includes(args.query)) {
        const line = { line: i + 1, text: lines[i] };
        if (matches.length >= 30 || bytes + Buffer.byteLength(JSON.stringify(line)) > LIMIT) { truncated = true; break; }
        matches.push(line); bytes += Buffer.byteLength(JSON.stringify(line));
      }
      observed.set(name, files.get(name).sha256);
      for (const { line } of matches) disclose(name, line, line);
      return { matches, truncated };
    }
    throw new Error('DOCUMENT_ACTION_INVALID');
  };
  return { manifest, recall, execute, validateFindings, verifyRequirementCoverage, verifyPlanReadiness,
    originalDutyAccounting, originalDutyAccountingEnabled: Boolean(originalDutyPlan),
    originalDutyCapacityFailure: () => rejectedDutyCoverage ? cloneHostOriginalCoverage(rejectedDutyCoverage) : null,
    requiresPlanReadiness: Boolean(checklistInventory), requiredProposalCount: requiredAtoms.size,
    priorOriginalObservationsEnabled: priorNavigationEnabled, originalObservationIdentity,
    priorOriginalObservationCount: priorSnapshot?.items.length ?? 0,
    ownsPath(value) { return nameFor(value) !== undefined; },
    setRequestPath(value) { requestPath = value; },
    async checkpoint(phase) {
      assertActive();
      await atomicWriteJson(path.join(root, '.runtime-correction/document-agent/checkpoint.json'), {
        schemaVersion: 1, phase, requestPath, basis, manifest: manifest(), navigationOnly: true,
        noteKeys: (await recall()).current.map(note => note.key), updatedAt: Date.now() });
    },
    async verify() { for (const file of files.keys()) await read(file); },
    tool: { name: 'rc_document', label: 'Document review',
      description: 'Open the current document inventory, read or search a declared path, or read an exact span of an original user message by ref with read_original. Notes never prove compliance.'
        + (originalDutyPlan ? ' stage_original_duties freezes discovered full original duties before plan mapping; omit duties to page the frozen IDs using start/count. It is non-exhaustive pre-freeze accounting, not approval or semantic proof.' : '')
        + (priorNavigationEnabled ? ' prior_original_observations pages host-retained previous interpretations with start/count. knownCandidateId is not a new originalDutyId or a read receipt. Re-read the original span before explicitly staging a supported whole duty; prior wording is not approved truth and different duties must remain distinct.' : '')
        + (requiredAtoms.size ? ' required_proposal pages through the required obligation list using 1-based start and count. Copy each requiredProposalId; the list grants no evidence.' : '')
        + (checklistInventory ? ' plan_checklist pages the exact completion-blocking checkbox inventory using start/count. Read its current source lines before judging readiness.' : ''),
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['open', 'manifest', 'read', 'search', 'remember', 'recall', 'read_original',
          ...(originalDutyPlan ? ['stage_original_duties'] : []), ...(priorNavigationEnabled ? ['prior_original_observations'] : []),
          ...(requiredAtoms.size ? ['required_proposal'] : []), ...(checklistInventory ? ['plan_checklist'] : [])] },
        path: { type: 'string', description: 'Required for read and search. Use one exact path from the current open or manifest result.' },
        ref: { type: 'string', description: 'For read_original, use the exact ref of a user message in originalRequirements.' },
        start: { type: 'integer', minimum: 1, description: 'Physical 1-based line or item start; use nextStart for navigation pages.' },
        count: { type: 'integer', minimum: 1 }, query: { type: 'string' }, key: { type: 'string' }, note: { type: 'string' },
        ...(originalDutyPlan ? { duties: { type: 'array', minItems: 1, maxItems: 48, description: 'Discovered complete canonical clauses and conditions, from current issued read_original anchors. Distinct duties may share an anchor. First valid table freezes; do not supply a narrowed replacement.', items: { type: 'object', additionalProperties: false, required: ['originalSourceAnchorId', 'requirement'], properties: { originalSourceAnchorId: { type: 'string', pattern: '^original-source-[a-f0-9]{64}$' }, requirement: { type: 'string', minLength: 1, maxLength: 600 } } } } } : {}),
        paths: { type: 'array', items: { type: 'string' }, maxItems: 20,
          description: 'For remember, supply a nonempty list of exact current document paths already read in this review, together with key and note.' } } },
      async execute(_id, args) { return text(await execute(args)); } } };
}

export function bindDocumentTools({ sessionId, runId, tools, active }) {
  if (bindings.has(sessionId)) throw new Error('DOCUMENT_SESSION_ALREADY_BOUND');
  const binding = { runId, tools, active }; bindings.set(sessionId, binding);
  return () => { if (bindings.get(sessionId) === binding) bindings.delete(sessionId); };
}

export function registerDocumentTools(api) {
  api.registerTool(ctx => {
    const binding = bindings.get(ctx.sessionId);
    if (!binding || ctx.sandboxed || ctx.runId && ctx.runId !== binding.runId) return null;
    return { ...binding.tools.tool, async execute(...args) {
      if (bindings.get(ctx.sessionId) !== binding) throw new Error('DOCUMENT_BINDING_EXPIRED');
      ctx.assertInvocationCurrent?.(); binding.active();
      const result = await binding.tools.tool.execute(...args);
      if (bindings.get(ctx.sessionId) !== binding) throw new Error('DOCUMENT_BINDING_EXPIRED');
      binding.active(); return result;
    } };
  }, { names: ['rc_document'] });
  for (const phase of ['before_compaction', 'after_compaction']) api.on?.(phase, async (_event, ctx) => {
    const binding = bindings.get(ctx?.sessionId);
    if (!binding || ctx.runId && binding.runId !== ctx.runId) return;
    try { binding.active(); await binding.tools.checkpoint(phase); }
    catch { /* Navigation checkpoints are best effort; never fail host compaction. */ }
  }, { timeoutMs: 30000 });
}
