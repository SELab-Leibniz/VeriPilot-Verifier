import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { registerTaskTools, TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from '../lib/openclaw/task-tools.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { ensureTask, taskDirectory, withTaskState, withTaskDecision, decisionGuard } from '../lib/runtime-v2/task-store.mjs';
import { loadCurrentGroundTruth, applyGroundTruthDelta } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { atomicWriteJson, readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { toolText } from '../lib/review-task/source-tools.mjs';
import { FileTransactionJournal } from '../lib/runtime-v2/transaction-journal.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { observeInternalTool } from '../lib/openclaw/internal-context.mjs';
import { REVIEWER_NATIVE_TOOL_DENY } from '../lib/reviewer-tools.mjs';

const operation = (ref = 'transcript:U1#L1-L1') => ({ operation: 'ADD', category: 'requirements',
  text: 'Preserve the requested feature.', authority: 'USER_EXPLICIT', severity: 'HARD',
  applicabilityKind: 'CURRENT_TASK',
  source: { ref, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } });

test('completed baseline publication uses the parent deadline after the extractor closes',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t),started=Date.now();f.input.deadlineAt=started+60000;
 const state=await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'));
 let handle;
 const result=await withTaskDecision({projectRoot:f.root,taskId:f.task.taskId,context:{kind:'requirements',assessmentId:'long-parent',
  guard:decisionGuard(state),deadlineAt:started+60000,evidenceMatches:async()=>true}},async()=>{
  handle=await f.run(async({readAll,finish})=>{await readAll();await finish([]);});
  assert.equal(handle.baselineTask.extractionDeadlineAt,started+20000);
  assert.equal(handle.baselineTask.deadlineAt,started+60000);
  await applyGroundTruthDelta({projectRoot:f.root,taskId:f.task.taskId,delta:handle.result,sourceCatalog:f.input.request.sourceCatalog,
   baselineCommit:{...handle.baselineTask,id:handle.baselineTask.requestId,scope:'stop',cursorDigest:'long-parent'}});
  await handle.close();t.mock.timers.tick(21000);
  await handle.baselineTask.assertCurrent();
  return {baselineCommitted:true};
 });
 assert.equal(result.baselineCommitted,true);assert.equal(result.stale,undefined);
 assert.equal((await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'))).assessments['long-parent'].result.baselineCommitted,true);
 t.mock.timers.tick(39000);
 await assert.rejects(handle.baselineTask.assertCurrent(),error=>error.code==='REVIEWER_DEADLINE');
});

test('a completed baseline still rejects source changes after the extraction role deadline',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t);f.input.deadlineAt=Date.now()+60000;
 const handle=await f.run(async({readAll,finish})=>{await readAll();await finish([]);});await handle.close();
 t.mock.timers.tick(21000);await fs.appendFile(f.material,'Changed original source.');
 await assert.rejects(handle.baselineTask.assertCurrent(),error=>error.code==='BASELINE_INPUT_CHANGED');
});

