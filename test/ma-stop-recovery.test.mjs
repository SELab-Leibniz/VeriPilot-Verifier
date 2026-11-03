import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPostRunDispatcher, POST_RUN_RECONCILIATION } from '../lib/openclaw/post-run-dispatch.mjs';
import { registerPostRunControls } from '../lib/openclaw/post-run-controls.mjs';
import { createNativeStopReviews } from '../lib/openclaw/native-stop-review.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert(Date.now() < deadline, 'Expected bounded recovery state'); await pause(10); }
}
async function fixture(t, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-stop-'))), sent = [];
  const manager = createPostRunDispatcher({ directoryFor: () => root, defaultDirectory: root,
    validate: async () => true, waitTerminal: async () => ({ status: 'UNKNOWN' }),
    review: async () => assert.fail('Unknown host state cannot start review'),
    sendUser: async (_record, task) => { sent.push(task); return undefined; },
    reconciliation: { intervalMs: 60000 }, ...overrides });
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const identity = { agentId: 'main', sessionKey: 'agent:main:test', sessionId: 'test', projectRoot: root, scopeFingerprint: 'scope' };
  const methods = new Map();
  registerPostRunControls({ logger: { warn() {} }, registerGatewayMethod: (name, handler) => methods.set(name, handler), registerHttpRoute() {} },
    { postRuns: manager, postRunReady: Promise.resolve(), validatePostSession: async () => true });
  const request = async (action, params, { scopes = ['operator.read', 'operator.write'], device = 'one' } = {}) => {
    let result;
    await methods.get(`runtime-corrector.dispatch.${action}`)({ params, client: { connect: { role: 'operator', scopes, device: { id: device } } },
      respond: (ok, value, error) => { result = { ok, value, error }; } }); return result;
  };
  const current = () => manager.snapshot(identity);
  const target = () => ({ ...current(), runId: current().runId, version: current().version });
  return { root, manager, identity, sent, current, target, request };
}

test('unknown terminal polling stops at its persisted retry bound without replaying a dispatch', async t => {
  assert.deepEqual(POST_RUN_RECONCILIATION, { intervalMs: 5000, maxRetries: 12, escalationMs: 60000 });
  let calls = 0;
  const f = await fixture(t, { reconciliation: { intervalMs: 5, maxRetries: 2 }, waitTerminal: async () => { calls++; return { status: 'UNKNOWN' }; } });
  await f.manager.defer(f.identity, { sourceId: 'first', text: 'first task' }); await f.manager.drain();
  await f.manager.defer(f.identity, { sourceId: 'second', text: 'second task' });
  await until(() => f.current().reconciliation?.escalatedAt);
  assert.equal(f.current().reconciliation.attempts, 2); assert.equal(calls, 2);
  assert.equal(f.current().reconciliation.status, 'UNKNOWN'); assert.equal(f.current().dispatching.status, 'UNKNOWN');
  assert.equal(f.current().reason, 'HOST_RUN_RECONCILIATION_ESCALATED'); assert.equal(f.sent.length, 1);
  await pause(50); assert.equal(calls, 2); assert.equal(f.sent.length, 1); assert.equal(f.current().pending.length, 1);
  await f.manager.dispose();
  const recovered = createPostRunDispatcher({ directoryFor: () => f.root, defaultDirectory: f.root, validate: async () => true,
    waitTerminal: async () => { calls++; return null; }, sendUser: async () => assert.fail('No replay after restart') });
  t.after(() => recovered.dispose()); await recovered.load(); await recovered.drain();
  assert.equal(calls, 2); assert.equal(recovered.snapshot(f.identity).reconciliation.status, 'UNKNOWN');
});

test('elapsed reconciliation escalation survives restart even with retry allowance remaining', async t => {
  let calls = 0;
  const f = await fixture(t);
  await f.manager.started(f.identity, 'run'); await f.manager.candidate(f.identity, { runId: 'run', text: 'done', reviewBudgetMs: 1000 });
  await f.manager.drain(); const record = f.current(); await f.manager.dispose();
  record.reconciliation.startedAt = Date.now() - 60001;
  await fs.writeFile(path.join(f.root, `${record.id}.json`), JSON.stringify(record));
  const recovered = createPostRunDispatcher({ directoryFor: () => f.root, defaultDirectory: f.root, validate: async () => true,
    waitTerminal: async () => { calls++; return null; } });
  t.after(() => recovered.dispose()); await recovered.load(); await recovered.drain();
  const current = recovered.snapshot(f.identity);
  assert.equal(calls, 0); assert.equal(current.reconciliation.status, 'UNKNOWN'); assert(current.reconciliation.escalatedAt);
  assert.equal(current.phase, 'FINALIZING'); assert.equal(current.pending.length, 0);
});

