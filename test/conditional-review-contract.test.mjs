import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as contract from '../lib/review-task/task-evidence.mjs';
import { validateDecision, captureFiles } from '../lib/review-task/review-task.mjs';
import { validateReviewJudgement } from '../lib/runtime-v2/review-result-validation.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import * as runtime from '../lib/runtime-v2/orchestrator.mjs';

const assessment = activation => ({ activation, reason: 'Current original evidence establishes the condition at this boundary.', evidenceKind: 'TARGET_FACTS' });
const object = { objectId: 'M12:C', metricId: 'M12', sourceId: 'C', sourceRevisionId: 'C@1', hard: true,
  applicabilityKind: 'CONDITIONAL', verificationTarget: 'ARTIFACT' };

test('shared conditional contract rejects inactive NYA and never treats a tag or unknown as proof', () => {
  const validate = contract.validateConditionalAssessment;
  assert.equal(typeof validate, 'function');
  const context = { policy: contract.CONDITIONAL_REVIEW_POLICY_VERSION, objectId: 'C', basisComplete: true,
    currentCursor: 'current-snapshot', targetEvidence: true, processEvidence: false };
  assert.throws(() => validate({ assessment: assessment('INACTIVE_AT_CURRENT_BOUNDARY'), verdict: 'NOT_YET_APPLICABLE', context }), /REVIEW_CONDITION_VERDICT_CONFLICT/);
  assert.throws(() => validate({ assessment: assessment('INACTIVE_AT_CURRENT_BOUNDARY'), verdict: 'NOT_APPLICABLE', context: { ...context, targetEvidence: false } }), /REVIEW_CONDITION_EVIDENCE/);
  assert.throws(() => validate({ assessment: assessment('UNKNOWN'), verdict: 'NOT_APPLICABLE', context }), /REVIEW_CONDITION_VERDICT_CONFLICT/);
  const checked = validate({ assessment: assessment('INACTIVE_AT_CURRENT_BOUNDARY'), verdict: 'NOT_APPLICABLE', context });
  assert.equal(checked.policy, context.policy); assert.equal(checked.cursor, context.currentCursor);
  assert.equal(validate({ assessment: assessment('PENDING_REQUIRED_TRIGGER'), verdict: 'NOT_YET_APPLICABLE', context }).activation, 'PENDING_REQUIRED_TRIGGER');
});

test('negative process coverage includes interleaved records, rejects ambiguity and invalidates on a later append', async t => {
  const f = await stopProtocolFixture(t), transcript = path.join(f.root, 'window.jsonl');
  const call = (id, name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const result = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Exit code 0' }] } });
  const entries = [call('verify', 'Bash'), call('write', 'Write'), result('write'), result('verify'), { type: 'assistant', message: { content: 'Done.' } }];
  const text = entries.map(e => JSON.stringify(e)).join('\n') + '\n'; await fs.writeFile(transcript, text);
  const captured = await contract.captureConditionSnapshot({ entries, digest: sha256(text) }, transcript);
  assert.equal(captured.complete, true);
  const base = { entries, afterCallId: 'verify', cursor: captured.cursor, complete: captured.complete, source: captured };
  assert.equal(contract.bindConditionProcessWindow({ ...base, readComplete: i => [0, 3, 4].includes(i) }).complete, false);
  assert.equal(contract.bindConditionProcessWindow({ ...base, readComplete: () => true }).complete, true);
  assert.equal(contract.bindConditionProcessWindow({ ...base, complete: undefined, readComplete: () => true }).complete, false);
  assert.equal(contract.bindConditionProcessWindow({ ...base, entries: [...entries, call('verify', 'Bash')], readComplete: () => true }).complete, false);
  assert.equal(contract.bindConditionProcessWindow({ ...base, entries: [result('verify'), ...entries], readComplete: () => true }).complete, false);
  const bound = contract.bindConditionProcessWindow({ ...base, readComplete: () => true });
  await fs.appendFile(transcript, JSON.stringify(call('later-edit', 'Write')) + '\n');
  assert.equal(await contract.conditionWindowCurrent(bound), false);
  assert.equal((await contract.captureConditionSnapshot({ entries, digest: sha256(text) }, transcript)).complete, false);
});

test('pending/unknown Skill conditions cannot become completed empty-findings PASS; active execution needs actual results', () => {
  const graph = { constraints: [{ constraintId: 'rerun', applicabilityKind: 'CONDITIONAL', statement: 'Run verification if requested.', sourceRef: 'SKILL.md' }] };
  const review = activation => ({ summary: 'Controlled original condition.', completionStatus: 'COMPLETED', findings: [],
    conditionalAssessments: [{ constraintId: 'rerun', conditionAssessment: assessment(activation), actualEvidence: [] }] });
  assert.throws(() => runtime.validateSkillConditionalReview({ review: review('PENDING_REQUIRED_TRIGGER'), graph }), /VERDICT_CONFLICT/);
  assert.equal(runtime.validateSkillConditionalReview({ review: review('UNKNOWN'), graph }).unresolved, true);
  const citations = [
    { usedBy: ['condition:rerun'], readProof: { protocol: 'native-skill-care-v1', observed: true, policy: contract.CONDITIONAL_REVIEW_POLICY_VERSION, owner: 'BASIS', basisComplete: true } },
    { usedBy: ['condition:rerun'], readProof: { protocol: 'native-skill-care-v1', observed: true, policy: contract.CONDITIONAL_REVIEW_POLICY_VERSION, owner: 'PROCESS', fullFile: true, activationFact: true } },
  ];
  assert.equal(runtime.validateSkillConditionalReview({ review: review('ACTIVE'), graph, citations }).unresolved, true);
  const unrelated = { ...review('ACTIVE'), findings: [{ deviationKey: 'independent-doc-fault', violatedGroundTruthIds: ['other-duty'] }] };
  assert.equal(runtime.validateSkillConditionalReview({ review: unrelated, graph, citations }).unresolved, true,
    'a reliable independent finding cannot hide missing fulfillment evidence for another original condition');
  const knownButUnverified = { ...review('ACTIVE'), conditionalAssessments: review('ACTIVE').conditionalAssessments.map(a => ({ ...a, judgement: 'UNVERIFIED' })) };
  assert.equal(runtime.validateSkillConditionalReview({ review: knownButUnverified, graph }).unresolved, true,
    'known activation with unverified fulfillment remains incomplete even at completion');
});

test('SDK decision carries a checked conditional exclusion instead of stripping metadata', async t => {
  const f = await stopProtocolFixture(t), root = path.join(f.root, 'sdk'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'basis.md'), 'Only an array input requires the array branch.');
  await fs.writeFile(path.join(root, 'target.md'), 'The original task uses a number, not an array.');
  const snapshot = await captureFiles(root), reads = [{ path: 'basis.md', start: 1, end: 1 }, { path: 'target.md', start: 1, end: 1 }];
  const bytes = await fs.readFile(path.join(root, 'target.md'));
  const { registerCitation } = await import('../lib/review-task/evidence-utils.mjs');
  const registry = new Map(); const cite = registerCitation({ registry, bytes, file: 'target.md', sha256: snapshot.get('target.md').sha256,
    range: { start: 1, end: 1 } });
  const task = { id: 'C', requirement: 'Only array input activates the branch.', applicabilityKind: 'CONDITIONAL',
    conditionalReviewPolicy: 'current-boundary-v1', basisFiles: ['basis.md'], targetFiles: ['target.md'] };
  const decision = { taskId: 'C', verdict: 'NOT_APPLICABLE', reason: 'The complete original target is numeric.', citeIds: [cite.citeId],
    conditionAssessment: assessment('INACTIVE_AT_CURRENT_BOUNDARY') };
  const result = await validateDecision({ decision, task, root, snapshot, reads, registry });
  assert.equal(result.conditionAssessment.activation, 'INACTIVE_AT_CURRENT_BOUNDARY');
  assert.equal(result.conditionBinding.policy, contract.CONDITIONAL_REVIEW_POLICY_VERSION);
});