test('baseline publication failure keeps its typed cause and never commits a current cursor',async t=>{
 const f=await fixture(t),state=await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'));
 const result=await withTaskDecision({projectRoot:f.root,taskId:f.task.taskId,context:{kind:'requirements',assessmentId:'changed-before-head',
  guard:decisionGuard(state),evidenceMatches:async()=>true}},async()=>{
  const handle=await f.run(async({readAll,finish})=>{await readAll();await finish([]);});
  await applyGroundTruthDelta({projectRoot:f.root,taskId:f.task.taskId,delta:handle.result,sourceCatalog:f.input.request.sourceCatalog,
   baselineCommit:{...handle.baselineTask,id:handle.baselineTask.requestId,scope:'stop',cursorDigest:'must-not-publish'}});
  await handle.close();await fs.appendFile(f.material,'Changed before the head publication.');
  return {baselineCommitted:true};
 });
 assert.equal(result.stale,true);assert.equal(result.reason,'evidenceChanged');
 assert.equal(result.evidenceFailure.code,'BASELINE_INPUT_CHANGED');assert.match(result.evidenceFailure.reason,/Original source changed/);
 const current=await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'));
 assert.equal(current.assessments?.['changed-before-head'],undefined);
 assert.equal(current.groundTruth.sourceCursors?.stop,undefined);
 const records=(await fs.readFile(path.join(taskDirectory(f.root,f.task.taskId),'journal/events.jsonl'),'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
 assert.equal(records.findLast(record=>record.type==='STALE_ASSESSMENT').evidenceFailure.code,'BASELINE_INPUT_CHANGED');
});

async function fixture(t, { large = false, faults } = {}) {
  const scratch = path.resolve('.runtime-correction/stop-baseline-tests'); await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: 'baseline-test' });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.control ??= {}; });
  const truth = await loadCurrentGroundTruth(root, task.taskId);
  const truthPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json');
  await atomicWriteJson(truthPath, truth);
  const material = path.join(root, 'requirements.md');
  const regression = JSON.parse(await fs.readFile('test/fixtures/stop-baseline-budget.json', 'utf8'));
  const text = large ? Array.from({ length: Math.ceil(regression.observedCumulativeBytes / 64) + 100 }, (_, i) => `${i}: Original condition ${'x'.repeat(68)}`).join('\n') : 'Original material condition.';
  await fs.writeFile(material, text);
  let registry; const hooks = new Map();
  const api = { rootDir: path.resolve('.'), config: { agents: { defaults: { model: { primary: 'fixture/model' }, compaction: { mode: 'safeguard' } } },
    models: { providers: { fixture: { models: [{ id: 'model', contextWindow: 200000, maxTokens: 65536 }] } } } },
    runtime: { version: '2026.7.1-2', agent: {} }, logger: { warn() {}, info() {} },
    registerTool(factory, metadata) { registry = factory; assert(metadata.names.includes('finish_baseline')); },
    on(name, callback) { hooks.set(name, callback); },
  };
  registerTaskTools(api);
  const input = { projectRoot: root, taskId: task.taskId, parentSessionId: 'baseline-test', role: 'ground-truth-extractor',
    reviewer: { timeoutMs: 20000, formatRepairAttempts: 4 }, schema: GROUND_TRUTH_REVIEW_SCHEMA,
    request: { taskId: task.taskId, hookEventId: 'event-1', lastUserCursor: 'U1', hook: { hook_event_name: 'Stop' },
      currentGroundTruth: { path: truthPath, version: truth.version, digest: truth.digest },
      sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE', aliases: ['U1'] }, { ref: material, kind: 'MATERIAL', aliases: ['requirements.md'] }],
      reviewScope: { kind: 'baseline', boundedBasis: true }, instructions: ['Preserve source authority.'] },
    evidence: { groundTruth: truth, snapshot: { entries: [{ type: 'user', uuid: 'U1', message: { role: 'user', content: 'Preserve the requested feature.' } }] } } };
  let params, tools, callId = 0;
  const captures = [], seen = new Map();
  const ctx = () => ({ sessionId: params.sessionId, sessionKey: params.sessionKey });
  async function call(name, args, { persist = true, synthetic = false, notify = true } = {}) {
    const id = `call-${++callId}`; params.onAssistantMessageStart();
    const result = await tools.find(tool => tool.name === name).execute(id, args);
    if (name === 'source_read' && persist) hooks.get('tool_result_persist')({ toolName: name, toolCallId: id, isSynthetic: synthetic,
      message: { role: 'toolResult', toolName: name, toolCallId: id, content: result.content, details: result.details, isError: false } }, ctx());
    if (notify) params.onAgentToolResult({ toolName: name, result, isError: false });
    return result;
  }
  async function readAll() {
    const prompt = JSON.parse(params.prompt);
    for (const file of prompt.requiredFiles) {
      let offset = 1;
      do {
        const result = await call('source_read', { path: file, offset });
        seen.set(file, [...(seen.get(file) ?? []), result.details.citation.citeId]);
        offset = result.details.page.nextOffset;
      } while (offset);
    }
    return prompt;
  }
  const batch = () => ({ batchId: 1, operations: [operation()], bindings: [{ operationIndex: 0,
    citeIds: [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids) }] });
  const finish = ids => call('finish_baseline', { batchIds: ids, taskClassification: ids.length ? 'CONTINUATION' : 'NO_CHANGE', summary: 'Completed extraction.' });
  const makeFactory = script => {
    const factory = createOpenClawReviewerFactory(api, { stopReviewEngine: 'task', baselineFaults: faults,
      runEmbeddedAgent: async value => { params = value; captures.push(value); tools = registry(ctx());
        assert.equal(value.config.agents.defaults.models['fixture/model'].params.maxTokens, input.reviewer.maxOutputTokens ?? 32768);
        assert.deepEqual(value.toolsAllow, BASELINE_TOOL_NAMES); assert.equal(value.config.agents.defaults.compaction.mode, 'safeguard');
        assert(REVIEWER_NATIVE_TOOL_DENY.every(name => value.config.tools.deny.includes(name)));
        assert.equal(value.config.tools.codeMode.enabled, false);
        for (const name of ['write', 'edit', 'exec', 'code_execution', 'mcp__files__write_file'])
          assert.equal((await observeInternalTool(name, {})).block, true, `baseline must block ${name}`);
        assert.equal(await observeInternalTool('source_read', {}), undefined);
        assert.equal(registry({ sessionKey: 'agent:main:business', sessionId: 'business' }), null);
        await script({ call, readAll, batch, finish, params: value, hooks, ctx, seen });
        return { payloads: [], meta: {} };
      } });
    return factory;
  };
  const run = script => makeFactory(script)(input);
  return { root, task, truth, truthPath, material, input, api, run, makeFactory, captures, hooks, registry: () => registry };
}

