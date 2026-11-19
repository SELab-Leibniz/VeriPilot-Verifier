import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { createNativeStopFixture, deferred, within } from './support/openclaw-native-stop-fixture.mjs';

const { lifecycle } = createNativeStopFixture();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withOwnedContinuation(t, observeModelStart, run) {
  const terminal = deferred(t), dispatched = deferred(t);
  let childRunId, reviews = 0;
  const f = await lifecycle(t, { waitMode: 'until_pass', waitTimeoutMs: 120000,
    observeModelStart, review: async () => ++reviews === 1,
    postRunTerminal: async (_identity, runId) => {
      if (runId.startsWith('rc-stop-')) await terminal.promise;
      return { runId, status: 'ok' };
    } });
  const timing = [];
  f.api.logger.info = value => timing.push(value);
  f.api.runtime.subagent = { run: async args => {
    childRunId = args.idempotencyKey; dispatched.resolve(); return { runId: childRunId };
  } };
  let child;
  try {
    await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey,
      payload: { text: 'Current candidate.' } }, f.ctx);
    await within(dispatched.promise, 'correction dispatch');
    await within(f.runtime.waitForNativeReviews(), 'initial review');
    child = { ...f.ctx, runId: childRunId };
    const prompt = await f.runtime.prompt({ prompt: 'Apply the current feedback.' }, child);
    const protocol = f.sharedState.stopStartProtocol;
    const before = await protocol.findRun({ state: f.state, runId: childRunId });
    assert.equal(before.admission.accounting, observeModelStart ? 'USED' : 'RESERVED');
    assert.equal(protocol.knowsRun(f.state, childRunId), true);
    const event = { prompt: prompt?.prependContext ?? 'Continue the same owned run.' };
    await run({ f, child, childRunId, protocol, before, event, timing,
      ledger: path.join(f.root, 'host-state/runtime-corrector-stop-sessions/sessions', `${sha256('host')}.json`) });
  } finally {
    terminal.resolve();
    await f.runtime.reset({}, child ?? f.ctx);
    await f.runtime.waitForNativeReviews({ drain: true });
  }
}

async function withLedgerDelay(ledger, delayMs, run) {
  const original = fs.readFile, reads = [];
  fs.readFile = async function(file, ...args) {
    if (path.resolve(String(file)) !== ledger) return original.call(this, file, ...args);
    const settled = deferred(), entry = { requestedAt: Date.now(), settled: settled.promise };
    reads.push(entry);
    try { await pause(delayMs); return await original.call(this, file, ...args); }
    finally { entry.completedAt = Date.now(); settled.resolve(); }
  };
  try { return await run(reads); }
  finally { await Promise.all(reads.map(entry => entry.settled)); fs.readFile = original; }
}

test('known USED continuation performs one fresh ownership read without repeated history initialization', { timeout: 20000 }, async t => {
  await withOwnedContinuation(t, true, async ({ f, child, childRunId, protocol, event, ledger, timing }) => {
    timing.length = 0;
    await withLedgerDelay(ledger, 0, async reads => {
      const decision = await f.runtime.beforeAgentRun(event, child);
      assert.equal(decision.outcome, 'pass');
      assert.equal(reads.length, 1, 'Remembered navigation cannot replace the remaining fresh owned read.');
    });
    assert(timing.some(row => row.includes('gate.owned')));
    assert(!timing.some(row => row.includes('history.inspect')));
    const after = await protocol.findRun({ state: f.state, runId: childRunId });
    assert.equal(after.admission.accounting, 'USED');
    assert.equal(after.admission.invalidatedAt, undefined);
  });
});

test('known navigation still fails closed on an ownership read that exceeds the original gate deadline', { timeout: 20000 }, async t => {
  await withOwnedContinuation(t, true, async ({ f, child, event, ledger, timing }) => {
    timing.length = 0;
    await withLedgerDelay(ledger, 1500, async reads => {
      const decision = await f.runtime.beforeAgentRun(event, child);
      assert.equal(decision.outcome, 'block');
      assert.equal(decision.reason, 'RC_STOP_ADMISSION_CLOSED');
      assert.equal(reads.length, 1);
    });
    assert(timing.some(row => row.includes('"stage":"budget"') && row.includes('gate.owned')));
    assert(f.warnings.some(row => row.includes('Input check unavailable: STOP_DEADLINE_EXPIRED')));
  });
});

test('fresh lookup fences missing and foreign ledgers and current reset despite remembered navigation', { timeout: 20000 }, async t => {
  await withOwnedContinuation(t, true, async ({ f, child, childRunId, protocol, event, ledger }) => {
    const backup = `${ledger}.owned-test-backup`;
    await fs.rename(ledger, backup);
    try {
      const decision = await f.runtime.beforeAgentRun(event, child);
      assert.equal(decision.outcome, 'block');
      assert.equal(await fs.stat(ledger).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false,
        'A remembered continuation must not recreate missing history.');
    } finally { await fs.rename(backup, ledger); }
    const foreign = { ...child, sessionId: 'another-native-session' };
    assert.equal(protocol.knowsRun(foreign, childRunId), true, 'Navigation alone does not bind native session ownership.');
    assert.equal((await f.runtime.beforeAgentRun(event, foreign)).outcome, 'block');
    await f.runtime.reset({}, f.ctx);
    assert.equal((await f.runtime.beforeAgentRun(event, child)).outcome, 'pass', 'A stale original-run reset cannot revoke the active child.');
    await f.runtime.reset({}, child);
    assert.equal(protocol.knowsRun(child, childRunId), true);
    assert.equal((await f.runtime.beforeAgentRun(event, child)).outcome, 'block');
    assert((await protocol.findRun({ state: f.state, runId: childRunId })).admission.invalidatedAt);
  });
});

test('RESERVED source revalidation and unknown namespace history checks remain required', { timeout: 20000 }, async t => {
  await withOwnedContinuation(t, false, async ({ f, child, childRunId, protocol, event }) => {
    await fs.writeFile(path.join(f.root, 'draft.md'), 'Changed before any observed model start.\n');
    assert.equal((await f.runtime.beforeAgentRun(event, child)).outcome, 'block');
    assert.equal(protocol.knowsRun(child, childRunId), true);
    const restarted = f.restart(), info = [];
    f.api.logger.info = value => info.push(value);
    const unknown = { ...child, runId: `rc-stop-${'f'.repeat(64)}` };
    assert.equal((await restarted.beforeAgentRun({ prompt: 'An unregistered namespace value.' }, unknown)).outcome, 'block');
    assert(info.some(row => row.includes('history.inspect')), 'Namespace recognition must not skip history initialization.');
  });
});
