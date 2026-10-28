import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planIndependentReads } from '../lib/review-task/evidence-utils.mjs';

test('independent read scheduling preserves every source, order, byte budget and oversized files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-read-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const contents = ['甲甲甲', 'x'.repeat(12), 'y'.repeat(60), '', 'z'.repeat(5)];
  const names = contents.map((_, index) => `${index}.txt`);
  for (const [index, text] of contents.entries()) await fs.writeFile(path.join(root, names[index]), text);
  const result = await planIndependentReads(root, names, { maxBatchBytes: 24, maxBatchFiles: 2 });
  assert.equal(result.navigationOnly, true); assert.deepEqual(result.batches.flatMap(batch => batch.files), names);
  assert.equal(result.batches[0].bytes, 21);
  for (const batch of result.batches) {
    assert(batch.files.length <= 2);
    if (batch.bytes > 24) assert.deepEqual(batch.files, ['2.txt']);
  }
  await assert.rejects(planIndependentReads(root, ['missing.txt']), { code: 'ENOENT' });
  await assert.rejects(planIndependentReads(root, names, { maxBatchBytes: 0 }), /budgets/);
});
