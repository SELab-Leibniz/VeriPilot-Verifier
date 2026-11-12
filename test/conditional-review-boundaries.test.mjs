import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateReviewJudgement, validateReviewFinding } from '../lib/runtime-v2/review-result-validation.mjs';
import { collectReviewItems } from '../lib/runtime-v2/review-collector.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { runStopTaskReview } from '../lib/runtime-v2/stop-task-review.mjs';
import { runReviewTask } from '../lib/review-task/review-task.mjs';
import { nativeTools } from './helpers/native-task.mjs';
import { runProductionStop } from '../lib/runtime-v2/production-stop.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';

const object = { objectId: 'M12:R1', sourceId: 'R1', sourceRevisionId: 'R1@1', metricId: 'M12', hard: true,
  applicabilityKind: 'CONDITIONAL', verificationTarget: 'PROCESS', description: 'Only for a Python project, run pytest.' };
const condition = (activation, evidenceKind = 'TARGET_FACTS') => ({ activation, evidenceKind, reason: 'The complete original scope and current attributable evidence establish this condition.' });
const source = { path: '/project/package.json', contentHash: 'current-source', readProof: { version: 1, observed: true,
  basisComplete: true, owner: 'SOURCE', fullFile: true, activationFact: true } };
const process = { path: '/project/actual-result', contentHash: 'current-process', readProof: { version: 1, observed: true,
  basisComplete: true, owner: 'PROCESS', executionEvidence: true } };
const finding = { deviationKey: 'actual-test-failure', rootCauseId: 'REQUIREMENT_OMITTED', severity: 'error',
  reason: 'The attributable requested verifier failed.', actualEvidence: [], expectedConstraint: object.description, violatedGroundTruthIds: ['R1'] };

test('a target-fact conditional exemption does not require performing the inactive PROCESS duty', () => {
  const row = { objectId: object.objectId, judgement: 'NOT_APPLICABLE', conditionAssessment: condition('INACTIVE_AT_CURRENT_BOUNDARY') };
  assert.equal(validateReviewJudgement({ row, object, citations: [source] }).judgement, 'NOT_APPLICABLE');
  assert.throws(() => validateReviewJudgement({ row: { ...row, judgement: 'PASS', conditionAssessment: condition('ACTIVE') }, object, citations: [source] }), /PROCESS/);
});

test('a finding carries an already-qualified ACTIVE DEVIATION instead of losing the condition at the shared boundary', () => {
  const row = validateReviewJudgement({ row: { objectId: object.objectId, judgement: 'DEVIATION', conditionAssessment: condition('ACTIVE', 'PROCESS_EVENT') }, object, citations: [process] });
  assert.equal(validateReviewFinding({ finding, objects: [object], citations: [process], classification: { metricObjectJudgements: [row] } }), finding);
  assert.throws(() => validateReviewFinding({ finding, objects: [object], citations: [source], classification: { metricObjectJudgements: [row] } }), /original evidence|PROCESS/);
});

async function setup(t, entries = []) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.request.population = { ...f.input.request.population, metrics: { M12: [object] } };
  const claim = { ...f.input.evidence.groundTruth.claims[0], applicabilityKind: 'CONDITIONAL', verificationTarget: 'PROCESS', text: object.description };
  f.input.evidence.groundTruth.claims = [claim];
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(f.input.evidence.groundTruth));
  f.input.evidence.snapshot = { entries, digest: sha256(entries) };
  return f;
}

async function finalReview(f, unifiedReview, verificationId) {
  return runProductionStop({ projectRoot: f.root, task: f.task, input: { session_id: 'protocol-host', transcript_path: f.input.request.processSnapshotPath,
      last_assistant_message: 'Completed.' }, env: {}, verificationOnly: true, verificationId,
    snapshot: f.input.evidence.snapshot, reviewerFactory: Object.assign(async () => { throw new Error('No additional model dispatch is permitted.'); }, { reviewDeadlineAt: Date.now() + 10000 }),
    runtimeV2: compileRuntimeV2Config({ version: 2, stopCorrection: { enabled: true, fileQualityReviewEnabled: false } }, { policyRoot: path.join(f.root, '.runtime-corrector') }),
    isCurrent: async () => sha256(JSON.parse(await fs.readFile(f.input.request.groundTruthPath, 'utf8'))) === sha256(f.input.evidence.groundTruth),
    prepare: async () => ({ groundTruth: f.input.evidence.groundTruth, classification: f.input.request.fixedStopClassification,
      population: f.input.request.population, fullPopulation: f.input.request.population, unifiedReview, request: f.input.request }) });
}

