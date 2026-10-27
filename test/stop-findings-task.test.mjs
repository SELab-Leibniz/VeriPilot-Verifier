import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';

const finding = citeId => ({ deviationKey: 'R1:value', rootCauseId: 'OTHER', severity: 'error', reason: 'The delivered value contradicts R1.',
  expectedConstraint: 'R1', violatedGroundTruthIds: ['R1'], citeIds: [citeId] });

test('an empty complete findings check requires original reads and never creates a metric PASS', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  const handle = await f.run(async ({ readAll, submit }) => {
    await assert.rejects(submit('finish_findings', { batchIds: [], summary: 'No confirmed deviations.' }), /not fully read/);
    await readAll(); await submit('finish_findings', { batchIds: [], summary: 'No confirmed deviations.' });
  });
  assert.equal(handle.result.stopClassification, 'INTERMEDIATE');
  assert.deepEqual(handle.result.findings, []); assert.deepEqual(handle.result.metricObjectJudgements, []);
});

test('findings bind actual source receipts, retain conditions, and save batches idempotently', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll();
    await assert.rejects(submit('submit_findings', { batchId: 1, findings: [finding('fabricated')] }), /Unknown or unread/);
    const page = await read('project/spec.md'), value = finding(page.details.citation.citeId);
    await assert.rejects(submit('submit_findings', { batchId: 1, findings: [{ ...value, violatedGroundTruthIds: ['foreign'] }] }), /unassigned obligation/);
    const batch = { batchId: 1, findings: [value] };
    const first = await submit('submit_findings', batch), duplicate = await submit('submit_findings', batch);
    assert.deepEqual(duplicate, first);
    await assert.rejects(submit('submit_findings', { batchId: 1, findings: [{ ...value, reason: 'Changed' }] }), /Conflicting/);
    await assert.rejects(submit('finish_findings', { batchIds: [], summary: 'Omitted saved batch.' }), /every committed batch/);
    await submit('finish_findings', { batchIds: [1], summary: 'One confirmed deviation.' });
  });
  assert.equal(handle.result.findings.length, 1); assert.equal(handle.sourceCitations[0].readProof.owner, 'ARTIFACT');
  assert.equal(handle.sourceCitations[0].readProof.basisComplete, true);
  assert.match(handle.result.findings[0].actualEvidence[0], /spec\.md#L/);
});

test('saved valid findings survive an interrupted worker as partial results without claiming completion', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  const published = []; f.input.onFindingsBatch = async handle => { published.push(handle); };
  await assert.rejects(f.run(async ({ readAll, read, submit }) => {
    await readAll(); const page = await read('project/spec.md');
    await submit('submit_findings', { batchId: 1, findings: [finding(page.details.citation.citeId)] });
    throw new Error('Controlled host failure');
  }), error => {
    assert.equal(error.partialReview.findings.length, 1); assert(error.partialReview.citations.length);
    assert.equal(error.partialReviewIsActive(), true); return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(published.length, 1); assert.equal(published[0].result.findings.length, 1);
});

test('large original pages and more than 64 reads have no RC context-budget stop', async t => {
  const f = await stopProtocolFixture(t, 'findings', { text: ('Original source evidence '.repeat(40) + '\n').repeat(44) });
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll();
    for (let i = 0; i < 70; i++) {
      const page = await read('project/spec.md'); assert(Buffer.byteLength(JSON.stringify(page)) > 32768);
    }
    await submit('finish_findings', { batchIds: [], summary: 'Limited check finished without confirmed deviation.' });
  });
  assert.deepEqual(handle.result.findings, []); assert.equal(f.calls.length, 1);
});

test('an uncited source or inventory change invalidates a findings check before completion', async t => {
  for (const change of ['source', 'inventory']) await t.test(change, async t => {
    const f = await stopProtocolFixture(t, 'findings');
    await assert.rejects(f.run(async ({ readAll, submit }) => {
      await readAll();
      if (change === 'source') await fs.appendFile(f.file, 'Changed original evidence.');
      else await fs.writeFile(path.join(f.root, 'new-delivery.md'), 'New evidence.');
      await submit('finish_findings', { batchIds: [], summary: 'Do not accept stale completion.' });
    }), { code: 'STOP_TASK_INPUT_CHANGED' });
    assert.equal(f.calls.length, 1);
  });
});
