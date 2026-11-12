import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveStopCitations } from '../lib/runtime-v2/stop-citations.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { reviewedRegressionFailures } from '../lib/runtime-v2/regression-triage.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-stop-citations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'source.txt');
  await fs.writeFile(file, 'one\ntwo\nthree');
  const ctx = { active() {}, evidence: { registry: new Map(), snapshot: new Map(), resolutions: new Map() } };
  return { root, file, ctx };
}

test('Stop resolves direct file/range references without session reads and binds the current hash', async t => {
  const { root, file, ctx } = await fixture(t);
  const [ref] = await resolveStopCitations(ctx, { citations: [{ path: 'source.txt', start: 2, end: 3 }] }, root);
  assert.deepEqual([ref.path, ref.start, ref.end, ref.sha256], [file, 2, 3, sha256('one\ntwo\nthree')]);
  assert.equal(ctx.evidence.snapshot.get(file).sha256, ref.sha256);
  for (const id of ['source.txt#L1-L2', 'source.txt:1-2', file + ':1-2'])
    assert.deepEqual((await resolveStopCitations(ctx, { citeIds: [id] }, root)).map(r => [r.start, r.end]), [[1, 2]]);
  assert.equal(ref.readProof, undefined, 'mechanical resolution never manufactures observed-read proof');
});

test('Stop accepts a known but unacknowledged read without adding native read coverage', async t => {
  const { root, ctx } = await fixture(t);
  ctx.evidence.lookupCitation = id => id === 'pending' ? { path: 'source.txt', start: 1, end: 1 } : null;
  assert.equal((await resolveStopCitations(ctx, { citeIds: ['pending'] }, root)).length, 1);
  assert.equal(ctx.evidence.registry.size, 0);
});

test('attachment scope excludes traversal and outside symlink targets unless an exact external source was explicitly allowed', async t => {
  const { root, ctx } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-outside-citation-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const file = path.join(outside, 'external.txt'); await fs.writeFile(file, 'external source\n');
  await assert.rejects(resolveStopCitations(ctx, { citations: [{ path: file, start: 1, end: 1 }] }, root, { attachment: true }), { code: 'TASK_CITATION_INVALID' });
  const [ref] = await resolveStopCitations(ctx, { citations: [{ path: file, start: 1, end: 1 }] }, root, { attachment: true, allowedFiles: [await fs.realpath(file)] });
  assert.equal(ref.exactQuote, 'external source');
  try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(resolveStopCitations(ctx, { citations: [{ path: 'linked/external.txt', start: 1, end: 1 }] }, root, { attachment: true }), { code: 'TASK_CITATION_INVALID' });
});

test('Stop rejects missing files, nonexistent ranges, unknown IDs and mismatching hashes mechanically', async t => {
  const { root, ctx } = await fixture(t);
  for (const ref of [{ path: 'missing', start: 1, end: 1 }, { path: '.', start: 1, end: 1 },
    { path: 'source.txt', start: 0, end: 1 }, { path: 'source.txt', start: 1, end: 4 },
    { path: 'source.txt', start: 2, end: 1 }, { path: 'source.txt', start: 1, end: 1, sha256: '0'.repeat(64) }])
    await assert.rejects(resolveStopCitations(ctx, { citations: [ref] }, root), { code: 'TASK_CITATION_INVALID' });
  await assert.rejects(resolveStopCitations(ctx, { citeIds: ['unknown'] }, root), { code: 'TASK_CITATION_INVALID' });
});

test('changed citation bytes and cancelled ownership cannot be published as current evidence', async t => {
  const { root, file, ctx } = await fixture(t);
  await resolveStopCitations(ctx, { citeIds: ['source.txt:1'] }, root);
  await fs.writeFile(file, 'changed');
  await assert.rejects(resolveStopCitations(ctx, { citeIds: ['source.txt:1'] }, root), { code: 'BASELINE_INPUT_CHANGED' });
  ctx.active = () => { throw Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' }); };
  await assert.rejects(resolveStopCitations(ctx, { citeIds: ['source.txt:1'] }, root), { code: 'TASK_CANCELLED' });
});

test('remaining regressions are decided per case; missing decisions or unsaved deviations remain unresolved', () => {
  const inventory = { complete: true, failures: ['allowed', 'regressed', 'unknown'].map(id => ({ id })) };
  const disposition = { reason: 'Not enough evidence.', cases: [
    { id: 'allowed', verdict: 'AUTHORIZED_CHANGE', reason: 'Original request changes this behavior.' },
    { id: 'regressed', verdict: 'REGRESSION', objectId: 'saved', reason: 'Preserved behavior breaks.' },
  ] };
  const result = reviewedRegressionFailures({ inventory, disposition, hasDeviation: id => id === 'saved' });
  assert.deepEqual(result.cases.map(item => item.verdict), ['AUTHORIZED_CHANGE', 'REGRESSION', 'UNVERIFIED']);
  assert.equal(result.status, 'UNVERIFIED');
  const incomplete = reviewedRegressionFailures({ inventory: { complete: false, failures: [{ id: 'visible' }] },
    disposition: { status: 'EXPLAINED', reason: 'The visible failure was authorized.',
      cases: [{ id: 'visible', verdict: 'AUTHORIZED_CHANGE', reason: 'The request changes this assertion.' }] }, hasDeviation: () => false });
  assert.equal(incomplete.status, 'UNVERIFIED');
  assert.deepEqual(incomplete.cases.map(entry => entry.id), ['visible', 'regression-inventory']);
  const legacy = reviewedRegressionFailures({ inventory, hasDeviation: () => false, disposition: {
    status: 'UNVERIFIED', reason: 'The legacy review did not settle these cases independently.',
    explanations: inventory.failures.map(({ id }) => ({ failure: id, reason: 'A proposed explanation exists.' })) } });
  assert(legacy.cases.every(entry => entry.verdict === 'UNVERIFIED'), 'proposed explanations cannot overwrite an explicit unresolved verdict');
  assert.equal(reviewedRegressionFailures({ inventory, disposition, hasDeviation: () => false }).cases[1].verdict, 'UNVERIFIED');
  for (const cases of [[disposition.cases[0], disposition.cases[0]], [{ id: 'foreign', verdict: 'UNVERIFIED' }]])
    assert.throws(() => reviewedRegressionFailures({ inventory, disposition: { cases }, hasDeviation: () => false }), { code: 'REVIEW_ITEM_OWNERSHIP_INVALID' });
});
