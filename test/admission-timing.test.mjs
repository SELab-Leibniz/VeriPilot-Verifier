import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {admissionTiming} from '../lib/openclaw/admission-timing.mjs';
import {stopFeedbackCurrent} from '../lib/runtime-v2/production-stop.mjs';
import {sha256} from '../lib/runtime-v2/utils.mjs';

test('input timing logs only fixed stages, durations and outcomes, including a pending await', async () => {
  const logs=[];let time=0,release;
  const measure=admissionTiming({info:value=>logs.push(value)},()=>time);
  const pending=measure('gate.owned',()=>new Promise(resolve=>{release=resolve;}));
  time=1020;measure.snapshot();release('not logged: confidential prompt');await pending;measure.flush();
  assert(logs.some(value=>value.includes('"pending":[{"stage":"gate.owned"')));
  assert(logs.some(value=>value.includes('"elapsedMs":1020')));
  assert(!logs.join('').includes('confidential'));
  await assert.rejects(measure('user text / secret',()=>null),/Program-owned/);
});

test('a large read inventory overlaps independent filesystem waits and still detects real edits', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-admission-evidence-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=[];
  for(let i=0;i<1024;i+=32)await Promise.all(Array.from({length:32},async(_,j)=>{
    const file=path.join(root,'source-'+(i+j)+'.txt');await fs.writeFile(file,'current');files.push(file);
  }));
  const record={hard:true,originalRequirementsBasis:true,reviewEvidence:{readPaths:Object.fromEntries(files.map(f=>[f,f])),
    fingerprints:{[files[0]]:sha256('current')}},sourceCitations:[]};
  const findingPath=path.join(root,'.runtime-correction/tasks/task/review-components/round/findings/item.json');
  await fs.mkdir(path.dirname(findingPath),{recursive:true});await fs.writeFile(findingPath,JSON.stringify(record));
  const deviation={objectId:'finding:item',receiptId:sha256(record),findingPath};
  const args={directory:path.join(root,'host'),sessionId:'session',projectRoot:root,taskId:'task',deviations:[deviation]};
  const original=fs.stat;let calls=0,inflight=0,peak=0;
  t.mock.method(fs,'stat',async(...a)=>{
    if(String(a[0]).includes('source-')&&a[1]?.bigint){calls++;inflight++;peak=Math.max(peak,inflight);
      try{await new Promise(resolve=>setImmediate(resolve));return await original(...a);}finally{inflight--;}}
    return original(...a);
  });
  const result=await stopFeedbackCurrent(args);
  assert.equal(result.length,1);
  assert.equal(calls,2048,'each identity compares two files once, without a duplicate whole-tree pass');
  assert(peak>2&&peak<=64,'independent checks are bounded, rather than serial or unbounded');
  t.mock.restoreAll();
  await fs.writeFile(files[0],'changed');
  assert.deepEqual(await stopFeedbackCurrent(args),[],'a real same-path content change still invalidates feedback');
});
