import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJson, sha256 } from './runtime-v2/utils.mjs';
import { boundedLinePage } from './line-page.mjs';
import { hasLinkedPath, isSameFile } from './path-utils.mjs';

const inside = (root, file) => { const r = path.relative(root, file); return r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const bindingsKey = Symbol.for('runtime-corrector.document-tools.v1');
const bindings = globalThis[bindingsKey] ??= new Map();
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const LIMIT = 8192;
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

// The complete declared scope is small and deterministic. Never inventory or
// copy the repository. Full file reads stay available through the host.
export async function createDocumentTools({ projectRoot, semantic, signal, active = () => {}, scopeIdentity = null, requestPath = null }) {
  const root = await fs.realpath(projectRoot), files = new Map(), observed = new Map(), firstLines = new Map(), namesByPath = new Map();
  const nameFor = value => typeof value === 'string' ? namesByPath.get(pathKey(path.resolve(root, value))) : undefined;
  const editable = semantic.workflow ? semantic.workflow.editableArtifactFiles ?? [] : semantic.artifactFiles ?? [];
  const names = new Set([...(semantic.artifactFiles ?? []), ...editable, ...(semantic.workflow?.targetFiles ?? []),
    ...(semantic.workflow?.incomingEdges ?? []).flatMap(edge => edge.sourceFiles ?? edge.artifactFiles ?? []),
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
  const notePath = path.join(root, '.runtime-correction', 'document-agent', 'notes.json');
  // Policy, authority and task identities change the meaning of remembered
  // decisions even when artifact bytes are identical.
  const basis = sha256({ scopeIdentity, files: [...files].map(([file, item]) => [file, item.sha256]),
    stage: semantic.stage, reviewer: semantic.reviewer, specification: semantic.specification,
    workflow: semantic.workflow, runtimeV2: semantic.runtimeV2 && { taskId: semantic.runtimeV2.taskId,
      groundTruthDigest: semantic.runtimeV2.groundTruthDigest, groundTruthVersion: semantic.runtimeV2.groundTruthVersion },
    ...(semantic.originalRequirements ? { originalRequirements: semantic.originalRequirements.digest } : {}) });
  const read = async name => {
    assertActive(); const entry = files.get(nameFor(name));
    if (!entry) throw new Error('DOCUMENT_FILE_NOT_DECLARED');
    if (await hasLinkedPath(entry.absolute) || !await isSameFile(await fs.realpath(entry.absolute), entry.absolute)) throw new Error('DOCUMENT_LINKED_SOURCE');
    const bytes = await fs.readFile(entry.absolute); assertActive();
    if (sha256(bytes) !== entry.sha256) throw new Error('DOCUMENT_EVIDENCE_CHANGED');
    return bytes.toString('utf8').split(/\r?\n/u);
  };
  const manifest = () => [...files].map(([file, entry]) => ({ path: file, ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'absolute')) }));
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
    if (args.action === 'open') {
      const documents = [...files.keys()].map(file => ({ path: file, nextLine: 1, requiresRead: true,
        ...(firstLines.get(file).rawBytes > LIMIT ? { requiresHostRead: true } : {}) }));
      const opened = { requestPath, manifest: manifest(), notes: await recall(), documents };
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
        if (page.lines.length) disclosed.push(file);
      }
      // Commit disclosure qualification only when the complete open succeeds.
      assertActive();
      for (const file of disclosed) observed.set(file, files.get(file).sha256);
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
    const name = nameFor(args.path), lines = await read(name);
    if (args.action === 'read') {
      const start = args.start ?? 1, count = args.count ?? 60;
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 200) throw new Error('DOCUMENT_RANGE_INVALID');
      const page = boundedLinePage(lines, { start, count, byteLimit: LIMIT, render: (line, number) => `${number}: ${line}` }).lines;
      if (page.length) observed.set(name, files.get(name).sha256);
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
      return { matches, truncated };
    }
    throw new Error('DOCUMENT_ACTION_INVALID');
  };
  return { manifest, recall, execute, validateFindings,
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
      description: 'Read or search declared document evidence with hashes and line numbers; recall/save private navigation notes. Notes never prove compliance.',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['open', 'manifest', 'read', 'search', 'remember', 'recall'] }, path: { type: 'string' },
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
