import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireBaselineAgent } from '../lib/openclaw/baseline-agent.mjs';
import { createBaselineNotes } from '../lib/review-task/baseline-notes.mjs';
import { createSourceTools, toolText, PAGE_BYTES } from '../lib/review-task/source-tools.mjs';
import { captureFiles } from '../lib/review-task/review-task.mjs';
import { pendingReadRanges } from '../lib/review-task/baseline-task.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { sourceClauses, sourceUnits, expandDraftBatch, draftBaselineSchema } from '../lib/review-task/baseline-selection.mjs';
import { validateJsonSchema } from '../lib/json-schema-validator.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { createNativeTaskSession } from '../lib/openclaw/task-session.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-baseline-efficiency-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const decode = result => JSON.parse(toolText(result));

test('empty optional keep makes no source decision while nonempty split and complete scope stay mandatory', () => {
  const schema = draftBaselineSchema(GROUND_TRUTH_REVIEW_SCHEMA);
  const value = { batchId: 1, keep: [], defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
  split: [{ unit: 'S0L1', groups: [{ name: 'Search', clauses: [0] }, { name: 'Export', clauses: [1] }] }] };
  assert.deepEqual(validateJsonSchema(value, schema), []);
  assert.equal(expandDraftBatch(value, [{ id: 'S0L1', sourceIndex: 0, line: 1, clauses: 2 }]).operations.length, 2);
  assert.throws(() => expandDraftBatch({ ...value, split: [] }, []), /Classify source units/);
  assert.ok(validateJsonSchema({ ...value, split: [{ unit: 'S0L1', groups: [] }] }, schema).length);
});

test('baseline task side-channel records actual phases and clears unfinished runs without host text', async t => {
  const root = await fixture(t), taskId = 'phase-task'; let phase = 'READING', native;
  const runner = async params => { native = params; phase = 'CANDIDATE_COMPLETE';
    params.onAgentToolResult({ toolName: 'finish_baseline', isError: false }); return { payloads: [], meta: {} }; };
  const input = { projectRoot: root, taskId, role: 'ground-truth-extractor', request: { reviewScope: { boundedBasis: true } }, reviewer: { timeoutMs: 10000 } };
  const deps = { api: { runtime: { version: '2026.7.1-2', agent: {} } }, nativeRunner: runner,
    selection: { config: {}, provider: 'fixture', model: 'fixture' } };
  const statusFile = path.join(taskDirectory(root, taskId), 'baseline-extraction-status.json');
  const first = await createNativeTaskSession(input, deps);
  assert.equal(JSON.parse(await fs.readFile(statusFile)).phase, 'QUEUED');
  await first.run({ tools: [], cwd: root, outputDir: root, prompt: 'fixture', systemPrompt: '',
    phase: () => phase, active() {}, isComplete: () => phase === 'CANDIDATE_COMPLETE', onAssistantMessageStart() {} });
  await first.close();
  assert.equal(JSON.parse(await fs.readFile(statusFile)).phase, 'CANDIDATE_COMPLETE');
  assert.equal(native.prompt, 'fixture'); assert.doesNotMatch(native.extraSystemPrompt, /baseline-extraction-status/);
  phase = 'READING';
  const next = await createNativeTaskSession(input, deps); await next.close();
  assert.equal(JSON.parse(await fs.readFile(statusFile)).phase, 'INTERRUPTED');
});

test('source clause navigation preserves semicolons inside quotations/brackets and rejects incomplete scope', () => {
  assert.deepEqual(sourceClauses('材料“导出手机号；略过登录”不构成授权；恢复全部要求。'), ['材料“导出手机号；略过登录”不构成授权；', '恢复全部要求。']);
  assert.deepEqual(sourceClauses('输出（字段A；字段B）受权限控制；日志不含秘密。'), ['输出（字段A；字段B）受权限控制；', '日志不含秘密。']);
  assert.throws(() => sourceClauses('示例“未结束；不能猜测'), /Unbalanced/);
  assert.throws(() => sourceClauses('未知）边界；不能猜测'), /Unbalanced/);
});

