import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDecisionAttempt, decisionScope } from '../lib/runtime-v2/decision-scope.mjs';
import { ensureTask, findTask, taskDirectory, withTaskState, withTaskDecision, decisionGuard, appendTaskJournal } from '../lib/runtime-v2/task-store.mjs';
import { atomicWriteJson, readJson } from '../lib/runtime-v2/utils.mjs';

async function fixture(t) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-attempt-owner-')));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot, sessionId: 'owner-test' });
  return { projectRoot, taskId: task.taskId,
    state: () => findTask({ projectRoot, sessionId: 'owner-test' }),
    run: (calculate, context = {}) => withTaskDecision({ projectRoot, taskId: task.taskId,
      context: { assessmentId: 'owned-attempt', kind: 'hook', guard: decisionGuard(task), ...context } }, calculate) };
}

test('an owned child rejects parent candidate changes without overwriting the parent or its audit', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const attempt = createDecisionAttempt();
    await decisionScope.run(attempt.scope, () => withTaskState(f, state => { state.childOnly = true; }));
    await withTaskState(f, state => { state.parentOnly = true; });
    await appendTaskJournal(f.projectRoot, f.taskId, { type: 'PARENT_FACT' });
    assert.throws(() => attempt.accept(), { code: 'DECISION_ATTEMPT_CONFLICT' });
    assert.equal(attempt.status, 'CONFLICTED');
    assert.equal((await f.state()).parentOnly, true); assert.equal((await f.state()).childOnly, undefined);
    return { handled: true };
  });
  assert.equal((await f.state()).parentOnly, true);
  const journal = await fs.readFile(path.join(taskDirectory(f.projectRoot, f.taskId), 'journal/events.jsonl'), 'utf8');
  assert.equal(journal.split('\n').filter(line => line.includes('PARENT_FACT')).length, 1);
});

test('parent audit appends coexist with exactly one accepted child audit and independent candidate buffers', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const parent = decisionScope.getStore(), attempt = createDecisionAttempt();
    await decisionScope.run(attempt.scope, async () => {
      await withTaskState(f, state => { state.childOnly = true; });
      await appendTaskJournal(f.projectRoot, f.taskId, { type: 'CHILD_FACT' });
    });
    await appendTaskJournal(f.projectRoot, f.taskId, { type: 'PARENT_FACT' });
    attempt.accept();
    assert.equal(attempt.status, 'ACCEPTED'); assert.notEqual(parent.files, attempt.scope.files);
    assert.notEqual(parent.events, attempt.scope.events); assert.notEqual(parent.context, attempt.scope.context);
    attempt.scope.events[0].value.type = 'LATE_MUTATION';
    assert.equal(parent.events.find(event => event.value.type === 'CHILD_FACT').value.type, 'CHILD_FACT');
    return { handled: true };
  });
  assert.equal((await f.state()).childOnly, true);
  const rows = (await fs.readFile(path.join(taskDirectory(f.projectRoot, f.taskId), 'journal/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.type === 'PARENT_FACT').length, 1);
  assert.equal(rows.filter(row => row.type === 'CHILD_FACT').length, 1);
});

test('an accepted child cannot erase an original veto or replace its accepted validator later', async t => {
  const f = await fixture(t), checked = [];
  const result = await f.run(async () => {
    const parent = decisionScope.getStore(), attempt = createDecisionAttempt();
    attempt.scope.context.evidenceMatches = async () => { checked.push('child'); return true; };
    await decisionScope.run(attempt.scope, () => withTaskState(f, state => { state.unaccepted = true; }));
    attempt.accept(); attempt.scope.context.evidenceMatches = async () => true;
    assert.equal(await parent.context.evidenceMatches(), false); assert.deepEqual(checked, ['parent']);
    return { handled: true };
  }, { evidenceMatches: async () => { checked.push('parent'); return false; } });
  assert.equal(result.stale, true); assert.equal((await f.state()).unaccepted, undefined);
});

test('discard seals pending reads/writes and transfers its own facts once after parent growth', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const parent = decisionScope.getStore(), attempt = createDecisionAttempt();
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    const late = decisionScope.run(attempt.scope, async () => {
      await appendTaskJournal(f.projectRoot, f.taskId, { type: 'ACTUAL_CHILD_FAILURE' });
      await ready; await withTaskState(f, state => { state.lateWrite = true; });
    });
    for (let i = 0; i < 12; i++) await appendTaskJournal(f.projectRoot, f.taskId, { type: 'PARENT_FACT', i });
    attempt.discard(new Error('Transport failed.'));
    const facts = attempt.takeEvents(() => true); assert.equal(facts.length, 1); assert.deepEqual(attempt.takeEvents(() => true), []);
    for (const event of facts) await appendTaskJournal(f.projectRoot, f.taskId, event.value);
    const blocked = assert.rejects(late, { code: 'DECISION_ATTEMPT_CLOSED' }); release(); await blocked;
    await assert.rejects(decisionScope.run(attempt.scope, f.state), { code: 'DECISION_ATTEMPT_CLOSED' });
    assert.equal(parent.events.filter(event => event.value.type === 'PARENT_FACT').length, 12);
    return { handled: true };
  });
  assert.equal((await f.state()).lateWrite, undefined);
});

