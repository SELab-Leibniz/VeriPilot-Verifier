import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { ensureTask, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { STOP_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { coversSingleLineJsonRecords } from '../lib/runtime-v2/stop-source-coverage.mjs';
import { loadReviewCheckpoint } from '../lib/review-task/history-memory.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';

test('a long multi-line user message keeps one original and stable late-clause coordinates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-user-original-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const notes = Array.from({ length: 601 }, (_, i) => '往年记录 ' + i + ' 这段背景只用于解释词汇。'.repeat(4));
  const clause = 'The upload handler must refuse a missing signature.';
  const text = [...notes, clause].join('\n');
  const snapshot = { entries: [{ type: 'user', uuid: 'latest', message: { content: text } }] };
  const originals = await loadStopOriginalRequirements({ projectRoot: root, snapshot, referenceTier: true });
  const task = await ensureTask({ projectRoot: root, sessionId: 'whole-user-original' });
  const input = { projectRoot: root, taskId: task.taskId, role: 'stop-reviewer', schema: STOP_REVIEW_SCHEMA,
    reviewer: { timeoutMs: 30000 }, evidence: { snapshot, originalRequirements: originals, groundTruth: { version: 0, claims: [] } },
    request: { reviewScope: { kind: 'workspace-stop' }, workflowStages: [], hook: { last_assistant_message: 'Done.' },
      population: { metrics: {}, reviewPolicy: { deviationOnly: true, metrics: { M16: true } } } } };
  const parsed = result => JSON.parse(result.content[0].text);
  const handle = await scriptedWorkspaceReview(input, { script: async ({ task, call, read }) => {
    const user = task.basisFiles.filter(f => path.basename(f).startsWith('user-original-'));
    assert.equal(user.length, 1);
    assert.deepEqual(await fs.readFile(user[0]), Buffer.from(text));
    for (const file of task.basisFiles) await read(file);
    const start = Buffer.byteLength(notes.join('\n') + '\n');
    await call('append_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
      text: clause, path: user[0], lineStart: 602, lineEnd: 602, byteStart: start, byteEnd: Buffer.byteLength(text) }] });
    await call('seal_original_checklist', {});
    const page = parsed(await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true }));
    assert.equal(page.items[0].originalSource.start, 602);
    assert.equal(page.items[0].originalSource.byteStart, start);
    await call('finish_stop_review', { summary: 'Checked the late clause.' });
  } });
  t.after(() => handle.close());
  assert.equal(handle.reviewCompleted, true);
});

async function reviewSingleLineAnnex(t, omittedIndex = null) {
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
  const submitted = items.filter((_, index) => index !== omittedIndex);
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
    for (let i = 1; i < submitted.length; i += 24) await call('append_original_checklist', { items: submitted.slice(i, i + 24) });
    const tail = parsed(await call('original_checklist_progress', { offset: submitted.length - 1, limit: 1 }));
    assert.equal(tail.total, submitted.length); assert.equal(tail.items[0].source.byteEnd, items.at(-1).byteEnd);
    await call('seal_original_checklist', { noApplicableSources: [{ ref: charter, reason: 'This original delegates its content to the provisions.' }] });
    const firstPage = parsed(await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 15 }));
    assert.equal(firstPage.total, submitted.length);
    await assert.rejects(call('finish_stop_review', { summary: 'Only inspected the first page.' }), /have not been presented/u);
    let next = firstPage.nextOffset;
    while (next !== null) next = parsed(await call('review_checklist', { offset: next, limit: 20 })).nextOffset;
    await call('finish_stop_review', { summary: 'Finished the individually scoped review.' });
  } });
  t.after(() => handle.close());
  const base = path.join(taskDirectory(root, task.taskId), 'workspace-reviews');
  const [id] = await fs.readdir(base);
  const saved = JSON.parse(await fs.readFile(path.join(base, id, 'original-checklist.json'), 'utf8'));
  assert.equal(new Set(saved.population.metrics.M16.map(item => item.objectId)).size, submitted.length);
  assert.deepEqual(saved.population.metrics.M16.map(({ originalSource }) => [originalSource.byteStart, originalSource.byteEnd]),
    submitted.map(({ byteStart, byteEnd }) => [byteStart, byteEnd]));
  const checkpoint = await loadReviewCheckpoint(path.join(base, id, 'review-checkpoint.json'));
  assert(checkpoint.citations.some(c => c.rangeKind === 'bytes'));
  assert(checkpoint.reads.some(c => c.byteComplete && c.path === file));
  const coverage = handle.result.sourceCoverage.sources.find(source => source.ref === annex);
  assert.equal(coverage.readLines, 1);
  assert.equal(coverage.checklistItems, submitted.length);
  t.diagnostic(JSON.stringify({ sha256: coverage.sha256, bytes: bytes.length, submitted: submitted.length,
    omittedRecord: omittedIndex === null ? null : omittedIndex + 1, reviewCompleted: handle.reviewCompleted,
    disposition: coverage.disposition, reasonCode: handle.collection?.reasonCode ?? null }));
  if (omittedIndex === null) {
    assert.equal(coverage.disposition, 'REPRESENTED');
    assert.equal(handle.reviewCompleted, true);
    assert.equal(handle.result.sourceCoverage.complete, true);
  } else {
    assert.equal(handle.reviewCompleted, false);
    assert.equal(handle.result.sourceCoverage.complete, false);
    assert.equal(handle.collection.reasonCode, 'STOP_ORIGINAL_SCOPE_INCOMPLETE');
    assert.deepEqual(coverage.unextractedRanges, [[1, 1]]);
    assert(handle.result.unverifiedItems.some(item => item.id === `original:${annex}` && item.reviewState === 'UNREVIEWED'));
  }
}

test('a single long annex line can be read and committed in more than 256 independent original positions',
  t => reviewSingleLineAnnex(t));

test('a single long annex line stays unverified when one record is omitted',
  t => reviewSingleLineAnnex(t, 129));

test('single-line JSON coverage requires exact, valid object boundaries', () => {
  const first = JSON.stringify({ note: '中文 }, ["\\', nested: [{ value: true }] });
  const second = '{"id":2}';
  const original = Buffer.from(`[ ${first},\t${second} ]`);
  const spans = [first, second].map(record => {
    const byteStart = original.indexOf(record);
    return { start: 1, end: 1, byteStart, byteEnd: byteStart + Buffer.byteLength(record) };
  });
  assert.equal(coversSingleLineJsonRecords(original, spans), true);
  const umbrella = { ...spans[0], byteEnd: spans[1].byteEnd };
  assert.equal(coversSingleLineJsonRecords(original, [spans[0], spans[0], umbrella]), false);
  const malformed = Buffer.from(original);
  malformed[spans[1].byteEnd - 2] = 0x3a; // Keep the exact span and make its JSON invalid.
  assert.equal(coversSingleLineJsonRecords(malformed, spans), false);
});
