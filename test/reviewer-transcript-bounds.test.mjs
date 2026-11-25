import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { prepareReviewerRequest } from '../lib/runtime-v2/reviewer-evidence.mjs';
import { sha256 as canonicalDigest } from '../lib/runtime-v2/utils.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function prepare(t, entries, snapshot = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-transcript-bounds-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prepared = await prepareReviewerRequest({ requestDirectory: root, request: {},
    evidence: { snapshot: { entries, ...snapshot }, semanticRequest: { runtimeV2: {} } } });
  const full = await fs.readFile(prepared.transcript.path);
  const recent = await fs.readFile(prepared.transcriptNavigation.path);
  return { prepared, full, recent, navigation: JSON.parse(recent) };
}

function assertWrittenBounds({ navigation, full }) {
  const lines = full.toString('utf8').split('\n');
  assert.deepEqual(navigation.source.bounds, {
    byteLength: full.length,
    lineRange: { start: 1, end: lines.length },
    endOfSource: { afterLine: lines.length, nextOffset: null },
    navigationOnly: true,
    readProofGranted: false,
  });
  assert.equal(navigation.source.sha256, sha256(full));
  return lines;
}

test('Unicode and embedded CRLF retain exact full bytes and reader-consistent physical bounds', async t => {
  const entries = [{ type: 'user', uuid: 'u', message: { content: 'A\r\n中🙂\nB' } }];
  const result = await prepare(t, entries, { digest: 'snapshot-digest', lastEntryKey: 'u' });
  const lines = assertWrittenBounds(result);
  assert.deepEqual(JSON.parse(result.full), { entries });
  assert(result.full.length > result.full.toString('utf8').length, 'byte count must account for multibyte characters');
  assert.equal(lines.at(-1), '', 'the persisted trailing newline creates the SDK reader final empty slot');
  assert.equal(result.navigation.source.digest, 'snapshot-digest');
  assert.equal(result.navigation.source.cursor, 'u');
  assert.deepEqual(result.prepared.transcript, { path: result.prepared.transcript.path,
    digest: 'snapshot-digest', cursor: 'u' }, 'navigation must not replace snapshot identity or add evidence receipts');
});

test('empty history has truthful serialized-file bounds without inventing evidence or an invocation', async t => {
  const result = await prepare(t, []);
  assertWrittenBounds(result);
  assert.deepEqual(JSON.parse(result.full), { entries: [] });
  assert.deepEqual(result.navigation.entries, []);
  assert.deepEqual(result.navigation.recentToolResults, []);
  assert.equal(result.navigation.latestExternalUser, null);
  assert.equal(result.navigation.invocation, undefined);
  assert.equal(result.navigation.complete, true, 'complete describes the selected empty history, not a read receipt');
  assert.equal(result.navigation.source.bounds.readProofGranted, false);
});

test('a final in-bounds range reaches the real file end and has no fabricated continuation', async t => {
  const result = await prepare(t, [{ type: 'assistant', message: { content: 'Recorded event.' } }]);
  const lines = assertWrittenBounds(result);
  const { lineRange, endOfSource } = result.navigation.source.bounds;
  const offset = Math.max(lineRange.start, lineRange.end - 2);
  const tail = lines.slice(offset - 1, offset - 1 + 3).join('\n');
  assert(result.full.toString('utf8').endsWith(tail));
  assert.equal(lines.slice(endOfSource.afterLine).length, 0);
  assert.equal(endOfSource.nextOffset, null);
  assert.match(result.navigation.instructions, /Bounds are navigation only and do not mean any range has been read/);
  assert.match(result.navigation.instructions, /Follow actual read truncation or continuation notices/);
  assert.match(result.navigation.instructions, /Relevant rereads, including after compaction, remain allowed/);
  assert.match(result.navigation.instructions, /Missing or unread evidence is UNVERIFIED/);
});

test('a truncated recent view keeps whole entries, exact full-source bounds and oversized-entry navigation', async t => {
  const entries = [
    { type: 'user', uuid: 'u', message: { content: 'Current request.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'check', name: 'check', input: {} }] } },
    { type: 'user', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'check', content: '中🙂'.repeat(10000) }] } },
  ];
  const result = await prepare(t, entries);
  const lines = assertWrittenBounds(result);
  assert(result.recent.length <= 24 * 1024);
  assert(result.full.length > 24 * 1024);
  assert.equal(result.navigation.complete, false);
  assert.equal(result.navigation.omittedEntryCount, 1);
  assert.equal(result.navigation.source.entryCount, entries.length);
  for (const row of result.navigation.entries) assert.deepEqual(row.entry, entries[row.sourceIndex]);
  assert(!result.navigation.entries.some(row => row.sourceIndex === 2), 'an oversized entry must be omitted whole');
  const ref = result.navigation.recentToolResults[0];
  assert.equal(ref.index, 2);
  assert.equal(ref.sha256, canonicalDigest(entries[2]));
  const original = lines.slice(ref.startLine - 1, ref.startLine - 1 + ref.lineCount).join('\n').replace(/,\s*$/u, '');
  assert.deepEqual(JSON.parse(original), entries[2]);
  assert.deepEqual(JSON.parse(result.full), { entries }, 'the complete raw source must never be shortened to the recent view');
});

test('bounds bind the current snapshot without changing owner projection or semantic request identity', async t => {
  const snapshot = { invocation: { runId: 'run', sessionId: 'session', ignored: 'not-owner-authority' },
    digest: 'source-digest', lastEntryKey: 'cursor' };
  const first = await prepare(t, [{ type: 'user', message: { content: 'Short.' } }], snapshot);
  const next = await prepare(t, [{ type: 'user', message: { content: 'Longer Unicode内容.' } },
    { type: 'assistant', message: { content: 'A second event.' } }], snapshot);
  for (const result of [first, next]) {
    assertWrittenBounds(result);
    assert.deepEqual(result.navigation.invocation, { runId: 'run', sessionId: 'session' });
    assert(!result.recent.toString('utf8').includes('not-owner-authority'));
    const semantic = JSON.parse(await fs.readFile(result.prepared.semanticReviewRequestPath));
    assert.deepEqual(semantic.runtimeV2.transcript, result.prepared.transcript);
    assert.deepEqual(semantic.runtimeV2.transcriptNavigation, result.prepared.transcriptNavigation);
    assert.equal(sha256(result.recent), result.prepared.transcriptNavigation.sha256);
  }
  assert.notEqual(first.navigation.source.sha256, next.navigation.source.sha256);
  assert.notEqual(first.navigation.source.bounds.byteLength, next.navigation.source.bounds.byteLength);
  assert.notEqual(first.navigation.source.bounds.lineRange.end, next.navigation.source.bounds.lineRange.end);
});