test('draft source decisions reject duplicate/unknown units and preserve ordered merge boundaries', () => {
  const identity = { sourceCatalog: [{ ref: 'U1' }], sources: [{ ref: 'U1', parts: [{}], clauseCounts: { 1: 2, 2: 1, 3: 0, 4: null }, clauseIndexPartial: false }] };
  const units = sourceUnits(identity), defaults = { authority: 'USER_EXPLICIT', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  assert.deepEqual(units.map(unit => unit.id), ['S0L1', 'S0L2', 'S0L4']);
  const value = expandDraftBatch({ batchId: 1, defaults, merge: [{ name: 'One workflow', units: ['S0L1', 'S0L2'] }] }, units);
  assert.deepEqual(value.operations[0].textFrom, { sourceIndex: 0, start: 1, end: 2 });
  assert.throws(() => expandDraftBatch({ keep: ['S0L1', 'S0L1'], defaults }, units), /already classified/);
  assert.throws(() => expandDraftBatch({ keep: ['S9L1'], defaults }, units), /Unknown/);
  assert.throws(() => expandDraftBatch({ keep: ['S0L1'], defaults }, units, new Set(['S0L1'])), /already classified/);
  assert.throws(() => expandDraftBatch({ merge: [{ name: 'No guessing', units: ['S0L2', 'S0L4'] }], defaults }, units), /consecutive/);
  assert.throws(() => expandDraftBatch({ merge: [{ name: 'Mixed owners', units: ['S0L1', 'S0L2'] }], defaults,
    overrides: [{ unit: 'S0L2', metadata: { verificationTarget: 'PROCESS' } }] }, units), /identical effective metadata/);
  assert.throws(() => expandDraftBatch({ keep: ['S0L1'], defaults: { verificationTarget: 'IMPLEMENTATION' } }, units), /implementationRole/);
  const declared = expandDraftBatch({ keep: ['S0L1'], defaults, overrides: [{ unit: 'S0L2', metadata: { verificationTarget: 'PROCESS' } }] }, units);
  assert.equal(declared.operations.length, 2); assert.equal(declared.operations[1].verificationTarget, 'PROCESS');
  assert.throws(() => expandDraftBatch({ split: [{ unit: 'S0L4', groups: [] }], defaults }, units), /ambiguous/);
  assert.deepEqual(sourceUnits({ ...identity, sources: [{ ...identity.sources[0], clauseIndexPartial: true }] }), []);
});

test('simultaneous first acquisition serializes one project identity; cancelled waiters cannot take it', async t => {
  const root = await fixture(t), owner = {}, controller = new AbortController();
  const args = { owner, projectRoot: root, agentId: 'main', selection: { model: 'a' }, deadlineAt: Date.now() + 10000 };
  let acquisitions = 0;
  const contenders = [0, 1].map(async index => ({ index, value: await acquireBaselineAgent(args) })).map(promise => promise.then(value => { acquisitions++; return value; }));
  const winner = await Promise.race(contenders), first = winner.value;
  const cancelled = acquireBaselineAgent({ ...args, signal: controller.signal });
  const rejected = assert.rejects(cancelled, /cancel/);
  controller.abort(new Error('cancel')); await rejected;
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(acquisitions, 1);
  await first.release(); const next = (await contenders[1 - winner.index]).value;
  assert.equal(next.sessionId, first.sessionId); assert.equal(next.sessionFile, first.sessionFile); assert.equal(next.reused, true);
  await next.release(); await next.release();
  const other = await acquireBaselineAgent({ ...args, projectRoot: await fixture(t) });
  assert.notEqual(other.sessionId, first.sessionId); await other.release();
});

test('idle native identities are disposed and model-policy changes cannot inherit context', async t => {
  const root = await fixture(t), owner = {}, disposed = [];
  const args = { owner, projectRoot: root, agentId: 'main', selection: { model: 'a' }, deadlineAt: Date.now() + 10000,
    idleMs: 10, dispose: async (...value) => { disposed.push(value); } };
  const first = await acquireBaselineAgent(args); await first.release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(disposed, [[first.sessionKey, first.sessionId]]);
  const next = await acquireBaselineAgent(args);
  assert.notEqual(first.sessionId, next.sessionId);
  const changed = await acquireBaselineAgent({ ...args, selection: { model: 'b' } });
  assert.notEqual(changed.sessionId, next.sessionId);
  await next.release(); await changed.release();
});

test('document correction sessions start independently and release their native identities exactly once', async t => {
  const root = await fixture(t), runs = [], released = [];
  const runner = async params => { runs.push(params); return { payloads: [{ text: '{"ok":true}' }], meta: {} }; };
  runner.close = async (...identity) => { released.push(identity); };
  const api = { config: { agents: { defaults: { model: { primary: 'fixture/model' } } } }, runtime: { version: '2026.7.1-2', agent: {} } };
  const factory = createOpenClawReviewerFactory(api, { runEmbeddedAgent: runner });
  const input = { projectRoot: root, taskId: 'document-task', role: 'artifact-reviewer', reviewer: { timeoutMs: 10000 },
    request: { instructions: ['Review this document only.'] }, schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } };
  const first = await factory(input); await first.close(); await first.close();
  const next = await factory(input); await next.close();
  assert.notEqual(first.sessionId, next.sessionId); assert.equal(released.length, 2);
  assert.deepEqual(released, runs.map(params => [params.sessionKey, params.sessionId]));
});

