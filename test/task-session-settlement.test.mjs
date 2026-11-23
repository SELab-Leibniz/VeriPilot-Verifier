import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createNativeTaskSession } from '../lib/openclaw/task-session.mjs';
import { listNativeRuns, recordNativeRun } from '../lib/openclaw/native-runs.mjs';
import { runStopBaselineTask } from '../lib/runtime-v2/baseline-task.mjs';
import { registerTaskTools } from '../lib/openclaw/task-tools.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { ensureTask, taskDirectory, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { atomicWriteJson, readJson, sha256 } from '../lib/runtime-v2/utils.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const unverified = { code: 'OWNED_SETTLEMENT_UNVERIFIED' };
const selection = { config: {}, provider: 'offline-fixture', model: 'offline-fixture' };
const nativeDirectory = (root, taskId) => path.join(root, '.runtime-correction', 'openclaw', 'native-runs', sha256(taskId));

async function scratch(t, beforeRemove) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-owned-settlement-')));
  t.after(async () => {
    try { await beforeRemove?.(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  return root;
}

async function fixture(t, { runner, signal, options } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-owned-settlement-')));
  const taskId = 'offline-settlement-task', calls = [], closes = [], cleanup = [];
  const nativeRunner = async params => {
    assert.equal(params.config.agents.list.find(agent => agent.id === "main").memorySearch.enabled, false);
    assert.deepEqual(selection.config, {}, "the direct task-session path must leave its caller's host config intact");
    calls.push(params);
    return runner ? runner(params) : { payloads: [], meta: {} };
  };
  nativeRunner.close = async (...args) => { closes.push(args); };
  const session = await createNativeTaskSession({ projectRoot: root, taskId,
    role: 'ground-truth-extractor', request: {}, reviewer: { timeoutMs: 20000 }, abortSignal: signal }, {
    api: { runtime: { version: '2026.7.1-2', agent: {} } }, nativeRunner, selection, options,
  });
  t.after(async () => {
    for (const release of cleanup) release();
    await session.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const worker = { tools: [], cwd: root, outputDir: root, prompt: 'offline fixture', systemPrompt: '',
    active() {}, isComplete: () => true, phase: () => 'CANDIDATE_COMPLETE', onAssistantMessageStart() {} };
  return { root, taskId, session, worker, calls, closes, cleanup,
    file: id => path.join(nativeDirectory(root, taskId), `${id}.json`) };
}

// Delay/fail only the real SETTLED atomic rename, after DISPATCH_COMMITTED.
function interceptSettlement(t, f, callback) {
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (path.dirname(target) === nativeDirectory(f.root, f.taskId)) {
      const record = JSON.parse(await fs.readFile(source, 'utf8'));
      if (record.status === 'SETTLED') await callback(record, target);
    }
    return rename(source, target);
  });
}

test('owned settlement rejects an empty dispatch set even if another session is SETTLED', async t => {
  const f = await fixture(t);
  await recordNativeRun(f.root, { taskId: f.taskId, runId: 'foreign', sessionId: 'foreign',
    role: 'ground-truth-extractor', ownerPid: process.pid, status: 'SETTLED', settledAt: Date.now() });
  await assert.rejects(f.session.awaitOwnedSettlement(), unverified);
  assert.equal(f.calls.length, 0);
});

test('cancellation while binding a native task closes the unlaunched dispatch receipt', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal });
  let runId;
  await assert.rejects(f.session.run({ ...f.worker,
    bindNative(native) {
      runId = native.runId;
      controller.abort(Object.assign(new Error('Cancelled before the host invocation'), { code: 'REVIEWER_CANCELLED' }));
    },
  }), { code: 'REVIEWER_CANCELLED' });
  assert.equal(f.calls.length, 0);
  assert.equal((await readJson(f.file(runId))).status, 'PRE_DISPATCH_CLOSED');
  assert.deepEqual(await listNativeRuns(f.root, f.taskId), []);
});

test('cancellation at the last native launch check does not create a settled host run', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal, options: { approvalBridge: {
    bind() {
      controller.abort(Object.assign(new Error('Cancelled at the native launch check'), { code: 'REVIEWER_CANCELLED' }));
    },
  } } });
  await assert.rejects(f.session.run(f.worker), { code: 'REVIEWER_CANCELLED' });
  assert.equal(f.calls.length, 0);
  assert.equal((await readJson(f.file(f.session.runId))).status, 'PRE_DISPATCH_CLOSED');
  assert.deepEqual(await listNativeRuns(f.root, f.taskId), []);
});

test('the barrier waits for an owned invocation and leaves the session open', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { runner: async () => {
    entered.resolve(); await release.promise; return { payloads: [], meta: {} };
  } });
  f.cleanup.push(() => release.resolve());
  const run = f.session.run(f.worker);
  await entered.promise;
  let resolved = false;
  const barrier = f.session.awaitOwnedSettlement().then(value => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal((await listNativeRuns(f.root, f.taskId))[0].status, 'DISPATCH_COMMITTED');
  release.resolve(); await run;
  const proof = await barrier;
  assert.deepEqual(proof.runIds, [f.calls[0].runId]);
  assert.equal(proof.sessionId, f.session.sessionId);
  assert.equal(proof.ownerPid, process.pid);
  assert.equal(proof.status, 'SETTLED');
  assert.equal(f.closes.length, 0);
  assert.equal(f.session.signal.aborted, false);
});

