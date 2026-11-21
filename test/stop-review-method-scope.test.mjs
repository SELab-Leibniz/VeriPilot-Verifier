import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { taskDirectory, findTask } from '../lib/runtime-v2/task-store.mjs';
import { currentStopReviewMethodScope, describeStopReviewMethodScope, summarizeStopReviewMethodScope } from '../lib/runtime-v2/stop-review-coverage.mjs';
import { requirementExpectation } from '../lib/runtime-v2/regression-evidence.mjs';
import { readReport } from '../lib/openclaw/report.mjs';
import { createNativeStopReviews } from '../lib/openclaw/native-stop-review.mjs';
import { createNativeStopFixture, within } from './support/openclaw-native-stop-fixture.mjs';

const { lifecycle } = createNativeStopFixture();
const duties = [
  'Publish a transfer only after its prerequisite succeeds.',
  'Preserve the caller identifier while storing a transfer.',
  'Return without storing when the prerequisite is absent.',
  'Store a ready transfer through the declared production entry point.',
  'Keep the input transfer object unchanged.',
  'Return the stored transfer result to the caller.',
  'Keep independent caller records separate.',
  'Preserve the public transfer entry point.',
];
const code = 'export function transfer(input) {\n  if (!input.ready) return;\n  return store(input.id);\n}\n';
const pin = 'a'.repeat(64), caseId = 'public-transfer-case';
const declaredCommand = receipt => [process.execPath, '-e', `console.log('RC_REQUIREMENT_PROBE ' + ${JSON.stringify(JSON.stringify(receipt))});`,
  '--', `--requirement-probe-sha256=${pin}`, `--requirement-test=${caseId}`];

