import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJson, sha256 } from './runtime-v2/utils.mjs';
import { boundedLinePage } from './line-page.mjs';
import { hasLinkedPath, isSameFile } from './path-utils.mjs';
import { createOriginalSourceAnchor } from './runtime-v2/original-source-anchor.mjs';
import { covers } from './review-task/evidence-utils.mjs';
import { isOpenSpecChangeName, openSpecChecklistInventory, openSpecReadinessSyntaxIssue } from './openspec-plan.mjs';

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
export const originalRequirementCoverageSchema = {
  type: 'array', maxItems: 48, items: {
    type: 'object', additionalProperties: false,
    required: ['originalSourceAnchorId', 'requirement', 'disposition', 'reason', 'targets'],
    properties: {
      originalSourceAnchorId: { type: 'string', pattern: '^original-source-[a-f0-9]{64}$' },
      requirement: { type: 'string', minLength: 1, maxLength: 600 },
      disposition: { type: 'string', enum: ['COVERED', 'GAP', 'UNVERIFIED'] },
      reason: { type: 'string', minLength: 1, maxLength: 600 },
      targets: { type: 'array', maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['path', 'start', 'end'],
        properties: { path: { type: 'string' }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } },
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
  requestPath = null, requiredProposalReview = null, requiredPlanReadiness = null }) {
  const root = await fs.realpath(projectRoot), files = new Map(), observed = new Map(), firstLines = new Map(), namesByPath = new Map();
  const originals = new Map((semantic.originalRequirements?.userMessages ?? []).map(source => [source.ref, source]));
  const originalReads = new Map();
  const requiredAtoms = new Map();
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
      requiredAtoms.set(key, { anchor, requirement, readOriginal: { action: 'read_original', ref: original.ref, start, count: end - start + 1 } });
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
  async function verifyRequirementCoverage(rows) {
    if (!rows?.length) return null;
    const invalid = (index, reason) => Object.assign(new Error(`Coverage row ${index + 1}: ${reason}`),
      { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' });
    const verified = [], used = new Set();
    for (const [index, { originalSourceAnchorId, requirement, disposition, reason, targets }] of rows.entries()) {
      const original = originalReads.get(originalSourceAnchorId);
      if (!original) throw invalid(index, 'Use an original source anchor issued by read_original in this review.');
      await originalBytes(original.source);
      const key = coverageKey(originalSourceAnchorId, requirement.trim());
      if (!requirement.trim() || !reason.trim() || used.has(key)) throw invalid(index, 'Supply a distinct obligation and a reason.');
      used.add(key);
      const required = requiredAtoms.get(key);
      if (required && !sameAnchor(original.anchor, required.anchor))
        throw invalid(index, 'Read the exact original source span listed for this required Proposal obligation.');
      if (disposition === 'COVERED' && !targets.length) throw invalid(index, 'Cite at least one reviewed plan range for COVERED.');
      if (disposition === 'GAP' && !targets.length && (!artifactFiles.size ||
        [...artifactFiles].some(file => !covers(disclosedRanges, file, 1, files.get(file).lines))))
        throw invalid(index, 'Read the entire declared plan scope for a gap without a target. Use UNVERIFIED if that scope is incomplete.');
      const checked = targets.map(({ path: name, start, end }) => {
        const file = nameFor(name);
        if (!artifactFiles.has(file) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1
          || end < start || end > files.get(file).lines || !covers(disclosedRanges, file, start, end))
          throw invalid(index, 'Cite a declared plan range read by rc_document during this review.');
        return { path: file, start, end, sha256: files.get(file).sha256 };
      });
      verified.push({ source: original.anchor, requirement, disposition, reason, targets: checked });
    }
    const scope = [...artifactFiles].map(file => ({ path: file, sha256: files.get(file).sha256, lines: files.get(file).lines }));
    for (const { path: file } of scope) await read(file);
    return { schemaVersion: 1, scope, rows: verified };
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
      const items = [...requiredAtoms.values()].slice(start - 1, start - 1 + count).map(({ requirement, readOriginal }) => ({ requirement, readOriginal }));
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
      const anchor = createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256, bytes, start, end: start + count - 1 });
      const selected = { anchor, text: bytes.subarray(anchor.byteStart, anchor.byteEnd).toString('utf8') };
      if (jsonBytes(selected) > LIMIT) throw new Error('DOCUMENT_ORIGINAL_RANGE_TOO_LARGE');
      assertActive(); originalReads.set(anchor.anchorId, { source, anchor });
      return selected;
    }
    if (args.action === 'open') {
      const documents = [...files.keys()].map(file => ({ path: file, nextLine: 1, requiresRead: true,
        ...(firstLines.get(file).rawBytes > LIMIT ? { requiresHostRead: true } : {}) }));
      const opened = { requestPath, manifest: manifest(), notes: await recall(), documents,
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
      const page = boundedLinePage(lines, { start, count, byteLimit: LIMIT, render: (line, number) => `${number}: ${line}` }).lines;
      if (page.length) {
        observed.set(name, files.get(name).sha256);
        disclose(name, start, start + page.length - 1);
      }
      return { path: name, sha256: files.get(name).sha256, lines: page,
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
    requiresPlanReadiness: Boolean(checklistInventory), requiredProposalCount: requiredAtoms.size,
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
        + (requiredAtoms.size ? ' required_proposal pages through the required obligation list using start and count. The list grants no evidence.' : '')
        + (checklistInventory ? ' plan_checklist pages the exact completion-blocking checkbox inventory using start/count. Read its current source lines before judging readiness.' : ''),
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['open', 'manifest', 'read', 'search', 'remember', 'recall', 'read_original',
          ...(requiredAtoms.size ? ['required_proposal'] : []), ...(checklistInventory ? ['plan_checklist'] : [])] },
        path: { type: 'string', description: 'Required for read and search. Use one exact path from the current open or manifest result.' },
        ref: { type: 'string', description: 'For read_original, use the exact ref of a user message in originalRequirements.' },
        start: { type: 'integer' }, count: { type: 'integer' }, query: { type: 'string' }, key: { type: 'string' }, note: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, maxItems: 20 } } },
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
