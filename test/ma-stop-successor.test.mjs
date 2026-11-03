import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPostRunDispatcher } from '../lib/openclaw/post-run-dispatch.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert(Date.now() < deadline, 'Expected bounded successor state'); await pause(5); }
}
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-stop-successor-'))), managers = [], sent = [], errors = [];
  const identity = { agentId: 'main', sessionId: 'session', sessionKey: 'agent:main:session', projectRoot: root,
    scopeFingerprint: 'scope', scopeTaskId: 'task-one', controlRevision: 3 };
  const create = overrides => {
    const manager = createPostRunDispatcher({ directoryFor: () => root, defaultDirectory: root, validate: async () => true,
      waitTerminal: async () => ({ status: 'ok' }), review: async () => ({ reviewStatus: 'PASS' }),
      sendUser: async (_record, task) => { sent.push(task); }, onError: error => errors.push(error),
      reconciliation: { intervalMs: 60000 }, ...options, ...overrides });
    managers.push(manager); return manager;
  };
  t.after(async () => { for (const manager of managers) await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = create();
  return { root, identity, manager, create, sent, errors, current: () => manager.snapshot(identity) };
}
const successor = (identity, overrides = {}) => ({ identity, predecessorRunId: 'old', checkpointDigest: 'a'.repeat(64),
  runId: 'new', text: 'Complete latest candidate.\n', needsReview: true, reviewBudgetMs: 10000, terminalBudgetMs: 10000, ...overrides });
const recovery = record => ({ actor: 'device:fixture', runId: record.runId, version: record.version });

test('a late latest candidate is atomically adopted only after the old gateway terminal, then reviewed once after autopilot ends', async t => {
  const terminal = deferred(), reviewed = [], receipts = []; let status = 'RUNNING', probes = 0, f;
  f = await fixture(t, { waitTerminal: async (_record, runId) => runId === 'old' ? terminal.promise : { status: 'ok' },
    beforeReview: async record => {
      probes++; assert(Number.isFinite(record.candidate?.terminalConfirmedAt ?? record.lastTerminal?.confirmedAt));
      return { hold: status === 'RUNNING', coexistence: { status },
        ...(record.runId === 'old' ? { successorCandidate: successor(f.identity), isSuccessorCurrent: () => true,
          onSuccessorAdopted: async receipt => {
            const disk = JSON.parse(await fs.readFile(path.join(f.root, `${record.id}.json`), 'utf8'));
            assert.equal(disk.runId, 'new'); assert.equal(disk.phase, 'FINALIZING'); assert.equal(disk.candidate.text, successor(f.identity).text);
            assert.equal(disk.promotion.adoptedVersion, disk.version); receipts.push(receipt);
          } } : {}) };
    }, review: async (record, { deadlineAt }) => { reviewed.push(record); assert(deadlineAt - Date.now() > 9000); return { reviewStatus: 'PASS' }; } });
  await f.manager.started(f.identity, 'old');
  await f.manager.candidate(f.identity, { runId: 'old', text: 'Earlier candidate', reviewBudgetMs: 1000 });
  await pause(20); assert.equal(probes, 0); assert.equal(f.current().runId, 'old');
  terminal.resolve({ status: 'ok' }); await f.manager.drain();
  assert.equal(f.current().runId, 'new'); assert.equal(f.current().phase, 'COEXIST_WAIT'); assert.equal(f.current().candidate.reviewBudgetMs, 10000);
  assert.equal(f.current().promotion.terminalStatus, 'ok'); assert.equal(receipts.length, 1); assert.equal(receipts[0].provenance.runId, 'new');
  assert.equal(reviewed.length, 0); assert.equal(f.sent.length, 0); assert(f.current().completedRuns.includes('old'));
  await f.manager.candidate(f.identity, { runId: 'old', text: 'Late obsolete completion', reviewBudgetMs: 1 });
  status = 'IDLE'; await f.manager.recheck(f.identity, recovery(f.current())); await f.manager.drain();
  assert.deepEqual(reviewed.map(record => record.runId), ['new']); assert.equal(f.current().reviewStatus, 'PASS');
  assert.equal(f.current().phase, 'IDLE'); assert.equal(receipts.length, 1); assert.equal(f.sent.length, 0);
});

for (const old of [{ status: 'ok', needsReview: false }, { status: 'error', needsReview: true }]) {
  test(`a confirmed ${old.status} predecessor with needsReview=${old.needsReview} still admits its successor`, async t => {
    const reviewed = []; let f;
    f = await fixture(t, { waitTerminal: async (_record, runId) => ({ status: runId === 'old' ? old.status : 'ok' }),
      beforeReview: async record => ({ coexistence: { status: 'IDLE' }, successorCandidate: record.runId === 'old' ? successor(f.identity) : undefined,
        isSuccessorCurrent: () => true }), review: async record => { reviewed.push(record.runId); return { reviewStatus: 'PASS' }; } });
    await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity,
      { runId: 'old', text: 'Earlier candidate', reviewBudgetMs: 1000, needsReview: old.needsReview }); await f.manager.drain();
    assert.deepEqual(reviewed, ['new']); assert.equal(f.current().runId, 'new'); assert.equal(f.current().promotion.terminalStatus, old.status);
    assert.equal(f.sent.length, 0);
  });
}

