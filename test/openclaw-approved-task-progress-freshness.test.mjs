import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { prefix, tasks, approvedFixture } from './support/openclaw-approved-task-progress-fixture.mjs';

for(const mutation of ['criteria','config','enable-option-after-approval','foreign-user','unarmed'])test(`${mutation} cannot reuse old approval authority`,async t=>{
  const f=await approvedFixture(t,{skipProgress:mutation!=='enable-option-after-approval',unarmed:mutation==='unarmed'});
  if(mutation==='criteria')await fs.appendFile(path.join(f.root,'.runtime-corrector/review.md'),'Check an additional independent duty.\n');
  if(mutation==='config')await fs.appendFile(path.join(f.root,'.runtime-corrector/config.yaml'),'\n# Updated review policy\n');
  if(mutation==='enable-option-after-approval'){const file=path.join(f.root,'.runtime-corrector/config.yaml');await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('skipApprovedTaskProgress: false','skipApprovedTaskProgress: true'));}
  if(mutation==='foreign-user')await fs.appendFile(f.transcript,JSON.stringify({type:'message',id:'foreign-input',parentId:'apply-user',message:{role:'user',content:'A new unrelated requirement.'}})+'\n');
  const before=f.calls.length,{toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  assert.equal(f.calls.length,before+1,JSON.stringify({mutation,warnings:f.warnings}));
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

for(const policy of ['stageMetrics','groundTruthReview'])test(`independent ${policy} work cannot bootstrap approval from incomplete evidence`,async t=>{
  await assert.rejects(approvedFixture(t,{[policy]:true}),/full-plan Proposal review is unavailable or incomplete/u);
});

test('dynamic Ground Truth keeps the ordinary semantic review for approved checkbox progress', async t => {
  const f = await approvedFixture(t, { dynamicGroundTruth: true }), before = f.calls.length;
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  assert.equal(f.calls.length, before + 1);
  assert(!(await f.journal()).some(row => row.toolCallId === toolCallId && row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('fresh deterministic rules remain enforced even when a semantic worker reports no finding',async t=>{
  const f=await approvedFixture(t,{forbidProgress:true}),before=f.calls.length;
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  assert.equal(f.calls.length,before+1);
  const rows=(await f.journal()).filter(row=>row.toolCallId===toolCallId);
  const result=rows.find(row=>row.type==='OPENCLAW_ARTIFACT_REVIEW')?.result;
  assert.equal(result?.status,'failed');assert(result.diagnostics.some(row=>row.ruleId==='REQUIRE-INDEPENDENT-COMPLETION-CHECK'));
  assert(!rows.some(row=>row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('conflicting native event and context run identities receive no shortcut receipt',async t=>{
  const f=await approvedFixture(t),{toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'),{eventRunId:'foreign-run'});
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('a run replaced during the shortcut freshness check cannot publish old integrity evidence',async t=>{
  const f=await approvedFixture(t),before=f.calls.length,readFile=fs.readFile,criteria=path.join(f.root,'.runtime-corrector/review.md');let reads=0,replaced=false;
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'),{beforeResult(){
    t.mock.method(fs,'readFile',async(...args)=>{const value=await readFile(...args);if(args[0]===criteria&&++reads===3){replaced=true;f.state.nativeRunId='replacement';}return value;});
  }});
  assert(replaced,'The run must change inside the policy/input freshness pass.');
  assert.equal(f.calls.length,before,'The obsolete event cannot start a worker for the replacement run.');
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('checkbox reuse still reaches a fresh native final Stop and cannot pass without code evidence',async t=>{
  const bounded = async (phase, timeoutMs, action) => {
    let timer; const startedAt = Date.now();
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Approved-progress fixture: ${phase}`),
          { code: `TEST_${phase}_TIMEOUT` })), timeoutMs);
      })]);
    } catch (error) {
      t.diagnostic(JSON.stringify({ phase, elapsedMs: Date.now() - startedAt, timeoutMs,
        code: /^[A-Z][A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'UNCLASSIFIED_TEST_FAILURE' }));
      throw error;
    } finally { clearTimeout(timer); }
  };
  // Setup includes a separate Proposal review, approval and Apply. Its I/O is
  // outside the original ten-second Stop observation; the file bound stays 180s.
  const f = await bounded('SETUP', 60000, async () => {
    const fixture = await approvedFixture(t);
    await fixture.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
    return fixture;
  });
  await bounded('STOP_OBSERVATION', 10000, async () => {
    await f.runtime.reply({kind:'final',runId:'apply',sessionKey:f.ctx.sessionKey,payload:{text:'Completed the approved work.'}},f.ctx);
    await f.runtime.agentEnd({runId:'apply',success:true},f.ctx);await f.runtime.waitForNativeReviews({drain:true});
    const directory=path.join(f.root,'.runtime-correction/openclaw/native-stop-reviews'),records=[];
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(!entry.isDirectory())continue;for(const name of await fs.readdir(path.join(directory,entry.name))){if(name.endsWith('.json'))records.push(JSON.parse(await fs.readFile(path.join(directory,entry.name,name),'utf8')));}}
    const stop=records.find(row=>row.runId==='apply');assert.equal(stop?.status,'SETTLED');assert.equal(stop?.openSpecPlan?.status,'PRESERVED');
    assert(!['PASS','NO_DEVIATION_FOUND'].includes(stop.reviewStatus),'Host plan integrity does not replace fresh production evidence.');
  });
});
