import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {historicalOrderProof,successfulHistoricalResult,partitionHistoricalDeviations,HISTORICAL_ORDER_STATUS,
  classifiedProcessRow,processRepairProof} from '../lib/runtime-v2/historical-order.mjs';
import {createStopCorrectionStore} from '../lib/runtime-v2/stop-correction-store.mjs';
const object={objectId:'M11:rule',verificationTarget:'PROCESS',originalSource:{kind:'PROJECT_FILE',ref:'AGENTS.md',sha256:'source-v1',start:10,end:10}};
const row={judgement:'DEVIATION'};
const events=new Map([['created',{callIndex:1,resultIndex:2,successful:true,callDigest:'create',resultDigest:'created'}],
 ['status',{callIndex:3,resultIndex:4,successful:true,callDigest:'status',resultDigest:'queried'}]]);
const proposal={objectId:object.objectId,requiredFirstEventId:'status',requiredSecondEventId:'created',historicalOnly:true,reason:'The required status check occurred after the original creation.'};
const proof=()=>historicalOrderProof({proposal,object,row,events});

test('unclassified original process claims fail closed while genuine current repairs and source deviations remain actionable',()=>{
  const candidate={...row,objectId:object.objectId,reason:'The old order cannot be undone.'};
  assert.equal(classifiedProcessRow({object,row:candidate}).judgement,'UNVERIFIED');
  assert.equal(candidate.judgement,'DEVIATION');
  assert.equal(classifiedProcessRow({object,row:candidate,historical:true}).judgement,'DEVIATION');
  const repair={objectId:object.objectId,currentResidue:'The active configuration is still debug.',repairAction:'Set the active configuration to release and verify it.'};
  assert.equal(processRepairProof({proposal:repair,object,row:candidate}).kind,'CURRENT_PROCESS_REPAIR');
  assert.equal(classifiedProcessRow({object,row:candidate,repair:true}).judgement,'DEVIATION');
  for(const invalid of [{...repair,currentResidue:''},{...repair,repairAction:' '},{...repair,objectId:'another'}])
    assert.throws(()=>processRepairProof({proposal:invalid,object,row:candidate}),{code:'PROCESS_REPAIR_PROOF_INVALID'});
  const source={...object,verificationTarget:'IMPLEMENTATION'};
  assert.equal(classifiedProcessRow({object:source,row:candidate}).judgement,'DEVIATION');
  assert.equal(classifiedProcessRow({object:{...source,metricId:'M11'},row:candidate}).judgement,'UNVERIFIED',
    'the shared canonical PROCESS owner cannot be bypassed with a legacy target label');
  assert.throws(()=>processRepairProof({proposal:repair,object:source,row:candidate}),{code:'PROCESS_REPAIR_PROOF_INVALID'});
});

test('only successful inverted original process events establish a historical residue',()=>{
  assert.equal(successfulHistoricalResult({is_error:false,content:'{"exitCode":1}'}),false);
  assert.equal(successfulHistoricalResult({is_error:false,content:[{type:'text',text:'{"success":false}'}]}),false);
  assert.equal(successfulHistoricalResult({is_error:true,content:'Created.'}),false);
  assert.equal(successfulHistoricalResult({is_error:false,content:'{"exitCode":0}'}),true);
  for (const value of [
    { status: 'INCOMPLETE', exitCode: null },
    { status: 'UNVERIFIED', exitCode: 0 },
    { status: 'unavailable' },
    { status: 'Timed-Out' },
    { status: 'RUNNING', success: true },
    { status: 'PASS', outputComplete: false, exitCode: 0 },
    { exitCode: 0, interrupted: true },
  ]) assert.equal(successfulHistoricalResult({ content: JSON.stringify(value) }), false);
  assert.equal(successfulHistoricalResult({ content: '{"status":"PASS","exitCode":0,"outputComplete":true}' }), true);
  assert.equal(successfulHistoricalResult({ content: 'Created and ready.' }), true);
  assert.equal(successfulHistoricalResult({ isError: true, content: 'Created.' }), false);
  const p=proof();assert.equal(p.kind,'IRREVERSIBLE_ORDER');assert.equal(p.objectId,object.objectId);
  for(const args of [{proposal:{...proposal,historicalOnly:false}}, {proposal:{...proposal,requiredFirstEventId:'missing'}},
    {proposal:{...proposal,requiredFirstEventId:'created',requiredSecondEventId:'status'}}, {row:{judgement:'UNVERIFIED'}},
    {object:{...object,verificationTarget:'ARTIFACT'}}, {events:new Map([...events].map(([k,v])=>[k,{...v,successful:false}]))},
    {events:new Map([...events].map(([k,v])=>[k,{...v,ambiguous:true}]))}])
    assert.throws(()=>historicalOrderProof({proposal,object,row,events,...args}),/Historical order/);
});

test('same history binds one digest; new events or revised original sources remain distinct',()=>{
  assert.equal(proof().factDigest,proof().factDigest);
  assert.notEqual(proof().factDigest,historicalOrderProof({proposal,object:{...object,objectId:'M11:another-duty'},row,events}).factDigest);
  assert.notEqual(proof().factDigest,historicalOrderProof({proposal,object:{...object,originalSource:{...object.originalSource,sha256:'source-v2'}},row,events}).factDigest);
  const changed=new Map(events);changed.set('created',{...events.get('created'),resultDigest:'a-new-event'});
  assert.notEqual(proof().factDigest,historicalOrderProof({proposal,object,row,events:changed}).factDigest);
});

