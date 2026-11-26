import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sourcePage, toolText, createSourceTools } from '../lib/review-task/source-tools.mjs';
import { createLiveSourceTools } from '../lib/review-task/live-source-tools.mjs';
import { captureFiles, covers, disclosedRange } from '../lib/review-task/evidence-utils.mjs';
import { createTaskEvidence } from '../lib/review-task/task-evidence.mjs';
import { characterApplicabilityCases } from './fixtures/character-applicability.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-character-facts-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a bounded ASCII page reports Han outside the page without disclosing or citing its lines', () => {
  const bytes = Buffer.from('export const value = 1;\n' + '// ASCII\n'.repeat(450) + '// 设备\n');
  assert.equal(bytes.toString('utf8').includes('，'), false, 'the observed punctuation heuristic misses this real condition');
  const first = sourcePage(bytes, { offset: 1, limit: 1 });
  assert.deepEqual(first.details.page, { start: 1, end: 1, totalLines: 453, nextOffset: 2 });
  assert.deepEqual(first.details.fileFacts, { scope: 'entire-named-file', sha256: digest(bytes),
    utf8Valid: true, asciiOnly: false, nonAsciiCodePoints: 2, hanCodePoints: 2 });
  assert.doesNotMatch(toolText(first), /设备/u, 'metadata must not disclose unread source text');
  assert.match(toolText(first), /"hanCodePoints":2/u, 'facts must reach the model, not only transport details');
  assert.deepEqual(disclosedRange(bytes, { offset: 1, limit: 1 }, first), { start: 1, end: 1 });
  const last = sourcePage(bytes, { offset: 452, limit: 1, numbered: true });
  assert.deepEqual(last.details.fileFacts, first.details.fileFacts);
  assert.deepEqual(disclosedRange(bytes, { offset: 452, limit: 1, numbered: true }, last), { start: 452, end: 452 });
});

test('full-file facts distinguish ASCII, escaped text, punctuation and astral Han code points', () => {
  for (const [text, asciiOnly, hanCodePoints, nonAsciiCodePoints] of [
    ['const text = "\\u4e00";\r\n', true, 0, 0],
    ['// ，é', false, 0, 2],
    ['// \u{20000}设备', false, 3, 3],
    ['\ufeffconst value = 1;', false, 0, 1],
  ]) {
    const bytes = Buffer.from(text), facts = sourcePage(bytes).details.fileFacts;
    assert.deepEqual({ asciiOnly: facts.asciiOnly, hanCodePoints: facts.hanCodePoints, nonAsciiCodePoints: facts.nonAsciiCodePoints },
      { asciiOnly, hanCodePoints, nonAsciiCodePoints });
    assert.equal(facts.sha256, digest(bytes));
  }
  assert.throws(() => sourcePage(Buffer.from([0xff])), /Only UTF-8/u);
  assert.throws(() => sourcePage(Buffer.from('ASCII\0')), /Only UTF-8/u);
});

test('live and frozen readers expose identical facts for the same named original bytes', async t => {
  const root = await workspace(t), file = path.join(root, 'app.mjs');
  await fs.writeFile(file, 'export const value = 1;\n// 设备\n', 'utf8');
  const frozen = createSourceTools(root, await captureFiles(root));
  const live = createLiveSourceTools(root);
  const reads = await Promise.all([frozen, live].map(tools => tools.find(tool => tool.name === 'read')
    .execute('read', { path: 'app.mjs', offset: 1, limit: 1 })));
  assert.deepEqual(reads[0].details.fileFacts, reads[1].details.fileFacts);
  assert.equal(reads[0].details.fileFacts.hanCodePoints, 2);
  for (const read of reads) assert.deepEqual(read.details.page, { start: 1, end: 1, totalLines: 3, nextOffset: 2 });
});

test('legacy exact receipts remain bounded and cannot introduce forged character facts', () => {
  const bytes = Buffer.from('ASCII\n设备'), args = { offset: 1, limit: 1 };
  const legacy = { content: [{ type: 'text', text: 'ASCII\n[RC page {"start":1,"end":1,"totalLines":2,"nextOffset":2}]' }],
    details: { page: { start: 1, end: 1, totalLines: 2, nextOffset: 2 } } };
  assert.deepEqual(disclosedRange(bytes, args, legacy), { start: 1, end: 1 });
  assert.equal(legacy.details.fileFacts, undefined);
  const forged = structuredClone(sourcePage(bytes, args));
  for (const block of forged.content) block.text = block.text.replace('"hanCodePoints":2', '"hanCodePoints":0');
  assert.equal(disclosedRange(bytes, args, forged), null);
  assert.equal(disclosedRange(Buffer.from('ASCII\nunchanged visible line, different tail'), args, sourcePage(bytes, args)), null,
    'whole-file facts cannot be reassociated with different bytes outside the disclosed range');
  const forgedLegacy = structuredClone(legacy);
  forgedLegacy.details.page.end = 2;
  assert.equal(disclosedRange(bytes, args, forgedLegacy), null);
  assert.equal(sourcePage(bytes, { ...args, legacyPageFormat: true }).details.fileFacts.hanCodePoints, 2,
    'tool arguments cannot request the internal legacy format');
});

test('facts for one frozen part do not claim to describe the larger original document', async t => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'part-0000.txt'), 'ASCII part', 'utf8');
  await fs.writeFile(path.join(root, 'part-0001.txt'), '设备', 'utf8');
  const read = createSourceTools(root, await captureFiles(root)).find(tool => tool.name === 'read');
  const first = await read.execute('first', { path: 'part-0000.txt' });
  const second = await read.execute('second', { path: 'part-0001.txt' });
  assert.equal(first.details.fileFacts.scope, 'entire-named-file');
  assert.equal(first.details.fileFacts.asciiOnly, true);
  assert.equal(second.details.fileFacts.hanCodePoints, 2);
  assert.notEqual(first.details.fileFacts.sha256, second.details.fileFacts.sha256);
});

