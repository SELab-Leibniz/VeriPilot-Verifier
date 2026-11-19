import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { skillGraphQuoteCandidate as skillGraphCandidate } from './helpers/skill-source-interpretation.mjs';
import { applyGroundTruthDelta } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { taskDirectory, withTaskState, withTaskDecision, decisionGuard, appendTaskJournal } from '../lib/runtime-v2/task-store.mjs';
import { outsideDecision, decisionScope } from '../lib/runtime-v2/decision-scope.mjs';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { sharedBasisFixture as fixture, user, operation } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { semanticReviewClock } from './helpers/semantic-review-clock.mjs';

test('graph-only extraction keeps the existing native Skill-care role/tools and cannot issue global proof', async t => {
  const f = await fixture(t); await f.select(); const call = f.graphs()[0], captures = [];
  const graph = skillGraphCandidate(await scanSkillDirectory(path.dirname(f.skillFile)));
  const native = createOpenClawReviewerFactory(f.api, { runEmbeddedAgent: async params => {
    captures.push(params); return { payloads: [{ text: JSON.stringify({ summary: 'Native graph role route.', skillGroundTruth: graph }) }], meta: {} };
  } });
  const handle = await native({ projectRoot: f.root, sessionCwd: f.root, taskId: (await f.task()).taskId,
    parentSessionId: 'basis-session', role: 'ground-truth-extractor', reviewer: { model: 'fixture/model', timeoutMs: 20000 },
    schema: call.schema, request: call.request,
    evidence: { groundTruth: await f.truth(), snapshot: { entries: [user()] }, skillSource: await scanSkillDirectory(path.dirname(f.skillFile)) } });
  try {
    assert.deepEqual(handle.result.skillGroundTruth, graph); assert.equal(handle.baselineTask, undefined);
    assert.equal(captures.length, 1); assert(captures[0].toolsAllow.includes('rc_skill_care'));
    assert(!captures[0].toolsAllow.includes('finish_baseline'));
  } finally { await handle.close(); }
});

test('a real user revision stages the new baseline before local graph extraction and commits their matching basis together', async t => {
  // This case checks staged publication; filesystem latency is not review time.
  semanticReviewClock(t, { timeoutMs: 20000 });
  const f = await fixture(t); f.state.useNativeGraph = true; await f.select(); const first = await f.truth();
  const revised = user('U2'); revised.message.content = 'Preserve the revised requested feature.';
  await fs.appendFile(f.transcript, JSON.stringify(revised) + '\n');
  f.state.forceOperations = true; f.state.deltaOperation = { ...operation('transcript:U2#L1-L1'), text: revised.message.content };
  const task = await f.task();
  const originalWatcher = Object.values(task.watchers)[0], originalGuard = decisionGuard(task);
  const result = await withTaskDecision({ projectRoot: f.root, taskId: task.taskId,
    context: { assessmentId: 'revision-head', kind: 'hook', guard: originalGuard } }, async () => {
      const parent = decisionScope.getStore(), selected = await f.select();
      const staged = await f.task(), current = staged.watchers[originalWatcher.watcherId];
      assert.equal(decisionScope.getStore(), parent); assert.deepEqual(parent.context.guard, originalGuard);
      assert(staged.groundTruth.version > first.version);
      assert.equal((await outsideDecision(f.truth)).digest, first.digest, 'The physical parent still has its original complete guard');
      assert.equal(current.status, 'ACTIVE'); assert.equal(current.maxTurn, originalWatcher.maxTurn);
      assert(originalWatcher.invocationIds.every(id => current.invocationIds.includes(id)));
      assert(current.invocationIds.length > originalWatcher.invocationIds.length, 'The real revised selection is retained in the same identity');
      assert.equal(current.pendingSelection, undefined);
      return selected;
    });
  assert.equal(result.watcher.status, 'ACTIVE');
  const current = await f.truth(), request = f.graphs().at(-1).request;
  assert(current.version > first.version); assert.notEqual(current.digest, first.digest);
  assert.equal(request.currentGroundTruth.version, current.version); assert.equal(request.currentGroundTruth.digest, current.digest);
  const observed = f.state.graphInputs.at(-1); assert.equal(observed.committed.digest, first.digest);
  for (const input of [observed.supplied, observed.frozen, observed.staged]) assert.equal(input.digest, current.digest);
  assert.equal((await f.task()).groundTruth.sharedBasis.baselineDigest, current.digest);
});