test('Stop baseline reads beyond the old byte ceiling and returns source-bound operations, not verdicts', async t => {
  const f = await fixture(t, { large: true });
  f.input.reviewer.maxOutputTokens = 65536;
  const handle = await f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); await call('save_baseline_batch', batch()); await finish([1]);
  });
  assert.equal(handle.result.operations[0].source.ref, 'transcript:U1#L1-L1');
  assert.equal(handle.result.operations[0].source.excerpt, 'Preserve the requested feature.');
  assert.equal('verdict' in handle.result, false);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0, 'candidate does not write ledger');
  const checkpoint = await readJson(path.join(handle.artifacts, 'review-checkpoint.json'));
  assert(checkpoint.taskState.metrics.readBytes > 131072);
  assert.equal(checkpoint.taskState.pending.length, 0);
  await handle.close();
});

test('an explicit required-tool deny fails before the native model starts and names its policy',async t=>{
 const f=await fixture(t);
 f.api.config.tools={deny:[BASELINE_TOOL_NAMES.at(-1)]};
 let calls=0;
 await assert.rejects(f.makeFactory(async()=>{calls++;assert.fail('Denied protocol must never call the native model');})(f.input),error=>{
  assert.equal(error.code,'RC_REQUIRED_TOOLS_DENIED');assert.match(error.message,/tools\.deny/);
  assert(error.message.includes(BASELINE_TOOL_NAMES.at(-1)));return true;
 });
 assert.equal(calls,0);assert.equal(f.captures.length,0);
 assert.deepEqual(f.api.config.tools.deny,[BASELINE_TOOL_NAMES.at(-1)]);
});

test('compact removes visible tool results; history/checkpoint restore receipts and pending sources without granting evidence', async t => {
  const f = await fixture(t, { large: true });
  const handle = await f.run(async ({ readAll, call, batch, finish, hooks, ctx, params, seen }) => {
    const initial = JSON.parse(params.prompt);
    for (const file of initial.requiredFiles.filter(file => !file.startsWith('source-0001'))) {
      const read = await call('source_read', { path: file }); seen.set(file, [read.details.citation.citeId]);
    }
    await call('save_baseline_batch', batch());
    await hooks.get('before_compaction')({}, ctx());
    const checkpoint = JSON.parse(await fs.readFile(path.join(path.dirname(params.sessionFile), 'review-checkpoint.json')));
    assert.equal(checkpoint.taskState.batches.length, 1); assert(checkpoint.taskState.pending.length > 0);
    // Simulate a model-visible compacted context: all old source results/IDs
    // are removed; only this untrusted summary and the recovery tool remain.
    const visible = ['Summary: a batch may have been saved; consult review_history.']; seen.clear();
    await hooks.get('after_compaction')({}, ctx());
    let offset = 0, recovered = [], pending = [];
    do {
      const history = JSON.parse(toolText(await call('review_history', { mode: 'state', offset, limit: 10 })));
      visible.push(history); recovered.push(...history.citations); pending.push(...history.taskState.pending);
      offset = history.nextOffset ?? history.taskState.nextStateOffset;
      assert(history.taskState.pendingCount > 0); assert.equal(history.taskState.batchCount, 1);
    } while (offset !== null);
    const ids = recovered.filter(ref => ref.path.startsWith('source-0000')).map(ref => ref.citeId);
    assert(ids.length > 0);
    const saved = JSON.parse(toolText(await call('review_history', { mode: 'search', query: 'candidateBatch' })));
    assert(saved.matches.length > 0);
    const observation = JSON.parse(toolText(await call('review_history', { mode: 'read', entryId: saved.matches[0].entryId })));
    assert.match(observation.text, /Preserve the requested feature/);
    // Only the structured pending ranges remain available to the model.
    for (const item of pending) for (const range of item.ranges) {
      let start = range.start;
      do { const read = await call('source_read', { path: item.file, offset: start, limit: range.end - start + 1 });
        start = read.details.page.nextOffset;
      } while (start && start <= range.end);
    }
    await finish([1]);
  });
  await handle.close();
});