test('recovery RPC authenticates writes and safe release needs a current actor-bound second confirmation', async t => {
  const f = await fixture(t);
  await f.manager.started(f.identity, 'run'); await f.manager.defer(f.identity, { text: 'held task' });
  await f.manager.candidate(f.identity, { runId: 'run', text: 'done', reviewBudgetMs: 1000 }); await f.manager.drain();
  for (const action of ['recheck', 'cancel', 'release']) assert.equal((await f.request(action, f.target(), { scopes: ['operator.read'] })).error.code, 'FORBIDDEN');
  assert.equal((await f.request('recheck', { ...f.target(), runId: 'foreign' })).error.code, 'CONFLICT');
  const checked = await f.request('recheck', { ...f.target(), actor: 'spoofed' });
  assert.equal(checked.ok, true); assert.equal(checked.value.reconciliation.status, 'UNKNOWN');
  assert.equal(checked.value.recoveryAudit.at(-1).actor, 'device:one');
  const offered = await f.request('release', f.target()); assert.equal(offered.ok, true);
  assert.equal(f.current().phase, 'FINALIZING'); assert.match(offered.value.warning, /UNKNOWN/u);
  const confirmed = { ...f.target(), ...offered.value };
  assert.equal((await f.request('release', confirmed, { device: 'two' })).error.code, 'CONFLICT');
  assert.equal((await f.request('release', { ...confirmed, confirmationToken: 'forged' })).error.code, 'CONFLICT');
  assert.equal((await f.request('get', f.target())).value.recoveryConfirmation, undefined);
  const released = await f.request('release', confirmed);
  assert.equal(released.ok, true); assert.equal(released.value.phase, 'CLOSED');
  assert.equal(released.value.reconciliation.status, 'UNKNOWN'); assert.equal(released.value.reviewStatus, 'UNVERIFIED');
  assert.equal(released.value.pending.length, 1); assert.equal(f.sent.length, 0);
  assert.equal((await f.request('release', confirmed)).error.code, 'CONFLICT');
  const audit = (await fs.readFile(path.join(f.root, `${f.current().id}.audit.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(row => row.action), ['RECHECK', 'RELEASE_CONFIRMATION_REQUESTED', 'SAFE_RELEASE_CONFIRMED', 'SAFE_RELEASED']);
  assert(audit.every(row => row.actor === 'device:one' && row.runId === 'run'));
  assert(!JSON.stringify(audit).includes(offered.value.confirmationToken));
});

test('confirmation cannot survive a state revision, and cancel acknowledgement does not prove terminal completion', async t => {
  const f = await fixture(t);
  await f.manager.started(f.identity, 'run'); await f.manager.candidate(f.identity, { runId: 'run', text: 'done', reviewBudgetMs: 1000 }); await f.manager.drain();
  const offered = await f.request('release', f.target());
  assert.equal((await f.request('recheck', f.target())).ok, true);
  assert.equal((await f.request('release', { ...f.target(), ...offered.value })).error.code, 'CONFLICT');
  const cancelled = await f.request('cancel', f.target());
  assert.equal(cancelled.ok, true); assert.equal(cancelled.value.phase, 'RELEASING');
  assert.equal(cancelled.value.reconciliation.status, 'UNKNOWN'); assert.equal(f.sent.length, 0);
  assert.equal(cancelled.value.recoveryAudit.at(-1).action, 'CANCEL_REQUESTED');
  const stale = await f.request('release', f.target()), replacement = { ...f.current(), runId: 'newer-run', phase: 'RUNNING', version: f.current().version + 1 };
  await fs.writeFile(path.join(f.root, `${replacement.id}.json`), JSON.stringify(replacement));
  assert.equal((await f.request('release', { ...replacement, ...stale.value })).error.code, 'CONFLICT');
  assert.equal(f.current().runId, 'newer-run'); assert.equal(f.current().phase, 'RUNNING');
});

test('a stale candidate failure cannot overwrite the replacement run under the record lock', async t => {
  let f;
  f = await fixture(t, { waitTerminal: async record => {
    await fs.writeFile(path.join(record.directory, `${record.id}.json`), JSON.stringify({ ...record, runId: 'replacement', phase: 'RUNNING', reason: 'REPLACEMENT_REASON' }));
    throw new Error('old run failed');
  } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'done', reviewBudgetMs: 1000 }); await f.manager.drain();
  assert.equal(f.current().runId, 'replacement'); assert.equal(f.current().reason, 'REPLACEMENT_REASON');
  assert.equal(f.current().reconciliation, null); assert.equal(f.current().completedRuns.includes('old'), false);
});

test('settled Stop review retention is bounded and evicted records still deduplicate from disk', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-stop-retention-'))), jobs = new Map();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createNativeStopReviews(jobs, undefined, { maxSettledJobs: 2, settledRetentionMs: 10000 });
  let runs = 0;
  const params = { projectRoot: root, sessionKey: 'agent:main:test', sessionId: 'test', signal: new AbortController().signal,
    budgetMs: 10000, run: async () => { runs++; return { reviewStatus: 'PASS' }; } };
  for (let n = 0; n < 6; n++) { await manager.schedule({ ...params, runId: `run-${n}` }); await manager.wait({ settle: true }); }
  assert.equal(jobs.size, 2); assert.equal(runs, 6);
  const reused = await manager.schedule({ ...params, runId: 'run-0' }); await manager.wait({ settle: true });
  assert.equal(reused.reused, true); assert.equal(runs, 6); assert.equal(jobs.size, 2);
  const expiringJobs = new Map(), expiring = createNativeStopReviews(expiringJobs, undefined, { maxSettledJobs: 2, settledRetentionMs: 20 });
  await expiring.schedule({ ...params, runId: 'expires' }); await expiring.wait({ settle: true });
  await until(() => expiringJobs.size === 0);
  const records = await fs.readdir(path.join(root, '.runtime-correction/openclaw/native-stop-reviews'));
  assert.equal(records.length, 1);
});

test('verified autopilot hold preserves the full Stop review budget and unknown status resumes with a warning', async t => {
  let status = 'RUNNING', reviews = 0;
  const f = await fixture(t, { reconciliation: { intervalMs: 20 }, waitTerminal: async () => ({ status: 'ok' }),
    beforeReview: async () => ({ hold: status === 'RUNNING', coexistence: { status, message: status === 'UNKNOWN' ? 'Status unavailable' : 'Autopilot active' } }),
    review: async record => { reviews++; assert(record.deadlineAt - Date.now() > 500); return { reviewStatus: 'PASS' }; } });
  await f.manager.started(f.identity, 'run'); await f.manager.defer(f.identity, { text: 'held next task' });
  await f.manager.candidate(f.identity, { runId: 'run', text: 'done', reviewBudgetMs: 1000 }); await f.manager.drain();
  assert.equal(f.current().phase, 'COEXIST_WAIT'); assert.equal(f.current().deadlineAt, null);
  assert.equal(f.current().candidate.reviewBudgetMs, 1000); assert.equal(f.current().completedRuns.includes('run'), false);
  await pause(1100); assert.equal(reviews, 0); assert.equal(f.sent.length, 0);
  status = 'UNKNOWN'; await until(() => reviews === 1); await f.manager.drain();
  assert.equal(f.current().coexistence.status, 'UNKNOWN'); assert.equal(f.current().coexistence.message, 'Status unavailable');
  assert.equal(reviews, 1); assert.equal(f.sent.length, 1);
});

test('held Stop candidates survive restart and resume one review when autopilot becomes idle', async t => {
  const f = await fixture(t, { waitTerminal: async () => ({ status: 'ok' }), beforeReview: async () => ({ hold: true, coexistence: { status: 'RUNNING' } }) });
  await f.manager.started(f.identity, 'run'); await f.manager.candidate(f.identity, { runId: 'run', text: 'done', reviewBudgetMs: 2000 });
  await f.manager.drain(); await f.manager.dispose(); let status = 'RUNNING', reviews = 0;
  const recovered = createPostRunDispatcher({ directoryFor: () => f.root, defaultDirectory: f.root, validate: async () => true,
    waitTerminal: async () => ({ status: 'ok' }), reconciliation: { intervalMs: 60000 },
    beforeReview: async () => ({ hold: status === 'RUNNING', coexistence: { status } }),
    review: async () => { reviews++; return { reviewStatus: 'PASS' }; } });
  t.after(() => recovered.dispose()); await recovered.load(); await recovered.drain();
  assert.equal(recovered.snapshot(f.identity).phase, 'COEXIST_WAIT'); assert.equal(reviews, 0);
  status = 'IDLE'; const record = recovered.snapshot(f.identity);
  await recovered.recheck(f.identity, { actor: 'device:one', runId: record.runId, version: record.version }); await recovered.drain();
  assert.equal(reviews, 1); assert.equal(recovered.snapshot(f.identity).phase, 'IDLE');
  assert.equal(recovered.snapshot(f.identity).coexistence.status, 'IDLE');
});

test('cancelling a held Stop does not dispatch queued business work while autopilot remains active', async t => {
  let status = 'RUNNING';
  const f = await fixture(t, { reconciliation: { intervalMs: 20 }, waitTerminal: async () => ({ status: 'ok' }),
    beforeReview: async () => ({ hold: status === 'RUNNING', coexistence: { status } }) });
  await f.manager.started(f.identity, 'run'); await f.manager.defer(f.identity, { text: 'held next task' });
  await f.manager.candidate(f.identity, { runId: 'run', text: 'done', reviewBudgetMs: 2000 }); await f.manager.drain();
  assert.equal(f.current().phase, 'COEXIST_WAIT');
  assert.equal((await f.request('cancel', f.target())).ok, true);
  assert.equal(f.current().phase, 'IDLE'); assert.equal(f.current().pending.length, 1); assert.equal(f.sent.length, 0);
  await pause(60); assert.equal(f.sent.length, 0);
  status = 'IDLE'; await until(() => f.sent.length === 1); await f.manager.drain();
  assert.equal(f.current().pending.length, 0);
});

test('trusted continuation only supersedes a terminal-confirmed held owner; unknown dispatch stays reserved', async t => {
  const f = await fixture(t, { waitTerminal: async () => ({ status: 'ok' }), beforeReview: async () => ({ hold: true, coexistence: { status: 'RUNNING' } }) });
  await f.manager.started(f.identity, 'old'); await f.manager.defer(f.identity, { text: 'held next task' });
  await f.manager.candidate(f.identity, { runId: 'old', text: 'done', reviewBudgetMs: 2000 }); await f.manager.drain();
  assert(Number.isFinite(f.current().candidate.terminalConfirmedAt));
  const resumed = await f.manager.externalStarted(f.identity, 'new', { status: 'UNKNOWN', message: 'Status unavailable', updatedAt: Date.now() });
  assert.equal(resumed.phase, 'RUNNING'); assert.equal(resumed.runId, 'new'); assert.equal(resumed.candidate, null);
  assert.equal(resumed.pending.length, 1); assert(resumed.completedRuns.includes('old'));
  assert.equal(resumed.coexistence.status, 'UNKNOWN');
  assert.equal(resumed.recoveryAudit.at(-1).action, 'HOST_CONTINUATION_ADMITTED');
  await f.manager.candidate(f.identity, { runId: 'old', text: 'late', reviewBudgetMs: 1 });
  assert.equal(f.current().runId, 'new'); assert.equal(f.current().phase, 'RUNNING');
  await assert.rejects(f.manager.externalStarted(f.identity, 'different', { status: 'RUNNING' }), { code: 'CONFLICT' });
  await assert.rejects(f.manager.noteCoexistence({ ...f.identity, runId: 'old' }, { status: 'UNKNOWN' }), { code: 'CONFLICT' });
  await f.manager.noteCoexistence({ ...f.identity, runId: 'new' }, { status: 'UNKNOWN', message: 'Status unavailable' });
  assert.equal(f.current().coexistence.status, 'UNKNOWN'); assert.equal(f.current().phase, 'RUNNING');
  const u = await fixture(t); await u.manager.defer(u.identity, { text: 'unknown dispatched task' }); await u.manager.drain();
  await assert.rejects(u.manager.externalStarted(u.identity, 'external', { status: 'RUNNING' }), { code: 'CONFLICT' });
  assert.equal(u.current().dispatching.status, 'UNKNOWN'); assert.equal(u.sent.length, 1);
});
