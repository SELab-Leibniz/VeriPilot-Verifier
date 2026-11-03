import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createNativeStopFixture, deferred, until, within } from "./support/openclaw-native-stop-fixture.mjs";

const { lifecycle, findTask, withTaskState, taskDirectory } = createNativeStopFixture();

test('an UNKNOWN autopilot handoff conflict reports only the known retained RC owner', async t => {
  const f = await lifecycle(t, { waitMode: 'until_pass', postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  let activity = 'running';
  f.api.config.plugins = { entries: { autopilot: { enabled: true } } };
  const request = f.api.runtime.gateway.request;
  f.api.runtime.gateway.request = (method, ...args) => method === 'autopilot.status'
    ? { projection: activity === 'unknown' ? {} : { status: activity } } : request(method, ...args);
  await f.runtime.postRuns.candidate(f.post(), { runId: f.ctx.runId, text: 'Terminal-confirmed retained candidate.', reviewBudgetMs: 10000 });
  await f.runtime.postRuns.drain();
  const before = f.post();
  assert.equal(before.phase, 'COEXIST_WAIT'); assert(Number.isFinite(before.candidate.terminalConfirmedAt));
  assert.equal(before.candidate.terminalStatus, 'ok');
  let handoffs = 0;
  f.runtime.postRuns.externalStarted = async () => { handoffs++;
    throw Object.assign(new Error('Controlled owner conflict'), { code: 'CONFLICT' }); };
  activity = 'unknown';
  await f.runtime.prompt({ prompt: 'Trusted new native continuation.' }, { ...f.ctx, runId: 'unknown-conflicted-handoff' });
  assert.equal(handoffs, 1); assert.equal(f.state.coexistence.status, 'UNKNOWN');
  assert.match(f.state.coexistence.message, /旧 RC 运行尚未安全解除/u);
  assert.doesNotMatch(f.state.coexistence.message, /正在运行|已结束/u);
  const after = f.post();
  assert.equal(after.coexistence.status, 'UNKNOWN'); assert.equal(after.coexistence.message, f.state.coexistence.message);
  assert.equal(after.runId, before.runId); assert.equal(after.phase, before.phase);
  assert.deepEqual(after.candidate, before.candidate); assert.deepEqual(after.completedRuns, before.completedRuns);
  assert.equal(after.deadlineAt, before.deadlineAt);
});

const postRecord = runtime => runtime.postRuns.byId(runtime.postRuns.list().sessions.at(-1).id);
async function lateCandidate(t, { waitMode = 'until_pass', terminalStatus = 'ok', review, nextTerminal } = {}) {
  const terminal = deferred(t), reviewed = [], businessSends = [];
  let oldKnown = false, activity = 'running', f;
  f = await lifecycle(t, { waitMode, review: async input => {
    reviewed.push({ runId: f.post().runId, at: Date.now(), deadlineAt: f.post().deadlineAt, roleDeadlineAt: input.deadlineAt });
    return review?.(input);
  }, postRunTerminal: async (_identity, runId) => {
    if (runId === 'business-run') { await terminal.promise; return oldKnown ? { runId, status: terminalStatus } : null; }
    if (nextTerminal) await nextTerminal.promise;
    return { runId, status: 'ok' };
  } });
  f.api.config.plugins = { entries: { autopilot: { enabled: true } } };
  const request = f.api.runtime.gateway.request;
  f.api.runtime.gateway.request = (method, ...args) => {
    if (method === 'chat.send') businessSends.push(args[0]);
    return method === 'autopilot.status' ? { projection: activity === 'unknown' ? {} : { status: activity } } : request(method, ...args);
  };
  await f.runtime.postRuns.candidate({ agentId: 'main', sessionId: f.ctx.sessionId, sessionKey: f.ctx.sessionKey,
    projectRoot: f.root, scopeFingerprint: f.state.projectScope.fingerprint, scopeTaskId: f.state.scopeTaskId,
    controlRevision: f.state.enabledRevision }, { runId: f.ctx.runId, text: 'Earlier candidate.', reviewBudgetMs: 10000 });
  await until(() => f.post()?.phase === 'FINALIZING', 'old unresolved terminal');
  const next = { ...f.ctx, runId: `early-autopilot-final-${waitMode}` };
  await f.runtime.prompt({ prompt: 'Latest host continuation.' }, next);
  await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'new-delivery', params: { path: 'draft.md' } }, next);
  await fs.writeFile(path.join(f.root, 'draft.md'), 'Current independently verified delivery.\n');
  await f.runtime.toolResult({ toolName: 'write', toolCallId: 'new-delivery', args: { path: 'draft.md' },
    result: { content: [{ type: 'text', text: 'draft.md written' }] } }, next);
  await f.runtime.beforeFinalize({ sessionId: next.sessionId, lastAssistantMessage: 'Latest final candidate.' }, next);
  await f.runtime.agentEnd({ runId: next.runId, success: true,
    messages: [{ role: 'assistant', content: 'Latest final candidate.' }] }, next);
  const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.equal(f.post().runId, f.ctx.runId); assert.equal(f.post().phase, 'FINALIZING');
  assert.equal(task.stop.postRunCandidate.runId, next.runId); assert.equal(task.stop.postRunCandidate.text, 'Latest final candidate.');
  assert.equal(task.verification.status, 'UNVERIFIED'); assert.equal(task.verification.reasonCode, 'POST_RUN_CANDIDATE_OWNER_CONFLICT');
  return Object.assign(f, { next, reviewed, businessSends, checkpoint: structuredClone(task.stop.postRunCandidate),
    setActivity: value => { activity = value; }, releaseOld: (known = true) => { oldKnown = known; terminal.resolve(); },
    recheck: async () => { const record = f.post(); await f.runtime.postRuns.recheck(record, { actor: 'fixture-owner', runId: record.runId, version: record.version }); },
    recover: async () => { await f.runtime.postRuns.dispose(); f.runtime = f.restart();
      f.post = () => postRecord(f.runtime); await f.runtime.postRunReady; return f.runtime; } });
}

