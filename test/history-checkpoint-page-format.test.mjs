import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObservationJournal } from '../lib/review-task/observation-journal.mjs';
import { createTaskEvidence } from '../lib/review-task/task-evidence.mjs';
import { createReviewMemory, loadReviewCheckpoint } from '../lib/review-task/history-memory.mjs';
import { sourcePage, toolText, textBlocks } from '../lib/review-task/source-tools.mjs';

async function fixture(t, { numbered = false, text = 'First original line.\n第二行原文。', synthetic = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-page-checkpoint-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source'); await fs.mkdir(root);
  const bytes = Buffer.from(text); await fs.writeFile(path.join(root, 'original.txt'), bytes);
  const journal = new ObservationJournal(directory), active = () => {};
  const evidence = await createTaskEvidence({ root, active, journal });
  const result = await evidence.tools.find(tool => tool.name === 'source_read').execute('actual-call', { path: 'original.txt', numbered });
  evidence.observeReceipt({ toolName: 'source_read', toolCallId: 'actual-call', isSynthetic: synthetic,
    message: { role: 'toolResult', toolName: 'source_read', toolCallId: 'actual-call', isError: false, content: result.content, details: result.details } });
  const memory = await createReviewMemory({ sessionManager: journal, task: { id: 'page-task', basisFiles: ['original.txt'] },
    snapshot: evidence.snapshot, root, outputDir: directory, reads: evidence.reads, registry: evidence.registry });
  await memory.checkpoint('actual-read');
  return { ...memory, journal, result, bytes, numbered };
}

test('existing checkpoint loader accepts exact current and historical raw/numbered page bytes', async t => {
  for (const numbered of [false, true]) for (const legacyPageFormat of [false, true])
    await t.test(`${legacyPageFormat ? 'historical' : 'current'} ${numbered ? 'numbered' : 'raw'}`, async t => {
      const f = await fixture(t, { numbered });
      if (legacyPageFormat) {
        // A retained historical rendering of the same actual citation and
        // acknowledged source range. New task tools always issue current facts.
        const entries = f.journal.getEntries(), receipt = entries.find(entry => entry.message.role === 'toolResult');
        const citation = receipt.message.details.citation;
        receipt.message.content = textBlocks(`[citeId="${citation.citeId}" | range ${citation.path}:${citation.start}-${citation.end}]\n`
          + toolText(sourcePage(f.bytes, { offset: citation.start, limit: citation.end - citation.start + 1, numbered }, { legacyPageFormat: true })));
        await fs.writeFile(f.journal.file, [JSON.stringify({ type: 'review_session', id: f.journal.id }), ...entries.map(e => JSON.stringify(e))].join('\n') + '\n');
      }
      const checkpoint = await loadReviewCheckpoint(f.checkpointPath);
      assert.equal(checkpoint.reads.length, 1); assert.equal(checkpoint.citations.length, 1);
    });
});

test('page validation preserves exact text across native text-block boundaries', async t => {
  const f = await fixture(t, { numbered: true, text: 'x'.repeat(7000) + '\n原文。' });
  assert(f.result.content.length > 1); await loadReviewCheckpoint(f.checkpointPath);
});

test('numbered source body, footer, facts, byte range and acknowledgement substitutions fail', async t => {
  const f = await fixture(t, { numbered: true });
  const cp = JSON.parse(await fs.readFile(f.checkpointPath, 'utf8'));
  const originalJournal = await fs.readFile(f.journal.file, 'utf8');
  const cases = {
    'numbered body': (_cp, entry) => { entry.message.content[0].text = entry.message.content[0].text.replace('[1] First', '[1] Changed'); },
    'page footer': (_cp, entry) => { entry.message.content[0].text = entry.message.content[0].text.replace('"numbered":true', '"numbered":false'); },
    'character facts': (_cp, entry) => { entry.message.content[0].text = entry.message.content[0].text.replace('"utf8Valid":true', '"utf8Valid":false'); },
    'extra whitespace': (_cp, entry) => { entry.message.content[0].text += ' '; },
    'byte range': (cp, entry) => { cp.citations[0].byteEnd--; entry.message.details.citation.byteEnd--; },
    'wrong source hash': (cp, entry) => { cp.citations[0].sha256 = 'foreign'; entry.message.details.citation.sha256 = 'foreign'; },
    'missing call identity': (_cp, entry) => { entry.message.toolCallId = ''; },
    'wrong tool': (_cp, entry) => { entry.message.toolName = 'read'; },
    'unacknowledged boundary': (_cp, entry) => { entry.message.details.receiptBoundary = 'synthetic'; },
    'failed tool result': (_cp, entry) => { entry.message.isError = true; },
    'wrong session': cp => { cp.sessionId = 'foreign'; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const checkpoint = structuredClone(cp), entries = originalJournal.trim().split('\n').map(JSON.parse);
    mutate(checkpoint, entries.find(entry => entry.message?.role === 'toolResult'));
    await fs.writeFile(f.checkpointPath, JSON.stringify(checkpoint));
    await fs.writeFile(f.journal.file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    try { await assert.rejects(loadReviewCheckpoint(f.checkpointPath)); }
    finally { await fs.writeFile(f.checkpointPath, JSON.stringify(cp)); await fs.writeFile(f.journal.file, originalJournal); }
  });
});

test('synthetic acknowledgement grants no persisted read or citation', async t => {
  const f = await fixture(t, { numbered: true, synthetic: true }), cp = await loadReviewCheckpoint(f.checkpointPath);
  assert.deepEqual(cp.reads, []); assert.deepEqual(cp.citations, []); assert.deepEqual(cp.receiptEntries, []);
});
