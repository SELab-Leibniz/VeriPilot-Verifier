import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { createOpenClawRuntime } from '../lib/openclaw/runtime.mjs';
import { registerReviewerProgress } from '../lib/openclaw/reviewer-progress.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { createOwnedReadLoopSources } from '../lib/openclaw/owned-read-loop-observer.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const result = { payloads: [{ text: JSON.stringify({ summary: 'controlled engineering result' }) }], meta: {} };

async function fixture(t, body) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-loop-native-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: 'ordinary-parent' });
  let runtime, prepared, requestFile, owned, calls = 0, notices = 0, abortSignal;
  const diagnosticEvents = [];
  let finishCleanup;
  const cleanupComplete = new Promise(resolve => { finishCleanup = resolve; });
  const hooks = new Map();
  const api = { config: { agents: { defaults: { model: { primary: 'fixture/model' } } } },
    logger: { warn() {}, error() {}, info() {} },
    registerTool() {}, on(name, callback) { hooks.set(name, callback); },
    runtime: { version: '2026.7.1-2', agent: {} } };
  const runner = async params => {
    calls++; abortSignal = params.abortSignal;
    const beginRead = async (args, id) => runtime.beforeTool({ toolName: 'read', params: args, toolCallId: id }, {});
    const completeRead = async (args, id, value) => runtime.toolResult({ toolName: 'read', toolCallId: id, args,
      result: value, isError: false }, {});
    const read = async (offset, id, { sameBoundary = false } = {}) => {
      if (!sameBoundary) params.onAssistantMessageStart?.();
      const args = { path: prepared.transcript.path, offset, limit: 2 };
      const blocked = await runtime.beforeTool({ toolName: 'read', params: args, toolCallId: id }, {});
      if (blocked?.block) {
        notices++;
        await completeRead(args, id, { content: [{ type: 'text', text: blocked.blockReason }],
          details: { status: 'blocked', deniedReason: 'plugin-before-tool-call', reason: blocked.blockReason } });
        return blocked;
      }
      const text = (await fs.readFile(args.path, 'utf8')).split('\n').slice(offset - 1, offset + 1).join('\n');
      await runtime.toolResult({ toolName: 'read', toolCallId: id, args,
        result: { content: [{ type: 'text', text }] }, isError: false }, {});
    };
    return body({ params, read, beginRead, completeRead, requestFile, source: prepared.transcript.path,
      hook: (name, ctx) => hooks.get(name)?.({}, ctx) });
  };
  runner.close = async () => { finishCleanup(); };
  registerReviewerProgress(api);
  api.runtime.agent.runEmbeddedAgent = runner;
  runtime = createOpenClawRuntime(api, { pluginRoot, nativeHooks: true,
    projectScopes: { resolve: async () => { throw new Error('Internal calls cannot resolve business scope'); } } });
  const factory = createOpenClawReviewerFactory(api, { runEmbeddedAgent: runner,
    observeTool: async (name, value) => diagnosticEvents.push({ name, value }) });
  const input = { projectRoot: root, taskId: task.taskId, role: 'artifact-reviewer', pluginRoot,
    schema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
    reviewer: { timeoutMs: 15000, formatRepairAttempts: 0 }, request: { instructions: 'Generic controlled review.' },
    evidence: { snapshot: { digest: 'engineering-source', entries: [{ type: 'user',
      message: { role: 'user', content: 'Review the generic delivered artifact.' } }] } },
    onPrepared: ({ request, requestPath }) => { prepared = request; requestFile = requestPath; }, onOwnedInvocation: value => { owned = value; } };
  return { root, input, factory, owned: () => owned, calls: () => calls,
    notices: () => notices, events: () => diagnosticEvents, signal: () => abortSignal, cleanupComplete };
}