test('a late old terminal promotes the completed new native candidate once with its full independent review budget', async t => {
  for (const waitMode of ['assessment', 'until_pass']) for (const terminalStatus of ['ok', 'error']) await t.test(`${waitMode}/${terminalStatus}`, async t => {
    const f = await lateCandidate(t, { waitMode, terminalStatus });
    const controller = f.state.reviewController;
    f.releaseOld(); await f.runtime.postRuns.drain();
    assert.equal(f.post().runId, f.next.runId); assert.equal(f.post().phase, 'COEXIST_WAIT');
    assert.equal(f.post().candidate.text, f.checkpoint.text); assert.equal(f.post().deadlineAt, null);
    let task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
    assert.equal(task.stop.postRunCandidate.status, 'ADOPTED');
    assert.match(task.stop.postRunCandidate.adoption.checkpointDigest, /^[a-f0-9]{64}$/u);
    assert.equal(f.state.reviewController, controller); assert.equal(controller.signal.aborted, false);
    assert.equal(f.reviewed.length, 0);
    f.setActivity('done'); await f.recheck(); await within(f.runtime.waitForNativeReviews(), 'promoted native review');
    assert.deepEqual(f.reviewed.map(item => item.runId), [f.next.runId]);
    assert(f.reviewed[0].deadlineAt - f.reviewed[0].at >= f.checkpoint.reviewBudgetMs - 1000);
    task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
    assert(task.verification.assessmentId.startsWith(`${f.next.runId}:stop`)); assert.equal(task.verification.status, 'PASS');
    assert.equal(f.post().phase, 'IDLE');
    await f.runtime.beforeFinalize({ sessionId: f.next.sessionId, lastAssistantMessage: 'Latest final candidate.' }, f.next);
    await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
    await f.runtime.postRuns.drain(); assert.equal(f.reviewed.length, 1);
    assert.deepEqual(f.businessSends, [], 'promotion must review the completed native run without resending business work');
    const journal = (await fs.readFile(path.join(taskDirectory(f.root, task.taskId), 'journal/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.filter(entry => entry.type === 'POST_RUN_CANDIDATE_ADOPTED' && entry.runId === f.next.runId).length, 1);
  });
});

test('a newer completed candidate arriving while the prior review waits resumes through safe IDLE before any business replay', async t => {
  let reviews = 0;
  const f = await lifecycle(t, { waitMode: 'until_pass', postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }),
    review: () => { reviews++; } });
  const finish = deferred(t), entered = deferred(t), oldController = f.state.reviewController;
  f.state.hotReviewWork = { controller: oldController, promise: { then(resolve, reject) {
    entered.resolve(); return finish.promise.then(resolve, reject);
  } } };
  await f.runtime.postRuns.candidate(f.post(), { runId: f.ctx.runId, text: 'Earlier candidate.', reviewBudgetMs: 10000 });
  await until(() => f.post().phase === 'REVIEWING', 'old review waits for original background work');
  await within(entered.promise, 'old review entered its background wait');
  let activity = 'running';
  f.api.config.plugins = { entries: { autopilot: { enabled: true } } };
  const request = f.api.runtime.gateway.request;
  f.api.runtime.gateway.request = (method, ...args) => method === 'autopilot.status' ? { projection: { status: activity } } : request(method, ...args);
  const next = { ...f.ctx, runId: 'completed-during-prior-review' };
  await f.runtime.prompt({ prompt: 'Latest host continuation.' }, next);
  await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'latest-write', params: { path: 'draft.md' } }, next);
  await fs.writeFile(path.join(f.root, 'draft.md'), 'Verified current delivered source.\n');
  await f.runtime.beforeFinalize({ sessionId: next.sessionId, lastAssistantMessage: 'Latest candidate completed.' }, next);
  await f.runtime.agentEnd({ runId: next.runId, success: true, messages: [{ role: 'assistant', content: 'Latest candidate completed.' }] }, next);
  const saved = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.equal(saved.stop.postRunCandidate.runId, next.runId); assert.equal(f.post().runId, f.ctx.runId);
  finish.resolve(); await f.runtime.postRuns.drain();
  assert.equal(f.post().runId, next.runId); assert.equal(f.post().phase, 'COEXIST_WAIT'); assert.equal(reviews, 0);
  assert.equal(f.state.nativeRunId, next.runId); assert.equal(f.state.reviewController.signal.aborted, false);
  activity = 'done'; const record = f.post();
  await f.runtime.postRuns.recheck(record, { actor: 'fixture-owner', runId: record.runId, version: record.version });
  await within(f.runtime.waitForNativeReviews(), 'safe IDLE promoted review');
  assert.equal(reviews, 1); assert.equal(f.post().reviewStatus, 'PASS');
  const final = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert(final.verification.assessmentId.startsWith(`${next.runId}:stop`));
});