test('overlapping or same-record actions do not prove a serial historical inversion', () => {
  for (const resultIndex of [3, 5]) {
    const overlapping = new Map(events);
    overlapping.set('created', { ...events.get('created'), resultIndex });
    assert.throws(() => historicalOrderProof({ proposal, object, row, events: overlapping }), { code: 'HISTORICAL_ORDER_PROOF_INVALID' });
  }
});

test('historical closure preserves deviations and does not swallow repairable or unverified work',()=>{
  const d={objectId:object.objectId,receiptId:'proved',result:row};
  const base={complete:true,status:'DEVIATION',deviations:[d],historicalCandidates:[proof()]};
  const p=partitionHistoricalDeviations(base);assert.equal(p.status,HISTORICAL_ORDER_STATUS);assert.equal(p.actionable.length,0);assert.equal(p.historical.length,1);
  assert.equal(base.deviations[0].result.judgement,'DEVIATION');
  assert.equal(partitionHistoricalDeviations({...base,historicalUnverifiedCount:1}).status,'DEVIATION');
  assert.equal(partitionHistoricalDeviations({...base,complete:false}).status,'DEVIATION');
  const mixed=partitionHistoricalDeviations({...base,deviations:[d,{objectId:'M16:repair',result:row}]});
  assert.equal(mixed.actionable[0].objectId,'M16:repair');assert.equal(mixed.status,'DEVIATION');
});

test('three settlements notify once, spend no quota and close distinctly from PASS; cancellation cannot notify',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rc-historical-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createStopCorrectionStore({directory});
  const begin=async(stopId,flowId='flow')=>store.beginStop({sessionId:'session',flowId,stopId,sourceInput:{origin:'HUMAN',id:flowId},
    config:{enabled:true},initialize:{kind:'NEW_SESSION',evidence:'trusted fixture'}});
  await begin('stop');const params={sessionId:'session',stopId:'stop',status:HISTORICAL_ORDER_STATUS,progress:{complete:true},historicalDeviations:[proof()]};
  const first=await store.settleReview(params);assert.equal(first.reviewStatus,HISTORICAL_ORDER_STATUS);assert(first.releasedAt);assert.equal(first.newHistoricalNotices.length,1);
  await store.settleReview(params);await store.settleReview(params);
  const ledger=await store.inspect('session');assert.equal(ledger.used,0);assert.equal(Object.keys(ledger.admissions).length,0);
  assert.equal(ledger.events.filter(x=>x.type==='HISTORICAL_DEVIATION_NOTIFIED').length,1);
  assert.equal(Object.keys(ledger.historicalNotices).length,1);
  await begin('cancelled','new-user-input');const signal=AbortSignal.abort(new Error('User cancelled'));
  await assert.rejects(store.settleReview({...params,stopId:'cancelled',signal}),/cancelled/);
  assert.equal(Object.keys((await store.inspect('session')).historicalNotices).length,1);
  await store.settleReview({...params,stopId:'cancelled'});
  assert.equal(Object.keys((await store.inspect('session')).historicalNotices).length,2,'a genuine new user flow is a distinct notice scope');
});

test('three distinct stage Stops deduplicate the same fact while new events, duties and revisions notify independently', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-historical-stages-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStopCorrectionStore({ directory });
  const settle = async (stopId, history) => {
    await store.beginStop({ sessionId: 'session', flowId: 'same-flow', stopId, sourceInput: { origin: 'HUMAN', id: 'same-user' },
      config: { enabled: true }, initialize: { kind: 'NEW_SESSION', evidence: 'trusted fixture' } });
    await store.bindReviewScope({ sessionId: 'session', stopId, scopeId: 'same-scope', classification: { stopClassification: 'STAGE_COMPLETE', stage: 'proposal' } });
    return store.settleReview({ sessionId: 'session', stopId, status: HISTORICAL_ORDER_STATUS,
      progress: { complete: true }, historicalDeviations: [history] });
  };
  for (const [index, count] of [[1, 1], [2, 0], [3, 0]])
    assert.equal((await settle('stage-' + index, proof())).newHistoricalNotices.length, count);
  const changedEvents = new Map(events); changedEvents.set('created', { ...events.get('created'), resultDigest: 'new-original-event' });
  const newEvent = historicalOrderProof({ proposal, object, row, events: changedEvents });
  const newDuty = historicalOrderProof({ proposal: { ...proposal, objectId: 'M11:other' }, object: { ...object, objectId: 'M11:other' }, row, events });
  const revised = historicalOrderProof({ proposal, object: { ...object, originalSource: { ...object.originalSource, sha256: 'revised-source' } }, row, events });
  for (const [index, history] of [newEvent, newDuty, revised].entries())
    assert.equal((await settle('new-fact-' + index, history)).newHistoricalNotices.length, 1);
  const state = await store.inspect('session');
  assert.equal(Object.keys(state.historicalNotices).length, 4);
  assert.equal(state.used, 0); assert.equal(Object.keys(state.admissions).length, 0);
});
