import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dispatchNativeOriginalTurn, auditNativeOriginalTerminals, finalizeNativeOriginalCompletion } from '../scripts/helpers/native-original-turn-case.mjs';

test('headless original uses one standard agent request bounded by both original and shared deadlines', async () => {
  for (const [deadlineAt, seconds] of [[600000, 180], [46000, 45]]) {
    const requests = [];
    const result = await dispatchNativeOriginalTurn({ gateway: { request: async (...args) => {
      requests.push(args); return { runId: 'original', sessionKey: 'session-key' };
    } }, requirement: 'Original unmodified fictional request.\n', runId: 'original', sessionId: 'session-id',
    sessionKey: 'session-key', entry: 'agent', deadlineAt, now: () => 1000 });
    assert.equal(result.runId, 'original');
    assert.equal(requests.length, 1);
    const [method, params, options] = requests[0];
    assert.equal(method, 'agent');
    assert.equal(params.message, 'Original unmodified fictional request.\n');
    assert.equal(params.idempotencyKey, 'original');
    assert.equal(params.sessionId, 'session-id');
    assert.equal(params.timeout, seconds);
    assert.equal(options.timeoutMs, seconds * 1000);
    assert.equal(params.deliver, false);
  }
});

test('expired or unsupported original entry cannot dispatch a model request', async () => {
  let calls = 0;
  const args = { gateway: { request: async () => { calls++; } }, requirement: 'Fictional', runId: 'original',
    sessionId: 'session-id', sessionKey: 'session-key', deadlineAt: 1500, now: () => 1000 };
  await assert.rejects(dispatchNativeOriginalTurn({ ...args, entry: 'agent' }), { code: 'HARBOR_TASK_WALL_LIMIT' });
  await assert.rejects(dispatchNativeOriginalTurn({ ...args, entry: 'unknown' }), /Unsupported original business entry/);
  assert.equal(calls, 0);
});

test('legacy original callers retain their existing chat request and original timeout', async () => {
  const calls = [];
  await dispatchNativeOriginalTurn({ gateway: { request: async (...args) => { calls.push(args); return {}; } },
    requirement: 'Original', runId: 'original', sessionId: 'session-id', sessionKey: 'session-key', deadlineAt: 999999 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'chat.send');
  assert.equal(calls[0][1].timeoutMs, 180000);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-auth-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { id: 'a'.repeat(64), agentId: 'main', sessionId: 'session-id', sessionKey: 'session-key',
    scopeFingerprint: 'scope', projectRoot: root, phase: 'IDLE', reviewStatus: 'PASS', version: 1,
    pending: [], dispatching: false, completedRuns: ['original', 'repair'], runId: 'repair', correctionRunId: 'repair' };
  const directory = path.join(root, 'runtime-corrector-stop-sessions/post-run'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${state.id}.json`); await fs.writeFile(file, JSON.stringify(state));
  const requests = []; let repairWaits = 0;
  const gateway = { runtime: { state: { resolveStateDir: () => root } }, request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'agent.wait') {
      if (params.runId === 'repair' && ++repairWaits === 1)
        throw Object.assign(new Error('fictional observation timeout'), { name: 'GatewayTransportError', kind: 'timeout', timeoutMs: 2000 });
      return { runId: params.runId, status: 'ok' };
    }
    return method.endsWith('.list') ? { items: [state] } : state;
  } };
  return { root, state, file, requests, gateway };
}

test('native completion reads durable scope and requires original plus corrective authentic terminals', async t => {
  const f = await fixture(t);
  const result = await auditNativeOriginalTerminals({ gateway: f.gateway, originalRunId: 'original',
    sessionId: f.state.sessionId, sessionKey: f.state.sessionKey, projectRoot: f.root, deadlineAt: Date.now() + 5000 });
  assert.equal(result.complete, true);
  assert.deepEqual(result.terminals.map(x => x.runId), ['original', 'repair']);
  assert.deepEqual(f.requests.filter(x => x.method === 'agent.wait').map(x => x.params.runId), ['original', 'repair', 'repair']);
  assert(!f.requests.some(x => ['agent', 'chat.send', 'chat.abort'].includes(x.method)));
});

test('public PASS cannot override a durable dispatch belonging to another project', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ ...f.state, projectRoot: path.join(f.root, 'foreign') }));
  await assert.rejects(auditNativeOriginalTerminals({ gateway: f.gateway, originalRunId: 'original',
    sessionId: f.state.sessionId, sessionKey: f.state.sessionKey, projectRoot: f.root, deadlineAt: Date.now() + 5000 }),
  { code: 'HARBOR_DISPATCH_SCOPE_CHANGED' });
});

test('settled UNVERIFIED dispatch cannot certify semantic component completion', async () => {
  const result = await finalizeNativeOriginalCompletion({ inspect: async () => ({ complete: true }),
    auditTerminals: async () => ({ complete: true, dispatch: { reviewStatus: 'UNVERIFIED' } }) });
  assert.equal(result.complete, false);
});

test('terminal waiting cannot reuse an earlier PASS after current formal evidence changes', async () => {
  let inspected = 0;
  const result = await finalizeNativeOriginalCompletion({
    inspect: async () => ++inspected === 1 ? { complete: true, evaluationId: 'earlier' }
      : { complete: false, evaluationId: 'current' },
    auditTerminals: async () => ({ complete: true, dispatch: { reviewStatus: 'PASS' } }) });
  assert.equal(inspected, 2);
  assert.equal(result.evaluationId, 'current');
  assert.equal(result.complete, false);
});
