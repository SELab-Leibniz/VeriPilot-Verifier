import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { skillGraphQuoteCandidate as skillGraphCandidate, interpretSkillUnit } from './helpers/skill-source-interpretation.mjs';
import { applyGroundTruthDelta, freezeGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { ensureTask, taskDirectory, withTaskState, withTaskDecision, decisionGuard, appendTaskJournal } from '../lib/runtime-v2/task-store.mjs';
import { outsideDecision, decisionScope } from '../lib/runtime-v2/decision-scope.mjs';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { runSemanticReview } from '../lib/semantic-review.mjs';
import { invalidateCurrentStopVerification } from '../lib/runtime-v2/production-stop.mjs';
import { scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { sharedBasisFixture as sharedFixture, user, operation } from './helpers/runtime-v2-shared-basis-fixture.mjs';

import { semanticReviewClock } from './helpers/semantic-review-clock.mjs';

// These cases test original-source/cache semantics, not machine I/O speed.
// Keep the declared 20s role budget explicit; retry/backoff timers stay real.
function fixture(t, options) {
  semanticReviewClock(t, { timeoutMs: 20000 });
  return sharedFixture(t, options);
}

async function mixedRetainedOriginal(f) {
  const original = 'Create app.mjs and a short usage guide. Follow the selected demo Skill.';
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: original } }) + '\n');
  const common = operation();
  f.state.deltaOperations = [{ ...common, text: 'Create app.mjs.', expectedFiles: ['app.mjs'] },
    { ...common, text: 'Write a short usage guide.', verificationTarget: 'ARTIFACT', implementationRole: undefined },
    { ...common, text: 'Follow the selected demo Skill.', verificationTarget: 'PROCESS', implementationRole: undefined }];
  // Actual wire JSON omits undefined optional role fields; clone the scripted
  // arguments similarly, rather than supplying forbidden roles on other owners.
  f.state.deltaOperations = JSON.parse(JSON.stringify(f.state.deltaOperations));
}

// Decoded closed live006 response17/18. The first replay preserves the
// original source selectors, metadata, obligations AND NEW_TASK classification.
const closedMixedSave = { batchId: 1, defaults: { authority: 'MATERIAL_DERIVED', category: 'requirements', severity: 'HARD' },
  exclude: [{ reason: 'Unadopted MATERIAL heading-only context with no imperative content.', units: ['S1L1'] }],
  operations: [
    { expectedFiles: ['app.mjs'], implementationRole: 'PRODUCTION', sourceFrom: { unitId: 'S1L3' }, text: 'Create app.mjs (delivery-verifier Skill requirement).', verificationTarget: 'IMPLEMENTATION', applicabilityKind: 'CURRENT_TASK' },
    { applicability: 'If a later correction changes app.mjs', sourceFrom: { unitId: 'S1L3' }, text: 'If a later correction changes app.mjs, run verification again before completion.', verificationTarget: 'PROCESS', applicabilityKind: 'CONDITIONAL' },
  ] };
const closedMixedFinish = { batchIds: [1], summary: 'New delivery-verifier SKILL.md material: adopted "Create app.mjs" as IMPLEMENTATION/PRODUCTION requirement (expectedFiles app.mjs) and the conditional re-verification duty ("If a later correction changes app.mjs, run verification again before completion", PROCESS, CONDITIONAL). Permissive "You may inspect examples if useful" recorded as non-obligatory. S1L1 heading excluded as unadopted context. S0L1 preserved by program.', taskClassification: 'NEW_TASK' };

