import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireBaselineAgent } from '../lib/openclaw/baseline-agent.mjs';
import { createNativeTaskSession } from '../lib/openclaw/task-session.mjs';
import { withPrivateReviewMemoryPolicy } from '../lib/openclaw/native-config.mjs';

test('private baseline policy isolates old-capability context before pooling and survives native repairs', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-private-memory-')));
  const api = { runtime: { version: '2026.7.1-2', agent: {} } }, sessions = [], calls = [];
  t.after(async () => {
    try { for (const session of sessions) await session.close(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  const host = { agents: { defaults: { memorySearch: { enabled: true } }, list: [
    { id: 'reviewer', memorySearch: { enabled: true, sync: { watch: true } }, model: 'fixture/model' },
    { id: 'business', memorySearch: { enabled: true } },
  ] } };
  const before = structuredClone(host), selection = { config: host, provider: 'fixture', model: 'model' };
  // Seed an otherwise identical no-Memory selection without the new policy tag.
  // A new tag must isolate even a previously disabled but differently governed context.
  const old = await acquireBaselineAgent({ owner: api, projectRoot: root, agentId: 'reviewer',
    selection: { ...selection, config: withPrivateReviewMemoryPolicy(host, 'reviewer') }, deadlineAt: Date.now() + 20000 });
  await old.release();
  const nativeRunner = async params => {
    calls.push(params);
    assert.equal(params.agentId, 'reviewer');
    assert.deepEqual(params.config.agents.list[0].memorySearch, { enabled: false, sync: { watch: true } });
    assert.deepEqual(params.config.agents.defaults, { ...before.agents.defaults,
      models: { 'fixture/model': { params: { maxTokens: 32768 } } } });
    assert.deepEqual(params.config.agents.list[1], before.agents.list[1]);
    return { payloads: [], meta: {} };
  };
  const input = { projectRoot: root, taskId: 'private-memory-policy', role: 'ground-truth-extractor',
    request: { reviewScope: { boundedBasis: true } }, reviewer: { timeoutMs: 20000 } };
  const create = async () => {
    const session = await createNativeTaskSession(input, { api, nativeRunner, selection, options: { agentId: 'reviewer' } });
    sessions.push(session); return session;
  };
  const worker = { tools: [], cwd: root, outputDir: root, prompt: 'current explicit sources', systemPrompt: '',
    active() {}, isComplete: () => true, phase: () => 'CANDIDATE_COMPLETE', onAssistantMessageStart() {} };
  const first = await create();
  assert.equal(first.extractorReused, false);
  assert.notEqual(first.sessionId, old.sessionId);
  await first.run(worker);
  await first.run(worker);
  assert.equal(calls[0].sessionId, calls[1].sessionId, 'repair keeps the same private actor');
  assert.notEqual(calls[0].runId, calls[1].runId, 'repair owns a distinct tracked native dispatch');
  assert.equal((await first.awaitOwnedSettlement()).runIds.length, 2);
  await first.close();
  const next = await create();
  assert.equal(next.extractorReused, true);
  assert.equal(next.sessionId, first.sessionId, 'the same policy can reuse its own idle actor');
  await next.run(worker);
  await next.awaitOwnedSettlement();
  assert.deepEqual(host, before);
  assert.deepEqual(Object.keys(selection).sort(), ['config', 'model', 'provider']);
});