test('an unknown predecessor never calls the successor provider or releases its owner even when autopilot is idle', async t => {
  let probes = 0;
  const f = await fixture(t, { waitTerminal: async () => ({ status: 'UNKNOWN' }),
    beforeReview: async () => { probes++; return { coexistence: { status: 'IDLE' }, successorCandidate: successor(f.identity), isSuccessorCurrent: () => true }; } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await f.manager.drain(); await f.manager.recheck(f.identity, recovery(f.current())); await f.manager.drain();
  assert.equal(probes, 0); assert.equal(f.current().runId, 'old'); assert.equal(f.current().reconciliation.status, 'UNKNOWN');
  assert.equal(f.current().candidate.terminalConfirmedAt, undefined); assert.equal(f.current().promotion, undefined); assert.equal(f.sent.length, 0);
});

test('an UNKNOWN finalizing predecessor later confirmed error retains proof and resumes its successor without queued business work', async t => {
  let status = 'UNKNOWN', probes = 0, f; const waited = [], reviewed = [];
  f = await fixture(t, { waitTerminal: async (_record, runId) => {
    waited.push(runId); return { status: runId === 'old' ? status : 'ok' };
  }, beforeReview: async record => {
    probes++; assert.equal(status, 'error');
    if (record.runId === 'old') {
      assert.equal(record.lastTerminal.runId, 'old'); assert.equal(record.lastTerminal.terminalRunId, 'old');
      assert.equal(record.lastTerminal.status, 'error'); assert(Number.isFinite(record.lastTerminal.confirmedAt));
    }
    return { coexistence: { status: 'IDLE' }, successorCandidate: record.runId === 'old' ? successor(f.identity) : undefined,
      isSuccessorCurrent: () => true };
  }, review: async record => { reviewed.push(record.runId); return { reviewStatus: 'PASS' }; } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await f.manager.drain(); assert.equal(probes, 0); assert.equal(f.current().reconciliation.status, 'UNKNOWN');
  assert.equal(f.current().pending.length, 0); status = 'error';
  await f.manager.recheck(f.identity, recovery(f.current())); await f.manager.drain();
  assert.equal(f.current().runId, 'new'); assert.equal(f.current().promotion.terminalStatus, 'error');
  assert.equal(f.current().promotion.terminalRunId, 'old'); assert.deepEqual(reviewed, ['new']);
  assert.deepEqual(waited, ['old', 'old', 'new']); assert.equal(f.current().phase, 'IDLE'); assert.equal(f.sent.length, 0);
});

for (const status of ['ok', 'error']) test(`a recovered RUNNING predecessor confirmed ${status} resumes its successor from retained terminal proof`, async t => {
  const f = await fixture(t); await f.manager.started(f.identity, 'old'); await f.manager.dispose();
  const reviewed = [], waited = [];
  const recovered = f.create({ waitTerminal: async (_record, runId) => {
    waited.push(runId); return { status: runId === 'old' ? status : 'ok' };
  }, beforeReview: async record => {
    if (record.runId === 'old') {
      assert.equal(record.lastTerminal.runId, 'old'); assert.equal(record.lastTerminal.terminalRunId, 'old');
      assert.equal(record.lastTerminal.status, status); assert.equal(record.reconciliation, null);
    }
    return { coexistence: { status: 'IDLE' }, successorCandidate: record.runId === 'old' ? successor(f.identity) : undefined,
      isSuccessorCurrent: () => true };
  }, review: async record => { reviewed.push(record.runId); return { reviewStatus: 'PASS' }; } });
  await recovered.load(); await recovered.drain(); const current = recovered.snapshot(f.identity);
  assert.equal(current.runId, 'new'); assert.equal(current.phase, 'IDLE'); assert.equal(current.promotion.terminalStatus, status);
  assert.equal(current.promotion.terminalRunId, 'old'); assert.deepEqual(waited, ['old', 'new']);
  assert.deepEqual(reviewed, ['new']); assert.equal(f.sent.length, 0);
});

test('a releasing correction confirmed after UNKNOWN preserves the actual correction terminal identity in successor provenance', async t => {
  let correctionStatus = 'UNKNOWN', offer = false, f; const waited = [], reviewed = [];
  f = await fixture(t, { waitTerminal: async (_record, runId) => {
    waited.push(runId); return { status: runId === 'repair' ? correctionStatus : 'ok' };
  }, beforeReview: async record => ({ coexistence: { status: 'IDLE' },
    successorCandidate: offer && record.runId === 'old' ? successor(f.identity) : undefined, isSuccessorCurrent: () => true }),
  review: async record => {
    reviewed.push(record.runId);
    if (record.runId === 'old') {
      await f.manager.correction(f.identity, 'repair', Date.now() + 60000, 'old-stop', 'old');
      return { reviewStatus: 'DEVIATION' };
    }
    return { reviewStatus: 'PASS' };
  } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 10000 });
  await f.manager.drain(); assert.equal(f.current().phase, 'WAIT_CORRECTION');
  await f.manager.release(f.identity, 'POST_RUN_EXECUTION_TIMEOUT');
  assert.equal(f.current().phase, 'RELEASING'); assert.equal(f.current().reconciliation.status, 'UNKNOWN');
  offer = true; correctionStatus = 'error'; await f.manager.recheck(f.identity, recovery(f.current())); await f.manager.drain();
  assert.equal(f.current().runId, 'new'); assert.equal(f.current().promotion.terminalRunId, 'repair');
  assert.equal(f.current().promotion.terminalStatus, 'error'); assert.deepEqual(reviewed, ['old', 'new']);
  assert.deepEqual(waited, ['old', 'repair', 'repair', 'new']); assert.equal(f.sent.length, 0);
});

test('held predecessor restart and crash after atomic adoption recover the complete successor without business replay', async t => {
  const f = await fixture(t, { beforeReview: async () => ({ hold: true, coexistence: { status: 'RUNNING' } }) });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await f.manager.drain(); await f.manager.dispose(); const terminal = deferred(), text = '完整候选\n'.repeat(1000); let waiting = false;
  const second = f.create({ beforeReview: async record => ({ coexistence: { status: 'IDLE' },
    successorCandidate: record.runId === 'old' ? successor(f.identity, { text }) : undefined, isSuccessorCurrent: () => true,
    onSuccessorAdopted: async () => { throw new Error('Receipt consumer unavailable'); } }),
    waitTerminal: async (_record, runId) => { assert.equal(runId, 'new'); waiting = true; return terminal.promise; } });
  await second.load(); await until(() => waiting); const adopted = second.snapshot(f.identity);
  assert.equal(adopted.runId, 'new'); assert.equal(adopted.phase, 'FINALIZING'); assert.equal(adopted.candidate.text, text);
  assert.equal(adopted.promotion.checkpointDigest, 'a'.repeat(64)); assert.equal(f.errors.length, 1);
  await second.dispose(); const reviewed = [];
  const third = f.create({ beforeReview: async record => ({ coexistence: { status: 'IDLE' },
    successorCandidate: successor(f.identity, { text }), isSuccessorCurrent: () => true }),
    review: async record => { reviewed.push(record); return { reviewStatus: 'PASS' }; } });
  await third.load(); await third.drain(); const settled = third.snapshot(f.identity);
  assert.deepEqual(reviewed.map(record => record.runId), ['new']); assert.equal(reviewed[0].candidate.text, text);
  assert.equal(settled.promotion.adoptedVersion, adopted.promotion.adoptedVersion); assert.equal(settled.phase, 'IDLE'); assert.equal(f.sent.length, 0);
});

test('cancellation while a provider is waiting prevents late promotion and never executes the successor', async t => {
  const gate = deferred(); let entered = false, reviews = 0;
  const f = await fixture(t, { beforeReview: async () => { entered = true; return gate.promise; }, review: async () => { reviews++; } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await until(() => entered); await f.manager.confirmCancel(f.identity, recovery(f.current()));
  gate.resolve({ coexistence: { status: 'IDLE' }, successorCandidate: successor(f.identity), isSuccessorCurrent: () => true });
  await f.manager.drain(); assert.equal(f.current().runId, 'old'); assert.equal(f.current().phase, 'IDLE');
  assert.equal(f.current().promotion, undefined); assert.equal(reviews, 0); assert.equal(f.sent.length, 0);
});

test('a promoted review returning a late PASS cannot overwrite the next owner after audited cancellation', async t => {
  const late = deferred(); let reviewing = false, f;
  f = await fixture(t, { beforeReview: async record => ({ coexistence: { status: 'IDLE' },
    successorCandidate: record.runId === 'old' ? successor(f.identity) : undefined, isSuccessorCurrent: () => true }),
    review: async record => { if (record.runId === 'new') { reviewing = true; return late.promise; }
      return { reviewStatus: 'PASS', reviewSummary: { marker: 'third-owner' } }; } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await until(() => reviewing); await f.manager.confirmCancel(f.identity, recovery(f.current()));
  await f.manager.started(f.identity, 'third'); await f.manager.candidate(f.identity, { runId: 'third', text: 'Third', reviewBudgetMs: 1000 });
  late.resolve({ reviewStatus: 'PASS', reviewSummary: { marker: 'late-promoted-owner' } }); await f.manager.drain();
  assert.equal(f.current().runId, 'third'); assert.equal(f.current().reviewSummary.marker, 'third-owner'); assert.equal(f.sent.length, 0);
});

test('an audited cancellation ignores a late PASS summary even when the same owner remains IDLE', async t => {
  const late = deferred(); let reviewing = false, summaryReads = 0;
  const f = await fixture(t, { review: async () => { reviewing = true; return late.promise; } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 10000 });
  await until(() => reviewing); await f.manager.confirmCancel(f.identity, recovery(f.current())); await f.manager.drain();
  assert.equal(f.current().runId, 'old'); assert.equal(f.current().phase, 'IDLE'); assert.equal(f.current().reviewStatus, 'UNVERIFIED');
  late.resolve({ reviewStatus: 'PASS', get reviewSummary() { summaryReads++; return { marker: 'cancelled-late-pass' }; } });
  await late.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(summaryReads, 0, 'a cancelled owner must not inspect or publish its obsolete result');
  assert.equal(f.current().reviewSummary, undefined); assert.equal(f.current().reviewStatus, 'UNVERIFIED');
});

test('a version change during provider work retains the wakeup and requires a fresh proposal before promotion', async t => {
  const gate = deferred(); let entered = false, first = true, f;
  f = await fixture(t, { beforeReview: async record => {
    const result = { hold: true, coexistence: { status: 'RUNNING' },
      successorCandidate: record.runId === 'old' ? successor(f.identity) : undefined, isSuccessorCurrent: () => true };
    if (first) { first = false; entered = true; await gate.promise; } return result;
  } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await until(() => entered); await f.manager.defer(f.identity, { text: 'Retained FIFO task' }); gate.resolve(); await f.manager.drain();
  assert.equal(f.current().runId, 'old'); assert.equal(f.current().phase, 'COEXIST_WAIT'); assert.equal(f.current().promotion, undefined);
  await f.manager.recheck(f.identity, recovery(f.current())); await f.manager.drain();
  assert.equal(f.current().runId, 'new'); assert.equal(f.current().pending.length, 1); assert.equal(f.sent.length, 0);
});

test('a candidate arriving during the predecessor review is adopted before the released owner can dispatch business work', async t => {
  const release = deferred(); let reviewing = false, checkpoint = false, f; const reviewed = [];
  f = await fixture(t, { beforeReview: async record => ({ coexistence: { status: 'IDLE' },
    successorCandidate: checkpoint && record.runId === 'old' ? successor(f.identity) : undefined, isSuccessorCurrent: () => true }),
    review: async record => { reviewed.push(record.runId); if (record.runId === 'old') { reviewing = true; await release.promise; return { reviewStatus: 'CANCELLED' }; }
      return { reviewStatus: 'PASS' }; } });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await until(() => reviewing); checkpoint = true; release.resolve(); await f.manager.drain();
  assert.deepEqual(reviewed, ['old', 'new']); assert.equal(f.current().runId, 'new'); assert.equal(f.current().reviewStatus, 'PASS');
  assert.equal(f.sent.length, 0);
});

test('a released IDLE owner recovers a late durable candidate after restart even without queued business work', async t => {
  const f = await fixture(t, { beforeReview: async () => ({ coexistence: { status: 'IDLE' } }) });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await f.manager.drain(); assert.equal(f.current().phase, 'IDLE'); assert.equal(f.current().lastTerminal.runId, 'old');
  assert.equal(f.current().lastTerminal.status, 'ok'); await f.manager.dispose();
  const recovered = f.create({ beforeReview: async record => ({ hold: true, coexistence: { status: 'RUNNING' },
    successorCandidate: record.runId === 'old' ? successor(f.identity) : undefined, isSuccessorCurrent: () => true }) });
  await recovered.load(); await recovered.drain(); const current = recovered.snapshot(f.identity);
  assert.equal(current.runId, 'new'); assert.equal(current.phase, 'COEXIST_WAIT'); assert.equal(current.promotion.predecessorRunId, 'old');
  assert.equal(f.sent.length, 0);
});

for (const action of ['cancel', 'safe release']) test(`explicit ${action} persists successor suppression across restart`, async t => {
  let probes = 0;
  const f = await fixture(t, { waitTerminal: async () => ({ status: action === 'cancel' ? 'ok' : 'UNKNOWN' }),
    beforeReview: async () => ({ hold: true, coexistence: { status: 'RUNNING' } }) });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await f.manager.drain();
  if (action === 'cancel') await f.manager.confirmCancel(f.identity, recovery(f.current()));
  else {
    const confirmed = await f.manager.prepareRelease(f.identity, recovery(f.current()));
    await f.manager.safeRelease(f.identity, { ...recovery(f.current()), ...confirmed });
  }
  assert.equal(f.current().successorAdmissionClosed, true); await f.manager.dispose();
  const recovered = f.create({ beforeReview: async () => { probes++; return { coexistence: { status: 'IDLE' },
    successorCandidate: successor(f.identity), isSuccessorCurrent: () => true }; } });
  await recovered.load(); await recovered.drain(); const current = recovered.snapshot(f.identity);
  assert.equal(current.runId, 'old'); assert.equal(current.successorAdmissionClosed, true); assert.equal(current.promotion, undefined);
  assert.equal(probes, 0); assert.equal(f.sent.length, 0);
});

for (const guard of [() => false, () => { throw new Error('Not current'); }, async () => true, async () => { throw new Error('Async guard rejected'); }]) {
  test(`successor adoption requires a synchronous exact true guard (${guard.toString()})`, async t => {
    let f;
    f = await fixture(t, { beforeReview: async () => ({ hold: true, coexistence: { status: 'RUNNING' },
      successorCandidate: successor(f.identity), isSuccessorCurrent: guard }) });
    await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
    await f.manager.drain(); assert.equal(f.current().runId, 'old'); assert.equal(f.current().promotion, undefined); assert.equal(f.sent.length, 0);
  });
}

test('a restored UNKNOWN reconciliation cannot use an older confirmed marker to promote a successor', async t => {
  const f = await fixture(t, { beforeReview: async () => ({ hold: true, coexistence: { status: 'RUNNING' } }) });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await f.manager.drain(); const record = f.current(); await f.manager.dispose();
  record.reconciliation = { runId: 'old', status: 'UNKNOWN', attempts: 0, startedAt: Date.now() };
  await fs.writeFile(path.join(f.root, `${record.id}.json`), JSON.stringify(record)); let probes = 0;
  const recovered = f.create({ waitTerminal: async () => ({ status: 'UNKNOWN' }), beforeReview: async () => {
    probes++; return { coexistence: { status: 'IDLE' }, successorCandidate: successor(f.identity), isSuccessorCurrent: () => true };
  } });
  await recovered.load(); await recovered.drain(); const current = recovered.snapshot(f.identity);
  assert(Number.isFinite(current.candidate.terminalConfirmedAt)); assert.equal(current.reconciliation.status, 'UNKNOWN');
  assert.equal(probes, 0); assert.equal(current.runId, 'old'); assert.equal(current.promotion, undefined); assert.equal(f.sent.length, 0);
});

test('successor scope and payload bounds reject incomplete data without silently truncating text or metadata', async t => {
  for (const change of [value => ({ ...value, text: 'x'.repeat(200001) }), value => ({ ...value, unrecognizedMetadata: 'must not disappear' }),
    value => ({ ...value, identity: { ...value.identity, controlRevision: 4 } }), value => ({ ...value, predecessorRunId: 'foreign' }),
    value => ({ ...value, terminalBudgetMs: 0 })]) await t.test(change.toString(), async t => {
    let f;
    f = await fixture(t, { beforeReview: async () => ({ hold: true, coexistence: { status: 'RUNNING' },
      successorCandidate: change(successor(f.identity)), isSuccessorCurrent: () => true }) });
    await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
    await f.manager.drain(); assert.equal(f.current().runId, 'old'); assert.equal(f.current().promotion, undefined);
  });
  const complete = '界'.repeat(200000); let f;
  f = await fixture(t, { beforeReview: async record => ({ hold: true, coexistence: { status: 'RUNNING' },
    successorCandidate: record.runId === 'old' ? successor(f.identity, { text: complete }) : undefined, isSuccessorCurrent: () => true }) });
  await f.manager.started(f.identity, 'old'); await f.manager.candidate(f.identity, { runId: 'old', text: 'Old', reviewBudgetMs: 1000 });
  await f.manager.drain(); assert.equal(f.current().runId, 'new'); assert.equal(f.current().candidate.text, complete); assert.equal(f.sent.length, 0);
});