test('missing or synthetic read receipts cannot establish even NO_CHANGE', async t => {
  for (const synthetic of [false, true]) await t.test(String(synthetic), async t => {
    const f = await fixture(t);
    const controller = new AbortController(); f.input.abortSignal = controller.signal;
    await assert.rejects(f.run(async ({ call, finish, params }) => {
      for (const file of JSON.parse(params.prompt).requiredFiles) await call('source_read', { path: file }, { persist: synthetic, synthetic });
      await assert.rejects(finish([]), { code: 'BASELINE_INCOMPLETE' });
      controller.abort(new Error('test cancellation')); throw controller.signal.reason;
    }), /test cancellation/);
    assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  });
});

test('durable batches recover lost acknowledgements; conflicts and omitted batches are rejected', async t => {
  let lost = true;
  const f = await fixture(t, { faults: { afterBatchPersist() { if (lost) { lost = false; throw new Error('lost acknowledgement'); } } } });
  const handle = await f.run(async ({ call, readAll, batch, finish }) => {
    await readAll(); const value = batch();
    await assert.rejects(call('save_baseline_batch', value), /lost acknowledgement/);
    const stored = JSON.parse(toolText(await call('save_baseline_batch', value)));
    assert.equal(stored.batchId, 1);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], text: 'Conflicting claim' }] }), { code: 'BASELINE_BATCH_CONFLICT' });
    await assert.rejects(finish([]), { code: 'BASELINE_INCOMPLETE' }); await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('source authority and baseline version fences survive task transport', async t => {
  const f = await fixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  await assert.rejects(f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); const value = batch(); value.operations[0].source.ref = f.material; value.operations[0].source.kind = 'MATERIAL';
    await assert.rejects(call('save_baseline_batch', value), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    await call('save_baseline_batch', batch());
    await atomicWriteJson(f.truthPath, { ...f.truth, version: 1, digest: 'changed' });
    await assert.rejects(finish([1]), { code: 'BASELINE_INPUT_CHANGED' });
    controller.abort(new Error('version fence')); throw controller.signal.reason;
  }), /version fence/);
});

test('domain repair uses a new candidate generation, preserving read proof and original deadline', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, call, batch, finish, params, seen }) => {
    if (!seen.size) await readAll();
    await call('save_baseline_batch', batch()); await finish([1]);
  });
  const old = handle.result;
  await handle.followUp({ prompt: 'Repair rejected delta without changing source authority.', nextSchema: GROUND_TRUTH_REVIEW_SCHEMA });
  assert.deepEqual(handle.result, old); assert.equal(f.captures.length, 2);
  assert.equal(f.captures[0].sessionId, f.captures[1].sessionId);
  assert(f.captures[1].timeoutMs <= f.captures[0].timeoutMs);
  const checkpoint = await readJson(path.join(handle.artifacts, 'review-checkpoint.json'));
  assert.equal(checkpoint.taskState.generation, 1); assert.equal(checkpoint.taskState.repairs, 1);
  await handle.close();
});

test('formal delta, commit receipt and source cursor publish once, including a lost application reply', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, call, batch, finish }) => { await readAll(); await call('save_baseline_batch', batch()); await finish([1]); });
  const options = { projectRoot: f.root, taskId: f.task.taskId, delta: handle.result, sourceCatalog: f.input.request.sourceCatalog,
    baselineCommit: { ...handle.baselineTask, id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'cursor-1' } };
  const first = await applyGroundTruthDelta(options);
  assert.equal(first.current.version, 1);
  const duplicate = await applyGroundTruthDelta(options); assert.equal(duplicate.duplicate, true);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).claims.length, 1);
  const state = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(state.groundTruth.sourceCursors.stop, 'cursor-1');
  await assert.rejects(applyGroundTruthDelta({ ...options, delta: { ...handle.result, operations: [] } }), { code: 'BASELINE_COMMIT_CONFLICT' });
  await handle.close();
});