test('legacy already-PASS Skill adoption is recovered before the first shared certificate', async t => {
  const f = await fixture(t); await f.select();
  await withTaskState({ projectRoot: f.root, taskId: (await f.task()).taskId }, state => {
    delete state.groundTruth.sharedBasis;
    for (const watcher of Object.values(state.watchers)) watcher.status = 'PASS';
  });
  await f.refresh();
  const certificate = (await f.task()).groundTruth.sharedBasis;
  assert.deepEqual(certificate.adoptedSkills.map(skill => skill.skillId), ['demo']);
  assert(certificate.sources.some(source => source.ref === f.skillFile));
  await fs.rm(path.dirname(f.skillFile), { recursive: true });
  await withTaskState({ projectRoot: f.root, taskId: (await f.task()).taskId }, state => { delete state.groundTruth.sharedBasis; });
  const count = f.globals().length; await assert.rejects(f.refresh(), /baseline extraction failed/u);
  assert.equal(f.globals().length, count); assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

test('an in-progress staged certificate is reusable only after its task head commits', async t => {
  const f = await fixture(t); await f.select();
  const task = await f.task();
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { delete state.groundTruth.sharedBasis; });
  const before = f.globals().length;
  await withTaskDecision({ projectRoot: f.root, taskId: task.taskId,
    context: { assessmentId: 'uncommitted-proof', kind: 'hook', guard: decisionGuard(await f.task()) } }, async () => {
    assert.equal((await f.select()).watcher.status, 'ACTIVE');
    assert((await f.task()).groundTruth.sharedBasis);
    assert.equal((await outsideDecision(f.task)).groundTruth.sharedBasis, undefined);
    assert.equal((await f.select()).watcher.status, 'ACTIVE');
    assert.equal(f.globals().length, before + 2, 'an unpublished proof cannot supply a cache hit');
    return { handled: true };
  });
  assert((await f.task()).groundTruth.sharedBasis);
  await f.select(); assert.equal(f.globals().length, before + 2, 'the same proof is reused after atomic publication');
});

test('new real user identity, material bytes, PROJECT_FILE appearance and adopted Skill changes cause real bounded misses', async t => {
  const f = await fixture(t); await f.select(); let count = f.globals().length;
  await fs.appendFile(f.transcript, JSON.stringify(user('U2')) + '\n'); await f.refresh(); assert.equal(f.globals().length, ++count);
  await fs.writeFile(f.material, 'Changed original material.'); await f.refresh(); assert.equal(f.globals().length, ++count);
  await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'Original project obligation.'); await f.refresh(); assert.equal(f.globals().length, ++count);
  await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'Changed project obligation.'); await f.refresh(); assert.equal(f.globals().length, ++count);
  await fs.writeFile(f.skillFile, '# Demo\nVerify before completion, including errors.\n'); await f.refresh(); assert.equal(f.globals().length, ++count);
  const cert = (await f.task()).groundTruth.sharedBasis;
  assert(cert.sources.some(source => source.ref === f.skillFile));
  await fs.rm(f.skillFile); await assert.rejects(f.refresh(), /baseline extraction failed/u);
  assert.equal(f.globals().length, count, 'cannot drop unavailable adopted authority and certify a subset');
  assert.equal((await f.task()).groundTruth.sharedBasis.proof.requestId, cert.proof.requestId);
});

test('non-Stop graph failure rejects the global delta/certificate and graph together, then retries honestly', async t => {
  const f = await fixture(t); f.state.graphError = { summary: 'Wrong role.', skillGroundTruth: { constraints: [], taskOverlays: [] }, operations: [operation()] };
  const rejected = await f.select(); assert.equal(rejected.reason, 'SKILL_WATCH_NOT_ESTABLISHED');
  assert.equal((await f.truth()).version, 0); assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
  const pending = Object.values((await f.task()).watchers);
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'UNVERIFIED_RECOVERY');
  assert(pending[0].pendingSelection); assert.equal(pending[0].sourceInterpretationChecked, false);
  assert.equal(await readJson(await f.graphFile()), null);
  f.state.graphError = null; assert.equal((await f.select()).watcher.status, 'ACTIVE');
  assert.equal(f.globals().length, 2); assert.equal((await f.truth()).version, 1);
  assert.deepEqual(Object.keys((await f.task()).watchers), [pending[0].watcherId], 'Successful establishment transitions the same pending selection');
});

test('semantic shared-basis publication still rejects exact expiry and changed original bytes', async t => {
  for (const condition of ['deadline', 'source']) await t.test(condition, async t => {
    const clock = semanticReviewClock(t, { timeoutMs: 20000 });
    const f = await fixture(t); f.state.useNativeGraph = true; await f.select(); const first = await f.truth();
    const revised = user('U2'); revised.message.content = 'Preserve the revised requested feature.';
    await fs.appendFile(f.transcript, JSON.stringify(revised) + '\n');
    f.state.forceOperations = true;
    f.state.deltaOperation = { ...operation('transcript:U2#L1-L1'), text: revised.message.content };
    const task = await f.task();
    const result = await withTaskDecision({ projectRoot: f.root, taskId: task.taskId,
      context: { assessmentId: `rejected-${condition}`, kind: 'hook', guard: decisionGuard(task) } }, async () => {
      const selected = await f.select();
      assert.equal(selected.watcher.status, 'ACTIVE');
      assert((await f.truth()).version > first.version, 'the candidate was actually staged');
      if (condition === 'deadline') {
        clock.advance(19999);
        const parent = decisionScope.getStore();
        assert.equal(await outsideDecision(() => parent.context.evidenceMatches()), true);
        clock.advance(1);
      } else await fs.writeFile(f.material, 'Changed original material.');
      return selected;
    });
    assert.equal(result.stale, true);
    assert.equal(result.status, 'UNVERIFIED');
    assert.equal(result.reason, 'evidenceChanged');
    assert.equal(result.evidenceFailure.code, condition === 'deadline' ? 'REVIEWER_DEADLINE' : 'BASELINE_INPUT_CHANGED');
    assert.equal((await f.truth()).digest, first.digest, 'rejected staged truth must not publish');
  });
});
