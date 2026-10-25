import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { sourcePage } from '../../lib/review-task/source-tools.mjs';
import { ObservationJournal } from '../../lib/review-task/observation-journal.mjs';
import { createReviewMemory, publicHistoryEntry, loadReviewCheckpoint } from '../../lib/review-task/history-memory.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const decode = result => JSON.parse(result.content[0].text);
async function fixture(t) {
  const parent = fileURLToPath(new URL('../../.runtime-correction/review-task-test-runs/memory/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(parent, 'run-')), root = path.join(outputDir, 'source');
  await fs.mkdir(root);
  const bytes = Buffer.from('\uFEFF先校验😀\r\n后保存🌷\n');
  await fs.writeFile(path.join(root, 'app.txt'), bytes);
  const snapshot = new Map([['app.txt', { sha256: hash(bytes), lines: 3 }]]), reads = [], registry = new Map();
  const task = { id: 'memory-task', requirement: 'Check before save.', scope: 'SOURCE_IMPLEMENTATION', basisFiles: ['app.txt'], targetFiles: ['app.txt'] };
  const sessionManager = new ObservationJournal(outputDir);
  sessionManager.appendMessage({ role: 'user', content: 'Review only this task.', timestamp: Date.now() });
  const memory = await createReviewMemory({ sessionManager, task, snapshot, root, outputDir, reads, registry });
  t.diagnostic(`artifacts: ${outputDir}`);
  return { outputDir, root, bytes, snapshot, reads, registry, task, sessionManager, memory };
}
function addReceipt(f, overrides = {}) {
  const citation = { citeId: randomUUID(), path: 'app.txt', start: 1, end: 3, sha256: hash(f.bytes), byteStart: 0, byteEnd: f.bytes.length, rangeKind: 'range', ...overrides };
  f.reads.push({ path: citation.path, start: citation.start, end: citation.end });
  f.registry.set(citation.citeId, citation);
  f.sessionManager.appendMessage({ role: 'toolResult', toolCallId: randomUUID(), toolName: 'source_read', content: [{ type: 'text', text: `[citeId="${citation.citeId}" | range app.txt:1-3]\n${sourcePage(f.bytes, { offset: citation.start, limit: citation.end - citation.start + 1 }).content[0].text}` }], details: { citation }, isError: false, timestamp: Date.now() });
  return citation;
}

test('public projection excludes thinking, system and history retrieval results', async t => {
  const f = await fixture(t);
  const assistantId = f.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_SENTINEL' }, { type: 'text', text: 'PUBLIC_OBSERVATION' }], timestamp: Date.now() });
  f.sessionManager.appendMessage({ role: 'system', content: 'PRIVATE_SYSTEM_SENTINEL', timestamp: Date.now() });
  f.sessionManager.appendMessage({ role: 'toolResult', toolName: 'review_history', content: [{ type: 'text', text: 'PRIVATE_RETRIEVAL_SENTINEL' }], timestamp: Date.now() });
  f.sessionManager.appendCustomMessageEntry('review.history.internal', 'PRIVATE_CUSTOM_SENTINEL', false);
  const found = decode(await f.memory.tool.execute('search', { mode: 'search', query: 'PRIVATE' }));
  assert.deepEqual(found.matches, []);
  const read = decode(await f.memory.tool.execute('read', { mode: 'read', entryId: assistantId }));
  assert.equal(read.text, 'PUBLIC_OBSERVATION');
  const index = await fs.readFile(f.memory.indexPath, 'utf8');
  assert.doesNotMatch(index, /PRIVATE|PUBLIC_OBSERVATION/u);
});

test('long single-line UTF-8 history remains searchable with bounded byte pages', async t => {
  const f = await fixture(t), original = `${'前段😀'.repeat(20000)}ARCHIVED_WITNESS 图片加载时显示占位图${'后段🌷'.repeat(20000)}`;
  const entryId = f.sessionManager.appendMessage({ role: 'toolResult', toolName: 'historical_observation', toolCallId: 'historic-one', content: [{ type: 'text', text: original }], details: { stageReplay: true, sourceEntryId: 'original-uuid-615', sourceHash: hash(original) }, timestamp: Date.now() });
  const result = await f.memory.tool.execute('search', { mode: 'search', query: '图片加载时显示占位图' });
  assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
  const found = decode(result).matches[0];
  assert.equal(found.entryId, entryId); assert.equal(found.sourceEntryId, 'original-uuid-615'); assert.equal(found.publicTextSha256, hash(original));
  const page = decode(await f.memory.tool.execute('read', { mode: 'read', entryId, offset: found.offset, limit: 8192 }));
  assert.match(page.text, /图片加载时显示占位图/u); assert.doesNotMatch(page.text, /\uFFFD/u);
  assert.deepEqual(Buffer.from(page.text), Buffer.from(original).subarray(page.offset, page.nextOffset));
  assert.ok(page.nextOffset < Buffer.byteLength(original));
  assert.equal(f.reads.length, 0); assert.equal(f.registry.size, 0);
});

test('search index stays metadata-only and uses small result pages', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 600; n++) f.sessionManager.appendCustomMessageEntry('review.stage.history', `Observation ${n}: UNIQUE_PUBLIC_BODY ${'x'.repeat(1000)}`, false, { sourceEntryId: `source-${n}` });
  const page = decode(await f.memory.tool.execute('search', { mode: 'search', query: 'UNIQUE_PUBLIC_BODY', limit: 10000 }));
  assert.equal(page.totalMatches, 600); assert.ok(page.matches.length <= 10); assert.equal(page.nextOffset, page.matches.length);
  const index = JSON.parse(await fs.readFile(f.memory.indexPath, 'utf8'));
  assert.equal(index.entries.length, 601); assert.equal(index.entries.some(entry => 'text' in entry || 'content' in entry), false);
  assert.doesNotMatch(JSON.stringify(index), /UNIQUE_PUBLIC_BODY/u);
});

