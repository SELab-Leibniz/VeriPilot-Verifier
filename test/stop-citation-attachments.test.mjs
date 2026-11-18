import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { runProductionStop } from '../lib/runtime-v2/production-stop.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { findTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { prepareHostFeedback } from '../lib/runtime-v2/feedback-delivery.mjs';
import { createStopCorrectionStore } from '../lib/runtime-v2/stop-correction-store.mjs';

async function fixture(t, { two = false, deviationOnly = true } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  delete f.input.request.fixedStopClassification;
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly, fileQualityReviewEnabled: false, metrics: { M01: true } });
  if (two) f.input.request.population.metrics.M01.push({ ...f.input.request.population.metrics.M01[0], objectId: 'M01:R2', sourceId: 'R2' });
  const truth = f.input.evidence.groundTruth;
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => { state.groundTruth.version = truth.version; state.groundTruth.digest = truth.digest; });
  const scope = submit => submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'The original response claims completion.' });
  const deviation = (id = 'M01:R1', citations = [{ path: 'spec.md', start: 1, end: 1 }]) => ({ taskId: id, verdict: 'DEVIATION', reason: 'The actual value differs.', citations });
  const finish = submit => submit('finish_stop_review', { summary: 'The scan is complete.' });
  const production = async handle => runProductionStop({ projectRoot: f.root, task: await findTask({ projectRoot: f.root, sessionId: 'protocol-host' }),
    input: { session_id: 'protocol-host' }, env: {}, verificationOnly: true, verificationId: 'attachments',
    snapshot: { entries: [], digest: sha256([]) }, runtimeV2: compileRuntimeV2Config({ version: 2,
      stopCorrection: { enabled: true, deviationOnly, originalRequirementsBasis: false, fileQualityReviewEnabled: false } }),
    reviewerFactory: Object.assign(async () => assert.fail('The recorded worker is reused.'), { reviewDeadlineAt: Date.now() + 20000 }),
    prepare: async () => ({ taskId: f.task.taskId, groundTruth: truth, classification: { stopClassification: 'TASK_COMPLETE' },
      population: f.input.request.population, fullPopulation: f.input.request.population, unifiedReview: handle, request: { artifactCandidates: [] } }) });
  const run = async script => {
    let scriptError;
    try { return await f.run(async tools => { try { await script(tools); } catch (error) { scriptError = error; throw error; } }); }
    catch (error) { throw scriptError ?? error; }
  };
  return { ...f, run, scope, deviation, finish, production };
}

test('an unread file is a valid deviation attachment and keeps its exact source excerpt', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    await submit('submit_review', f.deviation()); await f.finish(submit);
  });
  assert.equal(handle.sourceCitations[0].exactQuote, 'The delivered value is incorrect.');
  assert.equal(handle.sourceCitations[0].readProof.observed, false);
  const outcome = await f.production(handle);
  assert.equal(outcome.status, 'DEVIATION', JSON.stringify(outcome));
});

test('conforming and unresolved results and checked frame items need no citations, including invalid optional legacy IDs', async t => {
  const f = await fixture(t, { two: true, deviationOnly: false });
  f.input.request.requirementFrame = { basis: { guidance: [{ id: 'G1' }], scenarios: [] } };
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    await submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS', reason: 'The requirement holds.', citeIds: ['never-read'] });
    await submit('submit_review', { taskId: 'M01:R2', verdict: 'UNVERIFIED', reason: 'One item is unclear.' });
    await submit('finish_stop_review', { summary: 'All items were reviewed.', frameDispositions: [{ id: 'G1', disposition: 'CHECKED' }] });
  });
  assert.equal(handle.result.frameCoverage.checked, 1);
  const outcome = await f.production(handle);
  assert.equal(outcome.status, 'UNVERIFIED');
  assert.equal(outcome.reasonCode, 'STOP_MANDATORY_REQUIREMENT_UNVERIFIED');
  assert.equal(outcome.admission, null);
});

