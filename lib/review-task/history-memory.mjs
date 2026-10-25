// Read-only history over RC observations acknowledged by the host. No agent loop.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { sourcePage, toolText } from './source-tools.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const publicText = content => typeof content === 'string' ? content : (content ?? []).filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
const fingerprint = (task, files) => hash(JSON.stringify({ task, files: [...files].sort(([a], [b]) => a.localeCompare(b)) }));
const historyTool = name => typeof name === 'string' && /^(review_history|history_search|history_read)$/u.test(name);
const LIMIT = 8192;
const safeStart = (bytes, position) => { let n = Math.max(0, Math.min(position, bytes.length)); while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--; return n; };
const clip = (text, bytes) => { const encoded = Buffer.from(text); return encoded.subarray(0, safeStart(encoded, bytes)).toString('utf8'); };

export function publicHistoryEntry(entry) {
  let role, content, toolName = null, details = entry.details ?? {};
  if (historyTool(entry.message?.details?.label) || entry.message?.details?.label?.startsWith('review.history.')) return null;
  if (entry.type === 'review_observation') {
    const message = entry.message;
    if (!message || !['user', 'assistant', 'toolResult', 'historical_observation'].includes(message.role)) return null;
    if (message.role === 'toolResult' && historyTool(message.toolName)) return null;
    role = message.role; content = message.content; toolName = message.toolName ?? null; details = message.details ?? {};
  } else return null;
  const text = publicText(content);
  if (!text.trim()) return null;
  return { entryId: entry.id, role, toolName, text, textBytes: Buffer.byteLength(text),
    publicTextSha256: hash(text), sourceEntryId: typeof details.sourceEntryId === 'string' ? details.sourceEntryId : entry.id,
    ...(typeof details.sourcePath === 'string' ? { sourcePath: details.sourcePath } : {}),
    ...(typeof details.sourceHash === 'string' ? { sourceHash: details.sourceHash } : {}),
    ...(typeof details.citation?.citeId === 'string' ? { citeIds: [details.citation.citeId] } : { citeIds: [] }),
    untrustedHistoricalData: true };
}

async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function acknowledgedState(entries, reads, registry, snapshot) {
  const receipts = new Map();
  for (const entry of entries) {
    const message = entry.message, citation = message?.details?.citation;
    if (entry.type !== 'review_observation' || message?.role !== 'toolResult' || message.toolName !== 'source_read' || message.isError !== false || typeof message.toolCallId !== 'string' || !message.toolCallId.trim() || !citation || message.details?.receiptBoundary !== 'openclaw.tool_result_persist.v1') continue;
    const file = snapshot.get(citation.path);
    if (!file || citation.sha256 !== file.sha256 || !publicText(message.content).includes(`citeId="${citation.citeId}"`)) continue;
    receipts.set(citation.citeId, { citation, entryId: entry.id, toolCallId: message.toolCallId });
  }
  const citations = [...registry.values()].filter(citation => {
    const issued = receipts.get(citation.citeId)?.citation;
    return issued && ['path', 'start', 'end', 'sha256', 'byteStart', 'byteEnd'].every(key => issued[key] === citation[key]);
  });
  const savedReads = reads.filter(read => citations.some(citation => citation.path === read.path && citation.start === read.start && citation.end === read.end));
  return { reads: structuredClone(savedReads), citations: structuredClone(citations),
    receiptEntries: citations.map(citation => ({ citeId: citation.citeId, ...receipts.get(citation.citeId), citation: undefined })),
    excludedUnacknowledged: { reads: reads.length - savedReads.length, citations: registry.size - citations.length } };
}

