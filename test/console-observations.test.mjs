import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readConsoleObservations, metricVerdict, validateObservationQuery } from '../lib/openclaw/console-observations.mjs';
import { recordRuntimeResponse } from '../lib/runtime-v2/response-record.mjs';
import { findTask } from '../lib/runtime-v2/task-store.mjs';
import { consoleFixture } from './support/console-fixture.mjs';

async function fixture(t, options) { const f = await consoleFixture(options); t.after(f.cleanup); return f; }

test('observations join explicit identities and distinguish computed, passed, returned and delivered', async t => {
  const f = await fixture(t), data = await readConsoleObservations(f.record, f.task, { limit: 100 });
  const artifact = data.records.find(r => r.id === 'artifact-demo'), stop = data.records.find(r => r.kind === 'stop');
  assert.equal(artifact.feedback.state, 'TOOL_RESULT'); assert.match(artifact.feedback.text, /补充报告/);
  assert.equal(stop.feedback.state, 'RETURNED'); assert.equal(stop.turnId, 12); assert.equal(stop.hookEventId, 'stop-hook');
  assert.equal(data.records.filter(r => r.kind === 'stop').length, 1);
  assert.equal(data.metrics.find(m => m.metricId === 'M16').status, 'DEVIATION');
  assert.equal(stop.metrics.find(m => m.metricId === 'M16').status, 'DEVIATION');
  assert.equal(metricVerdict({ status: 'MEASURED', objects: [{ judgement: 'PASS' }] }), 'PASS');
  assert.equal(metricVerdict({ status: 'MEASURED', objects: [] }), 'UNVERIFIED');
  assert.equal(data.records.find(r => r.id === 'skill-demo').status, 'UNVERIFIED');
  assert.ok((await readConsoleObservations(f.record, f.task, { search: '未验证' })).records.some(r => r.id === 'skill-demo'));
  assert.equal(data.baseline.claims[0].text, '交付说明包含指标与验证证据');
});

test('2,000 responses search the entire history before pagination and support time/kind/attention filters', async t => {
  const f = await fixture(t, { count: 2000 }), begin = performance.now();
  const page = await readConsoleObservations(f.record, f.task, { search: 'PostToolUse', offset: 25, limit: 25 });
  const elapsed = performance.now() - begin;
  assert.equal(page.total, 2000); assert.equal(page.records.length, 25); assert.equal(page.records[0].turnId, 1975);
  assert.equal((await readConsoleObservations(f.record, f.task, { search: 'response-0' })).total, 1);
  assert.equal((await readConsoleObservations(f.record, f.task, { search: 'M16 生产入口' })).total, 1);
  assert.equal((await readConsoleObservations(f.record, f.task, { kind: 'artifact', attention: true })).total, 1);
  const oldest = await readConsoleObservations(f.record, f.task, { kind: 'response', order: 'asc', limit: 1 });
  assert.equal(oldest.records[0].turnId, 1);
  const instant = oldest.records[0].time;
  assert.equal((await readConsoleObservations(f.record, f.task, { kind: 'response', from: instant, to: instant })).total, 1);
  t.diagnostic(`2000-record page: ${elapsed.toFixed(1)}ms; payload: ${Buffer.byteLength(JSON.stringify(page))} bytes`);
});

test('changed baseline or evidence never inherits historical PASS', async t => {
  const f = await fixture(t), before = await readConsoleObservations(f.record, f.task);
  assert.ok(before.metrics.some(m => m.status === 'PASS'));
  f.task.groundTruth.pendingUserCursor = 'new-input';
  assert.ok((await readConsoleObservations(f.record, f.task)).metrics.every(m => m.status !== 'PASS'));
  f.task.groundTruth.pendingUserCursor = null;
  await fs.writeFile(path.join(f.root, 'delivery.md'), '后续修改');
  assert.ok((await readConsoleObservations(f.record, f.task)).metrics.every(m => m.status !== 'PASS'));
  f.task.groundTruth.version++;
  const data = await readConsoleObservations(f.record, f.task);
  assert.equal(data.baseline.available, false); assert.equal(data.baseline.claims.length, 0);
  assert.equal(data.records.find(r => r.kind === 'stop').metrics.find(m => m.metricId === 'M16').status, 'DEVIATION');
});

