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

test('span batches copy exact originals, share explicit metadata and preserve ordinary ledger publication', async t => {
  const f = await fixture(t);
  const original = '创建订单时品种和数量必填，备注可空。\n数量必须为正整数，字段非法时拒绝创建且不得预留库存。';
  f.input.evidence.snapshot.entries[0].message.content = original;
  const handle = await f.run(async ({ call, readAll, finish, seen }) => {
    await readAll();
    assert.equal(JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState.phase, 'EXTRACTING');
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: '订单创建与字段校验', textFrom: { sourceIndex: 0, start: 1, end: 2 }, text: original }],
      bindings: [{ operationIndex: 0, citeIds: [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids) }] };
    const first = toolText(await call('save_baseline_batch', value));
    assert.equal(toolText(await call('save_baseline_batch', value)), first);
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, original);
  assert.equal(handle.result.operations[0].source.ref, 'transcript:U1#L1-L2');
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...handle.baselineTask, id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'selected-source' } });
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).claims[0].text, original);
  await handle.close();
});

test('span shortcuts cannot bypass current reads, promote material authority, or override captured text', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: 'Preserve the requested feature', textFrom: { sourceIndex: 0, start: 1, end: 1 } }] };
    await assert.rejects(call('save_baseline_batch', value), { code: 'BASELINE_SOURCE_INVALID' });
    await readAll();
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], text: 'invented' }] }), { code: 'BASELINE_SOURCE_INVALID' });
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: 'Material requirement', textFrom: { sourceIndex: 1, start: 1, end: 1 } }] }), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.'); await handle.close();
});

test('split sources capture exact original lines and retain the full-text fallback', async t => {
  const f = await fixture(t, { large: true });
  const handle = await f.run(async ({ call, readAll, finish, batch }) => {
    await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'MATERIAL_DERIVED', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: 'Material requirement', textFrom: { sourceIndex: 1, start: 201, end: 202 } }] });
    await call('save_baseline_batch', { ...batch(), batchId: 2 }); await finish([1, 2]);
  });
  const expected = (await fs.readFile(f.material, 'utf8')).split('\n').slice(200, 202).join('\n');
  assert.equal(handle.result.operations.length, 2);
  assert.equal(handle.result.operations[0].text, expected);
  assert.equal(handle.result.operations[0].source.ref, `${f.material.replaceAll('\\', '/')}#L201-L202`);
  await handle.close();
});

test('UTF-8 split-line selections require every genuine part receipt and retain source authority', async t => {
  const selected = '条件：不得改写源文，例外须保留。'.repeat(8) + '\r';
  const materialText = '# Context\r\n' + 'x'.repeat(16280) + '\r\n' + selected + '\n尾行';
  const f = await fixture(t, { materialText });
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    const prompt = JSON.parse(params.prompt);
    assert(prompt.selectableSourceIndices.includes(1));
    const request = await call('source_read', { path: 'request-0000.txt' });
    assert.match(toolText(request), /"startLine":3,"endLine":4/u, 'part coordinates must reach the real required-read response');
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'MATERIAL_DERIVED', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: '保留条件与例外', textFrom: { sourceIndex: 1, start: 3, end: 3 } }] };
    const files = prompt.requiredFiles.filter(file => file.startsWith('source-0001'));
    assert.equal(files.length, 2);
    await call('source_read', { path: files[0] });
    await assert.rejects(call('save_baseline_batch', value), /not fully disclosed/);
    await call('source_read', { path: files[1] }, { persist: false });
    await assert.rejects(call('save_baseline_batch', value), /not fully disclosed/);
    await readAll();
    await assert.rejects(call('save_baseline_batch', { ...value, defaults: { ...value.defaults, authority: 'USER_EXPLICIT' } }), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], text: '替换原文' }] }), /captured original/);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, selected);
  const request = await readJson(path.join(handle.requestDirectory, 'request.json'));
  const source = request.identity.sources.find(item => item.kind === 'MATERIAL');
  assert.equal(source.lineCount, 4);
  assert.deepEqual(source.parts.map(({ startLine, endLine }) => [startLine, endLine]), [[1, 3], [3, 4]]);
  await handle.close();
});