async function closedMixedFixture(t, materialAlongside = false) {
  const f = await fixture(t, { wireMode: 'draft', closedMixed: true, materialAlongside });
  const original = 'Create app.mjs and a short usage guide for a stateless numeric validation module. Follow the selected delivery-verifier Skill in this workspace.';
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: original } }) + '\n');
  f.state.sourceFrom = true; f.state.draftActual = true;
  f.state.deltaOperations = [
    { ...operation(), text: 'Create app.mjs implementing a stateless numeric validation module.', expectedFiles: ['app.mjs'] },
    { ...operation(), text: 'Write a short usage guide for the stateless numeric validation module.', verificationTarget: 'ARTIFACT' },
    { ...operation(), text: 'Follow the selected delivery-verifier Skill in this workspace.', verificationTarget: 'PROCESS' },
  ].map(op => { if (op.verificationTarget !== 'IMPLEMENTATION') delete op.implementationRole; return op; });
  const initial = await ensureTask({ projectRoot: f.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: f.root, taskId: initial.taskId }, state => { state.control ??= {}; });
  await f.refresh();
  assert.equal((await f.truth()).version, 1);
  assert.equal((await f.truth()).claims.length, 3);
  assert((await f.task()).groundTruth.sharedBasis.acceptedSourceCertificate);
  return f;
}

