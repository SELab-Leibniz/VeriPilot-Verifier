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

test('miss and cache-hit publication preserve source, cancellation, deadline, baseline and revision guards', async t => {
  for (const hit of [false, true]) for (const race of ['material', 'user', 'cancel', 'deadline', 'baseline', 'revision'])
    await t.test(`${hit ? 'hit' : 'miss'} ${race}`, async t => {
      const f = await fixture(t, { wireMode: 'draft' }), controller = new AbortController();
      f.state.sourceFrom = true; f.state.draftActual = true;
      if (hit) { await f.select(); await fs.rm(await f.graphFile()); }
      const originalTask = await f.task(), originalTruth = originalTask ? await f.truth() : { version: 0 };
      const originalProof = originalTask?.groundTruth.sharedBasis?.proof.requestId;
      const originalCertificate = originalTask?.groundTruth.sharedBasis?.acceptedSourceCertificate;
      const now = Date.now;
      f.factory.reviewAbortSignal = controller.signal; f.factory.reviewDeadlineAt = now() + 10000;
      f.state.beforeGraph = async () => {
        if (race === 'material') await fs.writeFile(f.material, 'Original changed during alignment.');
        if (race === 'user') await fs.appendFile(f.transcript, JSON.stringify(user('U-after-lookup')) + '\n');
        if (race === 'cancel') controller.abort(new Error('Cancelled before publication.'));
        if (race === 'deadline') Date.now = () => now() + 30000;
        if (race === 'revision') await outsideDecision(() => withTaskState({ projectRoot: f.root, taskId: f.calls.at(-1).request.taskId }, state => { state.concurrentWriter = true; }));
        if (race === 'baseline') await outsideDecision(async () => applyGroundTruthDelta({ projectRoot: f.root,
          taskId: f.calls.at(-1).request.taskId, delta: { summary: 'Actual competing ledger write.', taskClassification: 'CONTINUATION',
            operations: [{ ...operation(), text: 'Another accepted baseline obligation.' }] } }));
      };
      let outcome; try { outcome = await f.select(); } finally { Date.now = now; }
      assert.equal(outcome.reason, 'SKILL_WATCH_NOT_ESTABLISHED');
      const task = await f.task(); assert.equal(task.groundTruth.sharedBasis?.proof.requestId, originalProof);
      assert.deepEqual(task.groundTruth.sharedBasis?.acceptedSourceCertificate, originalCertificate, 'Stale/cancelled decisions cannot publish a new source-retention certificate');
      assert.equal(await readJson(await f.graphFile()), null, 'unpublished graph must not survive stale publication');
      if (race !== 'baseline') assert.equal((await f.truth()).version, originalTruth.version);
      if (!hit) {
        const pending = Object.values(task.watchers);
        assert.equal(pending.length, 1); assert.equal(pending[0].skillId, 'demo');
        assert.equal(pending[0].status, 'UNVERIFIED_RECOVERY'); assert.equal(pending[0].sourceInterpretationChecked, false);
        assert(pending[0].pendingSelection);
        const origin = await readJson(pending[0].pendingSelection.pointer.path);
        assert.equal(origin.taskId, task.taskId); assert.equal(origin.rootSessionId, task.rootSessionId);
        assert(pending[0].invocationIds.includes(origin.invocationId), 'Only the already retained genuine selection survives the discarded alignment');
        assert.equal(origin.source.files.find(file => file.path === 'SKILL.md').content, await fs.readFile(f.skillFile, 'utf8'));
      }
    });
});
