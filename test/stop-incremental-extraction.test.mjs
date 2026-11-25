import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { ensureTask, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { STOP_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { loadReviewCheckpoint } from '../lib/review-task/history-memory.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';

test('a single long annex line can be read and committed in more than 256 independent original positions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-single-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await fs.mkdir(path.join(root, 'manuals'));
  const charter = 'manuals/owner.md', annex = 'manuals/provisions.json';
  await fs.writeFile(path.join(root, charter), 'All provisions in manuals/provisions.json are mandatory.');
  const file = path.join(root, annex);
  const records = Array.from({ length: 259 }, (_, index) => JSON.stringify({ id: '通道-' + index, rule: '通行条款须遵循原文。'.repeat(4) }));
  const bytes = Buffer.from('[' + records.join(',') + ']');
  await fs.writeFile(file, bytes);
  const request = '本次规范见 manuals/owner.md 。';
  const snapshot = { entries: [{ type: 'user', uuid: 'request', message: { content: request } }] };
  const originals = await loadStopOriginalRequirements({ projectRoot: root, snapshot, referenceTier: true });
  assert.deepEqual(new Set(originals.acceptanceSources.map(s => s.path)), new Set([charter, annex]));
  const task = await ensureTask({ projectRoot: root, sessionId: 'independent-positions' });
  const input = { projectRoot: root, taskId: task.taskId, role: 'stop-reviewer', schema: STOP_REVIEW_SCHEMA,
    reviewer: { timeoutMs: 60000 }, evidence: { snapshot, originalRequirements: originals, groundTruth: { version: 0, claims: [] } },
    request: { reviewScope: { kind: 'workspace-stop' }, workflowStages: [], hook: { last_assistant_message: 'Delivered.' },
      population: { metrics: {}, reviewPolicy: { deviationOnly: true, metrics: { M16: true } } } } };
  let start = 1;
  const items = records.map(record => {
    const byteStart = start, byteEnd = start + Buffer.byteLength(record);
    start = byteEnd + 1;
    return { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
      text: 'Enforce this separately located provision.', path: file, lineStart: 1, lineEnd: 1, byteStart, byteEnd };
  });
  const parsed = result => JSON.parse(result.content[0].text);
  const handle = await scriptedWorkspaceReview(input, { script: async ({ task: assigned, call, read }) => {
    for (const original of assigned.basisFiles) if (original !== file) await read(original);
    await assert.rejects(call('append_original_checklist', { items: [items[0]] }), /observed revision|acknowledged/u);
    let offset = 0, first = true;
    do {
      const { page } = parsed(await call('source_read', { path: file, byteOffset: offset, byteLimit: 2047 }));
      assert.deepEqual(Buffer.from(page.data, 'base64'), bytes.subarray(offset, page.endByte));
      if (first) {
        assert.equal(parsed(await call('append_original_checklist', { items: [items[0]] })).added, 1);
        assert.equal(parsed(await call('append_original_checklist', { items: [items[0]] })).added, 0);
        await assert.rejects(call('append_original_checklist', { items: [items.at(-1)] }), /acknowledged/u);
        await assert.rejects(call('seal_original_checklist', {}), /basis|read/u);
        first = false;
      }
      offset = page.nextByteOffset;
    } while (offset !== null);
    for (let i = 1; i < items.length; i += 24) await call('append_original_checklist', { items: items.slice(i, i + 24) });
    const tail = parsed(await call('original_checklist_progress', { offset: 258, limit: 1 }));
    assert.equal(tail.total, 259); assert.equal(tail.items[0].source.byteEnd, items.at(-1).byteEnd);
    await call('seal_original_checklist', { noApplicableSources: [{ ref: charter, reason: 'This original delegates its content to the provisions.' }] });
    const firstPage = parsed(await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 15 }));
    assert.equal(firstPage.total, 259);
    await assert.rejects(call('finish_stop_review', { summary: 'Only inspected the first page.' }), /have not been presented/u);
    let next = firstPage.nextOffset;
    while (next !== null) next = parsed(await call('review_checklist', { offset: next, limit: 20 })).nextOffset;
    await call('finish_stop_review', { summary: 'Finished the individually scoped review.' });
  } });
  t.after(() => handle.close());
  assert.equal(handle.reviewCompleted, true);
  const base = path.join(taskDirectory(root, task.taskId), 'workspace-reviews');
  const [id] = await fs.readdir(base);
  const saved = JSON.parse(await fs.readFile(path.join(base, id, 'original-checklist.json'), 'utf8'));
  assert.equal(new Set(saved.population.metrics.M16.map(item => item.objectId)).size, 259);
  const checkpoint = await loadReviewCheckpoint(path.join(base, id, 'review-checkpoint.json'));
  assert(checkpoint.citations.some(c => c.rangeKind === 'bytes'));
  assert(checkpoint.reads.some(c => c.byteComplete && c.path === file));
});