test('returning from run does not bypass a delayed physical SETTLED write', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.cleanup.push(() => release.resolve());
  interceptSettlement(t, f, async () => { entered.resolve(); await release.promise; });
  await f.session.run(f.worker); await entered.promise;
  assert.equal((await readJson(f.file(f.calls[0].runId))).status, 'DISPATCH_COMMITTED');
  let resolved = false;
  const barrier = f.session.awaitOwnedSettlement().then(value => { resolved = true; return value; });
  await Promise.resolve(); assert.equal(resolved, false);
  release.resolve();
  await barrier;
  assert.equal((await readJson(f.file(f.calls[0].runId))).status, 'SETTLED');
  assert.equal(f.closes.length, 0);
});

test('a swallowed settlement write failure stays visible even with a replacement SETTLED record', async t => {
  const f = await fixture(t);
  const writeError = Object.assign(new Error('Controlled settlement write failure'), { code: 'EIO' });
  interceptSettlement(t, f, async () => { throw writeError; });
  await f.session.run(f.worker);
  await assert.rejects(f.session.awaitOwnedSettlement(), error => error.code === unverified.code && error.cause === writeError);
  const file = f.file(f.calls[0].runId), record = await readJson(file);
  await fs.writeFile(file, JSON.stringify({ ...record, status: 'SETTLED', settledAt: Date.now() }));
  await assert.rejects(f.session.awaitOwnedSettlement(), error => error.code === unverified.code && error.cause === writeError);
});

test('a later barrier rereads physical records instead of caching an earlier success', async t => {
  const f = await fixture(t);
  await f.session.run(f.worker); await f.session.awaitOwnedSettlement();
  await fs.rm(f.file(f.calls[0].runId));
  await assert.rejects(f.session.awaitOwnedSettlement(), unverified);
});

for (const [field, value] of [
  ['taskId', 'foreign-task'], ['sessionId', 'foreign-session'], ['runId', 'foreign-run'],
  ['role', 'skill-reviewer'], ['ownerPid', -1], ['startedAt', -1], ['sessionFile', 'foreign.jsonl'],
  ['status', 'DISPATCH_COMMITTED'], ['settledAt', null],
]) test(`physical settlement rejects a changed ${field}`, async t => {
  const f = await fixture(t);
  await f.session.run(f.worker); await f.session.awaitOwnedSettlement();
  const file = f.file(f.calls[0].runId), record = await readJson(file);
  await fs.writeFile(file, JSON.stringify({ ...record, [field]: value }));
  await assert.rejects(f.session.awaitOwnedSettlement(), unverified);
});

test('duplicate physical records cannot grant an owned settlement', async t => {
  const f = await fixture(t);
  await f.session.run(f.worker); await f.session.awaitOwnedSettlement();
  await fs.copyFile(f.file(f.calls[0].runId), f.file('duplicate'));
  await assert.rejects(f.session.awaitOwnedSettlement(), unverified);
});

test('original cancellation interrupts the barrier while settlement is blocked', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal });
  const entered = deferred(), release = deferred();
  f.cleanup.push(() => release.resolve());
  interceptSettlement(t, f, async () => { entered.resolve(); await release.promise; });
  await f.session.run(f.worker); await entered.promise;
  const barrier = f.session.awaitOwnedSettlement();
  const reason = Object.assign(new Error('Controlled parent cancellation'), { code: 'CONTROLLED_CANCEL' });
  const rejected = assert.rejects(barrier, error => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(f.closes.length, 0);
  release.resolve(); await f.session.close();
});

test('the original deadline interrupts a pending barrier without a fresh timeout window', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.cleanup.push(() => release.resolve());
  interceptSettlement(t, f, async () => { entered.resolve(); await release.promise; });
  await f.session.run(f.worker); await entered.promise;
  const originalDeadline = f.session.deadlineAt;
  const rejected = assert.rejects(f.session.awaitOwnedSettlement(), { code: 'REVIEWER_DEADLINE' });
  t.mock.timers.tick(originalDeadline - Date.now());
  await rejected;
  assert.equal(f.session.deadlineAt, originalDeadline);
  assert.equal(f.closes.length, 0);
  release.resolve(); await f.session.close();
});

test('a new owned run during record validation invalidates that barrier', async t => {
  const f = await fixture(t);
  await f.session.run(f.worker); await f.session.awaitOwnedSettlement();
  const entered = deferred(), release = deferred(), readdir = fs.readdir;
  let blocked = false;
  f.cleanup.push(() => release.resolve());
  t.mock.method(fs, 'readdir', async (...args) => {
    if (!blocked && args[0] === nativeDirectory(f.root, f.taskId)) {
      blocked = true; entered.resolve(); await release.promise;
    }
    return readdir(...args);
  });
  const rejected = assert.rejects(f.session.awaitOwnedSettlement(), unverified);
  await entered.promise;
  await f.session.run(f.worker);
  release.resolve(); await rejected;
  assert.deepEqual((await f.session.awaitOwnedSettlement()).runIds, f.calls.map(call => call.runId));
});