test('frozen part-local selectors capture canonical originals without rereads or authority promotion', async t => {
  const f = await fixture(t, { large: true });
  let expected;
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    await readAll();
    const request = JSON.parse(await fs.readFile(path.join(params.cwd, 'request-0000.txt'), 'utf8'));
    assert.equal(request.sourceNavigation.navigationOnly, true);
    const source = request.sourceNavigation.sources.find(item => item.sourceIndex === 1), part = source.parts[1];
    const start = part.startLine + 1;
    expected = (await fs.readFile(f.material, 'utf8')).split('\n').slice(start - 1, start + 1).join('\n');
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'MATERIAL_DERIVED', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: '材料条件', textFrom: { file: part.file, start: 2, end: 3 } }] };
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '混合坐标', textFrom: { ...value.operations[0].textFrom, sourceIndex: 1 } }] }), /exactly one/);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '未知来源', textFrom: { file: '../foreign.txt', start: 1, end: 1 } }] }), /current frozen original source/);
    await assert.rejects(call('save_baseline_batch', { ...value, defaults: { ...value.defaults, authority: 'USER_EXPLICIT' } }), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '边界须用原始坐标', textFrom: { file: part.file, start: 1, end: 1 } }] }), /partial original line/);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, expected);
  assert.equal(handle.result.operations[0].source.kind, 'MATERIAL');
  assert.equal(handle.result.operations[0].source.excerpt, expected);
  await handle.close();
});

test('multipart inputs default to compact outcomes and reject redundant source fields', async t => {
  const f = await fixture(t, { large: true, wireMode: null });
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    assert.equal(JSON.parse(params.prompt).wireMode, 'compact');
    const numbered = await call('source_read', { path: 'source-0000-0000.txt' });
    assert.equal(numbered.details.page.numbered, true);
    assert.match(toolText(numbered), /\[1\] Preserve the requested feature\./u);
    const raw = await call('source_read', { path: 'source-0000-0000.txt', numbered: false });
    assert.equal(raw.details.page.numbered, undefined, 'explicit raw presentation overrides the role default');
    assert.doesNotMatch(toolText(raw), /\n\[1\] /u);
    const request = await call('source_read', { path: 'request-0000.txt' });
    assert.equal(request.details.page.numbered, undefined, 'JSON stays raw by default');
    await readAll();
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      outcomes: [{ name: '保留用户要求', file: 'source-0000-0000.txt', lines: [1, 1] }] };
    await assert.rejects(call('save_baseline_batch', { ...value, outcomes: [{ ...value.outcomes[0], source: { ref: 'transcript:U1' } }] }), { code: 'BASELINE_SCHEMA_INVALID' });
    await call('save_baseline_batch', value);
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.');
  await handle.close();
});

test('span supersession preserves exact claim identity and unrelated project obligations', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries[0].message.content = '空闲10分钟释放提取agent。\n并发请求排队，项目之间隔离。';
  const defaults = { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' };
  let handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults,
      operations: [1, 2].map(line => ({ outcome: line === 1 ? '空闲释放' : '并发排队与隔离', textFrom: { sourceIndex: 0, start: line, end: line } })) }); await finish([1]);
  });
  const publish = current => applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: current.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...current.baselineTask, id: current.baselineTask.requestId, scope: 'stop', cursorDigest: current.baselineTask.requestId } });
  await publish(handle); await handle.close();
  const first = await loadCurrentGroundTruth(f.root, f.task.taskId), changed = first.claims.find(claim => claim.text.includes('10分钟'));
  const unchanged = first.claims.find(claim => claim.text.includes('排队'));
  f.input.evidence.groundTruth = first;
  Object.assign(f.input.request.currentGroundTruth, { version: first.version, digest: first.digest });
  Object.assign(f.input.request, { hookEventId: 'correction-event', lastUserCursor: 'U2' });
  f.input.request.sourceCatalog.push({ ref: 'transcript:U2', kind: 'USER_MESSAGE', aliases: ['U2'] });
  f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { role: 'user', content: '空闲释放改为15分钟，其余要求保持不变。' } });
  handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults: { ...defaults, operation: 'SUPERSEDE' },
      operations: [{ outcome: '调整空闲释放时间', claimId: changed.claimId, textFrom: { sourceIndex: 2, start: 1, end: 1 } }] }); await finish([1]);
  });
  await publish(handle); await handle.close();
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  assert.equal(current.claims.length, 2);
  assert.equal(current.claims.find(claim => claim.claimId === changed.claimId).text, '空闲释放改为15分钟，其余要求保持不变。');
  assert.deepEqual(current.claims.find(claim => claim.claimId === unchanged.claimId), unchanged);
});