for (const deviationOnly of [true, false]) test(`bad ranges downgrade only their deviation; a valid sibling survives (${deviationOnly})`, async t => {
  const f = await fixture(t, { two: true, deviationOnly });
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const bad = f.deviation('M01:R1', [{ path: 'spec.md', start: 900, end: 901 }]);
    await assert.rejects(submit('submit_review', bad), { code: 'TASK_CITATION_INVALID' });
    assert.equal((await submit('submit_review', bad)).downgraded, true);
    await submit('submit_review', f.deviation('M01:R2')); await f.finish(submit);
  });
  const outcome = await f.production(handle);
  assert.equal(outcome.status, 'DEVIATION', JSON.stringify(outcome));
  assert.equal(outcome.verificationUnavailable, false);
  assert.equal(outcome.review.unverifiedItems[0].type, 'CITATION');
  assert.equal(outcome.review.metricObjectJudgements.filter(x => x.judgement === 'DEVIATION').length, 1);
  assert.equal(handle.result.citationDiagnostics.rejectedSubmissions, 1);
  assert.equal(handle.result.citationDiagnostics.downgradedItems, 1);
});

test('even a lone invalid deviation is locally unverified rather than a majority-of-requirements failure', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    await assert.rejects(submit('submit_review', f.deviation('M01:R1', [])), { code: 'TASK_CITATION_INVALID' });
    await f.finish(submit); // Leaving the repair uncorrected records only this item.
  });
  const outcome = await f.production(handle);
  assert.equal(outcome.status, 'NO_DEVIATION_FOUND', JSON.stringify(outcome));
  assert.equal(outcome.feedback, null);
  assert.equal(outcome.review.unverifiedItems[0].id, 'M01:R1');
});

test('a changed previously read attachment gets one repair error and never invalidates the whole review', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit); await read(f.file);
    await fs.writeFile(f.file, 'Changed content.\n');
    await assert.rejects(submit('submit_review', f.deviation()), { code: 'TASK_CITATION_INVALID' });
    assert.equal((await submit('submit_review', f.deviation())).downgraded, true);
    await f.finish(submit);
  });
  assert.equal((await f.production(handle)).status, 'NO_DEVIATION_FOUND');
});

test('a corrected range is accepted on its single repair opportunity', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    await assert.rejects(submit('submit_review', f.deviation('M01:R1', [{ path: 'spec.md', start: 0, end: 0 }])), { code: 'TASK_CITATION_INVALID' });
    await submit('submit_review', f.deviation()); await f.finish(submit);
  });
  assert.equal(handle.result.citationDiagnostics.correctedItems, 1);
  assert.equal(handle.result.citationDiagnostics.downgradedItems, 0);
  assert.equal((await f.production(handle)).status, 'DEVIATION');
});

test('a file changing before finish yields one correction error, then only a local downgrade', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit); await submit('submit_review', f.deviation());
    await fs.writeFile(f.file, 'Changed before finishing.\n');
    await assert.rejects(f.finish(submit), { code: 'TASK_CITATION_INVALID' });
    await f.finish(submit);
  });
  assert.equal((await f.production(handle)).status, 'NO_DEVIATION_FOUND');
});

test('a post-worker attachment change is caught at production publication and preserves a valid sibling', async t => {
  const f = await fixture(t, { two: true }), other = path.join(f.root, 'other.txt');
  await fs.writeFile(other, 'A second counterexample.\n');
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit); await submit('submit_review', f.deviation());
    await submit('submit_review', f.deviation('M01:R2', [{ path: 'other.txt', start: 1, end: 1 }])); await f.finish(submit);
  });
  await fs.writeFile(f.file, 'Changed after worker completion.\n');
  const outcome = await f.production(handle);
  assert.equal(outcome.status, 'DEVIATION', JSON.stringify(outcome));
  assert.equal(outcome.review.metricObjectJudgements.filter(x => x.judgement === 'DEVIATION').length, 1);
  assert.equal(outcome.verificationUnavailable, false);
});

test('dependencies, tests and runtime output are all eligible file attachments', async t => {
  const f = await fixture(t);
  for (const file of ['node_modules/pkg/index.js', 'tests/original.test.mjs', 'logs/result.txt']) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), { recursive: true }); await fs.writeFile(path.join(f.root, file), 'real source\n');
  }
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    await submit('submit_review', f.deviation('M01:R1', ['node_modules/pkg/index.js', 'tests/original.test.mjs', 'logs/result.txt'].map(path => ({ path, start: 1, end: 1 }))));
    await f.finish(submit);
  });
  assert.equal(handle.sourceCitations.length, 3);
  assert.equal((await f.production(handle)).status, 'DEVIATION');
});

