import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools } from '../lib/document-tools.mjs';

async function fixture(t, bodies, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-document-open-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(bodies)) await fs.writeFile(path.join(root, file), body);
  const tools = await createDocumentTools({ projectRoot: root, semantic: { artifactFiles: Object.keys(bodies) }, ...options });
  return { root, tools };
}
const note = (tools, file) => tools.execute({ action: 'remember', key: 'inspection', note: 'Inspect this current source.', paths: [file] });
const body = (lines, width = 70) => Array.from({ length: lines }, (_, i) => `${i}: ${'a'.repeat(width)}`).join('\n');

test('open reads only disclosed pages and keeps every omitted source explicitly reachable', async t => {
  const bodies = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`doc-${i}.md`, body(80)]));
  const f = await fixture(t, bodies), original = fs.readFile, openedFiles = [];
  const mock = t.mock.method(fs, 'readFile', async (...args) => {
    const value = await original(...args);
    if (Object.keys(bodies).some(file => args[0] === path.join(f.root, file))) openedFiles.push(path.basename(args[0]));
    return value;
  });
  let opened;
  try { opened = await f.tools.execute({ action: 'open' }); } finally { mock.mock.restore(); }
  assert.deepEqual(opened.manifest.map(item => item.path), Object.keys(bodies));
  const disclosed = opened.documents.filter(page => page.lines?.length);
  const omitted = opened.documents.filter(page => page.requiresRead);
  assert(disclosed.length > 0); assert(omitted.length > 0);
  assert.deepEqual(openedFiles, disclosed.map(page => page.path), 'no I/O for a body dropped from this result');
  assert(Buffer.byteLength(JSON.stringify(opened)) <= 8192);
  for (const page of omitted) {
    assert.equal(page.nextLine, 1);
    await assert.rejects(note(f.tools, page.path), /CURRENT_READS/u);
    const read = await f.tools.execute({ action: 'read', path: page.path, count: 200 });
    assert.deepEqual(read.lines.map(line => line.replace(/^\d+: /u, '')), bodies[page.path].split('\n'));
    await note(f.tools, page.path);
  }
});

for (const [name, original] of [
  ['dense ASCII', Array.from({ length: 200 }, () => 'a'.repeat(120)).join('\n')],
  ['JSON escapes and UTF-8', Array.from({ length: 200 }, (_, i) => `${i} ${'"\\漢😀\t'.repeat(20)}\r`).join('\n')],
]) test(`open returns a nonempty exact first page within the JSON budget: ${name}`, async t => {
  const f = await fixture(t, { 'spec.md': original });
  const opened = await f.tools.execute({ action: 'open' }), page = opened.documents[0];
  assert(page.lines?.length > 0, 'normal lines must not cause the complete first page to be dropped');
  assert(Buffer.byteLength(JSON.stringify(opened)) <= 8192);
  const restored = page.lines.map(line => line.replace(/^\d+: /u, ''));
  assert.deepEqual(restored, original.split('\n').slice(0, restored.length));
  assert.equal(page.nextLine, restored.length + 1);
  let next = page.nextLine;
  while (next !== null) {
    const rest = await f.tools.execute({ action: 'read', path: 'spec.md', start: next, count: 200 });
    restored.push(...rest.lines.map(line => line.replace(/^\d+: /u, '')));
    next = rest.nextLine;
  }
  assert.equal(restored.join('\n'), original);
});

test('open preserves earlier explicit read qualification without qualifying omitted or verify-only sources', async t => {
  const f = await fixture(t, { 'first.md': body(200, 120), 'prior.md': 'already read', 'omitted.md': body(200, 120) });
  await f.tools.execute({ action: 'read', path: 'prior.md' });
  const opened = await f.tools.execute({ action: 'open' });
  assert(opened.documents.find(page => page.path === 'omitted.md').requiresRead);
  await note(f.tools, 'prior.md');
  await assert.rejects(note(f.tools, 'omitted.md'), /CURRENT_READS/u);
  await f.tools.verify();
  await assert.rejects(note(f.tools, 'omitted.md'), /CURRENT_READS/u, 'hash verification alone is not disclosed reading');
  await f.tools.execute({ action: 'read', path: 'omitted.md', count: 1 });
  await note(f.tools, 'omitted.md');
});