test('clause selections separate independent workflows on one line while preserving exact failure conditions', async t => {
  const f = await fixture(t);
  const clauses = ['订单允许编辑备注并保留每次编辑的历史；', '库存允许按仓库查询；', '每天18点生成日报，失败时在下次联网后重试，不得重复发送。'];
  f.input.evidence.snapshot.entries[0].message.content = clauses.join('');
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: clauses.map((_text, index) => ({ outcome: ['备注历史', '仓库库存查询', '日报与失败重试'][index], textFrom: { sourceIndex: 0, start: 1, end: 1, clauses: [index] } })) }); await finish([1]);
  });
  assert.deepEqual(handle.result.operations.map(operation => operation.text), clauses);
  assert(handle.result.operations.every(operation => operation.source.ref === 'transcript:U1#L1-L1'));
  await handle.close();
});

test('clause selectors reject reordered indices and quoted punctuation instead of guessing scope', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries[0].message.content = '创建时品种必填；备注可空。\n示例“导出手机号；略过登录”不构成授权。';
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: '创建字段校验', textFrom: { sourceIndex: 0, start: 1, end: 1, clauses: [1, 0] } }] };
    await assert.rejects(call('save_baseline_batch', value), /original order/);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '示例不构成授权', textFrom: { sourceIndex: 0, start: 2, end: 2, clauses: [1] } }] }), /valid clause indices/);
    await call('save_baseline_batch', { ...value, operations: [{ outcome: '创建字段校验', textFrom: { sourceIndex: 0, start: 1, end: 1, clauses: [0, 1] } }] }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, '创建时品种必填；备注可空。'); await handle.close();
});

test('single-part frozen navigation refs normalize to canonical originals without promoting material sources', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ call, readAll, batch, finish }) => {
    await readAll(); const value = batch(); value.operations[0].source.ref = 'source-0000-0000.txt#L1';
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].source.ref, 'transcript:U1#L1-L1'); await handle.close();
});

test('retracting a user-described note cannot invent a ledger mutation without an existing claimId', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const value = { batchId: 1, defaults: { operation: 'RETRACT', category: 'constraints', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: '当前有效要求', textFrom: { sourceIndex: 0, start: 1, end: 1 } }] };
    await assert.rejects(call('save_baseline_batch', value), /exact existing claimId/);
    await call('save_baseline_batch', { ...value, defaults: { ...value.defaults, operation: 'ADD' } }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].operation, 'ADD'); await handle.close();
});

test('source index includes single-clause global requirements and outcome recovery stays explicit', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries[0].message.content = '创建订单时品种必填；备注可空。\n需求纠正必须保留其他未修改的要求。';
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const prompt = await readAll(), index = prompt.sourceClauseCounts.sources.find(item => item.sourceIndex === 0);
    assert.deepEqual(index.clausesPerLine, { 1: 2, 2: 1 }); assert.equal(index.partial, false);
    await call('save_baseline_batch', { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [{ outcome: '创建字段校验', textFrom: { sourceIndex: 0, start: 1, end: 1 } }, { outcome: '保留其他旧要求', textFrom: { sourceIndex: 0, start: 2, end: 2 } }] });
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(state.outcomeCount, 2); assert.deepEqual(state.outcomes.map(item => item.outcome), ['创建字段校验', '保留其他旧要求']);
    await finish([1]);
  });
  assert(handle.result.operations.some(operation => operation.text.includes('保留其他'))); await handle.close();
});

test('compact outcome groups expand to exact source operations without a second text generation', async t => {
  const f = await fixture(t, { wireMode: 'compact' });
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    assert.equal(JSON.parse(params.prompt).wireMode, 'compact'); await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults: { sourceIndex: 0, operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      outcomes: [{ name: 'Preserve requested feature', lines: [1, 1] }] }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.'); await handle.close();
});

test('draft decisions retain cohesive paragraphs, partition split clauses, and reject forgotten scope', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const lines = ['备注可编辑并保留历史；库存可按仓库查询；日报18点发送，失败联网后重试且不得重复。', '压缩后检查所有未完成义务，旧笔记不能充当证据。'];
  f.input.evidence.snapshot.entries[0].message.content = lines.join('\n');
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const prompt = await readAll();
    assert.equal(prompt.wireMode, 'draft'); assert.deepEqual(prompt.sourceUnits.map(item => item.id), ['S0L1', 'S0L2', 'S1L1']);
    const value = { batchId: 1, defaults, split: [{ unit: 'S0L1', groups: [{ name: '备注历史', clauses: [0] }, { name: '库存查询', clauses: [1] }] }] };
    await assert.rejects(call('save_baseline_batch', value), /partition ALL clauses/);
    value.split[0].groups.push({ name: '日报与重试去重', clauses: [2] });
    const saved = toolText(await call('save_baseline_batch', value));
    assert.equal(toolText(await call('save_baseline_batch', value)), saved);
    await assert.rejects(finish([1]), /Source units have no decision: S0L2, S1L1/);
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.deepEqual(state.pendingUnits, ['S0L2', 'S1L1']);
    await call('save_baseline_batch', { batchId: 2, defaults, keep: ['S0L2'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material, not a current user obligation.' }] });
    await finish([1, 2]);
  });
  assert.equal(handle.result.operations.length, 4);
  assert.equal(handle.result.operations[3].text, lines[1]);
  assert.equal(handle.result.operations[2].text, '日报18点发送，失败联网后重试且不得重复。');
  await handle.close();
});