test('checkpoint saves only source reads with successful native receipts', async t => {
  const f = await fixture(t), originalHash = hash(await fs.readFile(path.join(f.root, 'app.txt'))), issued = addReceipt(f);
  f.registry.set('pending-no-receipt', { ...issued, citeId: 'pending-no-receipt', start: 2 });
  f.reads.push({ path: 'app.txt', start: 2, end: 3 });
  await f.memory.checkpoint('before_compact');
  const saved = await f.memory.loadCheckpoint();
  assert.deepEqual(saved.citations.map(cite => cite.citeId), [issued.citeId]);
  assert.deepEqual(saved.reads, [{ path: 'app.txt', start: 1, end: 3 }]);
  assert.deepEqual(saved.excludedUnacknowledged, { reads: 1, citations: 1 });
  assert.equal(hash(await fs.readFile(path.join(f.root, 'app.txt'))), originalHash);
  assert.equal(saved.sessionId, f.sessionManager.getSessionId());
});

test('checkpoint loads reject changed input, foreign task and forged receipt', async t => {
  const f = await fixture(t); addReceipt(f); await f.memory.checkpoint('before_compact');
  await assert.rejects(loadReviewCheckpoint(f.memory.checkpointPath, { task: { ...f.task, id: 'other' }, root: f.root }), /identity changed/u);
  const forged = JSON.parse(await fs.readFile(f.memory.checkpointPath, 'utf8'));
  forged.citations[0].citeId = 'unissued';
  const forgedPath = path.join(f.outputDir, 'forged-checkpoint.json'); await fs.writeFile(forgedPath, JSON.stringify(forged));
  await assert.rejects(loadReviewCheckpoint(forgedPath, { task: f.task, root: f.root, sessionManager: f.sessionManager }), /receipt/u);
  await assert.rejects(loadReviewCheckpoint(forgedPath, { task: f.task, root: f.root }), /receipt/u);
  await fs.writeFile(path.join(f.root, 'app.txt'), 'changed');
  await assert.rejects(f.memory.loadCheckpoint(), /source changed/u);
});

test('failed source receipt and raw historical observations never count as source evidence', async t => {
  const f = await fixture(t), issued = { citeId: 'not-evidence', path: 'app.txt', start: 1, end: 3, sha256: hash(f.bytes) };
  f.registry.set(issued.citeId, issued); f.reads.push({ path: 'app.txt', start: 1, end: 3 });
  for (const [toolName, isError] of [['source_read', true], ['historical_observation', false]]) f.sessionManager.appendMessage({ role: 'toolResult', toolName, isError, toolCallId: randomUUID(), details: { citation: issued }, content: [{ type: 'text', text: `citeId="${issued.citeId}"` }], timestamp: Date.now() });
  await f.memory.checkpoint('before_compact');
  const checkpoint = await f.memory.loadCheckpoint(); assert.equal(checkpoint.reads.length, 0); assert.equal(checkpoint.citations.length, 0);
});

