import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSourceTools, sourcePage, createSourcePager } from '../lib/review-task/source-tools.mjs';
import { createLiveSourceTools } from '../lib/review-task/live-source-tools.mjs';
import { createDocumentTools } from '../lib/document-tools.mjs';
import { createTaskEvidence } from '../lib/review-task/task-evidence.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-reader-lifecycle-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'source.txt');
  const bytes = Buffer.from('\ufeff' + Array.from({ length: 850 }, (_, i) => `${i}: 条件😀\r`).join('\n') + '\n');
  await fs.writeFile(file, bytes);
  return { root, file, bytes };
}
const readers = root => [createSourceTools(root, new Map([['source.txt', {}]])), createLiveSourceTools(root)]
  .map(tools => tools.find(tool => tool.name === 'read'));

test('readers reject cancellation at the real file-read completion boundary', async t => {
  const f = await fixture(t), reason = new Error('cancel after real I/O'), original = fs.readFile;
  for (const kind of ['frozen', 'live', 'document']) await t.test(kind, async t => {
    const controller = new AbortController();
    const read = kind === 'document'
      ? await createDocumentTools({ projectRoot: f.root, semantic: { artifactFiles: ['source.txt'] }, signal: controller.signal })
      : readers(f.root)[kind === 'frozen' ? 0 : 1];
    const mock = t.mock.method(fs, 'readFile', async (...args) => {
      const bytes = await original(...args);
      if (String(args[0]) === f.file) controller.abort(reason);
      return bytes;
    });
    try {
      const pending = kind === 'document' ? read.execute({ action: 'read', path: 'source.txt', count: 1 })
        : read.execute('cancelled', { path: 'source.txt', offset: 1, limit: 1 }, controller.signal);
      await assert.rejects(pending, error => error === reason);
    } finally { mock.mock.restore(); }
  });
});

test('cancelled document reads do not qualify a file for private notes', async t => {
  const f = await fixture(t), reason = new Error('lease cancelled'), original = fs.readFile;
  let cancelled = false;
  const tools = await createDocumentTools({ projectRoot: f.root, semantic: { artifactFiles: ['source.txt'] },
    active() { if (cancelled) throw reason; } });
  const mock = t.mock.method(fs, 'readFile', async (...args) => {
    const bytes = await original(...args); if (String(args[0]) === f.file) cancelled = true; return bytes;
  });
  await assert.rejects(tools.execute({ action: 'read', path: 'source.txt' }), error => error === reason);
  mock.mock.restore(); cancelled = false;
  await assert.rejects(tools.execute({ action: 'remember', key: 'cancelled', note: 'not observed', paths: ['source.txt'] }), /CURRENT_READS/u);
});

test('repeated source pages remain byte-identical and return independent receipt metadata', async t => {
  const f = await fixture(t);
  for (const read of readers(f.root)) {
    for (const offset of [1, 401, 801, 1]) {
      const args = { path: 'source.txt', offset, limit: 400 };
      const page = await read.execute('page', args);
      assert.deepEqual(page, sourcePage(f.bytes, args));
      page.details.fileFacts.hanCodePoints = -1;
      page.details.page.end = 999999;
      page.content[0].text = 'mutated caller output';
    }
    assert.deepEqual(await read.execute('again', { path: 'source.txt' }), sourcePage(f.bytes));
  }
});

test('same-size same-time edits and invalid UTF-8 cannot reuse earlier page facts', async t => {
  const f = await fixture(t);
  for (const read of readers(f.root)) {
    await fs.writeFile(f.file, 'ASCII\n汉');
    const before = await read.execute('before', { path: 'source.txt', limit: 1 });
    const stat = await fs.stat(f.file);
    await fs.writeFile(f.file, 'ASCII\nabc');
    await fs.utimes(f.file, stat.atime, stat.mtime);
    const after = await read.execute('after', { path: 'source.txt', limit: 1 });
    assert.notEqual(after.details.fileFacts.sha256, before.details.fileFacts.sha256);
    assert.equal(after.details.fileFacts.asciiOnly, true);
    assert.equal(after.details.fileFacts.hanCodePoints, 0);
    await fs.writeFile(f.file, Buffer.from([0xff]));
    await assert.rejects(read.execute('invalid', { path: 'source.txt' }), /Only UTF-8/u);
  }
});

test('cached content never bypasses frozen path selection or live path observation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'same.txt'), f.bytes);
  const frozen = readers(f.root)[0];
  await frozen.execute('allowed', { path: 'source.txt', limit: 1 });
  await assert.rejects(frozen.execute('not-in-snapshot', { path: 'same.txt', limit: 1 }), /frozen snapshot/u);
  const paths = [];
  const live = createLiveSourceTools(f.root, { onPath(requested, actual) { paths.push([requested, actual]); } }).find(t => t.name === 'read');
  for (const name of ['source.txt', 'same.txt', 'source.txt']) await live.execute('read', { path: name, limit: 1 });
  assert.deepEqual(paths.map(([requested, actual]) => [path.basename(requested), path.basename(actual)]),
    [['source.txt', 'source.txt'], ['same.txt', 'same.txt'], ['source.txt', 'source.txt']]);
});

