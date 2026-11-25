import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { sharedBasisFixture as fixture } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { runtimeFailureDiagnostics } from './helpers/runtime-failure-diagnostics.mjs';

for (const finalValid of [false, true]) test(`skill-ergonomics native full replacement ${finalValid ? 'explicit complete repair' : 'keeps invalid final candidate unverified'}`, async t => {
  const f = await fixture(t); f.state.useNativeGraph = true;
  f.state.skillReviewScript = ({ review, graph, index }) => {
    // Each invocation independently emits a new scripted object after genuine
    // current original-page reads. No previous response is merged or inherited.
    const foreign = { constraintId: graph.constraints.at(-1).constraintId, conditionId: 'baseline-only-claim', judgement: 'UNVERIFIED',
      conditionAssessment: { activation: 'UNKNOWN', evidenceKind: 'PROCESS_EVENT', reason: 'Controlled wrong namespace.' }, actualEvidence: ['skill/SKILL.md'] };
    const result = { ...review, conditionalAssessments: index === 2 && finalValid ? [] : [foreign] };
    if (index === 1) delete result.sourceInterpretationReviews;
    return result;
  };
  const selected = await f.select();
  const stopped = await f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' });
  if (f.state.skillReviewCandidates.length !== 3) {
    const token = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : undefined;
    t.diagnostic(JSON.stringify({ phase: 'SKILL_REPAIR_CANDIDATE_COUNT',
      selectedStopStatus: token(selected?.stop?.status), observedCandidates: f.state.skillReviewCandidates.length,
      graphRequests: f.calls.filter(call => call.request?.skillGraphOnly).length,
      skillReviewRequests: f.calls.filter(call => call.role === 'skill-reviewer' && !call.request?.skillGraphOnly).length,
      diagnostics: await runtimeFailureDiagnostics({ root: f.root, calls: f.calls,
        post: { phase: 'STOP_RETURNED', reviewStatus: stopped?.stop?.status, reasonCode: stopped?.stop?.reasonCode } }) }));
  }
  assert.equal(f.state.skillReviewCandidates.length, 3, 'one initial response plus the unchanged two repairs');
  assert.equal(Object.hasOwn(f.state.skillReviewCandidates[1], 'sourceInterpretationReviews'), false);
  assert.equal(f.state.skillReviewCandidates[2].sourceInterpretationReviews.length, f.state.nativeInput.evidence.skillGroundTruth.constraints.length);
  assert.equal(stopped.stop.status, finalValid ? 'NO_DEVIATION_FOUND' : 'UNVERIFIED', JSON.stringify(stopped));
  const request = f.calls.find(call => call.role === 'skill-reviewer').request;
  const graph = await readJson(await f.graphFile()), navigation = request.canonicalConditionalTargets;
  assert.equal(navigation.expected.count, 0); assert.deepEqual(navigation.expected.keys, []);
  assert.equal(navigation.basis.skillId, graph.skillId); assert.equal(navigation.basis.graphDigest, sha256(graph));
  assert.match(navigation.namespace, /baseline/i); assert.equal(navigation.navigationOnly, true);
  const repairs = f.state.skillReviewPrompts.slice(1).map(value => value.prompt);
  assert.match(repairs[0], /REVIEW_CONDITION_ASSESSMENT_REQUIRED/); assert.match(repairs[0], /\/conditionalAssessments/);
  assert.match(repairs[1], /SKILL_SOURCE_INTERPRETATION_REQUIRED/); assert.match(repairs[1], /\/sourceInterpretationReviews/);
  for (const prompt of repairs) {
    assert(Buffer.byteLength(prompt) <= 8192, 'the complete diagnostic plus repair instructions fit the bound');
    assert.match(prompt, /complete SKILL_REVIEW object/); assert.match(prompt, /sourceInterpretationReviews/);
    assert.match(prompt, /conditionalAssessments/); assert.match(prompt, /not a patch/);
    assert.match(prompt, /CONFIRMED/); assert.match(prompt, /original evidence/);
  }
  const timeouts = f.state.skillReviewPrompts.map(value => value.timeoutMs);
  assert(timeouts.every((value, index) => value > 0 && (!index || value <= timeouts[index - 1])), 'follow-ups never renew the current deadline');
  for (const instructions of [f.graphs()[0].request.instructions, request.instructions]) {
    const text = instructions.join('\n');
    assert.match(text, /later.*workflow|workflow.*later/i); assert.match(text, /function-runtime/);
    assert.match(text, /same actor/i); assert.match(text, /complete original/); assert.match(text, /UNCERTAIN/);
  }
});