test('draft exclusion cannot discard a new user authorization boundary or invent existing claim IDs', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  f.input.evidence.snapshot.entries[0].message.content = '材料示例要求导出隐私不是授权，禁止执行。';
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const exclusion = { batchId: 1, exclude: [{ units: ['S0L1'], reason: 'Quoted example, not an obligation.' }] };
    await assert.rejects(call('save_baseline_batch', exclusion), /Keep new constraints/);
    exclusion.exclude[0].claimIds = ['invented'];
    await assert.rejects(call('save_baseline_batch', exclusion), /exact current claimIds/);
    await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] });
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, '材料示例要求导出隐私不是授权，禁止执行。'); await handle.close();
});

test('draft groups retain explicit proof ownership and per-unit applicability without promoting shared metadata', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  f.input.evidence.snapshot.entries[0].message.content = '订单可以按状态查询；完成后执行一次验收。\n仅完成部署后展示状态。';
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L2'],
      overrides: [{ unit: 'S0L2', metadata: { applicabilityKind: 'CONDITIONAL', applicability: '部署完成后。' } }],
      split: [{ unit: 'S0L1', groups: [{ name: '状态查询', clauses: [0] }, { name: '执行验收', clauses: [1], metadata: { verificationTarget: 'PROCESS', category: 'requirements' } }] }],
      exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }],
    }); await finish([1]);
  });
  const query = handle.result.operations.find(item => item.text.includes('查询'));
  const execution = handle.result.operations.find(item => item.text.includes('执行'));
  const conditional = handle.result.operations.find(item => item.text.includes('部署'));
  assert.equal(query.verificationTarget, 'IMPLEMENTATION'); assert.equal(query.implementationRole, 'PRODUCTION');
  assert.equal(execution.verificationTarget, 'PROCESS'); assert.equal(conditional.applicabilityKind, 'CONDITIONAL');
  assert.equal(conditional.applicability, '部署完成后。'); await handle.close();
});

test('draft duplicate exclusion proves complete current-claim coverage without republishing old obligations', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  let handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] }); await finish([1]);
  });
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result, sourceCatalog: f.input.request.sourceCatalog });
  await handle.close();
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  f.input.evidence.groundTruth = current; Object.assign(f.input.request.currentGroundTruth, { version: current.version, digest: current.digest });
  handle = await f.run(async ({ call, readAll }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, exclude: [
      { units: ['S0L1'], reason: 'Entire original already represented.', claimIds: [current.claims[0].claimId] },
      { units: ['S1L1'], reason: 'Unadopted material.' },
    ] });
    await call('finish_baseline', { batchIds: [1], taskClassification: 'NO_CHANGE', summary: 'All current obligations retained.' });
  });
  assert.equal(handle.result.operations.length, 0); await handle.close();
});