test('private factory wiring preserves healthy distinct reads and genuine source changes', async t => {
  const f = await fixture(t, async ({ params, read, source }) => {
    const lines = (await fs.readFile(source, 'utf8')).split('\n').length;
    for (let i = 1; i <= lines; i++) await read(i, `${params.runId}-${i}`);
    assert.equal(params.abortSignal.aborted, false);
    return result;
  });
  const handle = await f.factory(f.input);
  assert.equal(handle.result.summary, 'controlled engineering result');
  assert.equal(handle.readLoopObservation.notices, 0);
  await handle.close();
  assert.equal((await f.owned().verifyClosed()).status, 'SETTLED');
  assert.equal(f.calls(), 1); assert.equal(f.notices(), 0);
});

test('actual private runtime before/result seams coach once and terminate same reviewer as unverified', async t => {
  const f = await fixture(t, async ({ params, read, source }) => {
    const tail = (await fs.readFile(source, 'utf8')).split('\n').length - 1;
    for (let i = 0; i < 64 && !params.abortSignal.aborted; i++) await read(tail, `${params.runId}-${i}`);
    params.abortSignal.throwIfAborted();
    assert.fail('a persistent loop must not return a fake final assessment');
  });
  await assert.rejects(f.factory(f.input), error => error.code === 'REVIEWER_NO_PROGRESS_UNVERIFIED'
    && error.reviewerRuntimeFailure === true && !error.partialReview);
  assert.equal(f.calls(), 1); assert.equal(f.notices(), 1);
  assert.equal(f.signal().reason.code, 'REVIEWER_NO_PROGRESS_UNVERIFIED');
  const closed = await f.owned().verifyClosed();
  assert.equal(closed.status, 'SETTLED'); assert.equal(closed.runs.length, 1);
});

test('noncooperative native settlement stays unverified and retains its private request until settled', async t => {
  let release, source;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async ({ params, read, source: file }) => {
    source = file;
    const tail = (await fs.readFile(file, 'utf8')).split('\n').length - 1;
    for (let i = 0; i < 64 && !params.abortSignal.aborted; i++) await read(tail, `${params.runId}-${i}`);
    await pending;
    return result;
  });
  try {
    await assert.rejects(f.factory(f.input), { code: 'REVIEWER_NO_PROGRESS_UNVERIFIED' });
    await assert.rejects(f.owned().verifyClosed(), { code: 'OWNED_SETTLEMENT_UNVERIFIED' });
    assert.equal((await fs.lstat(source)).isFile(), true, 'pending native input must be retained');
  } finally { release(); }
  const end = Date.now() + 1500;
  while (true) {
    try { assert.equal((await f.owned().verifyClosed()).status, 'SETTLED'); break; }
    catch (error) { if (Date.now() >= end) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  await f.cleanupComplete;
  assert.equal(f.calls(), 1); assert.equal(f.notices(), 1);
});

test('host file catalog detects actual changed bytes and ignores undeclared/foreign files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-loop-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requestDirectory = path.join(root, 'owned'); await fs.mkdir(requestDirectory);
  const file = path.join(requestDirectory, 'current-evidence.txt');
  await fs.writeFile(file, 'first body\n');
  const lookup = await createOwnedReadLoopSources({ projectRoot: root, requestDirectory, requestPath: file,
    prepared: {}, deadlineAt: Date.now() + 5000 });
  const a = await lookup({ path: file });
  assert.equal(a.lineCount, 2, 'SDK trailing empty split slot is counted without claiming it was read');
  await fs.writeFile(file, 'genuinely changed body\nsecond line');
  const b = await lookup({ path: file }); assert.notEqual(b.sha256, a.sha256);
  assert.equal(await lookup({ path: path.relative(root, file) }), null, 'relative reads cannot borrow the projectRoot base when native cwd differs');
  assert.equal(await lookup({ path: path.join(root, 'undeclared') }), null);
  assert.equal(await lookup({ path: '/outside-owned-scope' }), null);
});