test('the registered workspace accepts a complete SOURCE fact exemption without inventing a process event', async t => {
  const f = await setup(t), file = path.join(f.root, 'package.json'); await fs.writeFile(file, '{"type":"module"}');
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    const page = await read(file);
    await submit('submit_review', { taskId: object.objectId, verdict: 'NOT_APPLICABLE', reason: 'The complete original project manifest establishes the JavaScript-only scope.',
      citeIds: [page.details.citation.citeId], conditionAssessment: condition('INACTIVE_AT_CURRENT_BOUNDARY'), finish: true });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'NOT_APPLICABLE'); await handle.close();
});

test('registered conditional DEVIATION survives finding submission and the real collector handoff', async t => {
  for (const window of [false, true]) await t.test(window ? 'complete original window' : 'original process event', async t => {
  const entries = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'pytest', name: 'Bash', input: { command: 'pytest' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'pytest', content: 'Exit code 1: requested check failed.' }] } },
  ];
  const f = await setup(t, entries);
  if (window) {
    const file = path.join(f.root, 'finding-original.jsonl'), raw = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await fs.writeFile(file, raw); f.input.request.processSnapshotPath = file; f.input.evidence.snapshot.digest = sha256(raw);
  }
  const handle = await f.run(async ({ readAll, read, submit }) => {
    try {
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    const ids = [];
    for (const file of checklist.processFiles) { const result = await read(file); ids.push(result.details.citation.citeId); }
    const saved = await submit('submit_review', { taskId: object.objectId, verdict: 'DEVIATION', reason: finding.reason, citeIds: ids,
      conditionAssessment: window ? { ...condition('ACTIVE', 'PROCESS_WINDOW'), afterCallId: 'pytest' } : condition('ACTIVE', 'PROCESS_EVENT') });
    assert.equal(saved.saved, true);
    const { actualEvidence, ...fields } = finding;
    await submit('submit_finding', { ...fields, citeIds: ids });
    await submit('finish_stop_review', { summary: 'The original conditional execution deviation and finding are preserved.' });
    } catch (error) { t.diagnostic(error.stack); throw error; }
  });
  if (!handle.result.findings.length) t.diagnostic(JSON.stringify(handle.result));
  assert.equal(handle.result.findings.length, 1);
  const collected = await collectReviewItems({ ...f.input, classification: f.input.request.fixedStopClassification,
    reviewerFactory: async () => handle, deadlineAt: Date.now() + 10000 });
  assert.equal(collected.result.metricObjectJudgements[0].judgement, 'DEVIATION');
  assert.equal(collected.result.findings.length, 1);
  const outcome = await finalReview(f, collected, 'checked-conditional-finding');
  assert(outcome.review.findings.some(row => row.deviationKey === finding.deviationKey), JSON.stringify(outcome.review.validationIssues));
  assert.equal(outcome.review.metricObjectJudgements.find(row => row.objectId === object.objectId).judgement, 'DEVIATION');
  await collected.close();
  });
});