test('unrelated native extraction retains its existing read-only transport', async t => {
  const f = await fixture(t); let calls = 0;
  const factory = createOpenClawReviewerFactory(f.api, { runEmbeddedAgent: async params => {
    calls++; assert.deepEqual(params.toolsAllow, ['read']);
    return { payloads: [{ text: JSON.stringify({ summary: 'None', taskClassification: 'NO_CHANGE', operations: [] }) }], meta: {} };
  } });
  const input = structuredClone(f.input); delete input.request.reviewScope;
  const handle = await factory(input); assert.equal(calls, 1); assert.equal(handle.baselineTask, undefined); await handle.close();
  assert(TASK_TOOL_NAMES.includes('submit_review')); assert(!TASK_TOOL_NAMES.includes('finish_baseline'));
});

test('lost completion acknowledgement returns the same durable receipt and rejects conflicting completion', async t => {
  let lost = true;
  const f = await fixture(t, { faults: { afterFinishPersist() { if (lost) { lost = false; throw new Error('lost finish reply'); } } } });
  const handle = await f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); await call('save_baseline_batch', batch());
    await assert.rejects(finish([1]), /lost finish reply/);
    const first = toolText(await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Completed extraction.' }, { notify: false }));
    assert.equal(toolText(await finish([1])), first);
    await assert.rejects(call('finish_baseline', { batchIds: [1], taskClassification: 'CORRECTION', summary: 'Different finish' }), { code: 'BASELINE_FINISH_CONFLICT' });
  });
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('virtual time crosses the original deadline after compact without a real wait or a completed baseline', async t => {
  const f = await fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  f.input.deadlineAt = now + 2000;
  await assert.rejects(f.run(async ({ readAll, call, batch, finish, hooks, ctx }) => {
    await readAll(); await call('save_baseline_batch', batch());
    await hooks.get('before_compaction')({}, ctx()); now += 1500;
    await hooks.get('after_compaction')({}, ctx());
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    assert.equal(state.taskState.deadlineAt, f.input.deadlineAt);
    now += 501; await finish([1]);
  }), { code: 'REVIEWER_DEADLINE' });
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
});

test('cancellation after candidate finish persisted cannot produce a usable complete handle', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { faults: { afterFinishPersist() { controller.abort(new Error('cancel at candidate persistence')); } } });
  f.input.abortSignal = controller.signal;
  await assert.rejects(f.run(async ({ readAll, call, batch, finish }) => { await readAll(); await call('save_baseline_batch', batch()); await finish([1]); }), /cancel at candidate persistence/);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  assert.equal(f.registry()(f.captures[0]), null);
});

test('cancellation after transaction log write but before head publication applies neither delta nor cursor', async t => {
  const f = await fixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  const handle = await f.run(async ({ readAll, call, batch, finish }) => { await readAll(); await call('save_baseline_batch', batch()); await finish([1]); });
  const publish = FileTransactionJournal.prototype.publish;
  t.mock.method(FileTransactionJournal.prototype, 'publish', async function (...args) {
    const fault = this.fault;
    if (String(args[3]?.operationId).startsWith('baseline:')) this.fault = async point => {
      await fault.call(this, point);
      if (point === 'commit-written') controller.abort(new Error('cancel at head fence'));
    };
    try { return await publish.apply(this, args); } finally { this.fault = fault; }
  });
  await assert.rejects(applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...handle.baselineTask,
      id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'must-not-advance' } }), /cancel at head fence/);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  const state = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(state.groundTruth.sourceCursors.stop, undefined); await handle.close();
});

test('a complete empty delta and frozen authority filtering still use existing ledger semantics', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, finish }) => { await readAll(); await finish([]); });
  assert.equal(handle.result.taskClassification, 'NO_CHANGE'); assert.deepEqual(handle.result.operations, []);
  await handle.close();
  await atomicWriteJson(f.truthPath, { ...f.truth, frozenAtVersion: 0 });
  const dropped = await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId,
    sourceCatalog: f.input.request.sourceCatalog, delta: { operations: [{ ...operation('requirements.md'), authority: 'MATERIAL_DERIVED', source: { ref: 'requirements.md', kind: 'MATERIAL' } }] } });
  assert.equal(dropped.changed, false); assert.equal(dropped.droppedPostFreeze.length, 1);
});