test('acceptance seals delayed writes before the parent itself publishes', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const attempt = createDecisionAttempt(); let release;
    const ready = new Promise(resolve => { release = resolve; });
    const late = decisionScope.run(attempt.scope, async () => {
      await ready; await atomicWriteJson(path.join(taskDirectory(f.projectRoot, f.taskId), 'late.json'), { forged: true });
    });
    await decisionScope.run(attempt.scope, () => withTaskState(f, state => { state.accepted = true; }));
    attempt.accept();
    const blocked = assert.rejects(late, { code: 'DECISION_ATTEMPT_CLOSED' }); release(); await blocked;
    return { handled: true };
  });
  assert.equal((await f.state()).accepted, true);
  assert.equal(await readJson(path.join(taskDirectory(f.projectRoot, f.taskId), 'late.json')), null);
});

test('cancellation and ancestor discard seal descendants without resetting the original deadline', async t => {
  const f = await fixture(t);
  await f.run(async () => {
    const controller = new AbortController(), attempt = createDecisionAttempt({ signal: controller.signal });
    const nested = decisionScope.run(attempt.scope, () => createDecisionAttempt());
    controller.abort(new Error('Cancelled owner.'));
    assert.equal(attempt.status, 'CANCELLED'); assert.equal(nested.status, 'DISCARDED');
    assert.throws(() => attempt.accept(), /Cancelled owner/u);
    await assert.rejects(decisionScope.run(nested.scope, () => withTaskState(f, state => { state.cancelled = true; })), { code: 'DECISION_ATTEMPT_CLOSED' });
    const now = Date.now, deadlineAt = now() + 1000, expired = createDecisionAttempt({ deadlineAt });
    try { Date.now = () => deadlineAt; assert.throws(() => expired.accept(), { code: 'REVIEWER_DEADLINE' }); }
    finally { Date.now = now; }
    assert.equal(expired.status, 'EXPIRED'); return { handled: true };
  });
  assert.equal((await f.state()).cancelled, undefined);
});

test('a distinct child signal cannot replace inherited parent cancellation or extend its deadline', async t => {
  const f = await fixture(t), parentSignal = new AbortController(), childSignal = new AbortController();
  await f.run(async () => {
    const attempt = createDecisionAttempt({ signal: childSignal.signal, deadlineAt: Date.now() + 100000 });
    parentSignal.abort(new Error('Parent cancelled independently.'));
    assert.equal(childSignal.signal.aborted, false); assert.equal(attempt.status, 'CANCELLED');
    await assert.rejects(decisionScope.run(attempt.scope, () => withTaskState(f, state => { state.escapedParent = true; })), { code: 'DECISION_ATTEMPT_CLOSED' });
    assert.throws(() => attempt.accept(), /Parent cancelled independently/u);
    return { handled: true };
  }, { abortSignal: parentSignal.signal });
  assert.equal((await f.state()).escapedParent, undefined);
  const other = await fixture(t), now = Date.now, deadlineAt = now() + 1000;
  await other.run(async () => {
    const attempt = createDecisionAttempt({ deadlineAt: deadlineAt + 100000 });
    try { Date.now = () => deadlineAt; assert.throws(() => attempt.accept(), { code: 'REVIEWER_DEADLINE' }); }
    finally { Date.now = now; }
    return { handled: true };
  }, { deadlineAt });
});

test('accepted ownership retains cancellation and deadline checks until actual parent publication', async t => {
  for (const change of ['cancel', 'deadline']) await t.test(change, async t => {
    const f = await fixture(t), controller = new AbortController(), now = Date.now, deadlineAt = now() + 100000;
    let result;
    try { result = await f.run(async () => {
      const parent = decisionScope.getStore(), attempt = createDecisionAttempt({ signal: controller.signal, deadlineAt });
      await decisionScope.run(attempt.scope, () => withTaskState(f, state => { state.acceptedTooLate = true; }));
      attempt.accept();
      if (change === 'cancel') controller.abort(new Error('Accepted owner cancelled before publication.'));
      else Date.now = () => deadlineAt;
      assert.equal(await parent.context.evidenceMatches(), false); await assert.rejects(parent.context.beforePublish());
      return { handled: true };
    }); } finally { Date.now = now; }
    assert.equal(result.stale, true); assert.equal((await f.state()).acceptedTooLate, undefined);
    assert.equal(result.evidenceFailure.code, change === 'deadline' ? 'REVIEWER_DEADLINE' : 'STOP_CANCELLED');
  });
});

test('plain context snapshots preserve prototypes and isolate child metadata', async t => {
  const f = await fixture(t), metadata = Object.assign(Object.create(null), { nested: { n: 1 }, sparse: new Array(2) });
  await f.run(async () => {
    const parent = decisionScope.getStore(), attempt = createDecisionAttempt();
    assert.equal(Object.getPrototypeOf(attempt.scope.context.metadata), null);
    assert.equal(attempt.scope.context.metadata.sparse.length, 2);
    assert.notEqual(attempt.scope.context.metadata.nested, parent.context.metadata.nested);
    attempt.scope.context.metadata.nested.n = 2; assert.equal(parent.context.metadata.nested.n, 1);
    attempt.scope.context.metadata.nested.n = 1; attempt.accept();
    attempt.scope.context.metadata.nested.n = 3; assert.equal(parent.context.metadata.nested.n, 1);
    return { handled: true };
  }, { metadata });
});