test('a failed live read leaves no dependency when the unread file is removed', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, Buffer.from([0xff]));
  const evidence = await createTaskEvidence({ root: f.root, workspaceRoot: f.root, active() {}, journal: { appendMessage() {} } });
  const read = evidence.tools.find(tool => tool.name === 'source_read');
  await assert.rejects(read.execute('failed', { path: 'source.txt' }), /Only UTF-8/u);
  await fs.unlink(f.file);
  await evidence.assertFrozen();
  assert.deepEqual([...evidence.resolutions], []);
  assert.deepEqual([...evidence.snapshot], []);
});

test('a live read rejects bytes replaced before its page is issued, then can reread the current file', async t => {
  const f = await fixture(t);
  const evidence = await createTaskEvidence({ root: f.root, workspaceRoot: f.root, active() {}, journal: { appendMessage() {} } });
  const read = evidence.tools.find(tool => tool.name === 'source_read');
  const readFile = fs.readFile;
  let replaced = false;
  const mock = t.mock.method(fs, 'readFile', async (...args) => {
    const bytes = await readFile(...args);
    if (!replaced && args[0] === f.file) {
      replaced = true;
      await fs.writeFile(f.file, 'The replacement is current.\n');
    }
    return bytes;
  });
  try {
    await assert.rejects(read.execute('racing', { path: 'source.txt' }), { code: 'BASELINE_INPUT_CHANGED' });
  } finally { mock.mock.restore(); }
  assert.equal(replaced, true);
  assert.equal(evidence.resolutions.size, 0);
  assert.equal(evidence.snapshot.size, 0);
  const current = await read.execute('reread', { path: 'source.txt' });
  assert.match(current.content[0].text, /The replacement is current/u);
  assert(current.details.citation);
  await evidence.assertFrozen();
});

test('removing a successfully read file invalidates its evidence with an input change', async t => {
  const f = await fixture(t);
  const evidence = await createTaskEvidence({ root: f.root, workspaceRoot: f.root, active() {}, journal: { appendMessage() {} } });
  const read = evidence.tools.find(tool => tool.name === 'source_read');
  const page = await read.execute('present', { path: 'source.txt' });
  assert(page.details.citation);
  await fs.unlink(f.file);
  await assert.rejects(evidence.assertFrozen(), { code: 'BASELINE_INPUT_CHANGED' });
});

test('the final evidence reread detects a write before freshness checking completes', async t => {
  const f = await fixture(t);
  const evidence = await createTaskEvidence({ root: f.root, workspaceRoot: f.root, active() {}, journal: { appendMessage() {} } });
  await evidence.tools.find(tool => tool.name === 'source_read').execute('verified', { path: 'source.txt' });
  const readFile = fs.readFile;
  const mock = t.mock.method(fs, 'readFile', async (...args) => {
    const bytes = await readFile(...args);
    if (args[0] === f.file) await fs.writeFile(f.file, 'The source changed during the final check.\n');
    return bytes;
  });
  try { await assert.rejects(evidence.assertFrozen({ force: true }), { code: 'BASELINE_INPUT_CHANGED' }); }
  finally { mock.mock.restore(); }
});

test('parsed-source caching evicts at both limits and never retains an oversized source', t => {
  const original = Buffer.prototype.toString;
  let decodes = 0;
  t.mock.method(Buffer.prototype, 'toString', function (...args) { decodes++; return original.apply(this, args); });
  const page = createSourcePager(), small = Array.from({ length: 9 }, (_, i) => Buffer.from(`source ${i}`));
  const read = bytes => page(bytes, { limit: 1 });
  for (const bytes of small) read(bytes);
  const afterNine = decodes;
  read(small[8]); assert.equal(decodes, afterNine, 'recent source should remain parsed');
  read(small[0]); assert.equal(decodes, afterNine + 1, 'the ninth identity evicts the oldest');
  const sized = createSourcePager();
  const a = Buffer.from('a\n'.repeat(700000)), b = Buffer.from('b\n'.repeat(700000)), c = Buffer.from('c\n'.repeat(700000));
  for (const bytes of [a, b, c]) sized(bytes, { limit: 1 });
  const afterBudget = decodes;
  sized(c, { limit: 1 }); assert.equal(decodes, afterBudget);
  sized(a, { limit: 1 }); assert.equal(decodes, afterBudget + 1, 'total source-byte budget evicts old content');
  const oversized = Buffer.from('x\n'.repeat(2100000));
  const beforeLarge = decodes;
  for (let i = 0; i < 2; i++) sized(oversized, { limit: 1 });
  assert.equal(decodes, beforeLarge + 2, 'one source above 4 MiB must be reparsed each time');
});