async function publicationDiagnostic(t, f) {
  const task = await f.task(), truth = await f.truth(), td = taskDirectory(f.root, task.taskId);
  const receipts = await Promise.all((await fs.readdir(path.join(td, 'ground-truth/baseline-applied')))
    .map(name => readJson(path.join(td, 'ground-truth/baseline-applied', name))));
  t.diagnostic(JSON.stringify({ formalVersion: truth.version, formalMaterial: truth.claims.filter(c => c.source.kind === 'MATERIAL').length,
    receipts, sourceCursors: task.groundTruth.sourceCursors, sharedBasisSources: task.groundTruth.sharedBasis.sources,
    journal: await fs.readFile(path.join(td, 'journal/events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) }));
}

test('unchanged actual Skill → document → Stop hooks share one bounded alignment while independent checks still run', async t => {
  const f = await fixture(t); f.state.useNativeGraph = true;
  const selected = await f.select(); assert.equal(selected.watcher.status, 'ACTIVE');
  const originalTask = await f.task(), originalTruth = await f.truth(), certificate = originalTask.groundTruth.sharedBasis;
  await fs.appendFile(f.transcript, JSON.stringify({ type: 'assistant', uuid: 'A1', message: { content: 'The requested work is complete.' } }) + '\n');
  await fs.writeFile(path.join(f.root, 'guide.md'), 'The requested feature is preserved.');
  const artifact = { nodeId: 'guide', path: 'guide.md', stage: 'implementation', metrics: [], metricCheckpoint: false };
  const document = await f.invoke('PostToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(f.root, 'guide.md') } }, { artifact });
  assert.equal(document.artifactReviewContext.groundTruthDigest, originalTruth.digest, 'real document review preparation remains enabled');
  assert.equal(document.artifactReviewContext.artifact.nodeId, artifact.nodeId);
  const reviewed = await runSemanticReview({ input: { cwd: f.root, session_id: 'basis-session' },
    prepared: { projectRoot: f.root, result: { status: 'passed', diagnostics: [], metadata: {
      roundId: 'document-round', stage: 'implementation', artifactType: 'guide', triggerFile: 'guide.md', artifactFiles: ['guide.md'], bundleComplete: true } },
      reviewContext: { semanticReviewTimeoutMs: 1000, nodeReviewEnabled: false, reviewer: null, specification: null, workflow: null } },
    runtimeV2Context: document.artifactReviewContext, runtimeV2ReviewerFactory: f.factory });
  assert.equal(reviewed.status, 'completed');
  await document.reviewerHandle?.close();
  const stop = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' });
  assert.equal(stop.stop?.status === 'UNVERIFIED', false);
  assert.equal(f.globals().length, 1, 'same committed authority must not be globally re-extracted for document or Stop');
  assert.equal(f.graphs().length, 1);
  assert.equal(f.graphs()[0].request.currentGroundTruth.version, originalTruth.version);
  assert.equal(f.graphs()[0].request.currentGroundTruth.digest, originalTruth.digest);
  const graphInput = f.state.graphInputs[0];
  assert.equal(graphInput.committed.version, 0, 'new global truth stays unpublished during the local graph');
  for (const input of [graphInput.supplied, graphInput.frozen, graphInput.staged]) assert.equal(input.digest, originalTruth.digest);
  assert(certificate?.proof?.checkpointDigest); assert.equal(certificate.baselineDigest, originalTruth.digest);
  assert(f.calls.some(call => call.role === 'artifact-reviewer'), 'document semantic review remains independent');
  assert(f.calls.some(call => call.role === 'skill-reviewer'), 'Skill completion duty still ran');
  assert(f.calls.some(call => call.role === 'stop-reviewer'), 'normal Stop duty still ran');
  assert.equal((await f.task()).groundTruth.sharedBasis.proof.requestId, certificate.proof.requestId);
  assert.equal((await f.truth()).digest, originalTruth.digest);
});

test('a legacy strengthened Skill graph cannot hit a current cursor and does not force another global alignment', async t => {
  const f = await fixture(t); await f.select(); const task = await f.task();
  const certificate = task.groundTruth.sharedBasis.proof.requestId, globals = f.globals().length, graphs = f.graphs().length;
  const file = await f.graphFile(), cached = await readJson(file);
  delete cached.sourceContract;
  cached.constraints[0].statement = 'Read before any implementation, then verify before completion.';
  cached.digest = sha256({ skillId: cached.skillId, skillDigest: cached.skillDigest, constraints: cached.constraints, taskOverlays: cached.taskOverlays });
  await fs.writeFile(file, JSON.stringify(cached));
  await f.select();
  assert.equal(f.globals().length, globals); assert.equal(f.graphs().length, graphs + 1);
  const restored = await readJson(file); assert(restored.sourceContract?.version);
  assert(!restored.constraints.some(c => c.statement.includes('before any implementation')));
  assert.equal((await f.task()).groundTruth.sharedBasis.proof.requestId, certificate);
});

test('a wrong DESCRIPTION proposal cannot hide a hard duty before the watcher interval or after feedback capacity is exhausted', async t => {
  const f = await fixture(t); f.state.interpret = unit => interpretSkillUnit(unit, { normativity: 'DESCRIPTION' });
  f.state.semanticDisposition = 'CONFLICT';
  const selected = await f.select(); assert.equal(selected.watcher.status, 'ACTIVE');
  const task = await f.task(), graph = await readJson(await f.graphFile());
  assert(graph.constraints.every(c => c.modality === 'MAY'));
  assert.equal(f.calls.filter(c => c.role === 'skill-reviewer').length, 0, 'the normal interval has not elapsed');
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => {
    state.skillFeedbacks.demo = { epochId: state.correctionEpoch.id, count: f.plan.runtimeV2.skillCorrection.maxFeedbacksPerSkill };
  });
  const repeated = await f.select(); assert.equal(repeated.watcher.status, 'ACTIVE');
  const stopped = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' });
  assert.equal(stopped.stop.status, 'UNVERIFIED');
  assert.equal(f.calls.filter(c => c.role === 'skill-reviewer').length, 1);
  assert.equal((await f.task()).skillFeedbacks.demo.count, f.plan.runtimeV2.skillCorrection.maxFeedbacksPerSkill, 'checker uncertainty does not spend business feedback capacity');
  assert(Object.values((await f.task()).watchers).every(w => w.status === 'UNVERIFIED'));
  f.state.interpret = null; f.state.semanticDisposition = 'CONFIRMED';
  const repaired = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' }, {
    assessmentContext: { mode: 'verify_only', assessmentId: 'repair-semantic-proposal', guard: decisionGuard(await f.task()),
      deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs, evidenceMatches: async () => true } });
  assert.equal(repaired.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(repaired));
  assert.equal(f.graphs().length, 2, 'an observed semantic conflict invalidates only that local proposal');
  assert.equal(f.globals().length, 1, 'same original authority does not require a new global alignment');
});

test('all nonhard original units receive semantic review and only a current same-graph PASS can reuse it at Stop', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.skillFile, '# Description\n\nThis skill helps build validator libraries.\n\nYou may inspect 示例 😀 if useful.\n');
  f.state.interpret = (unit, index) => interpretSkillUnit(unit, { normativity: index === 0 ? 'DESCRIPTION' : 'PERMISSION' });
  await f.select();
  const request = f.graphs()[0].request;
  assert.equal(request.sourceUnits.length, 3); assert.equal(request.sourceUnits.filter(u => u.sourceOwnership.kind === 'BODY').length, 2);
  assert(request.sourceUnits.every(u => !Object.hasOwn(u, 'text')));
  assert(request.skill.files.every(file => !Object.hasOwn(file, 'content')), 'whole originals are paged once, not repeated in each node request');
  const first = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' });
  assert.equal(first.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(first));
  const firstTask = await f.task(), certificate = firstTask.groundTruth.sharedBasis.proof.requestId;
  const count = () => f.calls.filter(c => c.role === 'skill-reviewer').length;
  let verification = 0;
  const verify = async () => f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' }, {
    assessmentContext: { mode: 'verify_only', assessmentId: `semantic-reuse-${++verification}`, guard: decisionGuard(await f.task()),
      deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs, evidenceMatches: async () => true } });
  assert.equal(count(), 1);
  const second = await verify();
  assert.equal(second.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(second)); assert.equal(count(), 1, 'unchanged current graph/evidence/policy needs no new semantic call');
  const old = await readJson(await f.graphFile()); old.sourceContract.version = 'legacy-semantic-contract';
  await fs.writeFile(await f.graphFile(), JSON.stringify(old));
  const repaired = await verify();
  assert.equal(repaired.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(repaired)); assert.equal(count(), 2);
  assert.equal(f.graphs().length, 2); assert.equal(f.globals().length, 1);
  assert.equal((await f.task()).groundTruth.sharedBasis.proof.requestId, certificate);
  await withTaskState({ projectRoot: f.root, taskId: firstTask.taskId }, state => {
    for (const watcher of Object.values(state.watchers)) watcher.sourceInterpretationChecked = false;
  });
  const missingProof = await verify();
  assert.equal(missingProof.stop.status, 'NO_DEVIATION_FOUND'); assert.equal(count(), 3, 'an old PASS tag without semantic coverage cannot skip every nonhard unit');
});