test('frozen navigation paginates beyond 100 paths and within a dense file without omission or duplicated hits', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 137; i++) await fs.writeFile(path.join(root, `${String(i).padStart(3, '0')}.txt`), 'needle 中文\nneedle 条件\n');
  await fs.writeFile(path.join(root, 'dense.txt'), Array.from({ length: 230 }, (_, i) => `needle ${i}`).join('\n'));
  const tools = createSourceTools(root, await captureFiles(root));
  for (const name of ['ls', 'find', 'grep']) {
    const tool = tools.find(item => item.name === name), hits = [];
    let offset = 0, line = 1;
    do {
      const args = { path: '.', pattern: name === 'find' ? '.txt' : 'needle', offset, line, limit: 17 };
      const response = await tool.execute('test', args), page = decode(response);
      assert(Buffer.byteLength(toolText(response)) <= PAGE_BYTES); assert.equal(page.navigationOnly, true);
      assert.deepEqual(decode(await tool.execute('cached', args)), page);
      hits.push(...page.hits); offset = page.nextOffset; line = page.nextLine;
    } while (offset !== null);
    assert.equal(new Set(hits).size, hits.length);
    assert.equal(hits.length, name === 'grep' ? 137 * 2 + 230 : 138);
  }
});

test('working notes survive refresh as stale navigation, paginate, and cannot cite foreign sources', async t => {
  const file = path.join(await fixture(t), 'notes.json');
  const identity = { taskId: 'task', requestId: 'a', sources: [{ ref: 'U1' }] };
  const first = await createBaselineNotes({ file, identity, active() {} });
  for (let i = 0; i < 8; i++) await first.tool.execute('n', { action: 'put', key: `group-${i}`, text: 'Keep the exception with the outcome.', sourceRefs: ['U1'] });
  await assert.rejects(first.tool.execute('n', { action: 'put', key: 'bad', text: 'foreign', sourceRefs: ['U2'] }), /catalog/);
  const next = await createBaselineNotes({ file, identity: { ...identity, requestId: 'b' }, active() {} });
  let offset = 0, notes = [];
  do { const page = decode(await next.tool.execute('n', { action: 'list', offset })); notes.push(...page.notes); offset = page.nextOffset; } while (offset !== null);
  assert.equal(notes.length, 8); assert(notes.every(note => note.stale)); assert.equal(next.pointer().stale, 8);
  await next.tool.execute('n', { action: 'put', key: 'group-0', text: 'Revalidated exception.', sourceRefs: ['U1'] });
  assert.equal(next.pointer().stale, 7);
});

test('interval recovery preserves gaps with overlap, duplicates, partial and out-of-order reads', () => {
  const snapshot = new Map([['a', { lines: 12 }], ['b', { lines: 4 }]]);
  assert.deepEqual(pendingReadRanges(['a', 'b'], snapshot, [
    { path: 'a', start: 7, end: 9 }, { path: 'a', start: 2, end: 5 },
    { path: 'a', start: 3, end: 4 }, { path: 'a', start: 9, end: 10 },
  ]), [{ file: 'a', ranges: [{ start: 1, end: 1 }, { start: 6, end: 6 }, { start: 11, end: 12 }] },
    { file: 'b', ranges: [{ start: 1, end: 4 }] }]);
});
