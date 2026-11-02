import test from 'node:test';
import assert from 'node:assert/strict';
import * as observer from '../scripts/helpers/native-integrated-original-case.mjs';
import { awaitHarborGatewaySettlement } from '../scripts/bench/harbor-gateway-controller.mjs';

test('critical-path authenticated negative terminal ends observation without accepting an ACTIVE task', async () => {
  let now = 0;
  const identity = { id: 'dispatch', agentId: 'main', sessionId: 'business', sessionKey: 'agent:main:business', projectRoot: '/work', scopeFingerprint: 'frozen' };
  const terminal = { ...identity, version: 2, phase: 'IDLE', reviewStatus: 'UNVERIFIED', runId: 'original', completedRuns: ['original'], pending: [], dispatching: null };
  const result = await observer.observeIntegratedSettlement({ deadlineAt: 100, now: () => now, pause: async ms => { now += ms; },
    auditTerminals: () => awaitHarborGatewaySettlement({ ...identity, originalRunId: 'original', rcEnabled: true, deadlineAt: 100, now: () => now,
      request: async (method, args) => method === 'agent.wait' ? { runId: args.runId, status: 'ok' } : method.endsWith('.list') ? { items: [terminal] } : terminal,
      readPersistentDispatch: async () => terminal }), inspect: async () => ({ task: { status: 'ACTIVE' }, privateRuns: [{ status: 'SETTLED' }] }) });
  assert.equal(now, 0); assert.equal(result.observationOutcome, 'AUTHENTICATED_NEGATIVE_TERMINAL');
  assert.equal(result.current.task.status, 'ACTIVE'); assert.equal(result.authenticTerminals.semanticAccepted, null);
});

for (const mode of ['foreign-task', 'private-pending', 'owner-cancel']) test(`critical-path negative observation rejects ${mode}`, async () => {
  const controller = new AbortController(); if (mode === 'owner-cancel') controller.abort(new Error('Actual owner cancel'));
  let now = 0;
  const identity = { id: 'dispatch', agentId: 'main', sessionId: 'business', sessionKey: 'agent:main:business', projectRoot: '/work', scopeFingerprint: 'frozen' };
  const terminal = { ...identity, version: 2, phase: 'IDLE', reviewStatus: 'UNVERIFIED', runId: 'original', completedRuns: ['original'], pending: [], dispatching: null };
  const result = await observer.observeIntegratedSettlement({ signal: controller.signal, deadlineAt: 100, now: () => now, pause: async ms => { now += ms; },
    auditTerminals: () => awaitHarborGatewaySettlement({ ...identity, originalRunId: 'original', rcEnabled: true, signal: controller.signal, deadlineAt: 100, now: () => now,
      request: async (method, args) => method === 'agent.wait' ? { runId: args.runId, status: 'ok' } : method.endsWith('.list') ? { items: [terminal] } : terminal,
      readPersistentDispatch: async () => terminal }), inspect: async () => ({ task: { status: 'ACTIVE', sessionIds: [mode === 'foreign-task' ? 'foreign' : 'business'] },
        privateRuns: [{ status: mode === 'private-pending' ? 'RUNNING' : 'SETTLED' }] }) });
  assert.equal(result.observationOutcome, null); if (mode !== 'owner-cancel') assert.equal(now, 100);
});

test('integrated observer hands off immediately to the existing authenticated waiter without waiting for PASS', async () => {
  assert.equal(typeof observer.observeIntegratedSettlement, 'function');
  let now = 0, audits = 0, reads = 0;
  const result = await observer.observeIntegratedSettlement({ deadlineAt: 100, now: () => now,
    pause: async () => { now++; }, auditTerminals: async () => { audits++; assert.equal(now, 0); return { complete: true, dispatch: { phase: 'IDLE', reviewStatus: 'UNVERIFIED', pending: [] } }; },
    inspect: async () => { reads++; return { task: { status: 'COMPLETED_WITH_ISSUES' }, privateRuns: [{ status: 'SETTLED' }] }; } });
  assert.equal(audits, 1); assert.equal(reads, 1); assert.equal(result.authenticTerminals.dispatch.reviewStatus, 'UNVERIFIED');
});

