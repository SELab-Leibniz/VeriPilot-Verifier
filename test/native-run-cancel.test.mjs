import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createOwnedRunCanceller,createStopStartProtocol} from '../lib/openclaw/stop-start-protocol.mjs';
import {createStopCorrectionStore} from '../lib/runtime-v2/stop-correction-store.mjs';

function fixture(){
 const sessions=new Map(),runs=new Map(),aborts=[];
 const cancel=createOwnedRunCanceller({sessionHandle:id=>sessions.get(id),runHandle:id=>runs.get(id),abortSession:id=>{aborts.push(id);return true;}});
 return {sessions,runs,aborts,cancel};
}
test('only the exact current RC-created handle can be aborted',()=>{
 const f=fixture(),handle={runId:'rc-stop-owned'};f.sessions.set('session',handle);f.runs.set(handle.runId,handle);
 assert.deepEqual(f.cancel({sessionId:'session',runId:handle.runId}),{aborted:true,status:'ABORTED'});assert.deepEqual(f.aborts,['session']);
});
test('a replacement user run is untouched even if the old run index remains',()=>{
 const f=fixture();f.runs.set('rc-stop-old',{runId:'rc-stop-old'});f.sessions.set('session',{runId:'user-next'});
 assert.deepEqual(f.cancel({sessionId:'session',runId:'rc-stop-old'}),{aborted:false,status:'NOT_ACTIVE'});assert.deepEqual(f.aborts,[]);
});
test('a foreign session or mismatched handle cannot satisfy cancellation ownership',()=>{
 const f=fixture();f.runs.set('rc-stop-owned',{runId:'rc-stop-owned'});f.sessions.set('session',{runId:'rc-stop-owned'});
 assert.equal(f.cancel({sessionId:'session',runId:'rc-stop-owned'}).aborted,false);
 assert.equal(f.cancel({sessionId:'foreign',runId:'rc-stop-owned'}).aborted,false);assert.deepEqual(f.aborts,[]);
});
test('invalid or ordinary user run identities are rejected before any abort',()=>{
 const f=fixture();for(const input of [{},{sessionId:'s',runId:'user-run'},{sessionId:'',runId:'rc-stop-own'}])
  assert.throws(()=>f.cancel(input),error=>error.code==='RC_NATIVE_CANCEL_IDENTITY_REQUIRED');
 assert.deepEqual(f.aborts,[]);
});
test('a host refusal is explicitly unconfirmed rather than reported aborted',()=>{
 const handle={runId:'rc-stop-own'};
 const cancel=createOwnedRunCanceller({sessionHandle:()=>handle,runHandle:()=>handle,abortSession:()=>false});
 assert.deepEqual(cancel({sessionId:'s',runId:handle.runId}),{aborted:false,status:'UNCONFIRMED'});
});

test('the native cancellation protocol uses its scoped SDK adapter and never privileged Gateway dispatch',async t=>{
 const parent=path.resolve('.runtime-correction/test-temp');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'native-owned-cancel-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'state'),store=createStopCorrectionStore({directory});
 const state={projectRoot:root,sessionId:'session',sessionKey:'agent:main:controlled'};
 await store.beginStop({sessionId:'session',flowId:'flow',stopId:'stop',scope:root,
  sourceInput:{origin:'HUMAN',id:'user'},initialize:{kind:'NEW_SESSION',evidence:'controlled host creation'},config:{enabled:true}});
 await store.settleReview({sessionId:'session',stopId:'stop',status:'DEVIATION',currentDeviations:[{objectId:'M16:R',basisKey:'frozen',reason:'Controlled obligation'}]});
 const admission=await store.reserveFeedback({sessionId:'session',stopId:'stop',packageId:'feedback',basisCurrent:async()=>true});
 const runId='rc-stop-'+admission.id;
 await store.bindHostRequest({sessionId:'session',admissionId:admission.id,request:{runId,sessionKey:state.sessionKey,projectRoot:root,taskId:'task',message:'Current feedback'}});
 const f=fixture(),handle={runId};f.sessions.set('session',handle);f.runs.set(runId,handle);
 const protocol=createStopStartProtocol({runtime:{gateway:{request:()=>assert.fail('Privileged Gateway API must not be called')},subagent:{run(){}}},logger:{warn(){}}},
  {directoryFor:()=>directory,isCurrent:async()=>true,compatibility:async()=>({version:1,onStart:()=>()=>{},drain:async()=>{},cancelOwnedRun:f.cancel})});
 try{await protocol.cancel({state,stopId:'stop',reason:'CONTROLLED_CANCEL'});}finally{await protocol.dispose();}
 assert.deepEqual(f.aborts,['session']);assert.equal((await protocol.findRun({state,runId})).status,'CANCELLED');
 assert.equal((await store.inspect('session')).used,0);
});
