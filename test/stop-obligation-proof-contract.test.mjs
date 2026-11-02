import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { reviewProofScope, validateReviewJudgement } from '../lib/runtime-v2/review-result-validation.mjs';

async function fixture(t, { wrong = false, process: processCase = null, testCode = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings'), source = path.join(f.root, testCode ? 'next.test.mjs' : 'app.mjs');
  await fs.writeFile(path.join(f.root, 'app.mjs'), wrong ? 'export const next = value => value;\n' : 'export const next = value => value + 1;\n');
  if (testCode) await fs.writeFile(source, "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { next } from './app.mjs';\ntest('next increments', () => assert.equal(next(0), 1));\n");
  const claims = [{ claimId: 'R1', text: testCode ? 'Write next.test.mjs containing a node:test assertion that next(0) equals 1.'
    : 'Implement next(value) in app.mjs for integers 0 through 9: return value + 1 without state. No other input behavior is required.', verificationTarget: 'IMPLEMENTATION',
    ...(testCode ? { implementationRole: 'TEST' } : {}) },
    ...(processCase ? [{ claimId: 'R2', text: 'Actually run the assigned verifier and establish a successful exit before completion.', verificationTarget: 'PROCESS' }] : [])]
    .map(claim => ({ ...claim, revisionId: `${claim.claimId}@1`, category: 'requirements', status: 'ACTIVE',
      severity: 'HARD', authority: 'USER_EXPLICIT', applicabilityKind: 'CURRENT_TASK' }));
  const truth = { version: 1, digest: sha256(claims), claims };
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(truth)); f.input.evidence.groundTruth = truth;
  const entries = [{ type: 'user', message: { content: claims.map(claim => claim.text).join('\n') } }];
  if (processCase === 'failed') {
    const args = ['-e', 'console.log("synthetic verification failed"); process.exit(3)'];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 3);
    entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify-1', name: 'Bash', input: { executable: process.execPath, args } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'verify-1', content: `Exit code ${result.status}; ${result.stdout}` }] } });
  }
  entries.push({ type: 'assistant', message: { content: 'The implementation is complete.' } });
  f.input.evidence.snapshot.entries = entries;
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.request.sourceManifest = [{ path: path.basename(source), sha256: sha256(await fs.readFile(source)) }];
  f.input.request.population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: truth,
    reviewPolicy: compileRuntimeV2Config({ version: 2 }).stopCorrection });
  return { ...f, source, truth };
}

const trace = { version: 1, entryPoint: 'Exported next(value)', actualInput: 'Integer 0..9',
  producerToConsumer: 'The supplied integer is incremented and returned directly to its caller.', stateful: false,
  statelessReason: 'The complete module is one expression and has no stored/shared mutable resource.', stateTargets: [], targetRelations: [] };

for (const wrong of [false, true]) test(`production workspace accepts source-supported M12 and M16 ${wrong ? 'DEVIATION' : 'PASS'} without an invented execution duty`, async t => {
  const f = await fixture(t, { wrong });
  const original = JSON.stringify(f.truth), expected = wrong ? 'DEVIATION' : 'PASS';
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    assert.deepEqual(checklist.items.map(item => item.objectId).sort(), ['M12:R1', 'M16:R1']);
    const source = await read(f.source), citeIds = [source.details.citation.citeId];
    for (const item of checklist.items) await submit('submit_review', { taskId: item.objectId, verdict: expected,
      reason: wrong ? 'The original integer is returned unchanged, contradicting value + 1.' : 'The original integer flows through + 1 directly to the caller without state.', citeIds,
      ...(item.metricId === 'M16' && !wrong ? { productionTrace: trace } : {}), finish: item === checklist.items.at(-1) });
  });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), [expected, expected]);
  assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(f.truth), original);
});