test('authentication failure is not replaced by raw task/dispatch state and private settlement retains the original deadline', async () => {
  assert.equal(typeof observer.observeIntegratedSettlement, 'function');
  let now = 0;
  const result = await observer.observeIntegratedSettlement({ deadlineAt: 3, now: () => now, pause: async () => { now++; },
    auditTerminals: async () => { throw new Error('Wrong original run'); },
    inspect: async () => ({ task: { status: 'COMPLETED_WITH_ISSUES' }, privateRuns: [{ status: 'SETTLED' }] }) });
  assert.equal(result.authenticTerminals, null); assert.match(result.terminalError.message, /Wrong original run/);
  const pending = await observer.observeIntegratedSettlement({ deadlineAt: 3, now: () => now, pause: async () => { now++; },
    auditTerminals: async () => ({ complete: true }), inspect: async () => ({ task: { status: 'ACTIVE' }, privateRuns: [{ status: 'RUNNING' }] }) });
  assert.equal(pending.privateSettled, false); assert.equal(now, 3);
});

test('the integrated observer reaches the actual existing authenticated negative terminal, including historical USED corrections', async () => {
  let now = 0; const waited = [];
  const identity = { id: 'record', agentId: 'main', sessionId: 'business', sessionKey: 'agent:main:business', projectRoot: '/work', scopeFingerprint: 'actual-scope' };
  const state = { ...identity, version: 7, phase: 'IDLE', reviewStatus: 'UNVERIFIED', runId: 'original',
    correctionRunId: 'historical-repair', admissions: { old: { status: 'USED' } }, completedRuns: ['original', 'historical-repair'], pending: [], dispatching: null };
  const result = await observer.observeIntegratedSettlement({ deadlineAt: 500, now: () => now, pause: async ms => { now += ms; },
    auditTerminals: () => awaitHarborGatewaySettlement({ ...identity, originalRunId: 'original', rcEnabled: true, deadlineAt: 500, now: () => now,
      pause: async ms => { now += ms; }, request: async (method, params) => {
        if (method === 'agent.wait') { waited.push(params.runId); return { runId: params.runId, status: 'ok' }; }
        return method.endsWith('.list') ? { items: [state] } : state;
      }, readPersistentDispatch: async () => state }),
    inspect: async () => ({ task: { status: 'COMPLETED_WITH_ISSUES' }, privateRuns: [{ status: 'SETTLED' }] }) });
  assert.equal(result.privateSettled, true); assert.equal(result.authenticTerminals.complete, true);
  assert.equal(result.authenticTerminals.dispatch.reviewStatus, 'UNVERIFIED'); assert.equal(result.authenticTerminals.semanticAccepted, null);
  assert.deepEqual(waited, ['original', 'historical-repair']); assert.equal(now, 0);
});

test('actual authenticated pending/foreign/correcting paths stay incomplete and raw settled state cannot replace them', async t => {
  for (const mode of ['pending', 'foreign-terminal', 'correcting']) await t.test(mode, async () => {
    let now = 0;
    const identity = { id: 'record', agentId: 'main', sessionId: 'business', sessionKey: 'agent:main:business', projectRoot: '/work', scopeFingerprint: 'scope' };
    const state = { ...identity, version: 1, phase: mode === 'correcting' ? 'CORRECTING' : 'IDLE', reviewStatus: 'UNVERIFIED',
      runId: 'original', completedRuns: ['original'], pending: mode === 'pending' ? ['required-review'] : [],
      ...(mode === 'correcting' ? { correctionRunId: 'repair' } : {}) };
    const result = await observer.observeIntegratedSettlement({ deadlineAt: 200, now: () => now, pause: async ms => { now += ms; },
      auditTerminals: () => awaitHarborGatewaySettlement({ ...identity, originalRunId: 'original', rcEnabled: true, deadlineAt: 200, cleanupMs: 1,
        now: () => now, pause: async ms => { now += ms; }, request: async (method, params) => {
          if (method === 'chat.abort') return {};
          if (method === 'agent.wait') return { runId: mode === 'foreign-terminal' ? 'foreign' : params.runId, status: 'ok' };
          return method.endsWith('.list') ? { items: [state] } : state;
        }, readPersistentDispatch: async () => state }),
      inspect: async () => ({ task: { status: 'COMPLETED_WITH_ISSUES' }, privateRuns: [{ status: 'SETTLED' }] }) });
    assert.equal(result.authenticTerminals, null); assert(result.terminalError);
  });
});

test('an ACTIVE business task stays unsettled even after authentic host terminals and private settlement', async () => {
  let now = 0;
  const result = await observer.observeIntegratedSettlement({ deadlineAt: 3, now: () => now, pause: async () => { now++; },
    auditTerminals: async () => ({ complete: true }), inspect: async () => ({ task: { status: 'ACTIVE' }, privateRuns: [{ status: 'SETTLED' }] }) });
  assert.equal(result.privateSettled, true); assert.equal(result.current.task.status, 'ACTIVE'); assert.equal(now, 3,
    'private settlement is separate from business completion; the observer keeps the original task window open');
});
