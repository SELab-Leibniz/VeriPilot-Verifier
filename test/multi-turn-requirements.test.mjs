import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { ensureTask, findTask, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { applyGroundTruthDelta, freezeGroundTruth, loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { pendingUserSourceRefs, userSourceRef } from '../lib/runtime-v2/ground-truth-provenance.mjs';
import { runStopTaskGroup } from '../lib/runtime-v2/stop-task-group.mjs';
import { observedTaskResult } from './helpers/observed-review.mjs';

const catalog = id => ({ ref: `transcript:${id}`, kind: 'USER_MESSAGE', aliases: [id, 'user'] });
const operation = (text, user, extra = {}) => ({ operation: 'ADD', category: 'requirements', text,
  authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION',
  implementationRole: 'PRODUCTION', source: { ref: `transcript:${user}`, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' }, ...extra });
async function fixture(t) {
  const parent = path.resolve('.runtime-correction/test-temp'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'multi-turn-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app.py'), 'def sort(values): return sorted(values)\n');
  const transcript = path.join(root, 'transcript.jsonl');
  const entries = [{ type: 'user', uuid: 'user-1', message: { role: 'user', content: 'Write quicksort.' } },
    { type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: 'Quicksort implementation complete. Optional improvements are available.' } }];
  const persist = () => fs.writeFile(transcript, entries.map(row => JSON.stringify(row)).join('\n') + '\n'); await persist();
  const task = await ensureTask({ projectRoot: root, sessionId: 'session' });
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, sourceCatalog: [catalog('user-1')], delta: { operations: [operation('Implement quicksort.', 'user-1')] } });
  await freezeGroundTruth({ projectRoot: root, taskId: task.taskId });
  const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, '0')}`, i === 15]));
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
    skillCorrection: { enabled: false }, implementationCorrection: { enabled: false, platform: null }, stopCorrection: { enabled: true, metrics } });
  const calls = [], reviewed = []; let delta = { taskClassification: 'NO_CHANGE', operations: [] }, classification = 'TASK_COMPLETE', beforeClassification;
  const factory = async input => {
    calls.push(input.role);
    if (input.role === 'ground-truth-extractor') return { result: { summary: 'Real user delta.', ...delta }, close: async () => {} };
    if (input.request.reviewScope.kind === 'classification') { await beforeClassification?.(); return { result: { summary: 'Requested implementation complete.',
      stopClassification: classification, stage: classification === 'STAGE_COMPLETE' ? 'tasks' : null,
      findings: [], metricObjectJudgements: [] }, close: async () => {} }; }
    assert.equal(input.request.reviewScope.kind, 'stop-group');
    return runStopTaskGroup(input, { runTask: async options => {
      for (const item of options.tasks) { reviewed.push(item.objectId); await options.onItemResult(await observedTaskResult({ ...options, task: item }, { file: 'project/app.py', verdict: 'PASS' })); }
      return { completed: true };
    } });
  };
  factory.supportsStopTasks = true; factory.supportsStopGroups = true; factory.supportsReviewCollection = true;
  const event = (hook, fields = {}) => handleRuntimeV2Event({ projectRoot: root, plan: { runtimeV2, configuredArtifacts: [{ stage: 'tasks', metrics: [] }] },
    reviewerFactory: factory, stopHost: { directory: path.join(root, 'host-state') }, input: { cwd: root, session_id: 'session',
      transcript_path: transcript, hook_event_name: hook, hook_event_id: crypto.randomUUID(), last_assistant_message: 'Implementation complete.', ...fields } });
  await event('SessionStart', { source: 'startup' });
  return { root, task, entries, persist, event, calls, reviewed, setDelta: value => { delta = value; }, setClassification: value => { classification = value; },
    setBeforeClassification: value => { beforeClassification = value; },
    truth: () => loadCurrentGroundTruth(root, task.taskId) };
}

test('quicksort then insertion sort: lazy user update publishes before the first write and reaches the production Stop', async t => {
  const f = await fixture(t); const first = await f.event('Stop'); assert.equal(first.stop.status, 'PASS', JSON.stringify(first.stop));
  f.entries.push({ type: 'user', uuid: 'user-2', message: { role: 'user', content: 'Also implement insertion sort.' } }); await f.persist();
  f.setDelta({ taskClassification: 'NEW_TASK', operations: [operation('Implement insertion sort.', 'user-2')] });
  const count = f.calls.length; await f.event('UserPromptSubmit', { prompt: 'Also implement insertion sort.' });
  assert.equal(f.calls.length, count, 'input recording is cheap');
  await f.event('PreToolUse', { tool_name: 'Write' });
  assert.deepEqual((await f.truth()).claims.map(row => row.text).sort(), ['Implement insertion sort.', 'Implement quicksort.']);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: 'session' })).taskId, f.task.taskId);
  f.setDelta({ taskClassification: 'NO_CHANGE', operations: [] });
  f.entries.push({ type: 'assistant', uuid: 'assistant-2', message: { role: 'assistant', content: 'Insertion sort complete.' } }); await f.persist();
  const result = await f.event('Stop'); assert.equal(result.stop.status, 'PASS', JSON.stringify(result.stop));
  assert.equal(result.stop.review.scopeSelection.fullObjectCount, 2);
  assert.equal(result.stop.review.scopeSelection.selectedObjectCount, 2);
  assert.equal(result.stop.review.groundTruthVersion, 2);
  assert.equal(result.stop.correctionAttempt, 0);
});

test('a delayed new user requirement at Stop is accepted, while an old-source switch cannot alter the ledger', async t => {
  const f = await fixture(t);
  f.entries.push({ type: 'user', uuid: 'user-2', message: { role: 'user', content: 'Write insertion sort.' } }); await f.persist();
  f.setDelta({ taskClassification: 'NEW_TASK', operations: [operation('Implement insertion sort.', 'user-2')] });
  const result = await f.event('Stop'); assert.equal(result.stop.review.groundTruthVersion, 2);
  f.entries.push({ type: 'user', uuid: 'user-3', message: { role: 'user', content: 'Continue the existing work.' } },
    { type: 'assistant', uuid: 'progress', message: { role: 'assistant', content: 'More progress.' } }); await f.persist();
  f.setDelta({ taskClassification: 'NEW_TASK', operations: [operation('Invented requirement.', 'user-1')] });
  await f.event('Stop'); assert.equal((await f.truth()).claims.length, 2);
  assert.match(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), 'journal/events.jsonl'), 'utf8'), /TASK_SWITCH_SUPPRESSED/);
});

test('new-user supersede and retract update the same frozen baseline, and a replay does not add revisions', async t => {
  const f = await fixture(t), id = (await f.truth()).claims[0].claimId;
  for (const [user, op, expected] of [['user-2', 'SUPERSEDE', 'ACTIVE'], ['user-3', 'RETRACT', 'RETRACTED']]) {
    f.entries.push({ type: 'user', uuid: user, message: { role: 'user', content: op === 'RETRACT' ? 'Cancel that requirement.' : 'Replace quicksort with insertion sort.' } }); await f.persist();
    f.setDelta({ taskClassification: 'CORRECTION', operations: [operation('Implement insertion sort.', user, { operation: op, claimId: id })] });
    await f.event('UserPromptSubmit'); await f.event('PreToolUse', { tool_name: 'Write' });
    assert.equal((await f.truth()).claims[0].status, expected);
  }
  const version = (await f.truth()).version; await f.event('PreToolUse', { tool_name: 'Write' }); assert.equal((await f.truth()).version, version);
});

test('a forged new input reference leaves baseline pending and prevents an old-baseline PASS', async t => {
  const f = await fixture(t); f.entries.push({ type: 'user', uuid: 'user-2', message: { role: 'user', content: 'New work.' } }); await f.persist();
  f.setDelta({ taskClassification: 'NEW_TASK', operations: [operation('Forged work.', 'not-in-transcript')] });
  const result = await f.event('Stop'); assert.equal(result.stop.status, 'UNVERIFIED');
  assert.equal(result.stop.reasonCode, 'GROUND_TRUTH_INPUT_UNVERIFIED'); assert.equal((await f.truth()).version, 1);
});

test('an empty declared stage records the real excluded obligations instead of NO_CURRENT_DEVIATION', async t => {
  const f = await fixture(t); f.setClassification('STAGE_COMPLETE');
  const result = await f.event('Stop'); assert.equal(result.stop.status, 'UNVERIFIED');
  assert.equal(result.stop.reasonCode, 'STOP_STAGE_METRICS_UNDECLARED');
  assert.equal(result.stop.review.scopeSelection.fullObjectCount, 1); assert.equal(result.stop.review.scopeSelection.selectedObjectCount, 0);
  assert.deepEqual(f.reviewed, []);
});

test('test source belongs to M12 but not M16; generic source aliases cannot authorize a multi-turn change', async t => {
  const f = await fixture(t); const sources = [catalog('user-1'), catalog('user-2')];
  assert.equal(userSourceRef({ ref: 'user' }, sources), null);
  assert.deepEqual(pendingUserSourceRefs(await f.truth(), sources), ['transcript:user-2']);
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, sourceCatalog: sources,
    delta: { operations: [operation('Write a sorting test file.', 'user-2', { implementationRole: 'TEST' }),
      operation('Run the requested sorting tests.', 'user-2', { verificationTarget: 'PROCESS', implementationRole: undefined })] } });
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: await f.truth() });
  assert.equal(population.metrics.M12.length, 3); assert.equal(population.metrics.M16.length, 1);
  assert(population.metrics.M12.some(object => object.verificationTarget === 'PROCESS' && object.description.includes('Run')));
});

test('same-identity edited user input is detected by its content digest; repeated identical obligations do not grow the denominator', async t => {
  const f = await fixture(t), sources = [{ ...catalog('user-1'), contentDigest: 'before' }];
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, sourceCatalog: sources, delta: { operations: [] } });
  const truth = await f.truth(); assert.deepEqual(pendingUserSourceRefs(truth, sources), []);
  assert.deepEqual(pendingUserSourceRefs(truth, [{ ...sources[0], contentDigest: 'edited' }]), ['transcript:user-1']);
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, sourceCatalog: sources,
    delta: { operations: [operation('Implement quicksort.', 'user-1')] } });
  assert.equal((await f.truth()).version, truth.version); assert.equal((await f.truth()).claims.length, 1);
});

test('editing the same user message during classification fences stale review and dispatch', async t => {
  const f = await fixture(t);
  f.setBeforeClassification(async () => { f.entries[0].message.content = 'Replace quicksort with insertion sort.'; await f.persist(); });
  const result = await f.event('Stop');
  assert.equal(result.stop.status, 'UNVERIFIED'); assert.equal(result.stop.correctionAttempt, 0);
  assert.deepEqual(f.reviewed, []); assert.notEqual(result.stop.reasonCode, 'REVIEW_PASSED');
});