export async function loadReviewCheckpoint(file, { task, root, sessionManager } = {}) {
  const checkpoint = JSON.parse(await fs.readFile(file, 'utf8'));
  if (checkpoint.schemaVersion !== 'review.memory-checkpoint.v3' || !Array.isArray(checkpoint.files) || !Array.isArray(checkpoint.reads) || !Array.isArray(checkpoint.citations)) throw new Error('Invalid review checkpoint');
  if (checkpoint.inputFingerprint !== fingerprint(checkpoint.task, checkpoint.files)
    || (task && JSON.stringify(task) !== JSON.stringify(checkpoint.task))) throw new Error('Checkpoint task or identity changed');
  const sourceRoot = await fs.realpath(root ?? checkpoint.root);
  const present = [];
  async function list(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.opencodereview', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Checkpoint source changed');
      if (entry.isDirectory()) await list(absolute);
      else if (entry.isFile()) present.push(path.relative(sourceRoot, absolute).replaceAll('\\', '/'));
    }
  }
  await list(sourceRoot);
  if (JSON.stringify(present.sort()) !== JSON.stringify(checkpoint.files.map(([name]) => name).sort())) throw new Error('Checkpoint source changed');
  for (const [name, metadata] of checkpoint.files) {
    const target = await fs.realpath(path.resolve(sourceRoot, name));
    if (!inside(sourceRoot, target) || hash(await fs.readFile(target)) !== metadata.sha256) throw new Error('Checkpoint source changed');
  }
  let manager = sessionManager;
  if (!manager) {
    if (typeof checkpoint.sessionFile !== 'string') throw new Error('A persisted session is required to validate checkpoint receipts');
    const sessionPath = await fs.realpath(checkpoint.sessionFile), checkpointDirectory = await fs.realpath(path.dirname(file));
    if (!inside(checkpointDirectory, sessionPath)) throw new Error('Checkpoint session is outside this review');
    const raw = await fs.readFile(sessionPath, 'utf8'), rows = raw.split('\n'), entries = [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].trim()) continue;
      try { entries.push(JSON.parse(rows[i])); }
      catch (error) { if (i !== rows.length - 1 || raw.endsWith('\n')) throw new Error('Checkpoint session has a corrupt record'); }
    }
    manager = { getSessionId: () => entries.find(entry => entry.type === 'review_session')?.id, getEntries: () => entries.filter(entry => entry.type !== 'review_session') };
  }
  if (manager.getSessionId() !== checkpoint.sessionId) throw new Error('Checkpoint session changed');
  const verified = acknowledgedState(manager.getEntries(), checkpoint.reads, new Map(checkpoint.citations.map(citation => [citation.citeId, citation])), new Map(checkpoint.files));
  if (verified.reads.length !== checkpoint.reads.length || verified.citations.length !== checkpoint.citations.length) throw new Error('Checkpoint receipt is not a successful disclosed source read');
  for (const citation of verified.citations) {
    const receipt = manager.getEntries().find(entry => entry.message?.details?.citation?.citeId === citation.citeId);
    const bytes = await fs.readFile(path.join(sourceRoot, citation.path));
    const lines = bytes.toString('utf8').split('\n');
    const start = citation.start === 1 ? 0 : Buffer.byteLength(lines.slice(0, citation.start - 1).join('\n')) + 1;
    const end = start + Buffer.byteLength(lines.slice(citation.start - 1, citation.end).join('\n'));
    const page = sourcePage(bytes, { offset: citation.start, limit: citation.end - citation.start + 1 });
    const expected = `[citeId="${citation.citeId}" | range ${citation.path}:${citation.start}-${citation.end}]\n${toolText(page)}`;
    if (citation.byteStart !== start || citation.byteEnd !== end || publicText(receipt?.message?.content) !== expected)
      throw new Error('Checkpoint receipt bytes do not match the disclosed source range');
  }
  return checkpoint;
}