// Actual registered review handlers feed the ordinary production Stop path.
// Scripted source appraisals exercise transport, not semantic correctness.
async function reviewed(t, { sampled = true, regressionCheck, forged = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  await fs.unlink(f.input.request.groundTruthPath);
  const producer = path.join(f.root, 'producer.mjs'); await fs.writeFile(producer, code);
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  execFileSync('git', ['add', '--', 'producer.mjs'], { cwd: f.root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'public production basis'], { cwd: f.root });
  const transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, [{ type: 'user', uuid: 'source-original', message: { content: duties.join('\n') } },
    { type: 'assistant', uuid: 'completed', message: { content: 'The implementation is complete.' } }].map(JSON.stringify).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false }, stopCorrection: {
    enabled: true, originalRequirementsBasis: true, deviationOnly: true,
    metrics: { ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, '0')}`, false])), M16: true },
    ...(sampled ? { implementationChallengeMode: 'sampled' } : {}), ...(regressionCheck ? { regressionCheck } : {}),
  } });
  let scriptFailure;
  const reviewerFactory = input => {
    Object.assign(f.input, input);
    return f.run(async tools => {
      try {
        await tools.readAll();
        const original = await tools.read(tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-')));
        if (tools.brief.attempt === 1) await tools.submit('set_original_checklist', { items: duties.map((text, i) => ({
          metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', text,
          citeId: original.details.citation.citeId, lineStart: i + 1, lineEnd: i + 1,
        })) });
        const page = await tools.submit('review_checklist', tools.brief.attempt === 1
          ? { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } : { limit: 20 });
        if (page.deferred) return;
        const source = await tools.read(producer), span = (start, end = start) => ({ citeId: source.details.citation.citeId, start, end });
        const refs = [];
        for (const selected of sampled ? page.implementationChallenges.selection.selected : []) {
          const item = page.items.find(item => item.objectId === selected.objectId);
          const frame = (await tools.submit('review_implementation_challenge', { phase: 'FRAME', frames: [{
            objectId: item.objectId, original: { citeId: original.details.citation.citeId, start: item.originalSource.start, end: item.originalSource.end },
            entry: span(1), decision: span(2), allowedClass: 'The public caller invokes the operation.',
            requiredOutcome: 'Preserve the complete original duty.', alternativeRoute: 'The current decision permits a conflicting effect.',
            predictedOutcome: 'The effect contradicts the original duty.', feasibilityReason: 'Inspect the current decision and result.',
          }] })).frames[0];
          const resolution = (await tools.submit('review_implementation_challenge', { phase: 'RESOLVE', resolutions: [{
            challengeId: frame.challengeId, steps: [{ source: span(2), valueClass: 'The prerequisite is absent.', decision: 'NOT_TAKEN', consequence: 'The effect is not reached.' }],
            result: span(3), assessment: 'REFUTED', appraisal: 'A scripted current-source appraisal, not host-proved semantics.',
            refutingSource: span(2), refutationReason: 'The cited current decision blocks this proposed route.',
          }] })).resolutions[0];
          refs.push({ objectId: resolution.objectId, receiptId: resolution.receiptId });
        }
        if (forged) await assert.rejects(tools.submit('finish_stop_review', { summary: 'Serialized scope is not an input.',
          reviewMethodScope: { implementationChallenges: { selectedCount: 8, eligibleCount: 8, semanticsVerified: true } } }),
        error => error.code === 'TASK_SUBMISSION_INVALID');
        await tools.submit('finish_stop_review', { summary: 'The current scoped source review is recorded.', ...(refs.length ? { implementationChallenges: refs } : {}) });
      } catch (error) { scriptFailure = error; throw error; }
    });
  };
  const event = name => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: { directory: path.join(f.root, 'host'), stopId: 'method-scope-stop', startProtocol: { version: 1 } },
    input: { session_id: 'protocol-host', cwd: f.root, transcript_path: transcript, hook_event_name: name,
      ...(name === 'SessionStart' ? { source: 'startup' } : {}), last_assistant_message: 'The implementation is complete.' } });
  await event('SessionStart');
  const result = await event('Stop'); if (scriptFailure) throw scriptFailure;
  const stop = result.stop, task = await findTask({ projectRoot: f.root, sessionId: 'protocol-host' });
  return { f, stop, task, event, producer, binding: { workspaceDir: f.root, sessionId: 'protocol-host' } };
}

test('actual sampled production review and native committed boundary preserve partial 3/8 scope', async t => {
  const { f, stop, task, binding } = await reviewed(t, { forged: true });
  assert.equal(stop.status, 'NO_DEVIATION_FOUND'); assert.equal(stop.admission, null);
  const scope = stop.review.reviewMethodScope;
  assert.deepEqual(scope.implementationChallenges, { mode: 'sampled', status: 'PARTIAL_SCOPE', selectedCount: 3,
    eligibleCount: 8, exhaustive: false, semanticsVerified: false });
  assert.deepEqual(scope.publicRequirementVerifier, { configured: false, status: 'NOT_CONFIGURED' });
  assert.equal(stop.review.reviewCoverage.denominator.requirementCount, 8, 'the sample must not replace ordinary checklist coverage');
  assert.deepEqual(stop.report.reviewMethodScope, scope);
  const native = createNativeStopReviews();
  await native.schedule({ projectRoot: f.root, sessionId: 'protocol-host', sessionKey: 'agent:fixture:scope', runId: 'original-run',
    signal: new AbortController().signal, budgetMs: 5000, run: async ({ commit }) => {
      const value = { reviewStatus: stop.status, evaluationId: task.verification.evaluationId,
        reviewSummary: { status: stop.status, evaluationId: task.verification.evaluationId,
          assessmentId: task.verification.assessmentId, reviewMethodScope: currentStopReviewMethodScope(scope, {
            taskId: task.taskId, evaluationId: task.verification.evaluationId, assessmentId: task.verification.assessmentId }) } };
      await commit(value); return value;
    } });
  const [record] = await native.wait({ drain: true });
  assert.equal(record.status, 'SETTLED'); assert.deepEqual(record.reviewSummary.reviewMethodScope, scope);
  const report = await readReport(binding);
  assert.deepEqual(report.reviewMethodScope, scope); assert.match(report.text, /3\/8/); assert.match(report.summary, /未配置公开需求验证器/);
});

test('ordinary optional nonuse preserves NDF without inventing a sample or semantic verification', async t => {
  const { stop } = await reviewed(t, { sampled: false });
  assert.equal(stop.status, 'NO_DEVIATION_FOUND'); assert.equal(stop.admission, null);
  assert.deepEqual(stop.review.reviewMethodScope.implementationChallenges,
    { mode: 'optional', status: 'METHOD_NOT_EXERCISED', exhaustive: false, semanticsVerified: false });
  assert.equal(stop.review.reviewMethodScope.publicRequirementVerifier.status, 'NOT_CONFIGURED');
  assert.equal(describeStopReviewMethodScope(stop.review.reviewMethodScope), null, 'default optional nonuse adds no human method warning');
});

test('a configured incomplete public verifier remains incomplete with no automatic deviation', async t => {
  const receipt = { sha256: pin, status: 'INCOMPLETE', checks: [], reason: 'PUBLIC_FIXTURE_UNAVAILABLE' };
  const { stop } = await reviewed(t, { sampled: false, regressionCheck: { enabled: true, command: declaredCommand(receipt) } });
  assert.equal(stop.status, 'UNVERIFIED'); assert.equal(stop.reasonCode, 'STOP_PUBLIC_REQUIREMENT_UNVERIFIED');
  assert.equal(stop.admission, null); assert.equal(stop.review.requirementCheck.status, 'INCOMPLETE');
  assert.deepEqual(stop.review.reviewMethodScope.publicRequirementVerifier, { configured: true, status: 'INCOMPLETE', checkCount: 0 });
});

test('configured absence is not mislabeled unconfigured and disabled declarations cannot claim a result', () => {
  const binding = { taskId: 't', evaluationId: 'e', assessmentId: 'a' };
  for (const [enabled, command, expected] of [
    [false, declaredCommand({}), 'NOT_CONFIGURED'], [true, [process.execPath, 'ordinary-tests.mjs'], 'NOT_CONFIGURED'],
    [true, declaredCommand({}), 'NOT_OBSERVED'],
  ]) {
    const scope = summarizeStopReviewMethodScope({ binding,
      publicVerifierConfigured: enabled && Boolean(requirementExpectation(command)) });
    assert.equal(scope.publicRequirementVerifier.status, expected);
  }
  for (const status of ['PASS', 'FAIL', 'INCOMPLETE']) {
    const scope = summarizeStopReviewMethodScope({ binding, publicVerifierConfigured: true, requirementCheck: { status, checks: [{}] } });
    assert.equal(scope.publicRequirementVerifier.status, status); assert.equal(scope.publicRequirementVerifier.checkCount, 1);
  }
  const disabled = summarizeStopReviewMethodScope({ binding, publicVerifierConfigured: false, requirementCheck: { status: 'PASS', checks: [] } });
  assert.equal(disabled.publicRequirementVerifier.status, 'NOT_CONFIGURED');
});

test('stale, foreign and changed-source retained scopes cannot become the current report', async t => {
  const { f, stop, task, producer, binding } = await reviewed(t);
  const scope = stop.review.reviewMethodScope;
  for (const key of ['taskId', 'evaluationId', 'assessmentId']) {
    assert.equal(currentStopReviewMethodScope(scope, { ...scope.binding, [key]: 'foreign' }), null);
  }
  const evaluation = path.join(taskDirectory(f.root, task.taskId), 'evaluations', `${task.verification.evaluationId}.json`);
  const bytes = await fs.readFile(evaluation), saved = JSON.parse(bytes);
  for (const key of ['taskId', 'evaluationId', 'assessmentId']) {
    const changed = structuredClone(saved); changed.review.reviewMethodScope.binding[key] = 'foreign';
    await fs.writeFile(evaluation, JSON.stringify(changed));
    assert.equal((await readReport(binding)).reviewMethodScope, null, key);
  }
  const old = structuredClone(saved); delete old.review.reviewMethodScope;
  await fs.writeFile(evaluation, JSON.stringify(old));
  assert.equal((await readReport(binding)).reviewMethodScope, null, 'old cache data must not be reconstructed from actor state');
  await fs.writeFile(evaluation, bytes);
  await fs.writeFile(producer, code + '// changed after the current assessment\n');
  const stale = await readReport(binding); assert.equal(stale.verification, 'STALE'); assert.equal(stale.reviewMethodScope, null);
});

test('the real native runtime public summary adds display scope without changing ordinary acceptance or reply', async t => {
  const f = await lifecycle(t), payload = { text: 'Delivered.', mediaUrl: 'fixture://media' }, original = structuredClone(payload);
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload }, f.ctx);
  const [record] = await within(f.runtime.waitForNativeReviews({ drain: true }), 'ordinary current native summary');
  assert.equal(record.reviewStatus, 'NO_DEVIATION_FOUND'); assert.deepEqual(payload, original);
  assert.equal(record.reviewSummary.reviewMethodScope.publicRequirementVerifier.status, 'NOT_CONFIGURED');
  assert.equal(record.reviewSummary.reviewMethodScope.implementationChallenges.semanticsVerified, false);
  assert.equal(f.hostAbort.signal.aborted, false);
});

test('scope descriptions retain partiality and never repeat arbitrary serialized status text', () => {
  const scope = summarizeStopReviewMethodScope({ binding: { taskId: 't', evaluationId: 'e', assessmentId: 'a' }, mode: 'sampled',
    challenges: { status: 'PARTIAL_SCOPE', selection: { selected: [{}, {}, {}], eligibleCount: 8 }, semanticsVerified: true, exhaustive: true } });
  assert.match(describeStopReviewMethodScope(scope), /3 of 8/); assert.match(describeStopReviewMethodScope(scope), /do not prove semantics/);
  assert.equal(scope.implementationChallenges.semanticsVerified, false); assert.equal(scope.implementationChallenges.exhaustive, false);
  scope.publicRequirementVerifier.status = 'private-untrusted-status';
  assert(!describeStopReviewMethodScope(scope).includes('private-untrusted-status'));
});


test('same-binding overclaims and injected retained fields are rejected at the display boundary', async t => {
  const { f, stop, task, binding } = await reviewed(t);
  const scope = stop.review.reviewMethodScope;
  const evaluation = path.join(taskDirectory(f.root, task.taskId), 'evaluations', `${task.verification.evaluationId}.json`);
  const bytes = await fs.readFile(evaluation), saved = JSON.parse(bytes);
  for (const alter of [
    value => { value.implementationChallenges.semanticsVerified = true; },
    value => { value.implementationChallenges.exhaustive = true; },
    value => { value.implementationChallenges.selectedCount = 8; },
    value => { value.implementationChallenges.eligibleCount = 2; },
    value => { value.publicRequirementVerifier.status = 'PASS'; },
    value => { value.publicRequirementVerifier.arbitraryResult = 'injected'; },
    value => { value.serializedAuthority = 'host-verified'; },
    value => { value.binding.unrelatedOwner = 'injected'; },
  ]) {
    const forged = structuredClone(scope); alter(forged);
    assert.equal(currentStopReviewMethodScope(forged, scope.binding), null);
    const changed = structuredClone(saved); changed.review.reviewMethodScope = forged;
    await fs.writeFile(evaluation, JSON.stringify(changed));
    assert.equal((await readReport(binding)).reviewMethodScope, null);
  }
  await fs.writeFile(evaluation, bytes);
  assert.deepEqual((await readReport(binding)).reviewMethodScope, scope, 'the original conservative host-produced scope remains usable');
});
