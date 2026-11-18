import test from 'node:test';
import assert from 'node:assert/strict';
import { readBusinessTerminal, knownBusinessTerminal, businessCompleted, createBusinessRunTracker, createBusinessTerminalObserver, nativeCompactionStart, pairedBusinessWorkflowFailure, retainedBusinessTransportError } from '../scripts/bench/business-completion.mjs';
import { compareOpenSpecApplyProgress } from '../scripts/bench/original-basis-workflow.mjs';

test('matches the terminated active Apply leaf to its own input and settled tool calls', () => {
  const scope = { runId: 'apply', sessionId: 'session' };
  const records = [{ type: 'session', id: 'session' },
    { type: 'message', id: 'input', parentId: null, message: { role: 'user', idempotencyKey: 'apply:user' } },
    { type: 'message', id: 'call', parentId: 'input', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool', name: 'edit' }] } },
    { type: 'message', id: 'result', parentId: 'call', message: { role: 'toolResult', toolCallId: 'tool', toolName: 'edit' } },
    { type: 'message', id: 'leaf', parentId: 'result', timestamp: new Date(3000).toISOString(),
      message: { role: 'assistant', timestamp: 2000, content: [], stopReason: 'error', errorMessage: 'terminated', usage: { totalTokens: 0 } } }];
  const proof = retainedBusinessTransportError(records, scope);
  assert.deepEqual({ messageId: proof.messageId, startedAt: proof.startedAt, persistedAt: proof.persistedAt, failureKind: proof.failureKind },
    { messageId: 'leaf', startedAt: 2000, persistedAt: 3000, failureKind: 'terminated' });
  assert.match(proof.messageSha256, /^[a-f0-9]{64}$/u);
  const partial = structuredClone(records);
  const fragment = { type: 'text', text: '確認 interrupted' };
  partial.at(-1).message.content = [fragment];
  const partialProof = retainedBusinessTransportError(partial, scope);
  assert.equal(partialProof.retainedTextBytes, Buffer.byteLength(fragment.text));
  assert.notEqual(partialProof.messageSha256, proof.messageSha256);
  assert(!Object.values(partialProof).includes(fragment.text));
  assert.equal(retainedBusinessTransportError(records, { ...scope, runId: 'different' }), null);
  for (const change of [
    rows => { rows[0].id = 'different'; },
    rows => { rows[4].parentId = 'call'; },
    rows => { rows[3].message.toolName = 'write'; },
    rows => { rows[4].message.errorMessage = 'context length exceeded'; },
    rows => { rows[4].message.content.push({ type: 'toolCall', id: 'partial', name: 'edit' }); },
    rows => { rows[4].message.content = [fragment, { type: 'toolCall', id: 'partial', name: 'edit' }]; },
    rows => { rows[4].message.content = [{ type: 'thinking', thinking: 'partial' }]; },
    rows => { rows[4].message.content = [{ ...fragment, id: 'partial' }]; },
    rows => { rows[4].message.content = [{ type: 'text', text: '確'.repeat(350) }]; },
    rows => { rows[4].message.content = [fragment]; rows[4].message.usage.totalTokens = 1; },
    rows => { rows.push({ ...rows[4], id: 'new-leaf', parentId: 'leaf', message: { role: 'assistant', stopReason: 'stop' } }); },
  ]) {
    const invalid = structuredClone(records);
    change(invalid);
    assert.equal(retainedBusinessTransportError(invalid, scope), null);
  }
});

test('OpenClaw settlement and exact terminal identity take precedence over OpenSpec progress', () => {
  const terminal = { source: 'agent.wait', runId: 'apply', status: 'error' };
  const final = { settled: true, finalRunId: 'apply', terminal };
  const openSpec = { proposal: { readyToApply: true }, codeing: null };
  assert.equal(pairedBusinessWorkflowFailure(final, openSpec), 'OPENCLAW_BUSINESS_TERMINAL_ERROR');
  assert.equal(pairedBusinessWorkflowFailure({ ...final, settled: false }, openSpec), 'OPENCLAW_BUSINESS_UNSETTLED');
  assert.equal(pairedBusinessWorkflowFailure({ ...final, finalRunId: 'different' }, openSpec), 'OPENCLAW_BUSINESS_UNSETTLED');
  assert.equal(pairedBusinessWorkflowFailure({ settled: true, terminal: { source: 'agent.wait', status: 'ok' } }, openSpec),
    'OPENCLAW_BUSINESS_UNSETTLED');
  assert.equal(pairedBusinessWorkflowFailure({ ...final, terminal: { ...terminal, status:'timeout' } }, openSpec),
    'OPENCLAW_BUSINESS_UNSETTLED');
  const success = { ...final, terminal: { ...terminal, status: 'ok' } };
  assert.equal(pairedBusinessWorkflowFailure(success, openSpec), 'OPENSPEC_APPLY_PROGRESS_UNVERIFIED');
  assert.equal(pairedBusinessWorkflowFailure(success, { proposal: null }), 'OPENSPEC_PLAN_NOT_READY');
  assert.equal(pairedBusinessWorkflowFailure(success, { ...openSpec, codeing: { applyComplete: true }, applyChecklistPreserved: true }), null);
});

test('strict Apply completion requires the approved task inventory and text', () => {
  const changeName = 'benchmark-change';
  const descriptions = ['Implement the requested behavior.', 'Verify the required acceptance check.'];
  const checkpoint = tasks => {
    const total = tasks.length, complete = tasks.filter(task => task.done).length, remaining = total - complete;
    return { changeName, planVerified: true, readyToApply: remaining > 0, applyComplete: remaining === 0,
      apply: { exitCode: 0, value: { changeName, progress: { total, complete, remaining }, tasks } } };
  };
  const approvedTasks = descriptions.map((description, index) => ({ id: String(index + 1), description, done: false }));
  const proposal = checkpoint(approvedTasks);
  const completed = approvedTasks.map(task => ({ ...task, done: true }));
  const final = { settled: true, finalRunId: 'apply', terminal: { source: 'agent.wait', runId: 'apply', status: 'ok' } };
  const check = codeing => {
    const applyChecklistPreserved = compareOpenSpecApplyProgress(proposal, codeing, changeName);
    return [applyChecklistPreserved, pairedBusinessWorkflowFailure(final, { proposal, codeing, applyChecklistPreserved })];
  };

  assert.deepEqual(check(checkpoint(completed)), [true, null]);
  assert.deepEqual(check(checkpoint([completed[0]])), [false, 'OPENSPEC_APPLY_CHECKLIST_CHANGED']);
  assert.deepEqual(check(checkpoint([completed[0], { ...completed[1], description: 'Read the acceptance guidance.' }])),
    [false, 'OPENSPEC_APPLY_CHECKLIST_CHANGED']);
  assert.deepEqual(check(checkpoint([completed[0], approvedTasks[1]])), [true, 'OPENSPEC_APPLY_INCOMPLETE']);
  assert.deepEqual(check(checkpoint([completed[0], { ...approvedTasks[1], description: 'Required check is blocked.' }])),
    [false, 'OPENSPEC_APPLY_CHECKLIST_CHANGED']);
  assert.deepEqual(check(checkpoint([completed[0], { ...approvedTasks[1], description: '' }])),
    [null, 'OPENSPEC_APPLY_PROGRESS_UNVERIFIED']);
  assert.deepEqual(check(null), [null, 'OPENSPEC_APPLY_PROGRESS_UNVERIFIED']);
  assert.equal(pairedBusinessWorkflowFailure(final, { proposal, codeing: checkpoint(completed), applyChecklistPreserved: null }),
    'OPENSPEC_APPLY_PROGRESS_UNVERIFIED');
  const restored = { proposal, codeing: checkpoint(completed), applyChecklistPreserved: true };
  assert.equal(pairedBusinessWorkflowFailure(final, { ...restored, applyChecklistCorrection: { verified: false } }),
    'OPENSPEC_APPLY_CHECKLIST_RECOVERY_UNVERIFIED');
  assert.equal(pairedBusinessWorkflowFailure(final, { ...restored, applyChecklistCorrection: { verified: true } }), null);
});

test('settled Apply workflow scope protects completion while preserving terminal and checklist outcomes', () => {
  const terminal = { source: 'agent.wait', runId: 'apply', status: 'ok' };
  const final = { settled: true, finalRunId: 'apply', terminal };
  const complete = { proposal: { readyToApply: true }, codeing: { applyComplete: true }, applyChecklistPreserved: true };
  const withScope = (status, overrides = {}) => ({ ...complete, applyWorkflowScope: { status }, ...overrides });
  assert.equal(pairedBusinessWorkflowFailure(final, complete), null, 'legacy receipts retain their existing behavior');
  assert.equal(pairedBusinessWorkflowFailure(final, withScope('PRESERVED')), null);
  assert.equal(pairedBusinessWorkflowFailure(final, withScope('CHANGED')), 'OPENSPEC_APPLY_WORKFLOW_CHANGED');
  assert.equal(pairedBusinessWorkflowFailure(final, withScope('UNVERIFIED')), 'OPENSPEC_APPLY_WORKFLOW_UNVERIFIED');
  assert.equal(pairedBusinessWorkflowFailure(final, withScope('PRESERVED', { codeing: { readyToApply: true } })), 'OPENSPEC_APPLY_INCOMPLETE');
  assert.equal(pairedBusinessWorkflowFailure(final, withScope('CHANGED', { applyChecklistPreserved: false })), 'OPENSPEC_APPLY_CHECKLIST_CHANGED');
  assert.equal(pairedBusinessWorkflowFailure(final, withScope('CHANGED', { applyChecklistPreserved: null })), 'OPENSPEC_APPLY_PROGRESS_UNVERIFIED');
  assert.equal(pairedBusinessWorkflowFailure(final, withScope('CHANGED', { applyChecklistCorrection: { verified: false } })),
    'OPENSPEC_APPLY_CHECKLIST_RECOVERY_UNVERIFIED');
  assert.equal(pairedBusinessWorkflowFailure({ ...final, settled: false }, withScope('CHANGED')), 'OPENCLAW_BUSINESS_UNSETTLED');
  assert.equal(pairedBusinessWorkflowFailure({ ...final, terminal: { ...terminal, status: 'error' } }, withScope('CHANGED')),
    'OPENCLAW_BUSINESS_TERMINAL_ERROR');
});

test('only native compaction in the exact business session is excluded from correction starts', () => {
  const scope = { sessionId: 'session', sessionKey: 'agent:main:arkts-case' };
  const event = { ...scope, runId: 'session:compaction:cmp-mw833c0z-XBvWUg' };
  assert.equal(nativeCompactionStart(event, scope), true);
  for (const row of [
    { ...event, sessionId: 'other' }, { ...event, sessionKey: 'other' },
    { ...event, runId: 'other:compaction:cmp-known' },
    { ...event, runId: 'session:compaction:cmp-' },
    { ...event, runId: 'session:compaction:cmp-known:other' },
    { ...event, runId: 'rc-stop-admitted' }, { ...scope, runId: 'unadmitted' },
  ]) assert.equal(nativeCompactionStart(row, scope), false);
});
test('an outer context-compaction error remains failed after a successful diagnostic attempt', async () => {
  const terminal = await readBusinessTerminal(async () => ({ result: { runId: 'host', status: 'error' } }), 'host');
  assert.equal(knownBusinessTerminal(terminal, 'host'), true);
  assert.equal(businessCompleted(terminal, 'host'), false);
});

test('a real public terminal captured before review survives gateway cache expiration', async () => {
  let clock = 100, requests = 0;
  const observer = createBusinessTerminalObserver({ now: () => clock });
  const starts = [{ runId: 'main', seq: 1, ts: 10 }];
  const request = async () => { requests++; return clock < 600000
    ? { runId: 'main', status: 'ok', startedAt: 10, endedAt: 90 }
    : { runId: 'main', status: 'timeout', timeoutPhase: 'queue', providerStarted: false }; };
  assert.equal(await observer.poll(request, 'main', starts, 'RUNNING'), null);
  const actual = await observer.poll(request, 'main', starts, 'REVIEWING');
  clock += 11 * 60000;
  assert.deepEqual(await observer.poll(request, 'main', starts, 'IDLE'), actual);
  assert.equal(requests, 1);
  assert.equal(businessCompleted(observer.terminal, 'main'), true);
  assert.equal(observer.drainEvents()[0].type, 'public-reply');
});

test('private activity does not invalidate a captured business terminal, but a correction does', async () => {
  const observer = createBusinessTerminalObserver();
  const first = [{ runId: 'main', seq: 1, ts: 10 }];
  await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 20 }), 'main', first, 'REVIEWING');
  const privateActivity = [...first, { runId: 'reviewer', seq: 2, ts: 30 }];
  assert.equal((await observer.poll(() => { throw Error('No new RPC needed'); }, 'main', privateActivity, 'REVIEWING')).status, 'ok');
  assert.equal(await observer.poll(async () => ({ runId: 'correction', status: 'ok' }), 'correction', privateActivity, 'RUNNING'), null);
  assert.equal(observer.terminal, null);
  assert(observer.drainEvents().some(event => event.type === 'invalidated' && event.reason === 'business-run-replaced'));
});