test('real MA hook runner accepts the isolated baseline tool protocol, synchronous receipts and compact checkpoints without a model',
  { skip: !process.env.RC_OPENCLAW_HOST_ROOT }, async t => {
    const host = process.env.RC_OPENCLAW_HOST_ROOT;
    const { i: initialize, t: current, a: reset } = await import(pathToFileURL(path.join(host, 'dist/hook-runner-global-BmIrGlLG.js')));
    const source = await fs.readFile(path.join(host, 'dist/attempt.model-diagnostic-events-CfZQM0hs.js'), 'utf8');
    assert.match(source, /runToolResultPersist\(\{\s*toolName: meta.toolName,\s*toolCallId: meta.toolCallId,\s*message,\s*isSynthetic: meta.isSynthetic/u);
    assert.match(source, /sessionKey: opts\?\.sessionKey/u, 'the actual persistence transport includes the private binding key');
    const f = await fixture(t); const pluginId = `baseline-contract-${crypto.randomUUID()}`;
    reset(); t.after(reset);
    initialize({ hooks: [], plugins: [{ id: pluginId, status: 'loaded' }], typedHooks: [...f.hooks].map(([hookName, handler]) => ({ pluginId, hookName, handler, timeoutMs: 30000 })) });
    const runner = current();
    f.hooks.set('tool_result_persist', (event, ctx) => {
      const result = runner.runToolResultPersist(event, ctx);
      assert.equal(result instanceof Promise, false); assert.equal(result.message, event.message);
      return result;
    });
    f.hooks.set('before_compaction', (event, ctx) => runner.runBeforeCompaction(event, ctx));
    f.hooks.set('after_compaction', (event, ctx) => runner.runAfterCompaction(event, ctx));
    const handle = await f.run(async ({ readAll, call, batch, finish, hooks, ctx }) => {
      await readAll(); await call('save_baseline_batch', batch());
      await hooks.get('before_compaction')({ messageCount: 10 }, ctx());
      await hooks.get('after_compaction')({ messageCount: 1, compactedCount: 9 }, ctx());
      const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
      assert.equal(state.taskState.batchCount, 1); assert.equal(state.taskState.pendingCount, 0);
      await finish([1]);
    });
    assert.equal(handle.result.operations.length, 1); await handle.close();
    assert.equal(f.registry()(f.captures[0]), null, 'closed private sessions cannot retain tools');
  });

test('existing requirements orchestrator repairs a rejected claimId, commits once and advances its source cursor', async t => {
  const f = await fixture(t); let attempts = 0;
  const transcript = path.join(f.root, 'transcript.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'U1', message: { role: 'user', content: 'Preserve the requested feature.' } }) + '\n');
  const factory = f.makeFactory(async ({ readAll, call, batch, finish, seen }) => {
    if (!seen.size) await readAll();
    const value = batch();
    if (++attempts === 1) value.operations[0] = { ...value.operations[0], operation: 'SUPERSEDE', claimId: 'unknown-original-claim' };
    await call('save_baseline_batch', value); await finish([1]);
  });
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [f.material] },
    reviewers: { defaults: { model: 'fixture/model', timeoutMs: 20000, formatRepairAttempts: 3 } },
    skillCorrection: { enabled: false }, stopCorrection: { enabled: true } }, { policyRoot: path.join(f.root, '.runtime-corrector') });
  const state = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  const result = await refreshRuntimeRequirements({ projectRoot: f.root,
    input: { cwd: f.root, session_id: 'baseline-test', hook_event_name: 'Stop', hook_event_id: 'integration-event', transcript_path: transcript },
    plan: { runtimeV2 }, reviewerFactory: factory,
    assessmentContext: { assessmentId: 'baseline-integration', guard: decisionGuard(state), deadlineAt: Date.now() + 20000 } });
  assert.equal(attempts, 2); assert.equal(result.baselineCommitted, true); assert.equal(result.requirementVersion, 1);
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  assert.equal(current.claims.length, 1);
  const saved = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(typeof saved.groundTruth.sourceCursors.stop, 'string');
  assert.equal(saved.groundTruth.version, current.version);
});
