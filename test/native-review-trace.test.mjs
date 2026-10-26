import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {archiveNativeReview,recordNativeRun,listNativeRuns} from '../lib/openclaw/native-runs.mjs';

async function fixture(t){
  const projectRoot=await fs.mkdtemp(path.join(os.tmpdir(),'rc-private-trace-'));
  t.after(()=>fs.rm(projectRoot,{recursive:true,force:true}));
  const requestDirectory=path.join(projectRoot,'.runtime-correction/.internal-requests/private-run');await fs.mkdir(requestDirectory,{recursive:true});
  const transcript=path.join(requestDirectory,'session.jsonl');await fs.writeFile(transcript,'{"type":"session","id":"private-session"}\n');
  return {projectRoot,requestDirectory,transcript,taskId:'task',sessionId:'private-session',retryDelayMs:1};
}

test('private raw trajectory survives cleanup with exact bytes and redacted credentials, and terminal records retain dispatch identity',async t=>{
  const f=await fixture(t),secret='fixture-private-token-123';
  await fs.writeFile(path.join(f.requestDirectory,'request.json'),JSON.stringify({token:secret,basis:'original task'}));
  await recordNativeRun(f.projectRoot,{taskId:f.taskId,sessionId:f.sessionId,runId:'run',role:'stop-reviewer',startedAt:1,sessionFile:f.transcript,status:'DISPATCH_COMMITTED'});
  await recordNativeRun(f.projectRoot,{taskId:f.taskId,runId:'run',status:'SETTLED',settledAt:2});
  const archived=await archiveNativeReview({...f,secrets:[secret]});assert.equal(archived.status,'COMPLETE');
  assert.equal(await fs.readFile(path.join(archived.destination,'session.jsonl'),'utf8'),await fs.readFile(f.transcript,'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(archived.destination,'request.json'),'utf8')).token,'[REDACTED]');
  const [run]=await listNativeRuns(f.projectRoot,f.taskId);assert.equal(run.startedAt,1);assert.equal(run.sessionFile,f.transcript);assert.equal(run.status,'SETTLED');assert.equal(run.trace.status,'COMPLETE');
});

test('busy private trajectory is a recorded gap with finite attempts, recoverable without deleting its source or failure history',async t=>{
  const f=await fixture(t),read=fs.readFile;let busy=true,calls=0;
  fs.readFile=async function(file,...args){if(file===f.transcript){calls++;if(busy)throw Object.assign(new Error('Host owns this file'),{code:'EBUSY'});}return read.call(this,file,...args);};
  try{
    const failed=await archiveNativeReview({...f,retries:2});assert.equal(calls,3);assert.equal(failed.stored,false);assert.equal(failed.status,'EVIDENCE_INCOMPLETE');
    assert(failed.missing.some(item=>item.path==='session.jsonl'));assert.equal((await fs.stat(f.transcript)).isFile(),true);
    busy=false;const recovered=await archiveNativeReview({...f,retries:2});assert.equal(recovered.status,'COMPLETE');
    assert.equal(recovered.files.find(file=>file.path==='session.jsonl').failures.length,3);assert.deepEqual(recovered.history.map(item=>item.status),['EVIDENCE_INCOMPLETE','COMPLETE']);
  }finally{fs.readFile=read;}
});