test('same-run retries invalidate old outcomes and reject terminals older than the latest model start', async () => {
  const observer = createBusinessTerminalObserver({ pollIntervalMs: 0 });
  let starts = [{ runId: 'main', seq: 1, ts: 10 }];
  await observer.poll(async () => ({ runId: 'main', status: 'error', endedAt: 20 }), 'main', starts, 'FINALIZING');
  starts = [...starts, { runId: 'main', seq: 2, ts: 30 }];
  await observer.poll(async () => ({}), 'main', starts, 'RUNNING');
  assert.equal(observer.terminal, null);
  assert.equal(await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 20 }), 'main', starts, 'REVIEWING'), null);
  assert.equal(businessCompleted(await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 40 }), 'main', starts, 'IDLE'), 'main'), true);
  assert(observer.drainEvents().some(event => event.type === 'stale-reply-rejected'));
});

test('timeouts, errors and cross-run replies are preserved honestly without a fabricated success', async () => {
  let clock = 0, calls = 0;
  const observer = createBusinessTerminalObserver({ now: () => clock, pollIntervalMs: 2000 });
  const request = async () => { calls++; return { runId: 'main', status: 'timeout', timeoutPhase: 'queue', providerStarted: false }; };
  assert.equal(await observer.poll(request, 'main', [], 'IDLE'), null);
  clock = 1000;
  await observer.poll(request, 'main', [], 'IDLE');
  assert.equal(calls, 1);
  clock = 2000;
  await observer.poll(async () => ({ runId: 'other', status: 'ok' }), 'main', [], 'IDLE');
  assert.equal(observer.terminal, null);
  const failed = await observer.poll(async () => ({ runId: 'main', status: 'error' }), 'main', [], 'IDLE', { force: true });
  assert.equal(businessCompleted(failed, 'main'), false);
  assert.equal(failed.status, 'error');
});

