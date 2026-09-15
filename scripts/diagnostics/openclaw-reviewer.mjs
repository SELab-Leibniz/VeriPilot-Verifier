// Isolated native SDK regression; never connects to a Gateway or reads original chat/project data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const args=process.argv.slice(2),flags={};
for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1])throw new Error('Use --name value pairs.');flags[args[i].slice(2)]=args[i+1];}
for(const n of Object.keys(flags))if(!['openclaw-root','env-file','key-env','output','repeat'].includes(n))throw new Error('Unknown option '+n);
if(!flags['openclaw-root']||!flags.output)throw new Error('Specify --openclaw-root and --output.');
const hostRoot=path.resolve(flags['openclaw-root']);
if(JSON.parse(await fs.readFile(path.join(hostRoot,'package.json'),'utf8')).version!=='2026.7.1-2')throw new Error('Requires exact OpenClaw 2026.7.1-2.');
const repetitions=Number(flags.repeat??1);if(!Number.isInteger(repetitions)||repetitions<1||repetitions>5)throw new Error('repeat must be 1 through 5.');
const source=fileURLToPath(new URL('../../',import.meta.url));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-native-synthetic-'));
await fs.chmod(root,0o700);
process.env.OPENCLAW_STATE_DIR=root;
process.env.OPENCLAW_CONFIG_PATH=path.join(root,'openclaw.json');
const credentialEnv={...process.env};
for(const line of (flags['env-file']?await fs.readFile(flags['env-file'],'utf8'):'').split(/\r?\n/)){
 const m=line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(m)credentialEnv[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');
}
const key=credentialEnv[flags['key-env']??'ANTHROPIC_AUTH_TOKEN'];if(!key)throw new Error('Missing authorized credential.');
process.env.GLM_REVIEW_DIAGNOSTIC_KEY=key;
const config={agents:{defaults:{workspace:path.join(root,'workspace'),skipBootstrap:true,model:{primary:'review/glm-5.3'},models:{'review/glm-5.3':{}},timeoutSeconds:180,sandbox:{mode:'off'}}},
 models:{providers:{review:{baseUrl:'https://ark.cn-beijing.volces.com/api/coding',api:'anthropic-messages',apiKey:'${GLM_REVIEW_DIAGNOSTIC_KEY}',authHeader:true,models:[{id:'glm-5.3',name:'GLM synthetic reviewer',reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},plugins:{enabled:false},tools:{allow:['read']},logging:{level:'error',consoleLevel:'error'}};
await fs.mkdir(config.agents.defaults.workspace,{recursive:true});
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(config),{mode:0o600});
config.models.providers.review.apiKey=key;
const {createPluginRuntime}=await import(pathToFileURL(path.join(hostRoot,'dist/plugins/runtime/index.js')));
const native=createPluginRuntime();
const {createOpenClawReviewerFactory}=await import(source+'/lib/openclaw/reviewer.mjs');
const {STOP_REVIEW_SCHEMA}=await import(source+'/lib/runtime-v2/reviewer.mjs');
const {makeFixture,checkAssessment}=await import(source+'/scripts/diagnostics/glm-reviewer.mjs');
const report={syntheticOnly:true,hostVersion:'2026.7.1-2',gatewayUsed:false,startedAt:new Date().toISOString(),results:[]};
try{
for(let repetition=1;repetition<=repetitions;repetition++)for(const scenario of ['deviation','corrected','waiting']){
 const project=path.join(root,'workspace',String(repetition),scenario);await fs.mkdir(project,{recursive:true});
 const fixture=await makeFixture(project,scenario);
 for(const [name,contents] of Object.entries(fixture.files))await fs.writeFile(path.join(project,name),contents);
 let calls=0;const traces=[];
 const factory=createOpenClawReviewerFactory({config,runtime:{agent:native.agent}}, {reviewerModel:'review/glm-5.3',reviewerTimeoutMs:180000,
 runEmbeddedAgent:async p=>{calls++;const start=Date.now();console.log(JSON.stringify({event:'native_start',scenario,calls}));
  const value=await native.agent.runEmbeddedAgent(p);traces.push({durationMs:Date.now()-start,stopReason:value.meta?.stopReason,usage:value.meta?.agentMeta?.usage,error:value.meta?.error?.kind});
  const lines=(await fs.readFile(p.sessionFile,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
  traces.at(-1).tools=lines.flatMap(x=>x.message?.content??[]).filter(x=>x.type==='toolCall').map(x=>x.name);
  return value;
 }});
 const started=Date.now();let result;
 try{
 const h=await factory({projectRoot:project,taskId:'synthetic-glm-review',role:'stop-reviewer',reviewer:{session:'detached',effort:'low',timeoutMs:180000},schema:STOP_REVIEW_SCHEMA,
 request:{...fixture.request,files:Object.keys(fixture.files).map(x=>path.join(project,x))},evidence:{groundTruth:fixture.groundTruth,population:fixture.population}});
 result={scenario,assessment:h.result,issues:checkAssessment(fixture,h.result)};await h.close();
 }catch(e){result={scenario,error:String(e.message).replaceAll(key,'<redacted>'),issues:['NATIVE_REVIEW_FAILED']};}
 result.repetition=repetition;result.durationMs=Date.now()-started;result.calls=calls;result.traces=traces;report.results.push(result);
 console.log(JSON.stringify({...result,assessment:undefined}));
 await fs.writeFile(flags.output,JSON.stringify(report,null,2),{mode:0o600});
}
}finally{await fs.rm(root,{recursive:true,force:true});}
if(report.results.some(x=>x.issues.length))process.exitCode=1;