test('missing and corrupt historical evidence stays unknown and raises a visible warning', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.dir, 'journal/events.jsonl'), '{broken}\n' + JSON.stringify({ type: 'HOOK_EVENT', hookEventId: 'old-hook', hookEventName: 'Stop' }) + '\n{"incomplete":');
  const data = await readConsoleObservations(f.record, f.task, { search: 'old-hook' });
  assert.equal(data.records[0].turnId, null); assert.equal(data.records[0].feedback.state, 'UNKNOWN');
  assert.equal(data.records[0].time, null); assert.match(data.warnings.join(''), /损坏/);
  await fs.rm(path.join(f.dir, 'evaluations/stop-demo.json'));
  const missing = await readConsoleObservations(f.record, f.task, { kind: 'stop' });
  assert.ok(missing.records[0].metrics.every(m => m.status === 'UNVERIFIED'));
});

test('response snapshots retain actual turn/hook and suppressed feedback without claiming host delivery', async t => {
  const f = await fixture(t);
  await recordRuntimeResponse({ projectRoot: f.root, input: { session_id: 'demo', hook_event_name: 'PostToolUse', tool_use_id: 'snapshot-hook' },
    plan: { runtimeV2: { shadowMode: true } } }, { handled: true, taskId: f.task.taskId, feedback: 'suppressed-text' });
  const task = await findTask({ projectRoot: f.root, sessionId: 'demo' });
  const data = await readConsoleObservations(f.record, task, { search: 'snapshot-hook' });
  assert.equal(data.records[0].turnId, 12); assert.equal(data.records[0].feedback.state, 'SUPPRESSED');
  assert.equal(data.records[0].feedback.text, 'suppressed-text');
});

test('invalid queries are rejected rather than widening the requested scope', () => {
  for (const q of [{ limit: 101 }, { offset: -1 }, { from: 2, to: 1 }, { attention: 'true' }, { search: [] }, { kind: 'unknown' }])
    assert.throws(() => validateObservationQuery(q));
});

test('foreign-session feedback cannot confirm delivery in the selected session', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.dir, 'journal/events.jsonl'), [
    { type: 'OPENCLAW_ARTIFACT_REVIEW', eventId: 'owned-artifact', sessionId: 'demo', file: 'other.md', toolCallId: 'shared-call', result: { status: 'failed' } },
    { type: 'OPENCLAW_FEEDBACK_DELIVERED', sessionId: 'foreign', file: 'other.md', toolCallId: 'shared-call', feedback: 'Foreign delivery receipt' },
    { type: 'NATIVE_STOP_FOLLOWUP_OBSERVED', sessionId: 'foreign', assessmentId: 'stop-demo' },
  ].map(JSON.stringify).join('\n') + '\n');
  const data = await readConsoleObservations(f.record, f.task, { limit: 100 });
  assert.equal(data.records.find(r => r.id === 'owned-artifact').feedback.state, 'NONE');
  assert.equal(data.records.find(r => r.kind === 'stop').feedback.state, 'RETURNED');
});

test('current baseline extraction phase is visible but never establishes publication or PASS', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'baseline-extraction-status.json');
  const status = { taskId: f.task.taskId, runId: 'extractor-run', phase: 'READING', deadlineAt: Date.now() + 30000, updatedAt: Date.now() };
  await fs.writeFile(file, JSON.stringify(status));
  let data = await readConsoleObservations(f.record, f.task);
  assert.equal(data.baseline.extraction.phase, 'READING');
  assert.equal(data.baseline.version, 1);
  await fs.writeFile(file, JSON.stringify({ ...status, deadlineAt: 1 }));
  data = await readConsoleObservations(f.record, f.task);
  assert.equal(data.baseline.extraction.phase, 'UNVERIFIED');
  await fs.writeFile(file, JSON.stringify({ ...status, taskId: 'another-task' }));
  assert.equal((await readConsoleObservations(f.record, f.task)).baseline.extraction, undefined);
});