test('whole-file facts cannot forge a receipt, expand read coverage or survive a source change', async t => {
  const root = await workspace(t), file = path.join(root, 'app.mjs');
  await fs.writeFile(file, 'export const value = 1;\n// 设备', 'utf8');
  const evidence = await createTaskEvidence({ root, workspaceRoot: root, active() {}, journal: { appendMessage() {} } });
  const read = evidence.tools.find(tool => tool.name === 'source_read');
  const receipt = (id, value) => ({ isSynthetic: false, toolName: 'source_read', toolCallId: id,
    message: { role: 'toolResult', toolName: 'source_read', toolCallId: id, isError: false, content: value.content } });
  const forged = structuredClone(await read.execute('forged', { path: 'app.mjs', offset: 1, limit: 1 }));
  for (const block of forged.content) block.text = block.text.replace('"hanCodePoints":2', '"hanCodePoints":0');
  evidence.observeReceipt(receipt('forged', forged));
  assert.equal(evidence.reads.length, 0);
  assert.equal(evidence.registry.size, 0);
  const first = await read.execute('first', { path: 'app.mjs', offset: 1, limit: 1 });
  assert.equal(first.details.fileFacts.hanCodePoints, 2);
  assert.equal(evidence.reads.length, 0, 'facts are not an observed read receipt');
  evidence.observeReceipt(receipt('first', first));
  assert.equal(covers(evidence.reads, file, 1, 1), true);
  assert.equal(covers(evidence.reads, file, 1, 2), false, 'mandatory original reading still needs the undisclosed line');
  assert.deepEqual([...evidence.registry.values()].map(ref => [ref.start, ref.end]), [[1, 1]]);
  await fs.writeFile(file, 'export const value = 1;\n// 文字', 'utf8');
  await assert.rejects(evidence.assertFrozen(), { code: 'BASELINE_INPUT_CHANGED' });
});

test('conditional semantic fixtures record actual writes and distinguish a missing action from an inactive condition', async t => {
  const root = await workspace(t);
  for (const fixture of characterApplicabilityCases) {
    const file = path.join(root, fixture.id + '.mjs'), entries = await fixture.prepare({ file });
    const bytes = await fs.readFile(file), page = sourcePage(bytes, { offset: 1, limit: 400 });
    const calls = entries.filter(x => x.type === 'assistant').map(x => x.message.content[0]);
    const reads = calls.filter(x => x.name === 'Read');
    assert.equal(fixture.applicabilityKind, 'CONDITIONAL');
    assert.equal(calls[0].name, 'Write');
    assert.equal(bytes.toString('utf8'), fixture.code);
    assert.equal(bytes.toString('utf8').includes('，'), false);
    assert.doesNotMatch(bytes.toString('utf8').split('\n').slice(0, 400).join('\n'), /\p{Script=Han}/u);
    assert.equal(page.details.fileFacts.hanCodePoints > 0, fixture.expected !== 'NOT_APPLICABLE');
    assert.equal(reads.length, fixture.expected === 'PASS' ? 1 : 0);
    if (reads.length) {
      const observed = entries.find(x => x.type === 'user' && x.message.content[0].tool_use_id === reads[0].id);
      assert.equal(observed.message.content[0].content, fixture.code);
    }
  }
});

test('live JSONL projection keeps line positions and binds the version without granting raw coverage', async t => {
  const root = await workspace(t), file = path.join(root, 'table.jsonl');
  const row = (key, limit, detail) => JSON.stringify({ key, limit, detail }) + '\n';
  const bytes = Buffer.from(row('A', 1, 'long context '.repeat(4200)) + row('B', 2, 'tail'));
  await fs.writeFile(file, bytes);
  const evidence = await createTaskEvidence({ root, workspaceRoot: root, evidencePolicy: { jsonlProjection: true, byteReading: true },
    active() {}, journal: { appendMessage() {} } });
  const read = evidence.tools.find(tool => tool.name === 'source_read');
  const args = { path: 'table.jsonl', numbered: true, limit: 1, jsonlFields: ['key', 'limit'] };
  const first = await read.execute('projected', args);
  assert.match(toolText(first), /^\[RC field projection\]\n\[1\] \{"key":"A","limit":1\}\n/u);
  assert.equal(first.details.page.nextOffset, 2);
  assert.equal(first.details.fileFacts.sha256, digest(bytes));
  assert.doesNotMatch(toolText(first), /long context/u);
  const second = await read.execute('next', { ...args, offset: first.details.page.nextOffset });
  assert.match(toolText(second), /\[2\] \{"key":"B","limit":2\}/u);
  assert.equal(disclosedRange(bytes, args, first), null, 'partial fields cannot count as a raw page');
  evidence.observeReceipt({ toolName: 'source_read', toolCallId: 'projected', isSynthetic: false,
    message: { role: 'toolResult', toolName: 'source_read', toolCallId: 'projected', isError: false, content: first.content } });
  assert.equal(evidence.registry.size, 0);
  assert.equal(evidence.reads.length, 0);
  await assert.rejects(read.execute('missing-field', { ...args, jsonlFields: ['absent'] }), /every requested field/u);
  await assert.rejects(read.execute('bytes-and-fields', { ...args, byteOffset: 0, byteLimit: 64 }), /cannot be projected/u);
  await fs.writeFile(file, row('A', 1, 'different original') + row('B', 2, 'tail'));
  await assert.rejects(evidence.assertFrozen({ force: true }), { code: 'BASELINE_INPUT_CHANGED' });
});
