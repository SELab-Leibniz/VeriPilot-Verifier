import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJson, sha256 } from './runtime-v2/utils.mjs';
import { boundedLinePage } from './line-page.mjs';

const inside = (root, file) => { const r = path.relative(root, file); return r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const bindingsKey = Symbol.for('runtime-corrector.document-tools.v1');
const bindings = globalThis[bindingsKey] ??= new Map();
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const LIMIT = 8192;

// The complete declared scope is small and deterministic. Never inventory or
// copy the repository. Full file reads stay available through the host.
export async function createDocumentTools({ projectRoot, semantic, signal, active = () => {}, scopeIdentity = null, requestPath = null }) {
  const root = await fs.realpath(projectRoot), files = new Map(), observed = new Map();
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
    if (real !== absolute) throw new Error('DOCUMENT_LINKED_SOURCE');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('DOCUMENT_SOURCE_TOO_LARGE');
    const bytes = await fs.readFile(real); assertActive();
    if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('DOCUMENT_SOURCE_NOT_TEXT');
    files.set(name.replaceAll('\\', '/'), { absolute, sha256: sha256(bytes), lines: bytes.toString('utf8').split('\n').length,
      bytes: bytes.length, editable: editable.includes(name) });
  }
  const notePath = path.join(root, '.runtime-correction', 'document-agent', 'notes.json');
  // Policy, authority and task identities change the meaning of remembered
  // decisions even when artifact bytes are identical.
  const basis = sha256({ scopeIdentity, files: [...files].map(([file, item]) => [file, item.sha256]),
    stage: semantic.stage, reviewer: semantic.reviewer, specification: semantic.specification,
    workflow: semantic.workflow, runtimeV2: semantic.runtimeV2 && { taskId: semantic.runtimeV2.taskId,
      groundTruthDigest: semantic.runtimeV2.groundTruthDigest, groundTruthVersion: semantic.runtimeV2.groundTruthVersion } });
  const read = async name => {
    assertActive(); const entry = files.get(name);
    if (!entry) throw new Error('DOCUMENT_FILE_NOT_DECLARED');
    if (await fs.realpath(entry.absolute) !== entry.absolute) throw new Error('DOCUMENT_LINKED_SOURCE');
    const bytes = await fs.readFile(entry.absolute); assertActive();
    if (sha256(bytes) !== entry.sha256) throw new Error('DOCUMENT_EVIDENCE_CHANGED');
    observed.set(name, entry.sha256); return bytes.toString('utf8').split('\n');
  };
  const manifest = () => [...files].map(([file, entry]) => ({ path: file, ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'absolute')) }));
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
  const execute = async args => {
    assertActive();
    if (args.action === 'open') {
      const documents = []; let bytes = 0;
      for (const file of files.keys()) {
        const page = await execute({ action: 'read', path: file, count: 200 });
        const size = Buffer.byteLength(JSON.stringify(page));
        if (bytes + size <= LIMIT) { documents.push(page); bytes += size; }
        else documents.push({ path: file, nextLine: 1, requiresRead: true });
      }
      return { requestPath, manifest: manifest(), notes: await recall(), documents };
    }
    if (args.action === 'manifest') return manifest();
    if (args.action === 'recall') return recall();
    if (args.action === 'remember') {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/u.test(args.key ?? '') || typeof args.note !== 'string' || Buffer.byteLength(args.note) > 1000
        || !Array.isArray(args.paths) || !args.paths.length || args.paths.some(file => !observed.has(file))) throw new Error('DOCUMENT_NOTE_REQUIRES_CURRENT_READS');
      const refs = args.paths.map(file => ({ path: file, sha256: observed.get(file) }));
      const notes = await readJson(notePath, { entries: [] });
      notes.entries = [...notes.entries.filter(note => note.key !== args.key), { key: args.key, note: args.note, basis, refs }].slice(-24);
      assertActive(); await atomicWriteJson(notePath, notes); return { saved: args.key };
    }
    const lines = await read(args.path);
    if (args.action === 'read') {
      const start = args.start ?? 1, count = args.count ?? 60;
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 200) throw new Error('DOCUMENT_RANGE_INVALID');
      const page = boundedLinePage(lines, { start, count, byteLimit: LIMIT, render: (line, number) => `${number}: ${line}` }).lines;
      return { path: args.path, sha256: files.get(args.path).sha256, lines: page,
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
      return { matches, truncated };
    }
    throw new Error('DOCUMENT_ACTION_INVALID');
  };
  return { manifest, recall, execute,
    ownsPath(value) { return typeof value === 'string' && [...files.values()].some(entry => entry.absolute === path.resolve(root, value)); },
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
    binding.active(); await binding.tools.checkpoint(phase);
  }, { timeoutMs: 30000 });
}
