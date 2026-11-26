import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';

const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
  stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });
const scope = { stopClassification: 'TASK_COMPLETE', completionClaim: true };
const unpack = response => JSON.parse(response.content[0].text);
const cutoff = () => Object.assign(new Error('The scripted worker reached its deadline.'), { code: 'REVIEWER_DEADLINE' });

async function fixture(t, lines, { retries = 3 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-quick-regression-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const original = path.join(root, 'AGENTS.md'), code = path.join(root, 'retry.mjs');
  const transcript = path.join(root, 'transcript.jsonl'), directory = path.join(root, 'host');
  await fs.writeFile(original, lines.join('\n'));
  await fs.writeFile(code, 'export const retries = { sealed: ' + retries + ', standard: 3 };\n');
  const entries = [{ type: 'user', uuid: 'request', message: { content: 'Implement AGENTS.md in full.' } },
    { type: 'assistant', uuid: 'delivery', message: { content: 'Task complete.' } }];
  const save = () => fs.writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await save();
  const event = (name, stopId, script, options = {}) => handleRuntimeV2Event({
    projectRoot: root, plan: { artifacts: [], runtimeV2 },
    stopHost: { directory, stopId, startProtocol: { version: 1 } },
    reviewerFactory: input => scriptedWorkspaceReview({ ...input, ...options,
      reviewer: { ...input.reviewer, timeoutMs: options.timeoutMs ?? input.reviewer.timeoutMs } }, { script }),
    input: { session_id: 'quick', hook_event_name: name, cwd: root, transcript_path: transcript,
      last_assistant_message: entries.at(-1).message.content, source: 'startup' },
  });
  await ensureTask({ projectRoot: root, sessionId: 'quick' });
  await event('SessionStart');
  return { root, original, code,
    async stop(id, script, options) { return (await event('Stop', id, script, options)).stop; },
    async continue() {
      entries.push({ type: 'user', uuid: 'continue', message: { content: 'Continue reviewing the same AGENTS.md.' } },
        { type: 'assistant', uuid: 'follow-up', message: { content: 'Task complete.' } });
      await save();
    },
    item(start, end = start) {
      return { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', path: original,
        text: lines.slice(start - 1, end).join(' '), lineStart: start, lineEnd: end };
    },
  };
}

function longOriginal(finalLine, backgroundLines = 170) {
  return ['# SDD acceptance', 'Sealed mode must allow zero retries.', 'Standard mode must allow three retries.',
    'This rule applies to the exported retry configuration.', '## Background',
    ...Array.from({ length: backgroundLines }, () => 'The earlier logistics plan covered a different release. Its narrative describes the implementation of that earlier plan and supplies historical context.'),
    ...(finalLine ? [finalLine] : [])];
}

test('Reviewer deadline releases a confirmed deviation while the original Stop can still settle it', async t => {
  const f = await fixture(t, longOriginal());
  const stop = await f.stop('first', async ({ task, call, read, worker }) => {
    for (const file of task.basisFiles) if (file !== f.original) await read(file);
    await call('source_read', { path: f.original, offset: 1, limit: 10 });
    await read(f.code);
    const saved = unpack(await call('append_original_checklist', { items: [f.item(2)] }));
    await call('submit_review', { ...scope, taskId: saved.items[0].taskId, verdict: 'DEVIATION',
      reason: 'The sealed configuration exports 3 retries instead of 0.', citations: [{ path: f.code, start: 1, end: 1 }] });
    assert.equal(worker.isComplete(), true);
    return new Promise(() => {});
  }, { timeoutMs: 1800 });
  assert.deepEqual([stop.status, stop.reasonCode, stop.decision, stop.partialFeedbackEligible],
    ['UNVERIFIED', 'REVIEWER_DEADLINE', 'block', true]);
  assert.equal(stop.acceptanceReport.confirmedDeviations.length, 1);
  assert.deepEqual(stop.acceptanceReport.sourceCoverage.sources[0].unreadRanges, [[11, 175]]);
  assert.ok(stop.admission?.id);
});

for (const failure of ['expired', 'stale']) test('Reviewer cutoff cannot publish a deviation with ' + failure + ' evidence', async t => {
  const f = await fixture(t, longOriginal());
  const stop = await f.stop('first', async ({ task, call, read }) => {
    for (const file of task.basisFiles) if (file !== f.original) await read(file);
    await call('source_read', { path: f.original, offset: 1, limit: 10 });
    await read(f.code);
    const saved = unpack(await call('append_original_checklist', { items: [f.item(2)] }));
    await call('submit_review', { ...scope, taskId: saved.items[0].taskId, verdict: 'DEVIATION',
      reason: 'The sealed configuration exports 3 retries instead of 0.', citations: [{ path: f.code, start: 1, end: 1 }] });
    if (failure === 'stale') await fs.writeFile(f.code, 'export const retries = { sealed: 0, standard: 3 };\n');
    throw cutoff();
  }, failure === 'expired' ? { publicationDeadlineAt: Date.now() - 1 } : undefined);
  assert.equal(stop.status, 'UNVERIFIED');
  assert.equal(stop.decision, 'allow');
  assert.equal(stop.acceptanceReport?.confirmedDeviations.length ?? 0, 0);
  assert.ok(!stop.admission);
});

test('an interrupted original read resumes as navigation even before the first checklist item', async t => {
  const f = await fixture(t, longOriginal());
  const first = await f.stop('first', async ({ task, call, read }) => {
    for (const file of task.basisFiles) if (file !== f.original) await read(file);
    await call('source_read', { path: f.original, offset: 1, limit: 10 });
    throw cutoff();
  });
  assert.equal(first.acceptanceReport.sourceCoverage.sources[0].readLines, 10);
  assert.equal(first.decision, 'allow');
  await f.continue();
  const followUp = await f.stop('second', async ({ task, call }) => {
    assert.equal(task.extractionResume.navigationOnly, true);
    assert.equal(task.extractionResume.items, 0);
    assert.deepEqual(task.extractionResume.nextReads, [{ path: f.original, offset: 11 }]);
    const resumed = await call('source_read', { path: f.original, limit: 10 });
    assert.equal(resumed.details.citation.start, 11);
    throw cutoff();
  });
  assert.equal(followUp.reasonCode, 'REVIEWER_DEADLINE');
  assert.deepEqual(followUp.acceptanceReport.sourceCoverage.sources[0].unreadRanges, [[1, 10], [21, 175]]);
});

test('fully read long originals can close after bounded clauses and acknowledged background', async t => {
  const lines = longOriginal(null, 1000);
  assert.ok(Buffer.byteLength(lines.join('\n')) > 128 * 1024);
  const f = await fixture(t, lines, { retries: 0 });
  const stop = await f.stop('first', async ({ task, call, read }) => {
    for (const file of new Set([...task.basisFiles, f.original, f.code])) await read(file);
    await call('append_original_checklist', { items: [f.item(2), f.item(3, 4)] });
    await call('seal_original_checklist', { backgroundRanges: [{ path: f.original, start: 6, end: lines.length }] });
    assert.equal(unpack(await call('review_checklist', scope)).items.length, 2);
    await call('finish_stop_review', { summary: 'Both production retry values match their original conditions.' });
  });
  assert.equal(stop.status, 'NO_DEVIATION_FOUND');
  assert.equal(stop.decision, 'allow');
  assert.equal(stop.acceptanceReport.complete, true);
  assert.equal(stop.acceptanceReport.sourceCoverage.sources[0].readLines, lines.length);
});

test('background and an umbrella item cannot hide independent requirements', async t => {
  const f = await fixture(t, longOriginal('Release builds must use a signature.'), { retries: 0 });
  const stop = await f.stop('first', async ({ task, call, read }) => {
    for (const file of new Set([...task.basisFiles, f.original, f.code])) await read(file);
    await call('append_original_checklist', { items: [f.item(2, 4)] });
    await assert.rejects(call('seal_original_checklist', { backgroundRanges: [{ path: f.original, start: 6, end: 176 }] }),
      { code: 'STOP_ORIGINAL_CHECKLIST_INVALID' });
    await call('seal_original_checklist', { backgroundRanges: [{ path: f.original, start: 6, end: 175 }] });
    await call('review_checklist', scope);
    await call('finish_stop_review', { summary: 'Only the first portion of the specification was represented.' });
  });
  assert.equal(stop.status, 'UNVERIFIED');
  assert.equal(stop.decision, 'allow');
  assert.deepEqual(stop.acceptanceReport.sourceCoverage.sources[0].unextractedRanges, [[2, 4], [176, 176]]);
});