test('history lookup rejects unknown ids and does not read arbitrary file paths', async t => {
  const f = await fixture(t);
  await assert.rejects(f.memory.tool.execute('read', { mode: 'read', entryId: '../sessions/private.jsonl' }), /Unknown public/u);
  await assert.rejects(f.memory.tool.execute('search', { mode: 'search', query: '' }), /short literal query/u);
  assert.equal(publicHistoryEntry({ type: 'custom', id: 'hidden', data: 'PRIVATE' }), null);
});

test('standalone reload checks receipts and tolerates only an interrupted final session record', async t => {
  const f = await fixture(t); const issued = addReceipt(f); await f.memory.checkpoint('before_compact');
  await fs.appendFile(f.sessionManager.getSessionFile(), '{"type":"message","interrupted":');
  const loaded = await loadReviewCheckpoint(f.memory.checkpointPath, { task: f.task, root: f.root });
  assert.equal(loaded.citations[0].citeId, issued.citeId);
  await fs.writeFile(path.join(f.root, 'new-dependency.txt'), 'new');
  await assert.rejects(loadReviewCheckpoint(f.memory.checkpointPath, { task: f.task, root: f.root }), /source changed/u);
});

test('read pages reject invalid byte limits instead of repeating a zero-length UTF-8 page', async t => {
  const f = await fixture(t), entryId = f.sessionManager.appendCustomMessageEntry('review.stage.history', '😀第二页', false);
  await assert.rejects(f.memory.tool.execute('read', { mode: 'read', entryId, limit: 1 }), /complete UTF-8/u);
  const page = decode(await f.memory.tool.execute('read', { mode: 'read', entryId, limit: 4 }));
  assert.equal(page.text, '😀'); assert.equal(page.nextOffset, 4);
  await assert.rejects(f.memory.tool.execute('read', { mode: 'read', entryId, offset: -1 }), /valid positive integers/u);
});

test('after compaction state pages recover old cite metadata without new receipts', async t => {
  const f = await fixture(t), issued = Array.from({ length: 12 }, () => addReceipt(f));
  const retainedId = f.sessionManager.appendMessage({ role: 'user', content: 'Continue from the saved review state.', timestamp: Date.now() });
  const hostContext = 'Summary deliberately omits all old citation IDs.';
  assert.doesNotMatch(hostContext, new RegExp(issued[0].citeId, 'u'));
  await f.memory.checkpoint('after_compaction');
  const beforeReads = structuredClone(f.reads), beforeRegistry = [...f.registry];
  const firstRaw = await f.memory.tool.execute('state-1', { mode: 'state', offset: 0, limit: 10 });
  const first = decode(firstRaw);
  assert.equal(first.citations.length, 10); assert.equal(first.nextOffset, 10);
  assert.deepEqual(first.citations[0], issued[0]);
  assert.ok(Buffer.byteLength(firstRaw.content[0].text) <= 8192);
  const last = decode(await f.memory.tool.execute('state-2', { mode: 'state', offset: first.nextOffset, limit: 10 }));
  assert.equal(last.citations.length, 2); assert.equal(last.nextOffset, null);
  assert.deepEqual(last.citations[1], issued[11]);
  assert.deepEqual(f.reads, beforeReads); assert.deepEqual([...f.registry], beforeRegistry);
});

test('checkpoint reload rejects a receipt whose header survives but original body was lost', async t => {
  const f = await fixture(t); addReceipt(f); await f.memory.checkpoint('before_compaction');
  const entries = f.sessionManager.getEntries();
  const receipt = entries.find(entry => entry.message?.toolName === 'source_read');
  receipt.message.content[0].text = receipt.message.content[0].text.split('\n')[0];
  await assert.rejects(loadReviewCheckpoint(f.memory.checkpointPath, { task: f.task, root: f.root, sessionManager: f.sessionManager }), /receipt bytes/);
});