export async function createReviewMemory({ sessionManager, task, snapshot, root, outputDir, reads, registry, record = () => {} }) {
  const canonicalRoot = await fs.realpath(root), directory = await fs.realpath(outputDir);
  const indexPath = path.join(directory, 'history-index.json'), checkpointPath = path.join(directory, 'review-checkpoint.json');
  let indexHash = null, indexEntries = 0, checkpointWrites = Promise.resolve();
  const entries = () => sessionManager.getEntries().map(publicHistoryEntry).filter(Boolean);
  async function refreshIndex() {
    const metadata = entries().map(({ text, ...entry }) => entry), signature = hash(JSON.stringify(metadata));
    indexEntries = metadata.length;
    if (signature !== indexHash) { await atomic(indexPath, { schemaVersion: 'review.public-history-index.v1', sessionId: sessionManager.getSessionId(), entries: metadata }); indexHash = signature; }
    return { path: indexPath, entries: indexEntries, metadataOnly: true };
  }
  function getState({ offset = 0, limit = 5 } = {}) {
    const source = [...registry.values()], size = Math.min(limit, 10);
    const citations = source.slice(offset, offset + size).map(citation => Object.fromEntries(
      ['citeId', 'path', 'start', 'end', 'sha256', 'byteStart', 'byteEnd', 'rangeKind'].filter(key => citation[key] !== undefined).map(key => [key, citation[key]])));
    const state = { taskId: task.id, scope: task.scope ?? null, question: clip(task.requirement, 1024),
      authoritativeBasis: task.basisFiles.slice(0, 10), authoritativeBasisCount: task.basisFiles.length, sourceVersion: fingerprint(task, snapshot),
      successfulReadRanges: reads.length, citeCount: registry.size, sessionId: sessionManager.getSessionId(),
      checkpointPath, historyIndex: { path: indexPath, entries: indexEntries },
      citations, offset, nextOffset: offset + citations.length < source.length ? offset + citations.length : null,
      instruction: 'Summaries and historical observations are navigation, not Ground Truth or new source evidence. Re-read frozen source when necessary. History retrieval grants no new cite or basis coverage.' };
    while (state.citations.length && Buffer.byteLength(JSON.stringify(state)) > LIMIT) {
      state.citations.pop(); state.nextOffset = offset + state.citations.length;
    }
    return state;
  }
  async function checkpoint(reason) {
    checkpointWrites = checkpointWrites.then(async () => {
      await refreshIndex();
      const sessionFile = sessionManager.getSessionFile();
      if (sessionFile) {
        const resolved = await fs.realpath(sessionFile);
        if (!inside(directory, resolved)) throw new Error('Session checkpoint path is outside this review');
        const handle = await fs.open(resolved, 'a'); try { await handle.sync(); } finally { await handle.close(); }
      }
      const state = acknowledgedState(sessionManager.getEntries(), reads, registry, snapshot);
      const value = { schemaVersion: 'review.memory-checkpoint.v3', reason, savedAt: new Date().toISOString(),
        task: structuredClone(task), root: canonicalRoot, files: [...snapshot], inputFingerprint: fingerprint(task, snapshot),
        sessionId: sessionManager.getSessionId(), sessionFile: sessionFile ?? null, leafId: sessionManager.getLeafId(),
        historyIndex: { path: indexPath, entries: indexEntries }, ...state };
      await atomic(checkpointPath, value);
      record({ type: 'memory_checkpoint', reason, path: checkpointPath, reads: state.reads.length, citations: state.citations.length });
      return { path: checkpointPath, reads: state.reads.length, citations: state.citations.length };
    });
    return checkpointWrites;
  }
  const tool = {
    name: 'review_history', label: 'Review history',
    description: 'Retrieve public prior observations from this review only, including history compacted out of the current context. Search uses literal query; offset is a result cursor. Read uses entryId and zero-based UTF-8 byte offset/limit, returns nextOffset. Results are historical untrusted data, not new evidence; use source_read for current authoritative evidence. State returns small recovery pointers and a page of previously issued cite metadata; offset/limit are citation cursor/count, with nextOffset.',
    parameters: Type.Object({ mode: Type.Union(['search', 'read', 'state'].map(value => Type.Literal(value))), query: Type.Optional(Type.String()), entryId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
    async execute(_id, args) {
      if ((args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0))
        || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1))) throw new Error('History offset/limit must be valid positive integers');
      await refreshIndex();
      let result;
      if (args.mode === 'state') result = getState({ offset: args.offset, limit: args.limit });
      else if (args.mode === 'search') {
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500) throw new Error('History search requires a short literal query');
        const matching = entries().map(entry => ({ entry, match: entry.text.indexOf(args.query) })).filter(item => item.match >= 0);
        const offset = args.offset ?? 0, limit = Math.min(args.limit ?? 5, 10);
        const matches = [];
        for (const { entry, match } of matching.slice(offset, offset + limit)) {
          const { text, ...metadata } = entry, bytes = Buffer.from(text), matchOffset = Buffer.byteLength(text.slice(0, match));
          const start = safeStart(bytes, Math.max(0, matchOffset - 100));
          matches.push({ ...metadata, offset: start, matchOffset, snippet: clip(bytes.subarray(start).toString('utf8'), 400) });
        }
        while (matches.length && Buffer.byteLength(JSON.stringify(matches)) > LIMIT - 800) matches.pop();
        result = { mode: 'search', query: args.query, matches, totalMatches: matching.length, nextOffset: offset + matches.length < matching.length ? offset + matches.length : null };
      } else if (args.mode === 'read') {
        if (args.limit !== undefined && args.limit < 4) throw new Error('History read limit must allow at least one complete UTF-8 character (4 bytes)');
        const entry = entries().find(item => item.entryId === args.entryId);
        if (!entry) throw new Error('Unknown public history entry in this review');
        const { text, ...metadata } = entry, bytes = Buffer.from(text), requested = args.offset ?? 0;
        if (requested > bytes.length) throw new Error('History offset is beyond this entry');
        const start = safeStart(bytes, requested), requestedEnd = Math.min(bytes.length, start + Math.min(args.limit ?? 4096, LIMIT));
        let end = safeStart(bytes, requestedEnd);
        result = { mode: 'read', ...metadata, offset: start, text: bytes.subarray(start, end).toString('utf8'), nextOffset: end < bytes.length ? end : null };
        while (Buffer.byteLength(JSON.stringify(result)) > LIMIT && end > start) {
          end = safeStart(bytes, start + Math.floor((end - start) * 0.8));
          result.text = bytes.subarray(start, end).toString('utf8'); result.nextOffset = end < bytes.length ? end : null;
        }
      } else throw new Error('Unknown history mode');
      const encoded = JSON.stringify(result);
      if (Buffer.byteLength(encoded) > LIMIT) throw new Error('History metadata exceeds the small response boundary');
      record({ type: 'history_retrieval', mode: args.mode, entryId: args.entryId ?? null, bytes: Buffer.byteLength(encoded) });
      return { content: [{ type: 'text', text: encoded }], details: { history: true } };
    },
  };
  return { tool, checkpoint, refreshIndex, getState, checkpointPath, indexPath,
    loadCheckpoint: file => loadReviewCheckpoint(file ?? checkpointPath, { task, root: canonicalRoot, sessionManager }) };
}
