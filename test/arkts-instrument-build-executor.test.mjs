import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildArktsInstrumentHaps} from '../scripts/bench/arkts-instrument-build.mjs';
import {runArktsInstrumentTests} from '../scripts/bench/arkts-instrument-runtime.mjs';
import {runBoundedProcess} from '../scripts/bench/bounded-process.mjs';

const runner=fileURLToPath(new URL('../scripts/bench/arkts-toolchain-runner.mjs',import.meta.url));
// The instrumentation command backend exercised below is available on macOS.
const macTest=(name,fn)=>test(name,{skip:process.platform!=='darwin'},fn);
const successful=()=>({exitCode:0,interrupted:false,outputComplete:true,reason:'closed',durationMs:1,tail:''});
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'executor-contract-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project');await fs.mkdir(project);
  return {root,project,toolRoot:path.join(root,'immutable-sdk-fixture'),javaHome:path.join(root,'jbr-fixture')};
}
async function reportHap(cwd,target,onOutput,data='hap-'+target) {
  const directory=path.join(cwd,'entry/build/default/outputs',target);
  await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,'entry-'+target+'-unsigned.hap');
  await fs.writeFile(file,data);
  onOutput('[RC_ARKTS_HAP] '+JSON.stringify(file)+'\n');
  return file;
}

macTest('omitting the executor preserves default cancellation before any child launch',async t=>{
  const f=await fixture(t),control=new AbortController();control.abort();
  const options={projectRoot:f.project,toolRoot:f.toolRoot,javaHome:f.javaHome,
    appBuildMode:'debug',deadline:Date.now()+10000,signal:control.signal};
  const ordinary=await buildArktsInstrumentHaps(options);
  const explicit=await buildArktsInstrumentHaps({...options,executor:runBoundedProcess});
  for(const result of [ordinary,explicit]) {
    assert.deepEqual(result.haps,[]);
    assert.equal(result.execution.compileSucceeded,false);
    assert.equal(result.execution.exitCode,null);
    assert.equal(result.execution.reason,'cancelled-before-launch');
    assert.equal(result.execution.interrupted,true);
    assert.equal(result.execution.outputComplete,false);
    assert.equal(result.execution.phases.length,1);
    assert.equal(result.execution.phases[0].phase,'install');
    assert.equal(result.output,'');
  }
});

macTest('forwarded executor receives the original three commands, environment, cwd, deadline, signal and output stream',async t=>{
  const f=await fixture(t),control=new AbortController(),calls=[];
  const originalNow=Date.now;let clock=1000;
  Date.now=()=>clock;
  const deadline=clock+20000;
  const previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='FAKE_MUST_NOT_REACH_TOOL';
  process.env.PUBLIC_EXECUTOR_FIXTURE='retained-public-value';
  try {
    const result=await buildArktsInstrumentHaps({...f,projectRoot:f.project,appBuildMode:'debug',deadline,signal:control.signal,
      executor:async(command,args,options)=>{
        const phase=args[1];calls.push({command,args,options,observedAt:Date.now()});
        options.onOutput('phase '+phase+'\n');
        if(phase!=='install')await reportHap(options.cwd,phase==='instrument-app'?'default':'ohosTest',options.onOutput);
        clock+=12;
        return successful();
      }});
    assert.equal(result.execution.compileSucceeded,true);assert.equal(result.haps.length,2);
    assert.deepEqual(calls.map(c=>c.args),[
      [runner,'install',f.project,f.toolRoot,f.javaHome],
      [runner,'instrument-app',f.project,f.toolRoot,f.javaHome,'debug'],
      [runner,'instrument-test',f.project,f.toolRoot,f.javaHome],
    ]);
    for(const call of calls) {
      assert.equal(call.command,process.execPath);assert.equal(call.options.cwd,f.project);
      assert.equal(call.options.signal,control.signal);assert.equal(call.options.processGroup,true);
      assert.equal(call.options.env.NODE_OPTIONS,undefined);
      assert.equal(call.options.env.PUBLIC_EXECUTOR_FIXTURE,'retained-public-value');
      assert.equal(call.observedAt+call.options.timeoutMs,deadline);
    }
    assert.ok(calls[1].options.timeoutMs<calls[0].options.timeoutMs);
    assert.ok(calls[2].options.timeoutMs<calls[1].options.timeoutMs);
    for(const phase of ['install','instrument-app','instrument-test'])assert.match(result.output,new RegExp('phase '+phase));
    assert.deepEqual(result.execution.phases.map(p=>p.phase),['install','instrument-app','instrument-test']);
  } finally {
    Date.now=originalNow;
    if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;
    delete process.env.PUBLIC_EXECUTOR_FIXTURE;
  }
});

macTest('a genuine failed executor step stops later phases and preserves its failure',async t=>{
  const f=await fixture(t),calls=[];
  const result=await buildArktsInstrumentHaps({...f,projectRoot:f.project,appBuildMode:'test',deadline:Date.now()+10000,
    executor:async(_command,args,{onOutput})=>{
      calls.push(args[1]);onOutput('controlled tool failure\n');
      return {...successful(),exitCode:23,tail:'controlled tool failure'};
    }});
  assert.deepEqual(calls,['install']);assert.equal(result.execution.exitCode,23);
  assert.equal(result.execution.compileSucceeded,false);assert.deepEqual(result.haps,[]);
  assert.equal(result.output,'controlled tool failure\n');
});