test('baseline exposes the non-closing barrier and followUp reuses its actor, reads and budgets', async t => {
  let handle;
  const root = await scratch(t, () => handle?.close());
  const task = await ensureTask({ projectRoot: root, sessionId: 'offline-baseline' });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.control ??= {}; });
  const truth = await loadCurrentGroundTruth(root, task.taskId);
  const truthPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json');
  await atomicWriteJson(truthPath, truth);
  let registry, callId = 0;
  const hooks = new Map(), captures = [], cites = [];
  const api = { runtime: { version: '2026.7.1-2', agent: {} },
    registerTool(factory) { registry = factory; }, on(name, callback) { hooks.set(name, callback); } };
  registerTaskTools(api);
  const nativeRunner = async params => {
    captures.push(params);
    await fs.access(params.sessionFile).catch(() => fs.writeFile(params.sessionFile, JSON.stringify({ type: 'session', version: 3, id: params.sessionId }) + '\n'));
    const ctx = { sessionId: params.sessionId, sessionKey: params.sessionKey, runId: params.runId };
    const tools = registry(ctx), prompt = JSON.parse(params.prompt);
    const call = async (name, args) => {
      params.onAssistantMessageStart();
      const id = `settlement${++callId}`;
      await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } }) + '\n');
      const result = await tools.find(tool => tool.name === name).execute(id, args);
      const message = { role: 'toolResult', toolName: name, toolCallId: id, content: result.content, details: result.details, isError: Boolean(result.isError) };
      hooks.get('tool_result_persist')({ toolName: name, toolCallId: id, isSynthetic: false, message }, ctx);
      await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message }) + '\n');

      params.onAgentToolResult({ toolName: name, result, isError: false });
      return result;
    };
    if (captures.length === 1) for (const file of prompt.requiredFiles) {
      let offset = 1;
      do {
        const result = await call('source_read', { path: file, offset });
        if (file.startsWith('source-0000')) cites.push(result.details.citation.citeId);
        offset = result.details.page.nextOffset;
      } while (offset);
    }
    await call('save_baseline_batch', { batchId: 1, operations: [{ operation: 'ADD', category: 'requirements',
      text: 'Preserve the requested feature.', authority: 'USER_EXPLICIT', severity: 'HARD',
      applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
      source: { ref: 'transcript:U1#L1-L1', kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }],
      bindings: [{ operationIndex: 0, citeIds: cites }] });
    await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Offline extraction.' });
    return { payloads: [], meta: {} };
  };
  let closes = 0;
  nativeRunner.close = async () => { closes++; };
  handle = await runStopBaselineTask({ projectRoot: root, taskId: task.taskId, role: 'ground-truth-extractor',
    reviewer: { timeoutMs: 20000, formatRepairAttempts: 3 }, schema: GROUND_TRUTH_REVIEW_SCHEMA,
    request: { taskId: task.taskId, currentGroundTruth: { path: truthPath, version: truth.version, digest: truth.digest },
      sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE', aliases: ['U1'] }],
      reviewScope: { kind: 'baseline', boundedBasis: true } },
    evidence: { groundTruth: truth, snapshot: { entries: [{ type: 'user', uuid: 'U1',
      message: { role: 'user', content: 'Preserve the requested feature.' } }] } },
  }, { api, nativeRunner, selection, options: { baselineWireMode: 'full' } });
  const checkpoint = path.join(handle.artifacts, 'review-checkpoint.json');
  const first = (await readJson(checkpoint)).taskState;
  assert.deepEqual((await handle.baselineTask.awaitOwnedSettlement()).runIds, [captures[0].runId]);
  assert.equal(closes, 0);
  const deadline = handle.baselineTask.extractionDeadlineAt;
  await handle.followUp({ prompt: 'Recheck the same source-bound candidate.' });
  const after = (await readJson(checkpoint)).taskState;
  const proof = await handle.baselineTask.awaitOwnedSettlement();
  assert.deepEqual(proof.runIds, captures.map(params => params.runId));
  assert.equal(captures[1].sessionId, captures[0].sessionId);
  assert.notEqual(captures[1].runId, captures[0].runId);
  assert.equal(after.generation, first.generation + 1);
  assert.equal(after.repairs, first.repairs + 1);
  assert.equal(after.maxRepairs, 3);
  assert.equal(after.maxTurns, first.maxTurns);
  assert.equal(after.deadlineAt, first.deadlineAt);
  assert.equal(handle.baselineTask.extractionDeadlineAt, deadline);
  assert.equal(after.metrics.readBytes, first.metrics.readBytes);
  assert.equal(closes, 0);
  assert.equal((await loadCurrentGroundTruth(root, task.taskId)).version, truth.version);
});