test('runtime conditional metadata requires original owner evidence and survives the common boundary', () => {
  const row = { objectId: object.objectId, judgement: 'NOT_YET_APPLICABLE', reason: 'There was no later edit.', evidence: ['current'],
    conditionAssessment: assessment('INACTIVE_AT_CURRENT_BOUNDARY') };
  const citations = [{ path: '/actual/current.md', contentHash: 'current', readProof: { version: 1, observed: true, basisComplete: true, owner: 'ARTIFACT' } }];
  assert.throws(() => validateReviewJudgement({ row, object, citations, classification: { stopClassification: 'TASK_COMPLETE' } }), /REVIEW_CONDITION_VERDICT_CONFLICT/);
});

test('an active requested execution never passes on source-only evidence or inactive labels', () => {
  const processObject = { ...object, verificationTarget: 'PROCESS', description: 'If verification is requested, actually run the test.' };
  const row = { objectId: processObject.objectId, judgement: 'PASS', reason: 'Source exists.', evidence: ['source'], conditionAssessment: assessment('ACTIVE') };
  const source = { path: '/current/app.mjs', contentHash: 'current', readProof: { version: 1, observed: true, basisComplete: true,
    owner: 'SOURCE', fullFile: true, activationFact: true } };
  assert.throws(() => validateReviewJudgement({ row, object: processObject, citations: [source] }), /PROCESS/);
  assert.throws(() => validateReviewJudgement({ row: { ...row, judgement: 'NOT_APPLICABLE' }, object: processObject, citations: [source] }), /VERDICT_CONFLICT/);
  assert.equal(validateReviewJudgement({ row: { ...row, judgement: 'UNVERIFIED', conditionAssessment: assessment('UNKNOWN'), evidence: [] },
    object: processObject, citations: [] }).judgement, 'UNVERIFIED');
});

test('native workspace repairs a conditional conflict before ACK while retaining the complete checklist', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.request.population = { metrics: { M12: [object] } };
  const claim = { ...f.input.evidence.groundTruth.claims[0], claimId: 'C', revisionId: 'C@1',
    text: 'When arrays are requested, document the array branch.', applicabilityKind: 'CONDITIONAL', verificationTarget: 'ARTIFACT' };
  f.input.evidence.groundTruth.claims = [claim]; await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(f.input.evidence.groundTruth));
  let reached = false;
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    const source = await read(f.file), args = { taskId: object.objectId, verdict: 'NOT_YET_APPLICABLE',
      reason: 'The current complete target is numeric.', citeIds: [source.details.citation.citeId], conditionAssessment: assessment('INACTIVE_AT_CURRENT_BOUNDARY') };
    let error; try { await submit('submit_review', args); } catch (cause) { error = cause; }
    reached = true; assert.match(error?.message ?? '', /REVIEW_CONDITION_VERDICT_CONFLICT/);
    assert.equal((await submit('review_checklist', {})).pending, 1);
    await submit('submit_review', { ...args, verdict: 'NOT_APPLICABLE', finish: true });
  });
  assert(reached); assert.equal(handle.result.metricObjectJudgements[0].judgement, 'NOT_APPLICABLE');
  assert.equal(handle.proofs[object.objectId].conditionBinding.policy, contract.CONDITIONAL_REVIEW_POLICY_VERSION);
});
