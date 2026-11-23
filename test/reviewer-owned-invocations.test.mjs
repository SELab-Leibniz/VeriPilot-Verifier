import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { createReviewerAgentPool } from '../lib/openclaw/review-concurrency.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { listNativeRuns, recordNativeRun } from '../lib/openclaw/native-runs.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const output = () => ({ payloads: [{ text: JSON.stringify({ summary: 'Controlled owned invocation.' }) }], meta: {} });
const unverified = { code: 'OWNED_SETTLEMENT_UNVERIFIED' };
async function fixture(t, runner = async () => output(), options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-review-owned-')));
  const task = await ensureTask({ projectRoot: root, sessionId: 'owned-session' });
  const cleanup = [], calls = [], released = deferred();
  const native = async params => { calls.push(params); return runner(params); };
  native.close = async () => released.resolve();
  const api = { rootDir: path.resolve('.'), config: { agents: { defaults: { model: { primary: 'fixture/model' } } } },
    runtime: { version: '2026.7.1-2', agent: {} }, logger: { warn() {}, info() {} } };
  const factory = createOpenClawReviewerFactory(api, { ...options, runEmbeddedAgent: native });
  let observer;
  const input = { projectRoot: root, taskId: task.taskId, role: 'onboarding-extractor',
    reviewer: { model: 'fixture/model', timeoutMs: 20000, formatRepairAttempts: 0 },
    schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } }, additionalProperties: false },
    request: {}, onOwnedInvocation(value) { assert.equal(observer, undefined); observer = value; } };
  t.after(async () => { for (const release of cleanup) await release(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, task, factory, input, calls, cleanup, released, observer: () => observer,
    file: runId => path.join(root, '.runtime-correction/openclaw/native-runs', sha256(task.taskId), `${runId}.json`) };
}

test('a private reviewer and a requirement-frame worker share a slot across factories', { timeout: 10000 }, async t => {
  const pool = createReviewerAgentPool(1);
  const entered = deferred(), settled = deferred(), frameQueued = deferred();
  t.after(() => settled.resolve());
  const regular = await fixture(t, async () => { entered.resolve(); await settled.promise; return output(); },
    { reviewerAgentPool: pool });
  const frame = await fixture(t, async () => output(), { reviewerAgentPool: {
    run(dispatch, options) { frameQueued.resolve(); return pool.run(dispatch, options); },
  } });
  const first = regular.factory(regular.input);
  await entered.promise;
  const second = frame.factory.requirementFrame({ projectRoot: frame.root, taskId: frame.task.taskId, reviewer: frame.input.reviewer },
    { cwd: frame.root, outputDir: frame.root, prompt: 'Review a task-start frame.', systemPrompt: '', tools: [],
      active() {}, isComplete: () => true });
  await frameQueued.promise;
  assert.equal(frame.calls.length, 0);
  assert.deepEqual(await listNativeRuns(frame.root, frame.task.taskId), []);
  settled.resolve();
  const [handle] = await Promise.all([first, second]);
  try {
    assert.equal(frame.calls.length, 1);
    assert.equal(frame.calls[0].prompt, 'Review a task-start frame.');
  } finally { await handle.close(); }
});

test('only the actual host predispatch lifecycle can attest a closed zero-dispatch graph', async t => {
  const f = await fixture(t);
  await assert.rejects(f.factory({ ...f.input, onPrepared() {
    throw Object.assign(new Error('Controlled predispatch transport failure'), { reviewerRuntimeFailure: true });
  } }), { reviewerRuntimeFailure: true });
  assert.equal(f.calls.length, 0);
  const manifest = await f.observer().verifyClosed();
  assert.equal(manifest.status, 'PRE_DISPATCH_CLOSED'); assert.deepEqual(manifest.runs, []);
});

test('cancellation after recording intent closes the reviewer without invoking the host', async t => {
  const controller = new AbortController(), pool = createReviewerAgentPool(1);
  let runId;
  const f = await fixture(t, async () => output(), { reviewerAgentPool: pool,
    onRunStart(id) {
      runId = id;
      controller.abort(Object.assign(new Error('Cancelled before the host invocation'), { code: 'REVIEWER_CANCELLED' }));
    },
  });
  await assert.rejects(f.factory({ ...f.input, abortSignal: controller.signal }), { code: 'REVIEWER_CANCELLED' });
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(await fs.readFile(f.file(runId), 'utf8')).status, 'PRE_DISPATCH_CLOSED');
  assert.deepEqual(await listNativeRuns(f.root, f.task.taskId), []);
  const observation = await f.observer().verifyClosed();
  assert.equal(observation.status, 'PRE_DISPATCH_CLOSED');
  assert.deepEqual(observation.runs, []);
  assert.equal(await pool.run(() => 'available', { deadlineAt: Infinity }), 'available');
});

