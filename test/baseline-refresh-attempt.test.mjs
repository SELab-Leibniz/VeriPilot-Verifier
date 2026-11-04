import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { runAutomaticBaselineRefresh, BASELINE_REFRESH_RETRY } from '../lib/runtime-v2/baseline-refresh-attempt.mjs';

async function fixture(t) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-retry-')));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot, sessionId: 'retry-session' });
  return { projectRoot, taskId: task.taskId, key: 'original-source-revision', deadlineAt: Date.now() + 100000 };
}

test('pre/post and later tools share backoff and a finite source-revision retry budget', async t => {
  const f = await fixture(t); let calls = 0, time = Date.now();
  const run = () => runAutomaticBaselineRefresh({ ...f, now: () => time, run: async () => {
    calls++; return { unverified: true, error: Object.assign(new Error('context overflow'), { code: 'REVIEWER_RUN_FAILED' }) };
  } });
  assert.equal((await run()).unverified, true);
  for (let index = 0; index < 20; index++) assert.equal((await run()).reason, 'BASELINE_REFRESH_BACKOFF');
  assert.equal(calls, 1);
  time += BASELINE_REFRESH_RETRY.delayMs;
  await run(); assert.equal(calls, 2);
  time += BASELINE_REFRESH_RETRY.delayMs * 2;
  await run(); assert.equal(calls, 3);
  time += 10000000;
  assert.equal((await run()).reason, 'BASELINE_REFRESH_RETRY_LIMIT'); assert.equal(calls, 3);
  const changed = await runAutomaticBaselineRefresh({ ...f, key: 'new-user-or-model-policy',
    now: () => time, run: async () => ({ unverified: false, version: 2 }) });
  assert.equal(changed.version, 2);
});

test('a concurrent callback cannot duplicate a live refresh or steal it with another source key', async t => {
  const f = await fixture(t); let complete, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = runAutomaticBaselineRefresh({ ...f, run: () => {
    entered(); return new Promise(resolve => { complete = resolve; });
  } });
  await started;
  const duplicate = await runAutomaticBaselineRefresh({ ...f, key: 'changed-while-running', run: () => assert.fail('duplicate dispatch') });
  assert.equal(duplicate.reason, 'BASELINE_REFRESH_IN_PROGRESS');
  complete({ unverified: false }); await pending;
  let reran = false;
  await runAutomaticBaselineRefresh({ ...f, run: async () => { reran = true; return { unverified: false }; } });
  assert.equal(reran, true, 'Scheduling state never substitutes for the actual strong-basis check');
});

test('thrown failures settle scheduling ownership and cancellation prevents dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(runAutomaticBaselineRefresh({ ...f, run: () => { throw new Error('provider failed'); } }), /provider failed/);
  assert.equal((await runAutomaticBaselineRefresh({ ...f, run: () => assert.fail('retry during backoff') })).deferred, true);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(runAutomaticBaselineRefresh({ ...f, key: 'new-source', signal: controller.signal,
    run: () => assert.fail('cancelled dispatch') }), /cancelled/);
});

test('new explicit selections can retry promptly but cannot abandon the source revision attempt cap', async t => {
  const f = await fixture(t); let calls = 0;
  const select = actionId => runAutomaticBaselineRefresh({ ...f, actionId, retryOnNewAction: true,
    run: () => { calls++; return { unverified: true, error: new Error('Controlled selection failure') }; } });
  await select('selection-1');
  assert.equal((await select('selection-1')).reason, 'BASELINE_REFRESH_BACKOFF');
  await select('selection-2'); await select('selection-3');
  assert.equal((await select('selection-4')).reason, 'BASELINE_REFRESH_RETRY_LIMIT');
  assert.equal(calls, 3);
});

test('a frozen conflict with no new authority cannot be retried by another tool against the same basis', async t => {
  const f = await fixture(t), code = 'BASELINE_FROZEN_AUTHORIZATION_REQUIRED';
  await runAutomaticBaselineRefresh({ ...f, actionId: 'before', run: async () => ({ unverified: true, error: { code } }) });
  const blocked = await runAutomaticBaselineRefresh({ ...f, actionId: 'after', retryOnNewAction: true,
    now: () => Date.now() + 3600000, run: () => assert.fail('same frozen source retried') });
  assert.equal(blocked.reason, code);
  assert.equal((await runAutomaticBaselineRefresh({ ...f, key: 'new-authorized-user-source',
    run: async () => ({ version: 2 }) })).version, 2);
});
