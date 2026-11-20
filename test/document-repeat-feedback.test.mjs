import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools } from '../lib/document-tools.mjs';

async function fixture(t, body = '# Scope\nPreserve the requested behavior.\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-document-repeat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'design.md'), body);
  const make = () => createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['design.md'] } });
  return { root, body, make, tools: await make(), query: { action: 'read', path: 'design.md', start: 1, count: 60 } };
}

test('repeated current reads retain their content and offer non-gating navigation feedback', async t => {
  const f = await fixture(t);
  const first = await f.tools.execute(f.query), second = await f.tools.execute(f.query);
  assert.equal(first.readProgress, undefined); assert.equal(second.readProgress, undefined);
  const third = await f.tools.execute(f.query);
  assert.deepEqual(third.lines, first.lines); assert.equal(third.sha256, first.sha256);
  assert.equal(third.readProgress.repeatedRequestCount, 3);
  assert.equal(third.readProgress.navigationOnly, true);
  assert.match(third.readProgress.message, /does not establish correctness/u);
  assert.equal((await f.tools.execute(f.query)).readProgress.repeatedRequestCount, 4);
  assert.equal(await fs.readFile(path.join(f.root, 'design.md'), 'utf8'), f.body);
  await assert.rejects(f.tools.execute({ action: 'remember', key: 'n', note: 'Navigation only.' }), /CURRENT_READS/u);
  await f.tools.execute({ action: 'remember', key: 'n', note: 'Navigation only.', paths: ['design.md'] });
});

test('different ranges and review instances do not inherit repeat counts, and invalid calls add no read', async t => {
  const f = await fixture(t);
  await f.tools.execute(f.query);
  await assert.rejects(f.tools.execute({ ...f.query, count: 201 }), /RANGE_INVALID/u);
  await assert.rejects(f.tools.execute({ ...f.query, path: 'undeclared.md' }), /NOT_DECLARED/u);
  assert.equal((await f.tools.execute({ ...f.query, start: 2 })).readProgress, undefined);
  assert.equal((await f.tools.execute(f.query)).readProgress, undefined);
  assert.equal((await f.tools.execute(f.query)).readProgress.repeatedRequestCount, 3);
  const next = await f.make();
  assert.equal((await next.execute(f.query)).readProgress, undefined);
});

test('a repeat notice cannot bypass changed-source or cancellation rejection', async t => {
  const f = await fixture(t);
  await f.tools.execute(f.query); await f.tools.execute(f.query);
  await fs.writeFile(path.join(f.root, 'design.md'), '# Changed\n');
  await assert.rejects(f.tools.execute(f.query), /EVIDENCE_CHANGED/u);
  const controller = new AbortController();
  const tools = await createDocumentTools({ projectRoot: f.root, semantic: { artifactFiles: ['design.md'] }, signal: controller.signal });
  controller.abort(new Error('owned review cancelled'));
  await assert.rejects(tools.execute(f.query), /owned review cancelled/u);
});

test('repeat feedback fits the byte limit and preserves complete nextLine pagination', async t => {
  const body = Array.from({ length: 180 }, (_, i) => `Line ${i + 1}: ${'汉字 "quoted" \\ data '.repeat(18)}`).join('\n');
  const f = await fixture(t, body), query = { ...f.query, count: 200 };
  await f.tools.execute(query); await f.tools.execute(query);
  const repeated = await f.tools.execute(query);
  assert.equal(repeated.readProgress.repeatedRequestCount, 3);
  assert(Buffer.byteLength(JSON.stringify(repeated)) <= 8192);
  const expected = body.split('\n').map((line, i) => `${i + 1}: ${line}`), received = [...repeated.lines];
  let next = repeated.nextLine;
  while (next !== null) {
    assert.equal(next, received.length + 1);
    const page = await f.tools.execute({ ...query, start: next });
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    assert(page.lines.length > 0); received.push(...page.lines); next = page.nextLine;
  }
  assert.deepEqual(received, expected);
  const long = await fixture(t, 'x'.repeat(9000));
  await long.tools.execute(long.query); await long.tools.execute(long.query);
  const fallback = await long.tools.execute(long.query);
  assert.equal(fallback.requiresHostRead, true); assert.deepEqual(fallback.lines, []);
  assert.equal(fallback.nextLine, 1); assert(Buffer.byteLength(JSON.stringify(fallback)) <= 8192);
});