test('same-Stop old PASS becomes historical after original Skill changes, stays invalid after semantic recovery, and requires fresh full verification', async t => {
  const f = await fixture(t); await f.select();
  const stop = () => f.invoke('Stop', { hook_event_id: 'fixed-original-stop', last_assistant_message: 'The requested work is complete.' });
  const first = await stop(); assert.equal(first.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(first));
  const firstTask = await f.task(), originalId = firstTask.verification.evaluationId;
  const originalFile = path.join(taskDirectory(f.root, firstTask.taskId), 'evaluations', `${originalId}.json`), originalBytes = await fs.readFile(originalFile);
  await fs.appendFile(f.skillFile, '\nNever modify public API signatures.\n'); f.state.semanticDisposition = 'CONFLICT';
  const second = await stop(); assert.equal(second.stop.status, 'UNVERIFIED'); assert.equal(second.stop.reused, true);
  const invalidated = await f.task(); assert.equal(invalidated.verification.status, 'UNVERIFIED'); assert.equal(invalidated.status, 'COMPLETED_WITH_ISSUES');
  assert.notEqual(invalidated.verification.evaluationId, originalId);
  assert(Object.values(invalidated.watchers).every(w => w.status === 'UNVERIFIED' && w.sourceInterpretationChecked === false));
  const audit = await readJson(path.join(taskDirectory(f.root, firstTask.taskId), 'evaluations', `${invalidated.verification.evaluationId}.json`));
  assert.equal(audit.type, 'STOP_VERIFICATION_INVALIDATED'); assert.equal(audit.previousVerification.evaluationId, originalId);
  f.state.semanticDisposition = 'CONFIRMED';
  const third = await stop(); assert.equal(third.stop.status, 'UNVERIFIED'); assert.equal(third.stop.reused, true);
  assert.equal((await f.task()).verification.status, 'UNVERIFIED'); assert.deepEqual(await fs.readFile(originalFile), originalBytes);
  const beforeFresh = await f.task();
  const verified = await f.invoke('Stop', { hook_event_id: 'fresh-guarded-verification', last_assistant_message: 'The requested work is complete.' }, {
    assessmentContext: { mode: 'verify_only', assessmentId: 'fresh-after-skill-invalidation', guard: decisionGuard(beforeFresh),
      deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs, evidenceMatches: async () => true } });
  assert.equal(verified.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(verified));
  const current = await f.task(); assert.equal(current.verification.status, 'NO_DEVIATION_FOUND'); assert.notEqual(current.verification.evaluationId, originalId);
  const ignored = await invalidateCurrentStopVerification({ projectRoot: f.root, taskId: firstTask.taskId, sessionId: 'basis-session', expectedTask: beforeFresh,
    evaluationId: beforeFresh.verification.evaluationId, reasonCode: 'LATE_CALLBACK' });
  assert.equal(ignored, null); assert.equal((await f.task()).verification.evaluationId, current.verification.evaluationId);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await invalidateCurrentStopVerification({ projectRoot: f.root, taskId: firstTask.taskId, sessionId: 'basis-session', expectedTask: current,
    evaluationId: current.verification.evaluationId, reasonCode: 'CANCELLED_CALLBACK', signal: cancelled.signal }), null);
  assert.deepEqual(await fs.readFile(originalFile), originalBytes, 'original Stop evaluation/receipts are never rewritten to pretend they were current');
});

