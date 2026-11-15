import assert from 'node:assert/strict';
import test from 'node:test';
import { auditFrameSelection, createFrameSelectionLedger } from '../lib/runtime-v2/frame-selection.mjs';
import { countFrameDispositions } from '../lib/runtime-v2/requirement-frame.mjs';

const scenario = (id, symbol = 'Consumer.apply', kind = 'requirement') => ({ id, type: 'scenario', kind,
  confidence: .1, contractCell: 'values_defaults', entryPoint: { path: 'consumer.ts', symbol },
  given: 'The original loader substitute returns success for an empty target.' });
const row = (id, decision = 'select', extra = {}) => ({ id, decision, reason: 'Source establishes this input boundary.', ...extra });

test('selection audits missing, repeated, unknown and unexplained dispositions before delivery', () => {
  const candidates = [scenario('A'), scenario('B')];
  for (const reviews of [[row('A')], [row('A'),row('A')], [row('A'),row('Z')], [row('A'),row('B','reject',{reason:' '})]])
    assert.equal(auditFrameSelection(candidates,{reviews}).complete,false);
  assert.equal(auditFrameSelection(candidates,{reviews:[row('A'),row('B')]}).complete,true);
});

test('coverage cannot merge a public caller into its callee, a preservation into a changed effect, or a cycle', () => {
  for (const other of [scenario('B','Loader.load'),scenario('B','Consumer.apply','preservation')])
    assert.equal(auditFrameSelection([scenario('A'),other],{reviews:[row('A'),row('B','covered',{coveredBy:'A'})]}).complete,false);
  assert.equal(auditFrameSelection([scenario('A'),scenario('B')],{reviews:[row('A','covered',{coveredBy:'B'}),row('B','covered',{coveredBy:'A'})]}).complete,false);
  assert.equal(auditFrameSelection([scenario('A'),scenario('B')],{reviews:[row('A'),row('B','covered',{coveredBy:'A'})]}).complete,true);
});

test('over-quota scenarios and family checks stay incomplete; no candidate is silently truncated', () => {
  for (const candidates of [Array.from({length:7},(_,i)=>scenario(String(i))),
    Array.from({length:6},(_,i)=>({id:String(i),type:'check',family:'projectRules'}))]) {
    const audit=auditFrameSelection(candidates,{reviews:candidates.map(x=>row(x.id))});
    assert.equal(audit.complete,false);
    assert.equal(audit.dispositions.length,candidates.length);
    assert(audit.issues.some(x=>x.includes('limit')));
  }
});

test('classification labels do not prevent equivalent checks from being covered', () => {
  const a=scenario('A'),b={...scenario('B'),contractCell:'owner_signature'};
  const audit=auditFrameSelection([a,b],{reviews:[row('A'),row('B','covered',{coveredBy:'A'})]});
  assert.equal(audit.complete,true);
  const other=scenario('C','Loader.load');
  const bad=auditFrameSelection([a,other],{reviews:[row('A'),row('C','covered',{coveredBy:'A'})]});
  assert.equal(bad.complete,false);
  assert(bad.issues.some(x=>x.includes('Consumer.apply')&&x.includes('Loader.load')));
});

test('Stop requires the original entry and dependency prerequisites, and an explicit current-code trace', () => {
  const original=scenario('S1'), frame={guidance:[],scenarios:[original]};
  const assess={entryPoint:original.entryPoint,given:original.given,applicability:'APPLICABLE',
    trace:'consumer.ts:12 guards the empty target before write(), including when the original loader returns success.'};
  const checked={id:'S1',disposition:'CHECKED',reason:'Guard dominates the first write.',contractAssessment:assess};
  const count = entry => countFrameDispositions(frame,[entry],()=>[],()=>false);
  assert.equal(count({...checked,reason:''}),null);
  assert.equal(count({...checked,contractAssessment:undefined}),null);
  assert.equal(count({...checked,contractAssessment:{...assess,entryPoint:{path:'consumer.ts',symbol:'Loader.load'}}}),null);
  assert.equal(count({...checked,contractAssessment:{...assess,given:'A new mock returns failure.'}}),null);
  assert.equal(count({...checked,contractAssessment:{...assess,trace:' '}}),null);
  assert.equal(count(checked).checked,1);
  const bound=count({...checked,contractAssessment:{applicability:assess.applicability,trace:assess.trace}});
  assert.deepEqual(bound.items[0].contractAssessment.entryPoint,original.entryPoint);
  assert.equal(bound.items[0].contractAssessment.given,original.given);
  const na={...checked,reason:'The later original request explicitly removed this input from scope.',
    contractAssessment:{...assess,applicability:'NOT_APPLICABLE',trace:'U2 narrows the operation to nonempty targets; consumer.ts:12 keeps the old empty branch.'}};
  assert.equal(count(na).items[0].contractAssessment.applicability,'NOT_APPLICABLE');
  assert.equal(count({id:'S1',disposition:'UNVERIFIED',reason:'Original suite fails; setup interference is not established.'}).unverified,1);
});

test('incremental decisions retain valid siblings, explicit pending and bounded publication', () => {
  const candidates=Array.from({length:8},(_,i)=>scenario(String(i)));
  const ledger=createFrameSelectionLedger(candidates);
  let view=ledger.submit([row('0'),row('1','covered',{coveredBy:'unknown'}),null]);
  assert.equal(view.publishable,true);
  assert.equal(view.dispositions.find(x=>x.id==='1').decision,'pending');
  assert.equal(view.complete,false);
  view=ledger.submit(candidates.slice(1).map(x=>row(x.id)));
  assert.equal(view.dispositions.filter(x=>x.decision==='select').length,6);
  assert.equal(view.dispositions.filter(x=>x.decision==='deferred').length,2);
  assert.equal(view.complete,false);
  view=ledger.submit([row('6','covered',{coveredBy:'0'}),row('7','reject')]);
  assert.equal(view.complete,true);
  assert.equal(view.dispositions.find(x=>x.id==='0').decision,'select');
});

test('receipts reject conflicting duplicates and cover cycles without erasing prior accepted work', () => {
  const ledger=createFrameSelectionLedger([scenario('A'),scenario('B'),scenario('C','Other.entry')]);
  ledger.submit([row('A')]);
  let view=ledger.submit([row('A','reject'),row('A'),row('B','covered',{coveredBy:'C'}),row('C','covered',{coveredBy:'B'})]);
  assert.equal(view.dispositions[0].decision,'select');
  assert.equal(view.dispositions[1].decision,'pending');
  view=ledger.submit([row('B','covered',{coveredBy:'A'}),row('C','defer')]);
  assert.equal(view.dispositions[1].decision,'covered');
  assert.equal(view.dispositions[2].decision,'deferred');
  const cycle=createFrameSelectionLedger([scenario('X'),scenario('Y')]).submit([
    row('X','covered',{coveredBy:'Y'}),row('Y','covered',{coveredBy:'X'})]);
  assert.equal(cycle.publishable,false);
  assert(cycle.dispositions.every(x=>x.decision==='pending'));
});
