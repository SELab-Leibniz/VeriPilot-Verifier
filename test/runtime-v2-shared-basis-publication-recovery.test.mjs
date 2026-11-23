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

test('actual Stop cannot PASS after an ACTIVE cache-hit graph failure, and the next Stop can recover', async t => {
  for (const outer of [false, true]) await t.test(outer ? 'enclosing atomic assessment' : 'standalone Stop', async t => {
    const f = await fixture(t); f.state.useNativeGraph = true;
    const selected = await f.select(), original = await f.task();
    const proof = original?.groundTruth?.sharedBasis?.proof?.requestId;
    if (selected?.watcher?.status !== 'ACTIVE' || typeof proof !== 'string' || !proof) {
      const diagnostic = { fixturePhase: 'INITIAL_SHARED_BASIS_SELECTION', outer,
        selection: { handled: selected?.handled, taskId: selected?.taskId, reason: selected?.reason,
          reasonCode: selected?.reasonCode, watcherStatus: selected?.watcher?.status }, journalErrors: [] };
      let handle;
      try {
        assert.equal(selected?.taskId, original?.taskId, 'Read diagnostics only from this selected task.');
        const journal = path.join(taskDirectory(f.root, original.taskId), 'journal/events.jsonl');
        assert.equal(await fs.realpath(journal), journal);
        handle = await fs.open(journal, 'r'); const info = await handle.stat(); assert(info.isFile());
        const length = Math.min(info.size, 65536), bytes = Buffer.alloc(length);
        const { bytesRead } = await handle.read(bytes, 0, length, Math.max(0, info.size - length));
        diagnostic.journalBytesRead = bytesRead;
        diagnostic.journalErrors = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/u)
          .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
          .filter(row => ['GROUND_TRUTH_REFRESH_FAILED', 'SKILL_WATCH_NOT_ESTABLISHED'].includes(row.type))
          .slice(-8).map(row => ({ type: row.type,
            hookEventId: String(row.hookEventId ?? '').slice(0, 160),
            reason: String(row.error ?? row.reason ?? '').slice(0, 400) }));
      } catch (error) { diagnostic.journalReadError = String(error.message).slice(0, 160); }
      finally { await handle?.close().catch(error => { diagnostic.journalReadError = String(error.message).slice(0, 160); }); }
      t.diagnostic(JSON.stringify(diagnostic));
    }
    assert.equal(selected?.watcher?.status, 'ACTIVE', 'Initial Skill selection must establish its real current watcher: ' + JSON.stringify(selected));
    assert(typeof proof === 'string' && proof, 'Initial selection must publish its real shared-basis proof before the Stop case.');
    await fs.rm(await f.graphFile());
    f.state.graphError = { summary: 'Invalid graph role.', skillGroundTruth: { constraints: [], taskOverlays: [] }, operations: [operation()] };
    const options = id => outer ? { assessmentContext: { assessmentId: id, guard: decisionGuard(original),
      deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs } } : {};
    const failed = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' }, options('graph-failure'));
    assert.equal(failed.stop?.status ?? failed.status, 'UNVERIFIED');
    let task = await f.task(); assert.notEqual(task.verification?.status, 'PASS');
    assert.equal(task.groundTruth.sharedBasis.proof.requestId, proof); assert.equal(f.globals().length, 1);
    assert.equal(await readJson(await f.graphFile()), null);
    assert(!Object.values(task.watchers).some(watcher => watcher.status === 'PASS'));
    f.state.graphError = null;
    // UNVERIFIED terminates its correction flow under the existing host
    // contract. A genuine follow-up human turn opens the next normal flow.
    await fs.appendFile(f.transcript, JSON.stringify(user('U-retry')) + '\n');
    const recovered = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' }, outer ? {
      assessmentContext: { assessmentId: 'graph-recovered', guard: decisionGuard(task),
        deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs } } : {});
    assert.equal(recovered.stop?.status, 'NO_DEVIATION_FOUND', JSON.stringify(recovered)); task = await f.task();
    assert.equal(task.verification.status, 'NO_DEVIATION_FOUND'); assert(await readJson(await f.graphFile()));
    assert(Object.values(task.watchers).every(watcher => watcher.status === 'PASS'));
    assert.notEqual(task.groundTruth.sharedBasis.proof.requestId, proof); assert(f.globals().length >= 2);
  });
});