test('full-text fallback changes tools in the same session without resetting the original deadline', async t => {
  const f = await fixture(t, { wireMode: 'draft' }), runs = [];
  const handle = await f.run(async ({ call, readAll, finish, batch, params }) => {
    runs.push(params);
    if (runs.length === 1) {
      await readAll(); await call('save_baseline_batch', { batchId: 1, fullTextReason: 'Need a synthesis across source contexts.' }); return;
    }
    assert.equal(JSON.parse(params.prompt).wireMode, 'full');
    await call('save_baseline_batch', batch()); await finish([1]);
  });
  assert.equal(runs.length, 2); assert.equal(runs[0].sessionId, runs[1].sessionId);
  assert.notEqual(runs[0].runId, runs[1].runId); assert(runs[1].timeoutMs <= runs[0].timeoutMs);
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('same project refresh reuses the extractor but renews tools, reading proof and note validity', async t => {
  const f = await fixture(t); let oldTool, oldCite;
  const first = await f.run(async ({ call, readAll, finish, params }) => {
    await readAll();
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    oldCite = state.citations[0].citeId;
    oldTool = f.registry()({ sessionKey: params.sessionKey, sessionId: params.sessionId, runId: params.runId })[0];
    await call('baseline_notes', { action: 'put', key: 'scope', text: 'Remember the whole request.', sourceRefs: ['transcript:U1'] });
    await finish([]);
  });
  await first.close(); f.input.request.hookEventId = 'event-2';
  const second = await f.run(async ({ call, readAll, finish }) => {
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    assert.equal(state.citations.length, 0);
    assert(!state.citations.some(cite => cite.citeId === oldCite));
    const notes = JSON.parse(toolText(await call('baseline_notes', { action: 'list' })));
    assert.equal(notes.notes[0].stale, true);
    await assert.rejects(oldTool.execute('late', { path: 'request-0000.txt' }), /expired/);
    await assert.rejects(finish([]), { code: 'BASELINE_INCOMPLETE' });
    await readAll(); await finish([]);
  });
  assert.equal(first.sessionId, second.sessionId); assert.equal(second.extractorReused, true);
  assert.notEqual(f.captures[0].runId, f.captures[1].runId);
  assert.equal(f.captures[0].sessionFile, f.captures[1].sessionFile); await second.close();
});

test('a cancelled non-cooperative extractor cannot overlap the next project refresh', async t => {
  const f = await fixture(t), controller = new AbortController();
  let unblock, admitted;
  const pending = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { admitted = resolve; });
  f.input.abortSignal = controller.signal;
  const first = f.run(async () => { admitted(); await pending; });
  const rejected = assert.rejects(first, /cancel-extractor/);
  await started; controller.abort(new Error('cancel-extractor')); await rejected;
  f.input.abortSignal = new AbortController().signal;
  const second = f.run(async ({ readAll, finish }) => { await readAll(); await finish([]); });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.captures.length, 1);
  unblock(); const handle = await second;
  assert.equal(f.captures.length, 2); assert.equal(f.captures[0].sessionId, f.captures[1].sessionId);
  await handle.close();
});

test('transient Windows replacement locks preserve durable history and candidates without losing completion', async t => {
  const f = await fixture(t), originalRename = fs.rename, blocked = new Set();
  t.mock.method(fs, 'rename', async (source, destination) => {
    const name = path.basename(destination);
    if (['history-index.json', 'batch-1.json'].includes(name) && !blocked.has(name)) {
      blocked.add(name); throw Object.assign(new Error('transient file reader'), { code: 'EPERM' });
    }
    return originalRename(source, destination);
  });
  const handle = await f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); await call('save_baseline_batch', batch()); await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1); assert.equal(blocked.size, 2); await handle.close();
});

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

async function fixture(t, { large = false, materialText, faults, wireMode = 'full' } = {}) {
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
  const text = materialText ?? (large ? Array.from({ length: Math.ceil(regression.observedCumulativeBytes / 64) + 100 }, (_, i) => `${i}: Original condition ${'x'.repeat(68)}`).join('\n') : 'Original material condition.');
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
      sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE', aliases: ['U1'] }, { ref: material.replaceAll('\\', '/'), kind: 'MATERIAL', projectRelativePath: 'requirements.md', aliases: ['requirements.md'] }],
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
  async function readAll({ numberedSources = false } = {}) {
    const prompt = JSON.parse(params.prompt);
    for (const file of prompt.requiredFiles) {
      let offset = 1;
      do {
        const result = await call('source_read', { path: file, offset, ...(numberedSources && file.startsWith('source-') ? { numbered: true } : {}) });
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
    const factory = createOpenClawReviewerFactory(api, { stopReviewEngine: 'task', baselineFaults: faults, baselineWireMode: wireMode,
      runEmbeddedAgent: async value => { params = value; captures.push(value); tools = registry(ctx());
        assert.equal(value.config.agents.defaults.models['fixture/model'].params.maxTokens, 32768);
        assert.deepEqual(value.toolsAllow, BASELINE_TOOL_NAMES); assert.equal(value.config.agents.defaults.compaction.mode, 'safeguard');
        assert(REVIEWER_NATIVE_TOOL_DENY.every(name => value.config.tools.deny.includes(name)));
        assert.equal(value.config.tools.codeMode.enabled, false);
        for (const name of ['write', 'edit', 'exec', 'code_execution', 'mcp__files__write_file'])
          assert.equal((await observeInternalTool(name, {})).block, true, `baseline must block ${name}`);
        assert.equal(await observeInternalTool('source_read', {}), undefined);
        assert.equal(registry({ sessionKey: 'agent:main:business', sessionId: 'business' }), null);
        try { await script({ call, readAll, batch, finish, params: value, hooks, ctx, seen }); }
        catch (error) { if (error.code === 'ERR_ASSERTION') t.diagnostic(error.stack); throw error; }
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
    const recovery = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    const checkpoint = JSON.parse(await fs.readFile(recovery.checkpointPath));
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