macTest('a successful command without a regular HAP cannot become a successful build',async t=>{
  const f=await fixture(t),calls=[];
  const result=await buildArktsInstrumentHaps({...f,projectRoot:f.project,appBuildMode:'debug',deadline:Date.now()+10000,
    executor:async(_command,args,{onOutput})=>{
      calls.push(args[1]);
      if(args[1]==='instrument-app')onOutput('[RC_ARKTS_HAP] '+JSON.stringify(path.join(f.project,'entry/build/default/outputs/default/entry-default-unsigned.hap'))+'\n');
      return successful();
    }});
  assert.deepEqual(calls,['install','instrument-app']);
  assert.equal(result.execution.reason,'instrument-hap-missing-after-build');
  assert.equal(result.execution.compileSucceeded,false);assert.deepEqual(result.haps,[]);
});

macTest('the independently built app HAP stays sealed across the test-HAP phase',async t=>{
  const f=await fixture(t);let app;
  const result=await buildArktsInstrumentHaps({...f,projectRoot:f.project,appBuildMode:'test',deadline:Date.now()+10000,
    executor:async(_command,args,{cwd,onOutput})=>{
      if(args[1]==='instrument-app')app=await reportHap(cwd,'default',onOutput,'original-app');
      if(args[1]==='instrument-test') {
        await reportHap(cwd,'ohosTest',onOutput,'test-hap');
        await fs.writeFile(app,'test-phase-replaced-app');
      }
      return successful();
    }});
  assert.equal(result.execution.reason,'instrument-app-hap-changed');
  assert.equal(result.execution.compileSucceeded,false);assert.deepEqual(result.haps,[]);
});

test('invalid executor values are rejected before any build command',async t=>{
  const f=await fixture(t);
  for(const executor of [null,{},'actor-selected-command'])await assert.rejects(buildArktsInstrumentHaps({
    ...f,projectRoot:f.project,appBuildMode:'debug',deadline:Date.now()+10000,executor}),
    {name:'TypeError',message:'ArkTS instrumentation build executor must be a function'});
});

macTest('runtime preserves build failure and cancellation without executing a device or retaining its case copy',async t=>{
  const f=await fixture(t),save=async(name,value)=>{
    const file=path.join(f.project,name);await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));
  };
  await save('AppScope/app.json5',{app:{bundleName:'com.example.executorfixture'}});
  await save('entry/build-profile.json5',{targets:[{name:'default'},{name:'ohosTest'}]});
  await save('entry/src/main/module.json5',{module:{name:'entry',deviceTypes:['phone']}});
  await save('entry/src/main/ets/Main.ets','original production source');
  await save('entry/src/test/List.test.ets','export default function tests(){}');
  const json5Root=path.join(f.root,'node_modules','json5');await fs.mkdir(json5Root,{recursive:true});
  await fs.writeFile(path.join(json5Root,'package.json'),JSON.stringify({name:'json5',main:'index.cjs'}));
  await fs.writeFile(path.join(json5Root,'index.cjs'),'exports.parse=JSON.parse;');
  const marker=path.join(f.root,'unexpected-device-call');
  const fakeHdc=path.join(f.root,'fake-hdc');
  await fs.writeFile(fakeHdc,'#!/bin/sh\necho invoked > '+JSON.stringify(marker)+'\nexit 99\n',{mode:0o700});
  const control=new AbortController(),calls=[];
  const route={hdc:fakeHdc,server:'127.0.0.1:45477',target:'127.0.0.1:15471',appBuildMode:'debug'};
  for(const step of [
    {...successful(),exitCode:31},
    {...successful(),exitCode:null,interrupted:true,outputComplete:false,reason:'cancelled'},
  ]) {
    const result=await runArktsInstrumentTests({projectRoot:f.project,toolRoot:f.toolRoot,javaHome:f.javaHome,
      json5Package:path.join(json5Root,'package.json'),route,
      expectedDevice:{server:route.server,target:route.target,api:24,type:'phone',bootReady:true},
      timeoutMs:10000,signal:control.signal,buildExecutor:async(command,args,options)=>{
        calls.push({command,args,options});options.onOutput('protected build unavailable\n');
        return step;
      }});
    const call=calls.at(-1);assert.equal(call.args[1],'install');
    assert.notEqual(call.options.cwd,f.project);
    assert.ok(call.options.cwd.startsWith(f.root+path.sep+'rc-it-'));
    assert.equal(call.options.signal,control.signal);
    assert.equal(result.execution.exitCode,step.exitCode);
    assert.equal(result.execution.interrupted,step.interrupted);
    assert.equal(result.execution.reason,step.reason);
    assert.equal(result.execution.compileSucceeded,false);
    assert.equal(result.raw,'');assert.equal(result.freshReport,false);
    await assert.rejects(fs.stat(marker),{code:'ENOENT'});
    assert.deepEqual((await fs.readdir(f.root)).filter(n=>n.startsWith('rc-it-')),[]);
  }
  assert.equal(calls.length,2);
  assert.equal(await fs.readFile(path.join(f.project,'entry/src/main/ets/Main.ets'),'utf8'),'original production source');
});
