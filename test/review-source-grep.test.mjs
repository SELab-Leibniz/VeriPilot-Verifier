import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import { createSourceTools, toolText } from '../lib/review-task/source-tools.mjs';

async function fixture(t, files) {
  const parent = path.resolve('.runtime-correction/source-grep-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, bytes] of Object.entries(files)) await fs.writeFile(path.join(root, file), bytes);
  return { root, grep: createSourceTools(root, new Map(Object.keys(files).map(file => [file, {}]))).find(tool => tool.name === 'grep') };
}

test('grep stops reading a large matching file at 100 hits and never opens later files', async t => {
  const f = await fixture(t, { 'a.txt': 'needle\n'.repeat(200000) + 'unscanned tail\n'.repeat(100000), 'z.txt': 'needle\n' });
  const original = nativeFs.createReadStream; let bytesRead = 0; const opened = [];
  t.mock.method(nativeFs, 'createReadStream', (file, options) => {
    opened.push(path.basename(file)); const stream = original(file, options);
    stream.on('data', chunk => { bytesRead += chunk.length; }); return stream;
  });
  const output = JSON.parse(toolText(await f.grep.execute('bounded', { pattern: 'needle' })));
  assert.equal(output.hits.length, 100); assert.equal(output.possiblyTruncated, true);
  assert.match(output.hits[99], /^a\.txt:100:needle$/); assert.deepEqual(opened, ['a.txt']);
  assert(bytesRead <= 128 * 1024, `Only a bounded stream prefix should be consumed, read ${bytesRead} bytes`);
});
test('grep observes cancellation while scanning one large file with no hits', async t => {
  const f = await fixture(t, { 'a.txt': 'no match here\n'.repeat(1000000) });
  const controller = new AbortController(), reason = new Error('cancel scan'), original = nativeFs.createReadStream;
  let bytesRead = 0, opened = false;
  t.mock.method(nativeFs, 'createReadStream', (file, options) => {
    opened = true; const stream = original(file, options);
    stream.on('data', chunk => { bytesRead += chunk.length; });
    stream.once('data', () => setImmediate(() => controller.abort(reason))); return stream;
  });
  await assert.rejects(f.grep.execute('cancelled', { pattern: 'absent' }, controller.signal), error => error === reason);
  assert(opened); assert(bytesRead < 256 * 1024, `Cancellation must stop the scan, read ${bytesRead} bytes`);
});
test('grep retains literal matches and line numbers across UTF-8 chunk and CRLF boundaries', async t => {
  const f = await fixture(t, { 'a.txt': 'a'.repeat(65534) + '针needle\r\nsecond needle\r\nlast needle' });
  const output = JSON.parse(toolText(await f.grep.execute('chunks', { pattern: 'needle' })));
  assert.equal(output.hits.length, 3); assert.match(output.hits[0], /^a\.txt:1:a{300}$/);
  assert.equal(output.hits[1], 'a.txt:2:second needle\r'); assert.equal(output.hits[2], 'a.txt:3:last needle');
});
test('grep enforces the remaining hit cap across files and skips invalid/binary input', async t => {
  const f = await fixture(t, { 'a.txt': 'needle\n'.repeat(60), 'b.txt': 'needle\n'.repeat(200), 'binary.txt': Buffer.from('needle\0'), 'invalid.txt': Buffer.from([255, 254]) });
  const output = JSON.parse(toolText(await f.grep.execute('global-limit', { pattern: 'needle' })));
  assert.equal(output.hits.length, 100); assert.equal(output.hits.filter(hit => hit.startsWith('b.txt:')).length, 40);
  const invalid = JSON.parse(toolText(await f.grep.execute('invalid', { path: 'invalid.txt', pattern: 'needle' })));
  assert.deepEqual(invalid.hits, []);
  const binary = JSON.parse(toolText(await f.grep.execute('binary', { path: 'binary.txt', pattern: 'needle' })));
  assert.deepEqual(binary.hits, []);
});