test('a new original Skill duty invalidates cached Stop coverage even when the semantic checker immediately confirms it', async t => {
  const f = await fixture(t); await f.select();
  const stop = () => f.invoke('Stop', { hook_event_id: 'stable-stop-positive-semantics', last_assistant_message: 'The requested work is complete.' });
  const first = await stop(); assert.equal(first.stop.status, 'NO_DEVIATION_FOUND'); const old = await f.task();
  await fs.appendFile(f.skillFile, '\nNever modify public API signatures.\n');
  const changed = await stop(); assert.equal(changed.stop.status, 'UNVERIFIED'); assert.equal(changed.stop.reused, true);
  assert.equal((await f.task()).verification.status, 'UNVERIFIED');
  assert.notEqual((await f.task()).verification.evaluationId, old.verification.evaluationId);
  assert.equal(Object.values((await f.task()).watchers).at(-1).status, 'PASS', 'semantic checking alone does not revalidate the old whole-Stop denominator');
  const stillOld = await stop(); assert.equal(stillOld.stop.status, 'UNVERIFIED');
});

test('an old-policy whole-Stop evaluation remains historical and cannot bypass the current policy through early reuse', async t => {
  const f = await fixture(t); await f.select();
  const stop = () => f.invoke('Stop', { hook_event_id: 'old-policy-stop', last_assistant_message: 'The requested work is complete.' });
  const first = await stop(); assert.equal(first.stop.status, 'NO_DEVIATION_FOUND'); const task = await f.task();
  const file = path.join(taskDirectory(f.root, task.taskId), 'evaluations', `${task.verification.evaluationId}.json`);
  const prior = await readJson(file); delete prior.reviewPolicyVersion; await fs.writeFile(file, JSON.stringify(prior));
  const oldBytes = await fs.readFile(file), calls = f.calls.length;
  const reused = await stop(); assert.equal(reused.stop.status, 'UNVERIFIED'); assert.equal(reused.stop.reasonCode, 'STOP_REVIEW_POLICY_STALE');
  assert.equal((await f.task()).verification.status, 'UNVERIFIED'); assert.equal(f.calls.length, calls, 'no new Stop flow or model dispatch is manufactured for policy invalidation');
  assert.deepEqual(await fs.readFile(file), oldBytes);
});