test('actual Stop restores adopted completed Skill graphs and never accepts their missing denominator on failure', async t => {
  for (const damage of ['missing', 'corrupt', 'corrupt-no-history', 'stale', 'reconstruction-failed']) await t.test(damage, async t => {
    const f = await fixture(t); f.state.useNativeGraph = true; await f.select(); const original = await f.task();
    await withTaskState({ projectRoot: f.root, taskId: original.taskId }, state => {
      for (const watcher of Object.values(state.watchers)) watcher.status = 'PASS';
    });
    const file = await f.graphFile();
    const beforeGraph = await readJson(file);
    if (damage.startsWith('corrupt')) await fs.writeFile(file, '{invalid');
    else if (damage === 'stale') await fs.writeFile(file, JSON.stringify({ ...await readJson(file), skillDigest: 'stale' }));
    else await fs.rm(file);
    if (damage === 'corrupt-no-history') await fs.rm(path.join(path.dirname(file), 'history.jsonl'));
    if (damage === 'reconstruction-failed') f.state.graphError = { summary: 'Wrong role.', operations: [], skillGroundTruth: { constraints: [], taskOverlays: [] } };
    let result = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' });
    if (damage === 'corrupt-no-history') {
      assert.equal(result.stop.status, 'UNVERIFIED'); assert.equal((await f.task()).verification.status, 'UNVERIFIED');
      assert.equal(await fs.readFile(file, 'utf8'), '{invalid', 'unverifiable metadata remains untouched');
      assert(result.stop.error.includes(sha256('{invalid'))); assert.equal(f.globals().length, 1);
      return;
    }
    if (damage === 'reconstruction-failed') {
      assert.equal(result.stop.status, 'UNVERIFIED'); assert.equal((await f.task()).verification.status, 'UNVERIFIED');
      assert.equal(await readJson(file), null); f.state.graphError = null;
      await fs.appendFile(f.transcript, JSON.stringify(user('U-retry')) + '\n');
      result = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' });
    }
    assert.equal(result.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(result));
    const graph = await readJson(file); assert(graph.constraints.length > 0);
    if (damage === 'corrupt') {
      assert.equal(graph.version, beforeGraph.version + 1, 'history-backed counter continuity, never a guessed previous version');
      const journal = await fs.readFile(path.join(taskDirectory(f.root, original.taskId), 'journal/events.jsonl'), 'utf8');
      assert.match(journal, /SKILL_GROUND_TRUTH_CACHE_RECOVERED/u); assert(journal.includes(sha256('{invalid')));
    }
    const review = f.calls.filter(call => call.role === 'stop-reviewer').at(-1);
    assert(review.request.population.metrics.M08.length > 0, 'adopted Skill cannot disappear as an empty M08 denominator');
    if (damage === 'reconstruction-failed') {
      assert.notEqual((await f.task()).groundTruth.sharedBasis.proof.requestId, original.groundTruth.sharedBasis.proof.requestId);
      assert.equal(f.globals().length, 2, 'the follow-up human turn correctly establishes a new original basis');
    } else {
      assert.equal((await f.task()).groundTruth.sharedBasis.proof.requestId, original.groundTruth.sharedBasis.proof.requestId);
      assert.equal(f.globals().length, 1, 'derived graph recovery does not invent a new global extraction');
    }
    assert.deepEqual(Object.keys((await f.task()).watchers), Object.keys(original.watchers), 'recheck the same watcher, never silently create a new invocation');
    assert(f.calls.some(call => call.role === 'skill-reviewer'), 'a restored graph must receive current semantic checking even when the old watcher claimed PASS');
  });
});

test('generic JSON success never issues shared coverage or silently replaces a failed actual bounded worker', async t => {
  const f = await fixture(t, { generic: true }); await f.select();
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
  await f.refresh(); assert.equal(f.globals().length, 2);
  const actual = await fixture(t); actual.state.afterBaseline = async () => { throw Object.assign(new Error('Actual bounded failure.'), { code: 'BASELINE_INPUT_CHANGED' }); };
  assert.equal((await actual.select()).reason, 'SKILL_WATCH_NOT_ESTABLISHED');
  assert.equal(actual.globals().length, 1); assert.equal(actual.graphs().length, 0);
  assert.equal((await actual.task()).groundTruth.sharedBasis, undefined); assert.equal((await actual.truth()).version, 0);
});

test('a same-scope legacy marker cannot bypass a strict factory after backend, baseline or pending-input changes', async t => {
  for (const change of ['backend', 'baseline', 'pending-requirement']) await t.test(change, async t => {
    const f = await fixture(t, { generic: true }); await f.select(); const task = await f.task();
    assert(Object.keys(task.groundTruth.sourceCursors).some(key => key.startsWith('legacy:')));
    assert.equal(task.groundTruth.sharedBasis, undefined);
    if (change === 'baseline') await applyGroundTruthDelta({ projectRoot: f.root, taskId: task.taskId,
      delta: { summary: 'Changed accepted ledger.', taskClassification: 'CONTINUATION', operations: [{ ...operation(), text: 'Another accepted obligation.' }] } });
    if (change === 'pending-requirement') await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => {
      state.control.pendingRequirement = { revision: 1, status: 'PENDING' };
    });
    const calls = [], strict = async options => { calls.push(options); throw new Error('Actual strict extraction cannot complete.'); };
    const result = await f.invoke('PreToolUse', { tool_name: 'Skill', tool_use_id: 'strict-same-skill', tool_input: { skill: 'demo' } }, { reviewerFactory: strict });
    assert.equal(result.reason, 'SKILL_WATCH_NOT_ESTABLISHED');
    if (change !== 'pending-requirement') { assert.equal(calls.length, 1); assert.equal(calls[0].request.reviewScope?.boundedBasis, true, 'legacy markers cannot replace strict global alignment'); }
    assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
  });
});

test('genuine fully read but quarantined NEW_TASK operations cannot certify the old ledger; checked NO_CHANGE can', async t => {
  const f = await fixture(t); await f.select();
  await withTaskState({ projectRoot: f.root, taskId: (await f.task()).taskId }, state => { delete state.groundTruth.sharedBasis; });
  const original = await f.truth(); f.state.forceOperations = true; f.state.classification = 'NEW_TASK';
  const cursors = structuredClone((await f.task()).groundTruth.sourceCursors);
  await assert.rejects(f.refresh(), /baseline extraction failed/); assert.equal((await f.truth()).digest, original.digest);
  assert.deepEqual((await f.task()).groundTruth.sourceCursors, cursors);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
  f.state.forceOperations = false; f.state.classification = null; await f.refresh();
  assert.equal((await f.task()).groundTruth.sharedBasis.baselineDigest, original.digest);
});