for (const processEvidence of ['missing', 'failed']) test(`source fulfillment cannot erase a ${processEvidence} explicitly required execution`, async t => {
  const f = await fixture(t, { process: processEvidence });
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    assert.equal(checklist.total, 3);
    const source = await read(f.source), citeIds = [source.details.citation.citeId];
    await submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'The requested static implementation is present and returns input + 1.', citeIds });
    await submit('submit_review', { taskId: 'M16:R1', verdict: 'PASS', reason: 'The complete production flow increments and returns the original integer without state.', citeIds, productionTrace: trace });
    await assert.rejects(submit('submit_review', { taskId: 'M12:R2', verdict: 'PASS', reason: 'Correct source cannot prove this command succeeded.', citeIds }), /PROCESS/);
    assert.equal((await submit('review_checklist', {})).pending, 1);
    if (processEvidence === 'missing') {
      assert.equal(checklist.processEvidence.executionResultFileCount, 0);
      await submit('submit_review', { taskId: 'M12:R2', verdict: 'UNVERIFIED', reason: 'No attributable invocation and result establish the requested successful run.', citeIds: [], finish: true });
    } else {
      const sample = checklist.processEvidence.executionSamples[0];
      for (const file of sample.invocationFiles) await read(file);
      const result = await read(sample.resultFile);
      await submit('submit_review', { taskId: 'M12:R2', verdict: 'DEVIATION', reason: 'The attributed verifier ran and returned exit code 3, contradicting the required successful exit.', citeIds: [result.details.citation.citeId], finish: true });
    }
  });
  assert.deepEqual(Object.fromEntries(handle.result.metricObjectJudgements.map(row => [row.objectId, row.judgement])), {
    'M12:R1': 'PASS', 'M16:R1': 'PASS', 'M12:R2': processEvidence === 'missing' ? 'UNVERIFIED' : 'DEVIATION' });
});

test('legacy and unknown M12 targets and runtime closure cannot silently acquire source-only proof', () => {
  const source = { readProof: { version: 1, observed: true, basisComplete: true, owner: 'SOURCE' } };
  for (const verificationTarget of [undefined, 'UNKNOWN', 'ARTIFACT']) {
    const object = { metricId: 'M12', verificationTarget };
    assert.equal(reviewProofScope(object), 'ARTIFACT_EXECUTION');
    assert.throws(() => validateReviewJudgement({ object, row: { judgement: 'PASS' }, citations: [source] }), /ARTIFACT\/PROCESS/);
  }
  for (const metricId of ['M13', 'M14', 'M15']) assert.throws(() => validateReviewJudgement({
    object: { metricId, verificationTarget: 'IMPLEMENTATION' }, row: { judgement: 'PASS' }, citations: [source] }), /PROCESS/);
});

test('authoring test source fulfills only its TEST obligation, while running it still needs a result', async t => {
  const f = await fixture(t, { testCode: true, process: 'missing' });
  assert.equal(f.input.request.population.metrics.M16.length, 0, 'Test authoring must not enter the production coverage denominator.');
  assert.equal(f.input.request.population.metrics.M12.find(item => item.sourceId === 'R1').implementationRole, 'TEST');
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    assert.deepEqual(checklist.items.map(item => item.objectId).sort(), ['M12:R1', 'M12:R2']);
    const authored = await read(f.source), citeIds = [authored.details.citation.citeId];
    await submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'The delivered test module imports the real next function and asserts next(0) equals 1.', citeIds });
    await assert.rejects(submit('submit_review', { taskId: 'M12:R2', verdict: 'PASS', reason: 'The test exists, but that cannot establish its execution.', citeIds }), /PROCESS/);
    await submit('submit_review', { taskId: 'M12:R2', verdict: 'UNVERIFIED', reason: 'No attributable execution result establishes the explicitly required successful run.', citeIds: [], finish: true });
  });
  assert.deepEqual(Object.fromEntries(handle.result.metricObjectJudgements.map(row => [row.objectId, row.judgement])), { 'M12:R1': 'PASS', 'M12:R2': 'UNVERIFIED' });
});
