import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLiveSourceTools } from '../lib/review-task/live-source-tools.mjs';
import { toolText } from '../lib/review-task/source-tools.mjs';

async function fixture(t, files, bytes = 64) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-budget-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(root, file), body);
  const observed = [];
  const tools = createLiveSourceTools(root, { navigationBudget: { entries: 32, bytes },
    onSearchFile(file, data) { observed.push({ file: path.basename(file), bytes: Buffer.from(data) }); } });
  const grep = tools.find(tool => tool.name === 'grep');
  return { root, observed, tools, grep: async signal => JSON.parse(toolText(await grep.execute('grep', { pattern: 'needle' }, signal))) };
}
function monitor(t, root, onRead = () => {}) {
  const stats = { bytes: 0, opened: [], closed: 0 }, originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (path.dirname(String(args[0])) !== root) return handle;
    stats.opened.push(path.basename(args[0]));
    const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
    handle.read = async (...args) => { const value = await originalRead(...args); stats.bytes += value.bytesRead; onRead(value); return value; };
    handle.close = async () => { stats.closed++; return originalClose(); };
    return handle;
  });
  return stats;
}
function growAfterStat(t, file, body) {
  let count = 0; const original = fs.stat;
  t.mock.method(fs, 'stat', async (...args) => {
    const stat = await original(...args);
    if (args[0] === file && ++count === 2) await fs.appendFile(file, body);
    return stat;
  });
}

test('growth after real stat cannot exceed the search budget plus one EOF probe or become full evidence', async t => {
  const f = await fixture(t, { 'growing.txt': 'seed\n' });
  growAfterStat(t, path.join(f.root, 'growing.txt'), 'no-match'.repeat(1024) + '\nneedle\n');
  const io = monitor(t, f.root), result = await f.grep();
  assert.equal(result.scanIncomplete, true);
  assert.deepEqual(result.hits, []); assert.equal(result.nextOffset, null);
  assert.match(result.hint, /incomplete.*Narrow/su);
  assert.equal(f.observed.length, 0, 'partial input must not be registered as a complete file');
  assert.equal(io.bytes, 65); assert.equal(result.scanned.bytes, 64); assert.equal(result.scanned.probeBytes, 1);
  assert.equal(io.closed, io.opened.length);
  const direct = f.tools.find(tool => tool.name === 'read');
  assert.match(toolText(await direct.execute('full', { path: 'growing.txt' })), /needle/u);
});

test('a complete file at the exact byte budget retains its exact original callback and literal hit', async t => {
  const content = 'needle!\n', f = await fixture(t, { 'a.txt': content }, Buffer.byteLength(content));
  const io = monitor(t, f.root), result = await f.grep();
  assert.equal(result.scanIncomplete, undefined);
  assert.equal(result.hits.length, 1); assert.match(result.hits[0], /a\.txt:1:needle!/u);
  assert.equal(io.bytes, Buffer.byteLength(content)); assert.equal(io.closed, io.opened.length);
  assert.deepEqual(f.observed.map(row => row.bytes), [Buffer.from(content)]);
});

test('a filled byte budget never opens the following source file', async t => {
  const f = await fixture(t, { 'a.txt': 'none', 'b.txt': 'needle' }, 4);
  const io = monitor(t, f.root), result = await f.grep();
  assert.equal(result.scanIncomplete, true); assert.deepEqual(result.hits, []);
  assert.deepEqual(io.opened, ['a.txt']); assert.equal(io.bytes, 4);
  assert.deepEqual(f.observed.map(row => row.file), ['a.txt']); assert.equal(io.closed, 1);
});

