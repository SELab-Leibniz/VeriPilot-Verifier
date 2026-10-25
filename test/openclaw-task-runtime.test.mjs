import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { bindTaskTools, registerTaskTools, TASK_TOOL_NAMES } from '../lib/openclaw/task-tools.mjs';
import { ensureTask, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { IMPL_REVIEW_SCHEMA } from '../lib/runtime-v2/impl-review.mjs';
import { isInternalExecution } from '../lib/openclaw/internal-context.mjs';

async function fixture(t) {
  const parent = path.resolve('.runtime-correction/native-runtime-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: 'native-fixture' });
  await fs.writeFile(path.join(root, 'app.js'), 'export const accept = value => value;\n');
  const claim = { claimId: 'R1', revisionId: 'R1@1', category: 'requirements', text: 'Return the original value.',
    status: 'ACTIVE', severity: 'HARD', authority: 'USER_EXPLICIT', verificationTarget: 'IMPLEMENTATION' };
  const truth = { version: 1, claims: [claim], digest: sha256([claim]) }, groundTruthPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json');
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true }); await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  const object = { objectId: 'M12:R1', sourceId: 'R1', sourceRevisionId: 'R1@1', metricId: 'M12', authority: 'USER_EXPLICIT',
    hard: true, description: claim.text, applicability: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION' };
  const population = { metrics: { M12: [object] } };
  const input = { projectRoot: root, taskId: task.taskId, role: 'implementation-reviewer', schema: IMPL_REVIEW_SCHEMA,
    reviewer: { timeoutMs: 3000 }, request: { population, groundTruthPath, reviewScope: { kind: 'metric-object', boundedBasis: true, objectIds: [object.objectId], sourceIds: ['R1'] },
      sourceManifest: [{ path: 'app.js', sha256: sha256(await fs.readFile(path.join(root, 'app.js'))) }] }, evidence: { groundTruth: truth, population, snapshot: { entries: [] } } };
  let factory;
  const api = { rootDir: path.resolve('.'), config: { agents: { defaults: { model: { primary: 'host/catalog' } } } },
    runtime: { version: '2026.7.1-2', agent: {} }, registerTool: fn => { factory = fn; }, on() {} };
  registerTaskTools(api);
  return { root, input, api, tools: ctx => factory(ctx) };
}
async function scripted(params, f) {
  assert.equal(isInternalExecution(), true); assert.deepEqual(params.toolsAllow, TASK_TOOL_NAMES); assert.equal(params.customTools, undefined);
  assert.equal(f.tools({ sessionId: 'business', sessionKey: 'agent:main:business' }), null);
  assert.equal(f.tools({ sessionId: 'business', sessionKey: params.sessionKey }), null);
  const tools = new Map(f.tools(params).map(tool => [tool.name, tool]));
  const brief = JSON.parse(params.prompt); let citation;
  for (const file of [...brief.task.basisFiles, ...brief.task.targetFiles]) {
    params.onAssistantMessageStart(); const result = await tools.get('source_read').execute(crypto.randomUUID(), { path: file });
    params.onAgentToolResult({ toolName: 'source_read', result, isError: false });
    if (brief.task.targetFiles.includes(file)) citation = result.details.citation.citeId;
  }
  params.onAssistantMessageStart(); const result = await tools.get('submit_review').execute('submit', { taskId: brief.task.id,
    verdict: 'PASS', reason: 'The original value flows directly to the return statement.', citeIds: [citation] });
  params.onAgentToolResult({ toolName: 'submit_review', result, isError: false });
  assert.equal(params.abortSignal.aborted, true, 'Only the finished child execution is stopped after its receipt');
  return { payloads: [], meta: { aborted: true } };
}
test('task factory delegates authentication/catalog and lifecycle to the host with exact registered tools', async t => {
  const f = await fixture(t); let params;
  const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine: 'task', runEmbeddedAgent: async p => { params = p; return scripted(p, f); } });
  const result = await factory(f.input); assert.equal(result.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(f.tools(params), null); await result.close();
  const old = factory.reviewCacheIdentity(); assert.notEqual(old, createOpenClawReviewerFactory(f.api, {}).reviewCacheIdentity());
});
for (const mode of ['parent-cancel', 'deadline']) test(`native ${mode} closes tools and rejects late results`, async t => {
  const f = await fixture(t), parent = new AbortController(); let params, held;
  const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine: 'task', runEmbeddedAgent: async p => {
    params = p; held = f.tools(p); if (mode === 'parent-cancel') setTimeout(() => parent.abort(new Error('parent cancelled')), 10);
    await new Promise(resolve => setTimeout(resolve, mode === 'deadline' ? 1100 : 100));
    await assert.rejects(held[0].execute('late', { path: 'app.js' }), /expired|abort|cancel|deadline/i);
    p.onAgentToolResult({ toolName: 'source_read', result: { content: [{ type: 'text', text: 'invented late proof' }] }, isError: false });
    return { payloads: [{ text: 'late PASS' }] };
  } });
  await assert.rejects(factory({ ...f.input, abortSignal: parent.signal, ...(mode === 'deadline' ? { deadlineAt: Date.now() + 900 } : {}) }));
  assert(params.abortSignal.aborted); assert.equal(f.tools(params), null); await new Promise(resolve => setTimeout(resolve, mode === 'deadline' ? 1200 : 150));
});
test('task tool registry binds session incarnation and denies sandboxed or stale definitions', async () => {
  let factory; registerTaskTools({ registerTool: fn => { factory = fn; }, on() {} });
  const ctx = { sessionId: 'private', sessionKey: 'agent:main:runtime-corrector:private' };
  const release = bindTaskTools({ ...ctx, active() {}, checkpoint() {}, tools: [{ name: 'source_read', execute: () => ({ content: [] }) }] });
  const tool = factory(ctx)[0]; assert.equal(factory({ ...ctx, sandboxed: true }), null);
  release(); await assert.rejects(tool.execute('stale', {}), /expired/); assert.equal(factory(ctx), null);
});
test('native protocol repairs reuse the private session with a fresh run identity and shared deadline', async t => {
  const f = await fixture(t), calls = [];
  const deadlineAt = Date.now() + 3000;
  const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine: 'task', deadlineAt, runEmbeddedAgent: async params => {
    calls.push(params);
    if (calls.length === 1) return { payloads: [{ text: 'No submission yet.' }] };
    return scripted({ ...params, prompt: calls[0].prompt }, f);
  } });
  const handle = await factory(f.input); assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(calls.length, 2); assert.equal(calls[0].sessionId, calls[1].sessionId); assert.notEqual(calls[0].runId, calls[1].runId);
  assert(calls[1].timeoutMs < calls[0].timeoutMs); assert(calls[1].timeoutMs <= deadlineAt - Date.now() + 500);
  await handle.close();
});