test('a business retry beginning during the public query rejects its old reply', async () => {
  const observer = createBusinessTerminalObserver({ pollIntervalMs: 0 });
  const starts = [{ runId: 'main', seq: 1, ts: 10 }];
  const old = await observer.poll(async () => {
    starts.push({ runId: 'main', seq: 2, ts: 30 });
    return { runId: 'main', status: 'ok', endedAt: 20 };
  }, 'main', () => starts, 'REVIEWING');
  assert.equal(old, null);
  assert.equal(observer.terminal, null);
  assert.equal(businessCompleted(await observer.poll(async () => ({ runId: 'main', status: 'ok', endedAt: 40 }),
    'main', () => starts, 'IDLE'), 'main'), true);
});
test('a confirmed outer success remains successful after prior diagnostic failures', async () => {
  const terminal = await readBusinessTerminal(async () => ({ runId: 'host', status: 'ok' }), 'host');
  assert.equal(businessCompleted(terminal, 'host'), true);
});
test('unknown, unavailable and cross-run terminals never establish completion', async () => {
  for (const response of [{ runId: 'host', status: 'timeout' }, { runId: 'other', status: 'ok' }, {}]) {
    const terminal = await readBusinessTerminal(async () => response, 'host');
    assert.equal(knownBusinessTerminal(terminal, 'host'), false);
    assert.equal(businessCompleted(terminal, 'host'), false);
  }
  assert.equal(businessCompleted(await readBusinessTerminal(async () => { throw new Error('Unavailable'); }, 'host'), 'host'), false);
});
test('memory runs in the same session cannot replace the authoritative business identity', () => {
  const tracker = createBusinessRunTracker('original', 'business');
  tracker.observe({ sessionId: 'business', runId: 'memory-flush', phase: 'FINALIZING' });
  assert.equal(tracker.runId, 'original');
  tracker.observe({ sessionId: 'reviewer', correctionRunId: 'foreign' });
  assert.equal(tracker.runId, 'original');
  tracker.observe({ sessionId: 'business', runId: 'original', correctionRunId: 'trusted-correction' });
  assert.equal(tracker.runId, 'trusted-correction');
  tracker.observe({ sessionId: 'business', phase: 'IDLE', correctionRunId: null });
  assert.equal(tracker.runId, 'trusted-correction', 'settlement must retain the actual correction identity');
});