test('grep continues to other files when an enumerated cache disappears or changes type', async t => {
  for (const [operation, replace] of [['stat', false], ['open', false], ['open', true]]) await t.test(`${operation} ${replace ? 'replacement' : 'deletion'}`, async t => {
    const f = await fixture(t, { 'a-cache.log': 'needle in cache\n', 'z-source.txt': 'needle in source\n' });
    const cache = path.join(f.root, 'a-cache.log'), original = fs[operation];
    const deleteOnCall = operation === 'stat' ? 2 : 1;
    let attempts = 0;
    t.mock.method(fs, operation, async (...args) => {
      if (args[0] === cache && ++attempts === deleteOnCall) {
        await fs.unlink(cache);
        if (replace) await fs.mkdir(cache);
      }
      return original(...args);
    });
    const result = await f.grep();
    assert.equal(attempts, deleteOnCall);
    assert.equal(result.navigationOnly, true);
    assert.deepEqual(result.hits, [`${path.join(f.root, 'z-source.txt')}:1:needle in source`]);
    assert.deepEqual(f.observed.map(row => row.file), ['z-source.txt']);
  });
});

test('cancellation after actual bounded I/O closes the handle and registers no source', async t => {
  const f = await fixture(t, { 'a.txt': 'needle\n' }), controller = new AbortController(), reason = new Error('cancel bounded read');
  const io = monitor(t, f.root, () => controller.abort(reason));
  await assert.rejects(f.grep(controller.signal), error => error === reason);
  assert.equal(io.opened.length, 1); assert.equal(io.closed, 1); assert.equal(f.observed.length, 0);
});

test('a bounded-reader failure releases the actual handle without a success callback', async t => {
  const f = await fixture(t, { 'a.txt': 'needle\n' }), original = fs.open, failure = new Error('controlled read failure');
  let closed = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args), close = handle.close.bind(handle);
    handle.read = async () => { throw failure; };
    handle.close = async () => { closed++; return close(); };
    return handle;
  });
  await assert.rejects(f.grep(), error => error === failure);
  assert.equal(closed, 1); assert.equal(f.observed.length, 0);
});

test('a file growing beyond the per-file cap is incomplete even when total budget has room', async t => {
  const f = await fixture(t, { 'a.txt': 'small\n' }, 8 * 1024 * 1024);
  growAfterStat(t, path.join(f.root, 'a.txt'), 'x'.repeat(4 * 1024 * 1024) + '\nneedle');
  const io = monitor(t, f.root), result = await f.grep();
  assert.equal(result.scanIncomplete, true); assert.deepEqual(result.hits, []); assert.equal(f.observed.length, 0);
  assert.equal(io.bytes, 4 * 1024 * 1024 + 1); assert.equal(io.closed, 1);
});

test('wide grep reports a skipped large file and exact-path grep can find its tail within budget', async t => {
  const large = '//'.padEnd(4 * 1024 * 1024, 'x') + '\nneedle at tail\n';
  const f = await fixture(t, { 'a.ts': large, 'z.ts': 'needle at root' }, Buffer.byteLength(large) + 64);
  const broad = await f.grep();
  const file = path.join(f.root, 'a.ts');
  assert.equal(broad.scanIncomplete, true);
  assert.equal(broad.scanned.skippedLargeFiles, 1);
  assert.equal(broad.scanned.firstSkippedPath, file);
  assert.deepEqual(broad.hits, [path.join(f.root, 'z.ts') + ':1:needle at root']);
  assert.deepEqual(f.observed.map(row => row.file), ['z.ts']);
  const grep = f.tools.find(tool => tool.name === 'grep');
  const direct = JSON.parse(toolText(await grep.execute('exact', { path: file, pattern: 'needle' })));
  assert.equal(direct.scanIncomplete, undefined);
  assert.equal(direct.navigationOnly, true);
  assert.deepEqual(direct.hits, [file + ':2:needle at tail']);
  assert.deepEqual(f.observed.at(-1).bytes, Buffer.from(large));
  const bounded = createLiveSourceTools(f.root, { navigationBudget: { entries: 2, bytes: Buffer.byteLength(large) - 1 } })
    .find(tool => tool.name === 'grep');
  const limited = JSON.parse(toolText(await bounded.execute('exact', { path: file, pattern: 'needle' })));
  assert.equal(limited.scanIncomplete, true);
  assert.equal(limited.scanned.bytes, 0);
});
