import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewJudgement, conditionalWitnessReadiness, CONDITIONAL_WITNESS_GUIDANCE } from '../lib/runtime-v2/review-result-validation.mjs';
import { CONDITIONAL_REVIEW_POLICY_VERSION } from '../lib/review-task/task-evidence.mjs';
const object = { objectId:'duty', metricId:'M16', sourceId:'original', sourceRevisionId:'original@1',
  verificationTarget:'IMPLEMENTATION', applicabilityKind:'CONDITIONAL', hard:true, evidenceRequired:true,
  description:'Preserve segment ordering when streaming is enabled.' };
const assessment = { activation:'ACTIVE', evidenceKind:'TARGET_FACTS', reason:'The current source establishes the original activation fact.' };
const row = { objectId:'duty', judgement:'PASS', reason:'The current source preserves the duty.', conditionAssessment:assessment };
const citation = (changes={}) => ({ citeId:'C1',path:'/unshown/source',contentHash:'hash', readProof:{
  version:1, observed:true, basisComplete:true, owner:'SOURCE', fullFile:true, activationFact:true, ...changes } });
function rejected(citations, { expected='REVIEW_CONDITION_EVIDENCE_UNAVAILABLE', currentRow=row, currentObject=object }={}) {
  let caught;
  assert.throws(()=>validateReviewJudgement({row:currentRow,object:currentObject,citations}), error=>{ caught=error;return error.code===expected; });
  assert(caught.witnessReadiness);assert(caught.message.includes('witnessReadiness'));
  assert.equal(caught.witnessReadiness.readProofGranted,false);assert.equal(caught.witnessReadiness.semanticsVerified,false);
  return caught.witnessReadiness;
}
test('valid full SOURCE activation retains PASS and identical condition binding',()=>{
  const accepted=validateReviewJudgement({row,object,citations:[citation()]});
  assert.equal(accepted.judgement,'PASS');assert.equal(accepted.conditionBinding.evidenceKind,'TARGET_FACTS');
  assert.equal(accepted.conditionBinding.policy,CONDITIONAL_REVIEW_POLICY_VERSION);assert(!Object.hasOwn(accepted,'witnessReadiness'));
});
for (const [name,change,predicate] of [['partial',{fullFile:false},'fullFile'],['nonactivation',{activationFact:false},'activationFact'],
 ['unobserved',{observed:false},'observed'],['wrong-version',{version:2},'version'],['incomplete-basis',{basisComplete:false},'basisComplete'],
 ['foreign-owner',{owner:'REVIEWER'},'owner']]) test(`${name} remains unavailable with its actual failed predicate`,()=>{
  const diagnostic=rejected([citation(change)]);assert(diagnostic.citations[0].targetFactsMissing.includes(predicate));
  assert.equal(diagnostic.effectiveContext.targetFactsReady,false);
});
test('ARTIFACT activation never substitutes for a SOURCE fulfillment owner',()=>{
  const diagnostic=rejected([citation({owner:'ARTIFACT'})],{expected:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});
  assert.equal(diagnostic.effectiveContext.targetFactsReady,true);assert.deepEqual(diagnostic.requiredJudgementOwners,['SOURCE']);
  assert.equal(diagnostic.citations[0].requiredOwnerReady,false);
});
test('PROCESS_EVENT keeps its existing PROCESS guard without a new full-file or activation-fact requirement',()=>{
  const process={...object,metricId:'M11',verificationTarget:'PROCESS'}, event={...row,conditionAssessment:{...assessment,evidenceKind:'PROCESS_EVENT'}};
  const accepted=validateReviewJudgement({row:event,object:process,citations:[citation({owner:'PROCESS',fullFile:false,activationFact:false})]});
  assert.equal(accepted.judgement,'PASS');assert.equal(accepted.conditionBinding.evidenceKind,'PROCESS_EVENT');
  const diagnostic=rejected([citation()],{currentRow:event,currentObject:process});
  assert.deepEqual(diagnostic.citations[0].processEventMissing,['owner']);assert.equal(event.conditionAssessment.evidenceKind,'PROCESS_EVENT');
  assert(CONDITIONAL_WITNESS_GUIDANCE.includes('not to bypass'));
});
test('event-based activation and separately acknowledged SOURCE fulfillment retain the original valid path',()=>{
  const event={...row,conditionAssessment:{...assessment,evidenceKind:'PROCESS_EVENT'}};
  const accepted=validateReviewJudgement({row:event,object,citations:[citation({fullFile:false,activationFact:false}),citation({owner:'PROCESS',fullFile:false,activationFact:false})]});
  assert.equal(accepted.judgement,'PASS');assert.equal(accepted.conditionBinding.evidenceKind,'PROCESS_EVENT');
});
test('sixteen-citation diagnostics remain bounded, identify each checked position and omit raw paths/content',()=>{
  const citations=Array.from({length:16},(_,i)=>({...citation({version:0,observed:false,basisComplete:false,owner:'MODEL',fullFile:false,activationFact:false}),
    citeId:'秘密'.repeat(2000),path:'/DO_NOT_DISCLOSE_PRIVATE_PATH/'+i}));
  const diagnostic=conditionalWitnessReadiness({citations,object,assessment,context:{}}),raw=JSON.stringify(diagnostic);
  assert.equal(diagnostic.citations.length,16);assert.equal(diagnostic.omittedCitationCount,0);
  assert.deepEqual(diagnostic.citations.map(c=>c.checkedCitationIndex),Array.from({length:16},(_,i)=>i));
  assert(Buffer.byteLength(raw)<6144);assert(!raw.includes('DO_NOT_DISCLOSE'));assert(!raw.includes('秘密'));
});

test('an exact-looking citation range cannot replace the checked fullFile predicate', () => {
  const checked={...citation({fullFile:false}), start:1, end:2, lineStart:1, lineEnd:2};
  const diagnostic=rejected([checked]);
  assert.deepEqual(diagnostic.citations[0].targetFactsMissing,['fullFile']);
  assert.equal(diagnostic.effectiveContext.targetFactsReady,false);
});