async function windowFixture(t, verdict = 'NOT_APPLICABLE') {
  const entries = [
    { type: 'user', message: { content: 'Run the requested verifier before completion.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify-window', name: 'Bash', input: { command: 'node verify.mjs' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'verify-window', content: 'Exit code 0.' }] } },
    { type: 'assistant', message: { content: 'Completed.' } },
  ];
  const f = await setup(t, entries), scoped = { ...object, description: verdict === 'PASS'
    ? 'If requested, run the verifier before completion.' : 'If a later correction changes the deliverable, run the verifier again.' };
  f.input.request.population.metrics.M12 = [scoped];
  f.input.evidence.groundTruth.claims[0].text = scoped.description;
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(f.input.evidence.groundTruth));
  const originalPath = path.join(f.root, 'window-original.jsonl'), raw = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  await fs.writeFile(originalPath, raw); f.input.request.processSnapshotPath = originalPath; f.input.evidence.snapshot.digest = sha256(raw);
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    const ids = [];
    for (const file of checklist.processFiles) ids.push((await read(file)).details.citation.citeId);
    await submit('submit_review', { taskId: scoped.objectId, verdict, reason: 'The entire attributable original interval establishes this current condition and action.', citeIds: ids,
      conditionAssessment: { activation: verdict === 'PASS' ? 'ACTIVE' : 'INACTIVE_AT_CURRENT_BOUNDARY', evidenceKind: 'PROCESS_WINDOW',
        afterCallId: 'verify-window', reason: 'Read every original event from invocation through the current completion cursor.' }, finish: true });
  });
  assert.equal(handle.result.metricObjectJudgements[0]?.judgement, verdict, JSON.stringify(handle.result));
  return { ...f, handle, originalPath, scoped };
}

test('mechanical Stop decisions survive collection without semantic certificates while original snapshot drift stays protected', async t => {
  const f = await windowFixture(t);
  assert.equal(f.handle.citationPolicy, 'mechanical-v1');
  assert.equal(f.handle.proofs[object.objectId].conditionBinding, undefined);
  const input = { ...f.input, classification: f.input.request.fixedStopClassification,
    reviewerFactory: async () => f.handle, deadlineAt: Date.now() + 15000 };
  const collected = await collectReviewItems(input);
  assert.equal(collected.citationPolicy, 'mechanical-v1');
  assert.equal(collected.result.metricObjectJudgements[0].judgement, 'NOT_APPLICABLE');
  const final = await finalReview(f, collected, 'mechanical-condition-final');
  assert.equal(final.status, 'NO_DEVIATION_FOUND');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectReviewItems({ ...input, abortSignal: controller.signal }), /cancel/i);
  await assert.rejects(collectReviewItems({ ...input, deadlineAt: Date.now() - 1 }), /deadline|window|time/i);
  await fs.appendFile(f.originalPath, JSON.stringify({ type: 'assistant', message: { content: 'A later original event.' } }) + '\n');
  await assert.rejects(collectReviewItems(input), /STALE|changed|snapshot|certificate/i);
});

test('a complete-window ACTIVE PASS carries its program proof through the existing PASS cache and rejects a later original append', async t => {
  const f = await windowFixture(t, 'PASS'); let calls = 0;
  const factory = async options => { calls++; return runStopTaskReview(options, { runTask: args => runReviewTask({ ...args,
    nativeRun: async worker => {
      const tools = nativeTools(worker), ids = [];
      for (const file of args.task.basisFiles) await tools.read(file);
      for (let i = 0; i < args.task.conditionProcess.count; i++) ids.push(await tools.read(`execution/${String(i).padStart(6, '0')}.json`));
      await tools.submit(args.task.id, 'PASS', ids, { conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'PROCESS_WINDOW',
        afterCallId: 'verify-window', reason: 'The complete current original interval proves the requested action at completion.' } });
    } }) }); }; factory.reviewCacheIdentity = () => 'window-pass-proof-fixture-v1';
  const input = { ...f.input, classification: f.input.request.fixedStopClassification, reviewerFactory: factory, deadlineAt: Date.now() + 15000 };
  const first = await collectReviewItems(input), second = await collectReviewItems(input);
  assert.equal(first.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(second.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(second.collection.reusedItems, 1); assert.equal(calls, 1);
  await fs.appendFile(f.originalPath, JSON.stringify({ type: 'assistant', message: { content: 'A later original event.' } }) + '\n');
  const changed = await collectReviewItems(input);
  assert.equal(changed.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
  assert.equal(changed.collection.reusedItems, 0); assert.equal(calls, 2);
});
