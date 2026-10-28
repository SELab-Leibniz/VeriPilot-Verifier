import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';

async function fixture(t) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.classificationContract = 2;
  delete f.input.request.fixedStopClassification;
  return f;
}

test('single-session scope cannot hide a completed request behind optional follow-ups', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll();
    await assert.rejects(submit('review_checklist', { stopClassification: 'TASK_COMPLETE' }), /structured completion/);
    await assert.rejects(submit('review_checklist', { stopClassification: 'WAITING_FOR_USER', completionClaim: true,
      requiredUserInput: 'Optional examples?', summary: 'The implementation is complete; examples are optional.' }), /optional follow-ups/);
    await assert.rejects(submit('review_scope', { stopClassification: 'INTERMEDIATE', completionClaim: true, summary: 'Complete.' }), /completion scope/);
    const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true,
      requiredUserInput: null, externalBlocker: null });
    assert.equal(checklist.total, 1);
    await submit('submit_review', { taskId: 'M01:R1', verdict: 'UNVERIFIED', reason: 'No delivery proof.', citeIds: [], finish: true });
  });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.result.stopClassification, 'TASK_COMPLETE');
  assert.equal(handle.result.metricObjectJudgements.length, 1);
  const scope = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'scope.json'), 'utf8'));
  assert.equal(scope.completionClaim, true);
});

test('an empty eligible-stage list rejects every document stage before scanning delivery', async t => {
  const f = await fixture(t); f.input.request.workflowStages = [];
  let scans = 0; f.input.onScope = async () => { scans++; };
  await f.run(async ({ readAll, submit }) => {
    await readAll();
    await assert.rejects(submit('review_scope', { stopClassification: 'STAGE_COMPLETE', stage: 'design', completionClaim: true,
      summary: 'Incorrect document stage for implementation.' }), /frozen workflow/);
    assert.equal(scans, 0);
    await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
    await submit('submit_review', { taskId: 'M01:R1', verdict: 'UNVERIFIED', reason: 'No delivery proof.', citeIds: [], finish: true });
  });
  assert.equal(scans, 1);
});

for (const stopClassification of ['WAITING_FOR_USER', 'BLOCKED_EXTERNAL']) test(`single session preserves legitimate ${stopClassification} without certifying pending obligations`, async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll();
    const checklist = await submit('review_checklist', { stopClassification, completionClaim: false,
      requiredUserInput: stopClassification === 'WAITING_FOR_USER' ? 'Select the required destination.' : null,
      externalBlocker: stopClassification === 'BLOCKED_EXTERNAL' ? 'The required external device is unavailable.' : null });
    assert.equal(checklist.total, 0);
    await submit('finish_stop_review', { summary: 'Original pending obligations remain unverified.' });
  });
  assert.equal(handle.result.stopClassification, stopClassification);
  assert.deepEqual(handle.result.metricObjectJudgements, []);
});
