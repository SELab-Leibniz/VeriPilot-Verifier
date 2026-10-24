import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';
import { captureFiles, covers, disclosedRange, validateDecision, excerpt, registerCitation } from './review-task.mjs';

async function fixture(t) {
  const testRoot = fileURLToPath(new URL('../../../unit-test-runs-v2/', import.meta.url));
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'single-review-'));
  await fs.writeFile(path.join(root, 'basis.md'), 'Condition\nException');
  await fs.writeFile(path.join(root, 'app.py'), 'check()\nsave()');
  const registry = new Map();
  const bytes = await fs.readFile(path.join(root, 'app.py'));
  const citation = { citeId: 'cite-fixture', path: 'app.py', start: 1, end: 1, sha256: (await captureFiles(root)).get('app.py').sha256, ...excerpt(bytes, 1, 1), rangeKind: 'range' };
  registry.set(citation.citeId, citation);
  return { root, registry, task: { id: 'R04', requirement: 'Check before save.', basisFiles: ['basis.md'], targetFiles: ['app.py'] }, snapshot: await captureFiles(root), reads: [{ path: 'basis.md', start: 1, end: 2 }, { path: 'app.py', start: 1, end: 1 }] };
}
const decision = { taskId: 'R04', verdict: 'DEVIATION', reason: 'State is saved before validation, leaving invalid state persisted.', citeIds: ['cite-fixture'] };

test('joining adjacent read ranges preserves gaps', () => {
  const reads = [{ path: 'a', start: 3, end: 4 }, { path: 'a', start: 1, end: 2 }, { path: 'a', start: 6, end: 9 }];
  assert.equal(covers(reads, 'a', 1, 4), true);
  assert.equal(covers(reads, 'a', 1, 6), false);
});
test('a conclusive decision binds citations to the frozen bytes', async t => {
  const input = await fixture(t);
  const result = await validateDecision({ ...input, decision });
  assert.equal(result.refs[0].sha256, input.snapshot.get('app.py').sha256);
});
test('an unread exception prevents acceptance', async t => {
  const input = await fixture(t); input.reads[0].end = 1;
  await assert.rejects(validateDecision({ ...input, decision }), /basis not fully read/u);
});
test('citation to an unread range or outside file is rejected', async t => {
  const input = await fixture(t);
  const bytes = await fs.readFile(path.join(input.root, 'app.py'));
  const unread = registerCitation({ registry: input.registry, bytes, file: 'app.py', sha256: input.snapshot.get('app.py').sha256, range: { start: 1, end: 2 } });
  await assert.rejects(validateDecision({ ...input, decision: { ...decision, citeIds: [unread.citeId] } }), /Unread or invalid citation/u);
  await assert.rejects(validateDecision({ ...input, decision: { ...decision, citeIds: ['foreign-id'] } }), /Unknown citation/u);
});
test('source mutation invalidates a previously acceptable decision', async t => {
  const input = await fixture(t);
  await fs.writeFile(path.join(input.root, 'app.py'), 'different()');
  await assert.rejects(validateDecision({ ...input, decision }), /STALE/u);
});
test('no findings or a foreign task cannot silently become PASS', async t => {
  const input = await fixture(t);
  await assert.rejects(validateDecision({ ...input, decision: { comments: [] } }), /Wrong task/u);
  await assert.rejects(validateDecision({ ...input, decision: { ...decision, taskId: 'other' } }), /Wrong task/u);
  await assert.rejects(validateDecision({ ...input, decision: { ...decision, verdict: 'PASS', citeIds: [] } }), /requires source evidence/u);
});
test('UNVERIFIED can preserve the infrastructure failure without false evidence', async t => {
  const input = await fixture(t);
  const result = await validateDecision({ ...input, reads: [], decision: { taskId: 'R04', verdict: 'UNVERIFIED', reason: 'Required source cannot be read', citeIds: [] } });
  assert.equal(result.verdict, 'UNVERIFIED');
});
test('a missing basis list or target list cannot become PASS', async t => {
  const input = await fixture(t);
  for (const task of [{ id: 'R04', basisFiles: [], targetFiles: ['app.py'] }, { id: 'R04', basisFiles: ['basis.md'] }])
    await assert.rejects(validateDecision({ ...input, task, decision: { ...decision, verdict: 'PASS' } }), /Task requires/u);
});
test('both conclusive verdicts require every basis and a current target citation', async t => {
  const input = await fixture(t);
  await fs.writeFile(path.join(input.root, 'exception.md'), 'Exception');
  input.snapshot = await captureFiles(input.root);
  input.task.basisFiles.push('exception.md');
  const basisCite = registerCitation({ registry: input.registry, bytes: await fs.readFile(path.join(input.root, 'basis.md')), file: 'basis.md', sha256: input.snapshot.get('basis.md').sha256, range: { start: 1, end: 1 } });
  for (const verdict of ['PASS', 'DEVIATION']) {
    await assert.rejects(validateDecision({ ...input, decision: { ...decision, verdict } }), /basis not fully read/u);
    await assert.rejects(validateDecision({ ...input, task: { ...input.task, basisFiles: ['basis.md'] },
      decision: { ...decision, verdict, citeIds: [basisCite.citeId] } }), /current target source/u);
  }
});
async function nativePage(t, content, args = {}) {
  const input = await fixture(t), bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(path.join(input.root, 'page.txt'), bytes);
  const result = await createReadToolDefinition(input.root).execute('read-test', { path: 'page.txt', ...args });
  return { bytes, result, range: disclosedRange(bytes, args, result) };
}
test('native byte truncation grants only complete actually disclosed lines', async t => {
  const { bytes, result, range } = await nativePage(t, Array.from({ length: 80 }, () => 'x'.repeat(1500)).join('\n'));
  assert.equal(result.details.truncation.truncatedBy, 'bytes');
  assert.deepEqual(range, { start: 1, end: result.details.truncation.outputLines });
  assert.equal(covers([{ path: 'basis.md', ...range }], 'basis.md', 1, bytes.toString().split('\n').length), false);
});
test('a native overlong first line grants no coverage', async t => {
  const { result, range } = await nativePage(t, 'x'.repeat(60000) + '\nexception');
  assert.equal(result.details.truncation.firstLineExceedsLimit, true);
  assert.equal(range, null);
});
test('native line truncation grants no undisclosed remainder', async t => {
  const { result, range } = await nativePage(t, Array.from({ length: 2200 }, (_, n) => `line ${n}`).join('\n'));
  assert.equal(result.details.truncation.truncatedBy, 'lines');
  assert.deepEqual(range, { start: 1, end: 2000 });
});
test('a real native image result never becomes text line coverage', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kdaoAAAAASUVORK5CYII=', 'base64');
  const { result, range } = await nativePage(t, png);
  assert.match(result.content[0].text, /Read image file/u);
  assert.equal(range, null);
});
test('native BOM and CRLF pages require exact bytes and can join to full coverage', async t => {
  const bytes = Buffer.from('\uFEFFcondition\r\nexception\r\n');
  const first = await nativePage(t, bytes, { limit: 1 });
  const rest = await nativePage(t, bytes, { offset: 2 });
  assert.deepEqual(first.range, { start: 1, end: 1 });
  assert.deepEqual(rest.range, { start: 2, end: 3 });
  assert.equal(covers([first.range, rest.range].map(range => ({ path: 'basis.md', ...range })), 'basis.md', 1, 3), true);
  assert.equal(disclosedRange(bytes, { limit: 1 }, { content: [{ type: 'text', text: first.result.content[0].text.replace('\uFEFF', '').replaceAll('\r', '') }] }), null);
});
test('unknown pages, image notes, binary bytes and invalid offsets grant no coverage', () => {
  const text = Buffer.from('condition\nexception');
  for (const result of [
    { content: [{ type: 'text', text: '[Page 1 of 2]\ncondition' }] },
    { content: [{ type: 'text', text: 'Read image file [image/png]' }] },
    { content: [{ type: 'text', text: text.toString() }, { type: 'image', data: '', mimeType: 'image/png' }] },
    { content: [{ type: 'text', text: text.toString() }], details: { truncation: { outputLines: 2 } } },
  ]) assert.equal(disclosedRange(text, {}, result), null);
  assert.equal(disclosedRange(Buffer.from([255, 254]), {}, { content: [{ type: 'text', text: '\uFFFD\uFFFD' }] }), null);
  assert.equal(disclosedRange(text, { offset: 0 }, { content: [{ type: 'text', text: text.toString() }] }), null);
});