test('an UNKNOWN old native terminal never promotes or replays a completed newer candidate across recheck and restart', async t => {
  for (const terminalStatus of ['ok', 'error']) await t.test(terminalStatus, async t => {
    const f = await lateCandidate(t, { terminalStatus }); f.releaseOld(false); await f.runtime.postRuns.drain();
    assert.equal(f.post().runId, f.ctx.runId); assert.equal(f.post().reconciliation.status, 'UNKNOWN');
    await f.recheck(); await f.recover(); await f.runtime.postRuns.drain();
    assert.equal(f.post().runId, f.ctx.runId); assert.equal(f.post().reconciliation.status, 'UNKNOWN');
    assert.equal(f.reviewed.length, 0);
    assert.deepEqual(f.businessSends, []);
    const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
    assert.equal(task.stop.postRunCandidate.status, 'UNVERIFIED'); assert.equal(task.stop.postRunCandidate.runId, f.next.runId);
    // Only a later trustworthy terminal may release the old reservation.
    f.releaseOld(); await f.recheck(); await f.runtime.postRuns.drain();
    assert.equal(f.post().runId, f.next.runId); assert.equal(f.post().promotion.terminalStatus, terminalStatus);
    assert.equal(f.post().phase, 'COEXIST_WAIT'); assert.equal(f.reviewed.length, 0);
    f.setActivity('done'); await f.recheck(); await within(f.runtime.waitForNativeReviews(), 'reconciled successor review');
    assert.deepEqual(f.reviewed.map(item => item.runId), [f.next.runId]); assert.equal(f.post().reviewStatus, 'PASS');
  });
});

test('restart restores an explicitly reconstructed successor even when its promotion ACK was lost', async t => {
  const nextTerminal = deferred(t), f = await lateCandidate(t, { nextTerminal });
  f.releaseOld(); await until(() => f.post().runId === f.next.runId, 'durable successor adoption');
  await f.runtime.postRuns.dispose();
  const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  // Reproduce a process ending after atomic promotion but before task ACK.
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { state.stop.postRunCandidate = structuredClone(f.checkpoint); });
  f.setActivity('done'); await f.recover(); nextTerminal.resolve();
  await within(f.runtime.waitForNativeReviews(), 'restored promoted review');
  const saved = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.equal(saved.stop.postRunCandidate.status, 'ADOPTED');
  assert.equal(saved.stop.postRunCandidate.adoption.adoptedVersion, f.post().promotion.adoptedVersion);
  assert(saved.verification.assessmentId.startsWith(`${f.next.runId}:stop`)); assert.equal(saved.verification.status, 'PASS');
  assert.deepEqual(f.reviewed.map(item => item.runId), [f.next.runId]);
  await f.recover(); await f.runtime.postRuns.drain(); assert.equal(f.reviewed.length, 1);
  assert.deepEqual(f.businessSends, []);
});

test('cancelling the owning scheduler never revives its saved newer candidate from a late terminal or restart', async t => {
  for (const operation of ['reset', 'confirmCancel']) await t.test(operation, async t => {
    const f = await lateCandidate(t), old = f.post();
    if (operation === 'reset') await f.runtime.reset({ sessionId: f.next.sessionId }, f.next);
    else {
      const cancelled = f.runtime.postRuns.confirmCancel(old, { actor: 'fixture-owner', runId: old.runId, version: old.version });
      await until(() => f.post().phase === 'RELEASING', 'cancellation begins'); f.releaseOld(); await cancelled;
    }
    f.releaseOld(); await f.runtime.postRuns.drain(); await f.recover(); await f.runtime.postRuns.drain();
    assert.equal(f.reviewed.length, 0);
    assert.deepEqual(f.businessSends, []);
    assert(f.post().phase === 'CLOSED' || f.post().successorAdmissionClosed);
    const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
    assert.equal(task.stop.postRunCandidate.status, 'UNVERIFIED'); assert.notEqual(task.verification.status, 'PASS');
  });
});