test('owned observation covers every first and follow-up run and requires close', async t => {
  const f = await fixture(t), handle = await f.factory(f.input);
  await handle.followUp({ prompt: 'Controlled follow-up in the same invocation.' });
  await assert.rejects(f.observer().verifyClosed(), unverified);
  await handle.close();
  const manifest = await f.observer().verifyClosed();
  assert.equal(manifest.status, 'SETTLED'); assert.equal(manifest.runs.length, 2);
  assert.deepEqual(manifest.runs.map(run => run.runId), f.calls.map(call => call.runId));
  assert.equal(new Set(manifest.runs.map(run => run.sessionId)).size, 1);
});

for (const invalid of ['missing', 'pending', 'foreign']) test(`a ${invalid} earlier graph run cannot hide behind the latest settled follow-up`, async t => {
  const f = await fixture(t), handle = await f.factory(f.input);
  await handle.followUp({ prompt: 'Second owned graph call.' }); await handle.close();
  const manifest = await f.observer().verifyClosed(), first = manifest.runs[0];
  if (invalid === 'missing') await fs.rm(f.file(first.runId));
  else await recordNativeRun(f.root, { ...first, ...(invalid === 'pending' ? { status: 'DISPATCH_COMMITTED' } : { ownerPid: first.ownerPid + 1 }) });
  await assert.rejects(f.observer().verifyClosed(), unverified);
  assert.equal(f.calls.length, 2);
});

test('close returning and a forged SETTLED record cannot replace a pending SDK promise', async t => {
  const release = deferred(), entered = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return output(); });
  f.cleanup.push(async () => { release.resolve(); await f.released.promise; });
  const controller = new AbortController();
  const run = f.factory({ ...f.input, abortSignal: controller.signal });
  const rejected = assert.rejects(run, { code: 'REVIEWER_CANCELLED' });
  await entered.promise;
  controller.abort(Object.assign(new Error('Controlled cancellation with SDK still pending'), { code: 'REVIEWER_CANCELLED' }));
  await rejected;
  const record = (await listNativeRuns(f.root, f.task.taskId))[0];
  await recordNativeRun(f.root, { ...record, status: 'SETTLED', settledAt: Date.now() });
  await assert.rejects(f.observer().verifyClosed(), unverified);
  assert.equal(f.calls.length, 1);
  release.resolve(); await f.released.promise;
  assert.equal((await f.observer().verifyClosed()).runs.length, 1);
});

test('a swallowed physical settlement write failure poisons the invocation observation', async t => {
  const f = await fixture(t), rename = fs.rename;
  let failed = false;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (!failed && path.dirname(target) === path.dirname(f.file('unused'))) {
      const record = JSON.parse(await fs.readFile(source, 'utf8'));
      if (record.status === 'SETTLED') { failed = true; throw Object.assign(new Error('Controlled settlement write failure'), { code: 'EIO' }); }
    }
    return rename(source, target);
  });
  const handle = await f.factory(f.input); await handle.close();
  assert.equal(failed, true);
  const record = (await listNativeRuns(f.root, f.task.taskId))[0];
  await recordNativeRun(f.root, { ...record, status: 'SETTLED', settledAt: Date.now() });
  await assert.rejects(f.observer().verifyClosed(), unverified);
  assert.equal(f.calls.length, 1);
});
