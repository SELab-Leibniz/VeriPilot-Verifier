import test from 'node:test';
import assert from 'node:assert/strict';
import * as validation from '../lib/runtime-v2/review-result-validation.mjs';

const { validateReviewJudgement } = validation;
const object = { objectId: 'original-duty', metricId: 'M12', verificationTarget: 'IMPLEMENTATION',
  implementationRole: 'SUPPORT', applicabilityKind: 'CURRENT_TASK' };
const row = { objectId: object.objectId, judgement: 'PASS', reason: 'Compare the complete original duty.' };
const citation = (owner, changes = {}) => ({ path: '/unpublished/evidence', contentHash: 'current',
  readProof: { version: 1, observed: true, basisComplete: true, owner, ...changes } });
function rejected(citations, currentObject = object, currentRow = row) {
  let caught;
  assert.throws(() => validateReviewJudgement({ row: currentRow, object: currentObject, citations }), error => {
    caught = error; assert.equal(error.code, 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'); return true;
  });
  return caught;
}

test('fully read artifact evidence reports its frozen SOURCE-owner mismatch in native error text', () => {
  const citations = [citation('ARTIFACT'), citation('ARTIFACT')], before = JSON.stringify({ object, row, citations });
  const error = rejected(citations), diagnostic = error.proofOwnerReadiness;
  assert.match(error.message, /^Complete basis and actually read SOURCE evidence were not established\./u);
  assert.match(error.message.slice(0, 320), /Frozen target IMPLEMENTATION\/SUPPORT; required SOURCE; complete acknowledged ARTIFACT:2\/2/u);
  assert(error.message.includes(JSON.stringify({ proofOwnerReadiness: diagnostic })));
  assert.equal(diagnostic.issue, 'PROOF_OWNER_MISMATCH'); assert.deepEqual(diagnostic.requiredOwners, ['SOURCE']);
  assert.deepEqual(diagnostic.received, [{ owner: 'ARTIFACT', total: 2, version1: 2, observed: 2, basisComplete: 2, complete: 2 }]);
  assert.equal(diagnostic.navigationOnly, true); assert.equal(diagnostic.readProofGranted, false);
  assert.equal(diagnostic.assessmentGranted, false); assert.equal(JSON.stringify({ object, row, citations }), before);
});

test('an incomplete basis is distinguished from an absent proof owner', () => {
  const diagnostic = rejected([citation('SOURCE', { basisComplete: false })]).proofOwnerReadiness;
  assert.equal(diagnostic.issue, 'READ_PROOF_INCOMPLETE');
  assert.deepEqual(diagnostic.received, [{ owner: 'SOURCE', total: 1, version1: 1, observed: 1, basisComplete: 0, complete: 0 }]);
});

test('unobserved or unsupported-version citations remain rejected without manufactured acknowledgement', () => {
  for (const change of [{ observed: false }, { version: 2 }]) {
    const cited = citation('SOURCE', change), before = JSON.stringify(cited), diagnostic = rejected([cited]).proofOwnerReadiness;
    assert.equal(diagnostic.issue, 'READ_PROOF_INCOMPLETE'); assert.equal(diagnostic.received[0].complete, 0);
    assert.equal(JSON.stringify(cited), before);
  }
});

test('genuine artifact, source implementation and attributable process proofs retain their accepted paths', () => {
  for (const [target, owner] of [['ARTIFACT', 'ARTIFACT'], ['IMPLEMENTATION', 'SOURCE'], ['PROCESS', 'PROCESS']]) {
    const current = { ...object, verificationTarget: target };
    if (target !== 'IMPLEMENTATION') delete current.implementationRole;
    const cited = citation(owner, { protocol: 'workspace-stop-v1', executionEvidence: true });
    assert.equal(validateReviewJudgement({ row, object: current, citations: [cited] }), row);
  }
  const process = { ...object, verificationTarget: 'PROCESS' };
  const error = rejected([citation('PROCESS', { protocol: 'workspace-stop-v1', executionEvidence: false })], process);
  assert.match(error.message, /^An attributable original execution result is unavailable\./u);
  assert.equal(error.proofOwnerReadiness, undefined);
});

test('arbitrary long subjects and many references produce only bounded enum-and-count diagnostics', () => {
  const secret = 'DO_NOT_COPY_PRIVATE_REF_OR_TEXT_'.repeat(2000);
  const citations = Array.from({ length: 10000 }, (_, i) => ({ ...citation(i % 2 ? 'ARTIFACT' : secret),
    path: secret, citeId: secret, exactQuote: secret }));
  const current = { ...object, description: secret, implementationRole: secret };
  const error = rejected(citations, current), diagnostic = error.proofOwnerReadiness;
  assert.equal(diagnostic.implementationRole, null); assert.equal(diagnostic.citationCount, 10000);
  assert.equal(diagnostic.received.length, 2); assert.equal(diagnostic.received[1].owner, 'UNKNOWN');
  assert(Buffer.byteLength(error.message) < 2048); assert(!error.message.includes('DO_NOT_COPY'));
  assert.equal(diagnostic.received.reduce((sum, group) => sum + group.total, 0), citations.length);
});

test('conditional owner failures retain the original witness diagnostic and rejection', () => {
  const conditional = { ...object, applicabilityKind: 'CONDITIONAL' };
  const currentRow = { ...row, conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'TARGET_FACTS', reason: 'Original condition is active.' } };
  const error = rejected([citation('ARTIFACT', { fullFile: true, activationFact: true })], conditional, currentRow);
  assert.equal(error.proofOwnerReadiness.issue, 'PROOF_OWNER_MISMATCH');
  assert.equal(error.witnessReadiness.effectiveContext.targetFactsReady, true);
  assert.equal(error.witnessReadiness.citations[0].requiredOwnerReady, false);
  assert(error.message.includes('witnessReadiness')); assert(error.message.includes('proofOwnerReadiness'));
});

test('navigation diagnostics cannot be recycled as read proof and empty citations keep their original error', () => {
  const diagnostic = rejected([citation('ARTIFACT')]).proofOwnerReadiness;
  assert.equal(rejected([{ readProof: diagnostic }]).code, 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE');
  const empty = rejected([]);
  assert.equal(empty.message, 'No checked original evidence supports this judgement.');
  assert.equal(empty.proofOwnerReadiness, undefined);
});

test('shared guidance explains targets before freeze without allowing automatic or easier reclassification', () => {
  const guidance = validation.ORIGINAL_PROOF_SUBJECT_GUIDANCE;
  assert.equal(typeof guidance, 'string'); assert(Buffer.byteLength(guidance) < 600);
  for (const text of ['Before freezing', 'ARTIFACT', 'IMPLEMENTATION', 'SUPPORT still requires SOURCE', 'PROCESS',
    'every part and condition', 'Do not borrow unrelated SOURCE', 'reclassify automatically']) assert(guidance.includes(text));
});