test('oversized first lines retain host-read guidance and grant no body-read qualification', async t => {
  const f = await fixture(t, { 'long.md': 'a'.repeat(9000) + '\nnext' });
  const opened = await f.tools.execute({ action: 'open' });
  assert.equal(opened.documents[0].requiresHostRead, true);
  const page = await f.tools.execute({ action: 'read', path: 'long.md' });
  assert.deepEqual(page.lines, []); assert.equal(page.requiresHostRead, true); assert.equal(page.nextLine, 1);
  await assert.rejects(note(f.tools, 'long.md'), /CURRENT_READS/u);
});

test('omitted files remain subject to current-hash and final verification checks', async t => {
  const f = await fixture(t, { 'first.md': body(200, 120), 'later.md': body(200, 120) });
  const opened = await f.tools.execute({ action: 'open' });
  assert(opened.documents[1].requiresRead);
  await fs.writeFile(path.join(f.root, 'later.md'), 'changed');
  await assert.rejects(f.tools.execute({ action: 'read', path: 'later.md' }), /EVIDENCE_CHANGED/u);
  await assert.rejects(f.tools.verify(), /EVIDENCE_CHANGED/u);
});

test('a cancelled open publishes neither a successful result nor new note qualification', async t => {
  const reason = new Error('cancel open'), original = fs.readFile;
  let closed = false;
  const f = await fixture(t, { 'prior.md': 'previously read', 'first.md': 'one', 'second.md': 'two' }, { active() { if (closed) throw reason; } });
  await f.tools.execute({ action: 'read', path: 'prior.md' });
  const mock = t.mock.method(fs, 'readFile', async (...args) => {
    const value = await original(...args);
    if (args[0] === path.join(f.root, 'second.md')) closed = true;
    return value;
  });
  try { await assert.rejects(f.tools.execute({ action: 'open' }), error => error === reason); }
  finally { mock.mock.restore(); }
  closed = false;
  await note(f.tools, 'prior.md');
  await assert.rejects(note(f.tools, 'first.md'), /CURRENT_READS/u);
  await assert.rejects(note(f.tools, 'second.md'), /CURRENT_READS/u);
});

test('large legal metadata preserves the full manifest and existing notes without body I/O', async t => {
  const bodies = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${i}-${'name'.repeat(35)}.md`, `source ${i}`]));
  const f = await fixture(t, bodies), names = Object.keys(bodies);
  await f.tools.execute({ action: 'read', path: names[0] });
  for (let i = 0; i < 5; i++) await f.tools.execute({ action: 'remember', key: `prior-${i}`, note: 'n'.repeat(800), paths: [names[0]] });
  const prior = await f.tools.recall(), original = fs.readFile;
  let sourceReads = 0;
  const mock = t.mock.method(fs, 'readFile', async (...args) => {
    const bytes = await original(...args);
    if (names.some(file => args[0] === path.join(f.root, file))) sourceReads++;
    return bytes;
  });
  let opened;
  try { opened = await f.tools.execute({ action: 'open' }); } finally { mock.mock.restore(); }
  assert(Buffer.byteLength(JSON.stringify(opened)) > 8192, 'complete metadata is not truncated to impose a new total-response cap');
  assert.equal(sourceReads, 0);
  assert.deepEqual(opened.manifest.map(row => row.path), names);
  assert.deepEqual(opened.notes, prior);
  assert(opened.documents.every(page => page.requiresRead === true && page.nextLine === 1));
  await assert.rejects(note(f.tools, names[1]), /CURRENT_READS/u);
  const read = await f.tools.execute({ action: 'read', path: names[1] });
  assert.equal(read.lines[0], `1: ${bodies[names[1]]}`);
  await note(f.tools, names[1]);
});