test('a stale metric attachment does not poison a valid finding through the legacy citation getter', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other.txt');
  await fs.writeFile(other, 'A separate current counterexample.\n');
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit); await submit('submit_review', f.deviation());
    await submit('submit_finding', { deviationKey: 'independent-finding', rootCauseId: 'REQUIREMENT_OMITTED', severity: 'error',
      reason: 'Another current counterexample remains.', expectedConstraint: 'Original requirement.', violatedGroundTruthIds: ['R1'],
      citations: [{ path: 'other.txt', start: 1, end: 1 }] });
    await f.finish(submit);
  });
  await fs.writeFile(f.file, 'The first attachment changed.\n');
  const outcome = await f.production(handle);
  assert.equal(outcome.status, 'DEVIATION', JSON.stringify(outcome));
  assert.equal(outcome.review.findings.length, 1);
  assert.equal(outcome.verificationUnavailable, false);
  assert.equal((await handle.getSourceCitations()).length, 1);
});

test('an uncited malformed finding can be downgraded without blocking a completed scan', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const value = { deviationKey: 'finding-one', rootCauseId: 'REQUIREMENT_OMITTED', severity: 'error', reason: 'A proposed counterexample.',
      expectedConstraint: 'Original requirement.', violatedGroundTruthIds: ['R1'] };
    await assert.rejects(submit('submit_finding', value), { code: 'TASK_CITATION_INVALID' });
    assert.equal((await submit('submit_finding', value)).downgraded, true); await f.finish(submit);
  });
  assert.equal((await f.production(handle)).status, 'NO_DEVIATION_FOUND');
  assert.equal(handle.result.unverifiedItems[0].id, 'finding:finding-one');
});

test('host feedback includes source location, excerpt and the existing rebuttal instruction', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit); await submit('submit_review', f.deviation()); await f.finish(submit);
  });
  const text = await prepareHostFeedback({ projectRoot: f.root, taskId: f.task.taskId, locale: 'zh',
    text: '[runtime-corrector:stop-feedback]\n如反馈不成立，请说明依据。', review: handle.result, citations: handle.sourceCitations });
  assert.match(text, /spec\.md#L1-L1/u);
  assert.match(text, /snippet: The delivered value/u);
  assert.match(text, /如反馈不成立，请说明依据/u);
  const index = JSON.parse(await fs.readFile(text.split('\n').find(line => line.startsWith('[RC_DETAILS] ')).slice(13), 'utf8'));
  const page = JSON.parse(await fs.readFile(index.pages[0].path, 'utf8'));
  const item = JSON.parse(await fs.readFile(page.items[0].path, 'utf8'));
  assert.equal(item.evidenceAttachments[0].text, 'The delivered value is incorrect.');
  assert.equal(item.evidenceAttachments[0].sha256, sha256(await fs.readFile(f.file)));
});

for (const retainSibling of [false, true]) test(`send-time invalid attachments suppress only their deviation (${retainSibling})`, async t => {
  const f = await fixture(t), store = createStopCorrectionStore({ directory: path.join(f.root, 'host-ledger') });
  await store.beginStop({ sessionId: 'session', flowId: 'flow', stopId: 'stop', sourceInput: { origin: 'HUMAN', id: 'request' },
    config: { enabled: true }, initialize: { kind: 'NEW_SESSION', evidence: 'A new isolated fixture session.' } });
  const bad = { objectId: 'bad', result: { judgement: 'DEVIATION' } }, good = { objectId: 'good', result: { judgement: 'DEVIATION' } };
  await store.settleReview({ sessionId: 'session', stopId: 'stop', status: 'DEVIATION', progress: { complete: true }, currentDeviations: retainSibling ? [bad, good] : [bad] });
  await store.reserveFeedback({ sessionId: 'session', stopId: 'stop', packageId: 'feedback',
    basisCurrent: async () => ({ deviations: retainSibling ? [good] : [], attachmentFailures: ['bad'] }) });
  const stop = (await store.inspect('session')).stops.stop;
  assert.equal(stop.reviewStatus, retainSibling ? 'DEVIATION' : 'NO_DEVIATION_FOUND');
  assert.deepEqual(stop.currentDeviations, retainSibling ? [good] : []);
  assert.deepEqual(stop.attachmentFailures, ['bad']);
});