test('a task without a concrete nonempty question is rejected', async t => {
  const input = await fixture(t);
  for (const requirement of [undefined, '', '   ']) await assert.rejects(validateDecision({ ...input, task: { ...input.task, requirement }, decision }), /nonempty requirement/u);
});

test('opaque citations are run-local and offsets cannot be altered', async t => {
  const first = await fixture(t), second = await fixture(t);
  const ref = registerCitation({ registry: first.registry, bytes: await fs.readFile(path.join(first.root, 'app.py')), file: 'app.py', sha256: first.snapshot.get('app.py').sha256, range: { start: 1, end: 1 } });
  await assert.rejects(validateDecision({ ...second, decision: { ...decision, citeIds: [ref.citeId] } }), /Unknown citation/u);
  first.registry.set(ref.citeId, { ...ref, byteEnd: ref.byteEnd + 1 });
  await assert.rejects(validateDecision({ ...first, decision: { ...decision, citeIds: [ref.citeId] } }), /Tampered citation/u);
});

test('the model cannot submit fabricated paths, line numbers or quotations', async t => {
  const input = await fixture(t);
  for (const extra of [{ quote: 'invented' }, { refs: [{ path: 'app.py', start: 1, end: 1 }] }, { path: 'app.py' }])
    await assert.rejects(validateDecision({ ...input, decision: { ...decision, ...extra } }), /Submit only/u);
});

test('BOM CRLF CJK and emoji excerpts preserve exact byte offsets', () => {
  const bytes = Buffer.from('\uFEFF中文😀\r\n第二行🌷\r\n');
  for (const [start, end] of [[1,1],[2,2],[1,2],[1,3],[3,3]]) {
    const result = excerpt(bytes,start,end);
    assert.deepEqual(Buffer.from(result.text), bytes.subarray(result.byteStart,result.byteEnd));
    assert.equal(result.text, bytes.toString().split('\n').slice(start-1,end).join('\n'));
  }
  assert.equal(excerpt(Buffer.from('a\r\nb\r\n'),1,1).byteEnd,2);
  assert.equal(excerpt(bytes,2,2).byteStart, Buffer.byteLength('\uFEFF中文😀\r\n'));
});