test('owned before/after compaction callbacks allow a bounded real rehydration pass', async t => {
  const f = await fixture(t, async ({ params, read, hook }) => {
    const pages = [1, 3, 5, 7];
    for (const page of pages) await read(page, `first-${page}`);
    const own = { sessionId: params.sessionId, sessionKey: params.sessionKey, agentId: params.agentId };
    await hook('before_compaction', { ...own, sessionId: 'foreign' });
    await hook('after_compaction', { ...own, sessionId: 'foreign' });
    await hook('before_compaction', own); await hook('after_compaction', own);
    for (const page of pages) await read(page, `rehydrate-${page}`);
    return result;
  });
  const handle = await f.factory(f.input);
  assert.equal(handle.readLoopObservation.rehydrationReads, 4);
  assert.equal(handle.readLoopObservation.notices, 0);
  await handle.close(); assert.equal((await f.owned().verifyClosed()).status, 'SETTLED');
});


test('native-shaped queued same-boundary repetitions do not consume the post-notice allowance', async t => {
  const f = await fixture(t, async ({ params, read, source }) => {
    const tail = (await fs.readFile(source, 'utf8')).split('\n').length - 1;
    params.onAssistantMessageStart();
    let blocked = false;
    for (let i = 0; i < 40; i++) {
      const decision = await read(tail, `same-boundary-${i}`, { sameBoundary: true });
      if (decision?.block) blocked = true;
    }
    assert.equal(blocked, true);
    assert.equal(params.abortSignal.aborted, false, 'same-batch issuance is not evidence of ignoring its blocked result');
    for (let i = 0; i < 16 && !params.abortSignal.aborted; i++) await read(tail, `later-boundary-${i}`);
    params.abortSignal.throwIfAborted();
    assert.fail('later persistent repetition must remain bounded and unverified');
  });
  await assert.rejects(f.factory(f.input), { code: 'REVIEWER_NO_PROGRESS_UNVERIFIED' });
  assert.equal(f.notices(), 1); assert.equal(f.calls(), 1);
  assert.equal((await f.owned().verifyClosed()).status, 'SETTLED');
});


test('exact coaching result cannot consume an older same-range source-read proof or create authority', async t => {
  let sourceFile, tail;
  const f = await fixture(t, async ({ params, read, beginRead, completeRead, requestFile, source }) => {
    sourceFile = source; tail = (await fs.readFile(source, 'utf8')).split('\n').length - 1;
    params.onAssistantMessageStart();
    const requestArgs = { path: requestFile };
    assert.equal((await beginRead(requestArgs, 'basis-read'))?.block, undefined);
    await completeRead(requestArgs, 'basis-read', { content: [{ type: 'text', text: await fs.readFile(requestFile, 'utf8') }] });
    for (let i = 0; i < 12; i++) await read(tail, `prime-${i}`);
    const args = { path: source, offset: tail, limit: 2 };
    params.onAssistantMessageStart();
    assert.equal((await beginRead(args, 'older-genuine-read'))?.block, undefined);
    await read(tail, 'trigger-threshold');
    const coach = await read(tail, 'host-coaching-call');
    assert.equal(coach?.block, true);
    await completeRead(args, 'older-genuine-read', { content: [{ type: 'text', text: (await fs.readFile(source, 'utf8')).split('\n').slice(tail - 1, tail + 1).join('\n') }] });
    assert.equal(params.abortSignal.aborted, false);
    return result;
  });
  f.input.role = 'implementation-reviewer';
  const handle = await f.factory(f.input);
  const proof = await handle.getSourceCitations({ findings: [{ deviationKey: 'generic-check', evidence: [`${sourceFile}#L${tail}-${tail + 1}`] }] });
  assert.equal(proof.length, 1);
  assert.equal(proof[0].readProof.observed, true);
  assert.equal(proof[0].readProof.basisComplete, true, 'veto text must not poison the real pending receipt');
  assert.equal(proof[0].readProof.owner, 'PROCESS');
  assert.deepEqual(await handle.getSourceCitations({ findings: [{ deviationKey: 'unread-check', evidence: [`${sourceFile}#L1`] }] }), [], 'coaching grants no unread range');
  const blocked = f.events().filter(e => e.name === 'read:result' && e.value.toolCallId === 'host-coaching-call');
  assert.equal(blocked.length, 1, 'ordinary diagnostics retain the unchanged real blocked result');
  assert.equal(blocked[0].value.result.details.status, 'blocked');
  await handle.close(); assert.equal((await f.owned().verifyClosed()).status, 'SETTLED');
});
