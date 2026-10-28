import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireBaselineAgent } from '../lib/openclaw/baseline-agent.mjs';
import { createBaselineNotes } from '../lib/review-task/baseline-notes.mjs';
import { createSourceTools, toolText, PAGE_BYTES } from '../lib/review-task/source-tools.mjs';
import { captureFiles } from '../lib/review-task/review-task.mjs';
import { pendingReadRanges } from '../lib/review-task/baseline-task.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-baseline-efficiency-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const decode = result => JSON.parse(toolText(result));

test('simultaneous first acquisition serializes one project identity; cancelled waiters cannot take it', async t => {
  const root = await fixture(t), owner = {}, controller = new AbortController();
  const args = { owner, projectRoot: root, agentId: 'main', selection: { model: 'a' }, deadlineAt: Date.now() + 10000 };
  const firstPromise = acquireBaselineAgent(args);
  let acquired = false;
  const second = acquireBaselineAgent(args).then(value => { acquired = true; return value; });
  const first = await firstPromise;
  const cancelled = acquireBaselineAgent({ ...args, signal: controller.signal });
  const rejected = assert.rejects(cancelled, /cancel/);
  controller.abort(new Error('cancel')); await rejected;
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(acquired, false);
  await first.release(); const next = await second;
  assert.equal(next.sessionId, first.sessionId); assert.equal(next.sessionFile, first.sessionFile); assert.equal(next.reused, true);
  await next.release(); await next.release();
  const other = await acquireBaselineAgent({ ...args, projectRoot: await fixture(t) });
  assert.notEqual(other.sessionId, first.sessionId); await other.release();
});

test('idle native identities are disposed and model-policy changes cannot inherit context', async t => {
  const root = await fixture(t), owner = {}, disposed = [];
  const args = { owner, projectRoot: root, agentId: 'main', selection: { model: 'a' }, deadlineAt: Date.now() + 10000,
    idleMs: 10, dispose: async (...value) => { disposed.push(value); } };
  const first = await acquireBaselineAgent(args); await first.release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(disposed, [[first.sessionKey, first.sessionId]]);
  const next = await acquireBaselineAgent(args);
  assert.notEqual(first.sessionId, next.sessionId);
  const changed = await acquireBaselineAgent({ ...args, selection: { model: 'b' } });
  assert.notEqual(changed.sessionId, next.sessionId);
  await next.release(); await changed.release();
});

test('frozen navigation paginates beyond 100 paths and within a dense file without omission or duplicated hits', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 137; i++) await fs.writeFile(path.join(root, `${String(i).padStart(3, '0')}.txt`), 'needle 中文\nneedle 条件\n');
  await fs.writeFile(path.join(root, 'dense.txt'), Array.from({ length: 230 }, (_, i) => `needle ${i}`).join('\n'));
  const tools = createSourceTools(root, await captureFiles(root));
  for (const name of ['ls', 'find', 'grep']) {
    const tool = tools.find(item => item.name === name), hits = [];
    let offset = 0, line = 1;
    do {
      const args = { path: '.', pattern: name === 'find' ? '.txt' : 'needle', offset, line, limit: 17 };
      const response = await tool.execute('test', args), page = decode(response);
      assert(Buffer.byteLength(toolText(response)) <= PAGE_BYTES); assert.equal(page.navigationOnly, true);
      assert.deepEqual(decode(await tool.execute('cached', args)), page);
      hits.push(...page.hits); offset = page.nextOffset; line = page.nextLine;
    } while (offset !== null);
    assert.equal(new Set(hits).size, hits.length);
    assert.equal(hits.length, name === 'grep' ? 137 * 2 + 230 : 138);
  }
});

test('working notes survive refresh as stale navigation, paginate, and cannot cite foreign sources', async t => {
  const file = path.join(await fixture(t), 'notes.json');
  const identity = { taskId: 'task', requestId: 'a', sources: [{ ref: 'U1' }] };
  const first = await createBaselineNotes({ file, identity, active() {} });
  for (let i = 0; i < 8; i++) await first.tool.execute('n', { action: 'put', key: `group-${i}`, text: 'Keep the exception with the outcome.', sourceRefs: ['U1'] });
  await assert.rejects(first.tool.execute('n', { action: 'put', key: 'bad', text: 'foreign', sourceRefs: ['U2'] }), /catalog/);
  const next = await createBaselineNotes({ file, identity: { ...identity, requestId: 'b' }, active() {} });
  let offset = 0, notes = [];
  do { const page = decode(await next.tool.execute('n', { action: 'list', offset })); notes.push(...page.notes); offset = page.nextOffset; } while (offset !== null);
  assert.equal(notes.length, 8); assert(notes.every(note => note.stale)); assert.equal(next.pointer().stale, 8);
  await next.tool.execute('n', { action: 'put', key: 'group-0', text: 'Revalidated exception.', sourceRefs: ['U1'] });
  assert.equal(next.pointer().stale, 7);
});

test('interval recovery preserves gaps with overlap, duplicates, partial and out-of-order reads', () => {
  const snapshot = new Map([['a', { lines: 12 }], ['b', { lines: 4 }]]);
  assert.deepEqual(pendingReadRanges(['a', 'b'], snapshot, [
    { path: 'a', start: 7, end: 9 }, { path: 'a', start: 2, end: 5 },
    { path: 'a', start: 3, end: 4 }, { path: 'a', start: 9, end: 10 },
  ]), [{ file: 'a', ranges: [{ start: 1, end: 1 }, { start: 6, end: 6 }, { start: 11, end: 12 }] },
    { file: 'b', ranges: [{ start: 1, end: 4 }] }]);
});
