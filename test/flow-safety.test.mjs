import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completion } from '../lib/settlement.mjs';
import { snapshot, observe, settleAndClose } from '../lib/observation.mjs';
import { ensureExperimentClock, expireExperiment } from '../lib/experiment-deadline.mjs';
import { validateStopReceipt } from '../lib/process-scope.mjs';
import { writeJson, json } from '../lib/files.mjs';
import { experimentExitCode, dispatchOnce, checkpoint, resume } from '../lib/runner.mjs';
import { stopGateway } from '../lib/host.mjs';

function state(runId = 'r1') {
  return { rc: { status: 'ENDED', phase: 'IDLE', active: false, ended: true, pendingUserTasks: 0,
    health: 'SETTLED', runId, roundId: `round-${runId}`, scopeFingerprint: 'scope' },
    dispatch: [{ id: 'd', version: 1, runId, phase: 'IDLE', pending: [] }],
    private: { dispatch: [{ id: 'd', version: 1, runId, phase: 'IDLE', pending: [] }], reviews: [], nativeReviews: [], ledgers: [] } };
}
async function record() {
  const runDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-flow-')));
  return { runDir, id: 'flow-test', identity: { projectRoot: path.join(runDir, 'project'), agentId: 'main', sessionKey: 'agent:main:s', sessionId: 's' },
    stateDir: path.join(runDir, 'state'), gatewayPid: process.pid, firstRunId: 'r1',
    input: { execution: { observerTimeoutMs: 1000, queryTimeoutMs: 50, uncertainTimeoutMs: 100, pollIntervalMs: 5 } },
    terminals: { r1: { runId: 'r1', status: 'ok' } } };
}
test('every RC active/unknown/stale state blocks shutdown even if ended flags disagree', () => {
  for (const status of ['WAITING', 'RUNNING', 'STOPPING', 'UNKNOWN', 'INTERRUPTED', 'NOT_REGISTERED']) {
    const s = state(); s.rc.status = status;
    assert.equal(completion(s, { r1: { runId: 'r1', status: 'ok' } }, 'r1').settled, false, status);
  }
  for (const health of ['STALE', 'OWNER_EXITED', 'UNKNOWN']) {
    const s = state(); s.rc.health = health;
    assert.equal(completion(s, { r1: { runId: 'r1', status: 'ok' } }, 'r1').settled, false, health);
  }
});
test('terminated current round is not Session completion while users or private work remain', () => {
  const s = state(); s.rc.status = 'TERMINATED'; s.rc.sessionEnabled = true;
  assert.equal(completion(s, { r1: { runId: 'r1', status: 'ok' } }, 'r1').settled, true);
  for (const mutate of [s => s.rc.pendingUserTasks = 1, s => s.dispatch[0].pending = [{ id: 'user-next' }],
    s => s.private.nativeReviews.push({ status: 'DISPATCH_COMMITTED' }),
    s => s.private.dispatch[0].terminalRelease = { runId: 'r1' },
    s => s.private.ledgers.push({ admissions: { a: { accounting: 'USED', deliveryStatus: 'UNKNOWN' } } })]) {
    const copy = structuredClone(s); mutate(copy);
    assert.equal(completion(copy, { r1: { runId: 'r1', status: 'ok' } }, 'r1').settled, false);
  }
});
test('foreign native receipt cannot satisfy an exact run terminal', () => {
  assert.equal(completion(state(), { r1: { runId: 'other', status: 'ok' } }, 'r1').settled, false);
});
test('legacy PID-only records cannot authorize automatic process termination', async () => {
  await assert.rejects(() => stopGateway({ gatewayPid: process.pid }), /Legacy run has no process-scope identity/);
});
test('unchanged healthy phase may run for the observation window; soft timeout never stops it', async () => {
  const r = await record(); let time = 0, stops = 0;
  const active = state(); Object.assign(active.rc, { status: 'RUNNING', active: true, ended: false, health: 'FRESH', stage: 'stop-reviewer' });
  const result = await settleAndClose(r, null, { now: () => time, wait: async ms => { time += ms; },
    policy: { observerTimeoutMs: 100, uncertainTimeoutMs: 10, pollIntervalMs: 5 },
    readSnapshot: async () => structuredClone(active), stop: async () => { stops++; } });
  assert.equal(result.reason, 'OBSERVER_DEADLINE_EXPIRED'); assert.equal(stops, 0); assert.equal(time, 100);
});
test('persistently unknown state exits in bounded time without stopping native work', async () => {
  const r = await record(); let time = 0, stops = 0;
  const unknown = state(); unknown.rc.status = 'UNKNOWN'; unknown.rc.ended = null;
  const result = await settleAndClose(r, null, { now: () => time, wait: async ms => { time += ms; },
    policy: { observerTimeoutMs: 100, uncertainTimeoutMs: 20, pollIntervalMs: 5 },
    readSnapshot: async () => structuredClone(unknown), stop: async () => { stops++; } });
  assert.equal(result.reason, 'STATE_UNCONFIRMED_TIMEOUT'); assert.equal(time, 20); assert.equal(stops, 0);
});
test('a hanging query is bounded, aborted, and cannot cause a shutdown', { timeout: 2000 }, async () => {
  const r = await record(); let aborted = false, stopped = false;
  const result = await settleAndClose(r, null, { policy: { observerTimeoutMs: 35, queryTimeoutMs: 100 },
    readSnapshot: async (_r, _rpc, { signal }) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
    stop: async () => { stopped = true; } });
  assert.equal(result.reason, 'OBSERVER_DEADLINE_EXPIRED'); assert.equal(aborted, true); assert.equal(stopped, false);
});
test('a new round between completion and final check is observed, not killed', async () => {
  const r = await record(); let reads = 0, stops = 0;
  const s1 = state(), active = state('r2'), s2 = state('r2');
  Object.assign(active.rc, { status: 'RUNNING', active: true, ended: false, health: 'FRESH' });
  active.dispatch[0].phase = active.private.dispatch[0].phase = 'CORRECTING';
  s2.dispatch[0].version = s2.private.dispatch[0].version = 2;
  const result = await settleAndClose(r, null, { readSnapshot: async () => {
    reads++; if (reads >= 3) r.terminals.r2 = { runId: 'r2', status: 'ok' };
    return structuredClone(reads === 1 ? s1 : reads === 2 ? active : s2);
  }, stop: async () => { assert.ok(reads >= 4); stops++; } });
  assert.equal(result.status, 'ARCHIVED'); assert.equal(result.rc.runId, 'r2'); assert.equal(stops, 1);
});
test('a failed final check retains the Gateway even after a settled snapshot', async () => {
  const r = await record(); let reads = 0, stops = 0;
  const result = await settleAndClose(r, null, { readSnapshot: async () => { if (++reads > 1) throw new Error('RPC lost'); return state(); }, stop: async () => { stops++; } });
  assert.equal(result.reason, 'FINAL_CHECK_UNAVAILABLE'); assert.equal(stops, 0);
});
test('attention checkpoint does not traverse or copy an active project', async () => {
  const r = await record(); r.identity.projectRoot = path.join(r.runDir, 'not-accessible');
  await checkpoint(r, { status: 'NEEDS_ATTENTION', reason: 'STATE_UNCONFIRMED_TIMEOUT' });
  const saved = await json(path.join(r.runDir, 'result.json'));
  assert.equal(saved.artifacts, null); assert.equal(saved.gatewayRetained, true);
  await assert.rejects(() => fs.stat(path.join(r.runDir, 'artifacts/project')), /ENOENT/);
});
test('snapshot rejects foreign RC identity and late native success after cancellation', async () => {
  const r = await record(); r.terminals = {};
  const detail = { ...r.identity, ...state().dispatch[0], scopeFingerprint: 'scope' };
  await writeJson(path.join(r.stateDir, 'runtime-corrector-stop-sessions/post-run/d.json'), detail);
  const rc = { ...r.identity, ...state().rc, owner: { pid: r.gatewayPid } };
  const client = { refreshSessionRuntimeStatus: async (_identity, { request }) => request('runtime-corrector.runtime.refresh', r.identity) };
  const rpc = async method => method.endsWith('refresh') ? rc : method.endsWith('.list') ? { sessions: [detail] }
    : method.endsWith('.get') ? detail : new Promise(resolve => setTimeout(() => resolve({ runId: 'r1', status: 'ok' }), 80));
  await assert.rejects(() => snapshot(r, rpc, { statusClient: { refreshSessionRuntimeStatus: async () => ({ ...rc, sessionId: 'wrong' }) } }), /different Session/);
  const abort = new AbortController(); const pending = snapshot(r, rpc, { statusClient: client, signal: abort.signal });
  setTimeout(() => abort.abort(new Error('controller read timed out')), 15);
  await assert.rejects(() => pending, /timed out/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(r.terminals.r1, undefined);
  await assert.rejects(() => fs.stat(path.join(r.runDir, 'rc-status/latest.json')), /ENOENT/);
});
test('maximum runtime is persistent across resume and prevents a late first dispatch', async () => {
  const r = await record(); r.createdAt = new Date(Date.now() - 100).toISOString(); r.input.execution.maxRuntimeMs = 20;
  const deadline = ensureExperimentClock(r); r.input.execution.maxRuntimeMs = 99999;
  assert.equal(ensureExperimentClock(r), deadline);
  delete r.firstRunId; let calls = 0;
  await assert.rejects(() => dispatchOnce(r, async () => { calls++; }), { code: 'EXPERIMENT_DEADLINE_EXPIRED' });
  assert.equal(calls, 0); assert.equal(r.requestId, undefined);
});
test('total deadline takes precedence over a fresh observation window', async () => {
  const r = await record(); r.experimentDeadlineAt = 20; let time = 0, stopped = 0;
  const active = state(); Object.assign(active.rc, { status: 'RUNNING', active: true, ended: false });
  const result = await settleAndClose(r, null, { now: () => time, wait: async ms => { time += ms; },
    policy: { observerTimeoutMs: 100, pollIntervalMs: 5 }, readSnapshot: async () => structuredClone(active),
    onExpired: async () => ({ status: 'TIMED_OUT', reason: 'EXPERIMENT_DEADLINE_EXPIRED' }), stop: async () => { stopped++; } });
  assert.equal(result.status, 'TIMED_OUT'); assert.equal(time, 20); assert.equal(stopped, 0);
});
function stopProof(r, overrides = {}) {
  r.processScope = { jobName: 'Local\\RCExperiment-unit', root: { pid: 1234, startedAt: '2026-01-01T00:00:00.0000000Z' } };
  return { jobName: r.processScope.jobName, root: r.processScope.root, deadlineAt: r.experimentDeadlineAt,
    reason: 'EXPERIMENT_DEADLINE_EXPIRED', requestedAt: Date.now(), confirmedAt: Date.now(), activeProcesses: 0, ...overrides };
}
test('hard deadline ends the entire sample including queued work without fabricating native success', async () => {
  const r = await record(); r.experimentDeadlineAt = Date.now() - 1;
  r.terminals = {}; const active = state('correction');
  active.private.dispatch[0].pending = [{ id: 'queued-user' }];
  active.private.nativeReviews.push({ role: 'reviewer', runId: 'private-review', status: 'RUNNING' });
  const receipt = stopProof(r); let stopped = 0, rpcCalls = 0;
  const result = await expireExperiment(r, async () => { rpcCalls++; }, { lastSnapshot: active,
    waitForStop: async () => { stopped++; return receipt; },
    reconcile: async (_identity, { request }) => {
      await assert.rejects(() => request('health'), /confirmed stopped/);
      return { ...r.identity, status: 'INTERRUPTED', health: 'OWNER_EXITED', ended: true, outcome: 'UNVERIFIED' };
    } });
  assert.equal(result.status, 'TIMED_OUT'); assert.equal(result.cleanupConfirmed, true);
  assert.equal(experimentExitCode(result), 4); assert.equal(stopped, 1); assert.equal(rpcCalls, 0);
  assert.deepEqual(result.host, {}); assert.equal(result.rc.outcome, 'UNVERIFIED');
  assert.equal(result.timeout.queuedAtLastObservation[0].id, 'queued-user');
  assert.equal(result.timeout.privateRunsInterrupted[0].runId, 'private-review');
  assert.equal(r.gatewayStoppedAt, receipt.confirmedAt);
});
test('hard timeout cleanup requires kernel-zero proof for this exact sample', async () => {
  for (const overrides of [{ activeProcesses: 1 }, { jobName: 'Local\\RCExperiment-other' },
    { root: { pid: 1234, startedAt: 'reused-PID' } }, { requestedAt: 1 }]) {
    const r = await record(); r.experimentDeadlineAt = Date.now() - 1;
    const receipt = stopProof(r, overrides);
    assert.throws(() => validateStopReceipt(r, receipt));
    const result = await expireExperiment(r, null, { waitForStop: async () => receipt });
    assert.equal(result.status, 'TIMEOUT_CLEANUP_FAILED'); assert.equal(experimentExitCode(result), 5);
    assert.equal(result.cleanupConfirmed, false); assert.equal(r.gatewayStoppedAt, undefined);
  }
});
test('hard stop is refused before the absolute deadline', async () => {
  const r = await record(); r.experimentDeadlineAt = Date.now() + 10000; let waits = 0;
  await assert.rejects(() => expireExperiment(r, null, { waitForStop: async () => { waits++; } }), /has not expired/);
  assert.equal(waits, 0); assert.equal(r.gatewayStoppedAt, undefined);
});

test('a deadline reached before Session creation can be finalized offline without reconnecting or copying the project', async () => {
  const r = await record(); r.experimentDeadlineAt = Date.now() - 1;
  const receipt = stopProof(r); delete r.identity; delete r.firstRunId;
  await writeJson(path.join(r.runDir, 'rc-status/sample-stop-receipt.json'), receipt);
  await writeJson(path.join(r.runDir, 'run.json'), r);
  let connects = 0;
  const { result } = await resume(r.runDir, { connect: async () => { connects++; throw new Error('must not connect'); } });
  assert.equal(connects, 0); assert.equal(result.status, 'TIMED_OUT'); assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.noModelDispatch, true); assert.equal(result.rc.status, 'NOT_REGISTERED');
  assert.equal((await json(path.join(r.runDir, 'result.json'))).artifacts, null);
});
