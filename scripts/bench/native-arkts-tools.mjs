// Controlled business-agent tools, identical in both benchmark arms. They
// expose only workspace navigation and fixed build/test operations, no shell,
// Git history, evaluator paths, hidden tests or gold answers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function arktsCheckActions({ lintRequirement, publicAcceptance } = {}) {
  return ['build', 'test', ...(lintRequirement ? ['lint'] : []), ...(publicAcceptance ? ['acceptance'] : [])];
}

export function arktsVerificationInstructions(options) {
  return [
    `The project tool bench_check supports ${arktsCheckActions(options).join(', ')}. Use openspec_cli for the OpenSpec workflow.`,
    options?.stage === 'proposal'
      ? 'Complete planning only. Plan verification using the available tools. Leave implementation files unchanged and implementation tasks unchecked until the controller dispatches Apply. Use checkboxes for implementation and required verification. Keep optional checks and their availability in notes outside the checklist.'
      : 'Run project verification through the available tools during Apply. Keep the approved checklist entries and update their completion marks to reflect the work. Record verification blockers in notes outside the entries. A task that only asks for a status report is complete once the status is recorded. Preserve the actual verification outcome in the report.',
    'Derive required checks from the task and applicable repository instructions. Treat command examples as guidance. Record a required check with no available tool as unverified and leave its task unchecked.',
  ].join('\n');
}

export async function createArktsBenchTools({ outputRoot, projectRoot, toolRoot, stableNavigationRoot, checkTimeoutMs = 180000, deadlineAt = null,
  baselineLocalTests = null, pagedReads = false, javaHome = null, publicTestWorker, instrument, publicAcceptance,
  lintRequirement, applyVerificationRunFile = null }) {
  if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1000) throw new Error('A positive project-check timeout is required.');
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) throw new Error('Invalid project-check deadline.');
  if (applyVerificationRunFile) {
    const parent = await fs.realpath(path.dirname(applyVerificationRunFile));
    const relative = path.relative(await fs.realpath(projectRoot), parent);
    if (!path.isAbsolute(applyVerificationRunFile)
      || !(relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))) {
      throw new Error('Apply verification requires a controller marker outside the project.');
    }
  }
  const directory = path.join(outputRoot, 'bench-tools'); await fs.mkdir(directory);
  const navigationModule = pathToFileURL(path.join(stableNavigationRoot, 'lib/review-task/live-source-tools.mjs')).href;
  const editGuardModule = applyVerificationRunFile && pathToFileURL(path.join(stableNavigationRoot, 'lib/openclaw/tools.mjs')).href;
  const boundedProcessModule = new URL('./bounded-process.mjs', import.meta.url).href;
  const toolchainModule = new URL('./arkts-toolchain-runner.mjs', import.meta.url).href;
  const localTestModule = new URL('./arkts-local-test.mjs', import.meta.url).href;
  const localEvidenceModule = new URL('./local-test-evidence.mjs', import.meta.url).href;
  const checkActions = arktsCheckActions({ lintRequirement, publicAcceptance });
  let acceptanceSetup = '';
  let lintSetup = '';
  if (lintRequirement) {
    const lintModule = new URL('./arkts-build-lint-check.mjs', import.meta.url).href;
    lintSetup = `import {runArktsRequiredLint} from ${JSON.stringify(lintModule)};
const lintRequirement=${JSON.stringify(lintRequirement)}, receiptRoot=${JSON.stringify(outputRoot)};`;
  }
  if (publicAcceptance) {
    const { probe, sha256, testIds } = publicAcceptance;
    const acceptanceModule = new URL('./arkts-regression-check.mjs', import.meta.url).href;
    const redactionModule = new URL('../helpers/simplify-native-evaluation.mjs', import.meta.url).href;
    acceptanceSetup = `import {runArktsRequirementProbe} from ${JSON.stringify(acceptanceModule)};
import {redactEvaluationText} from ${JSON.stringify(redactionModule)};
const publicAcceptance=${JSON.stringify({ probe, sha256, testIds })};`;
  }
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'rc-arkts-bench-tools', version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  await fs.writeFile(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id: 'rc-arkts-bench-tools', name: 'Controlled ArkTS benchmark tools',
    main: './index.mjs', activation: { onStartup: true }, contracts: { tools: ['bench_nav', 'bench_check', ...(pagedReads ? ['bench_read'] : [])] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  await fs.writeFile(path.join(directory, 'index.mjs'), `import path from 'node:path';
import {createLiveSourceTools} from ${JSON.stringify(navigationModule)};
import {runBoundedProcess} from ${JSON.stringify(boundedProcessModule)};
import {arktsToolchainCommand} from ${JSON.stringify(toolchainModule)};
import {arktsLocalTestCoveragePath,runArktsLocalTest} from ${JSON.stringify(localTestModule)};
import fs from 'node:fs/promises';
import {localTestEvidence,publicLocalTestEvidence,supportingTestVerification} from ${JSON.stringify(localEvidenceModule)};
${editGuardModule ? `import {isNoopToolRequest} from ${JSON.stringify(editGuardModule)};` : ''}
${acceptanceSetup}
${lintSetup}
const checkActions=${JSON.stringify(checkActions)};
const baselineLocalTests=${JSON.stringify(baselineLocalTests)};
const publicTestWorker=${JSON.stringify(publicTestWorker ?? null)};
const instrument=${JSON.stringify(instrument ?? null)};
const root=${JSON.stringify(projectRoot)}, toolRoot=${JSON.stringify(toolRoot)}, javaHome=${JSON.stringify(javaHome)}, checkTimeoutMs=${checkTimeoutMs};
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const applyVerificationRunFile=${JSON.stringify(applyVerificationRunFile)};
async function readApplyVerificationRun(sessionKey) {
 if(!applyVerificationRunFile||!sessionKey)return null;
 try {
  const marker=JSON.parse(await fs.readFile(applyVerificationRunFile,'utf8'));
  return marker.sessionKey===sessionKey&&typeof marker.runId==='string'
   &&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(marker.runId)?marker.runId:null;
 } catch { return null; }
}
async function verificationResult(value,sessionKey,runId,verification) {
 const original=result(value);
 if(!runId||!['PASS','FAIL','INCOMPLETE'].includes(verification?.status)||runId!==await readApplyVerificationRun(sessionKey))return original;
 return {...original,details:{runtimeCorrectorVerification:{runId,...verification}}};
}
const inside=file=>{const r=path.relative(root,file);if(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r))throw Error('Outside benchmark workspace');};
export default {id:'rc-arkts-bench-tools',name:'Controlled ArkTS tools',register(api){
 ${editGuardModule ? `if(api.runtime?.version==='2026.7.1-2') api.on('before_tool_call',async (event,ctx)=>{
  if(event.toolName!=='edit')return;
  const runId=ctx.runId??event.runId;
  if(!runId||event.runId!=null&&event.runId!==runId||runId!==await readApplyVerificationRun(ctx.sessionKey))return;
  // The pinned host treats a successful no-op edit as terminal. Reject it before execution in both arms.
  if(await isNoopToolRequest('edit',event.params,root)&&runId===await readApplyVerificationRun(ctx.sessionKey))
   return {block:true,blockReason:'RC_NOOP_TOOL_REQUEST. Every replacement matches the existing text. The edit was skipped. Continue the remaining Apply tasks.'};
 },{priority:10});` : ''}
 const tools=new Map(createLiveSourceTools(root,{onPath(requested,real){inside(requested);inside(real);}}).map(t=>[t.name,t]));
 ${pagedReads ? `api.registerTool(ctx=>ctx.sessionKey?.includes(':runtime-corrector:')?null:{name:'bench_read',label:'Read source page',
 description:'Read an exact UTF-8 source page inside this workspace. First locate relevant functions with bench_nav grep, then read their line ranges. Default 120 lines, maximum 250. Offsets are one-based. The returned nextOffset gives access to every remaining line; null means the file ends. Avoid reading whole large files when a targeted range suffices.',
 parameters:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string'},offset:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:250}}},
 async execute(id,args,signal){const offset=args.offset??1,limit=args.limit??120;
  if(!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1||limit>250)throw Error('Use a positive one-based offset and a limit from 1 to 250.');
  return tools.get('read').execute(id,{path:args.path,offset,limit},signal);}}, {names:['bench_read']});` : ''}
 api.registerTool(ctx=>ctx.sessionKey?.includes(':runtime-corrector:')?null:{name:'bench_nav',label:'Workspace navigation',
 description:'Navigate only this workspace. find matches literal path fragments, never globs or regex: use main.ets rather than *.ets. grep searches literal UTF-8 text. ls lists a directory. Narrow path first and follow nextOffset to page. Navigation grants no execution or correctness evidence.',
 parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['ls','find','grep']},path:{type:'string'},pattern:{type:'string',description:'Literal path fragment for find, or literal text for grep; not a glob.'},offset:{type:'integer'},limit:{type:'integer'},includeGenerated:{type:'boolean'}}},
 async execute(id,args,signal){
  const response=await tools.get(args.action).execute(id,args,signal);
  if(args.action==='grep'&&(args.pattern??'').includes('|')){
   const value=JSON.parse(response.content.map(block=>block.text??'').join(''));
   if(value.hits?.length===0)return {...response,...result({...value,
    hint:'grep matches literal text. The pipe character is not OR/alternation. Search each alternative in a separate call or use a shorter exact fragment. This empty result does not establish that the individual alternatives are absent.'})};
  }
  return response;
 }}, {names:['bench_nav']});
 api.registerTool(ctx=>ctx.sessionKey?.includes(':runtime-corrector:')?null:{name:'bench_check',label:'Project check',
 description:'Run a fixed project check with the installed HarmonyOS toolchain. build assembles the entry HAP. test returns runtime pass/fail counts and bounded assertion diagnostics for the available local tests. Full command output is saved at outputPath and each fresh runtime report at localTests.reportPath. Run final checks after finishing the edits they verify.${lintRequirement ? ' lint builds the current HAP, then runs the repository-required CodeLinter on a disposable snapshot. Only success:true confirms this check. Source fixes require explicit edits and a rerun.' : ''}${publicAcceptance ? ' acceptance runs the fixed public task requirement probe and returns its individual check outcomes.' : ''}${instrument ? ' Instrument Test builds the app and test packages before running each native check. Use build when a separate debug HAP check is needed.' : ''}',
 parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:checkActions}}},
 async execute(id,args,signal){
  if(!checkActions.includes(args.action))throw Error('Unknown check');
  const deadlineAt=${JSON.stringify(deadlineAt)};
  const timeoutMs=deadlineAt===null?checkTimeoutMs:Math.min(checkTimeoutMs,deadlineAt-Date.now());
  if(timeoutMs<=0)return result({action:args.action,status:'INCOMPLETE',success:false,exitCode:null,
    interrupted:true,outputComplete:false,reason:'BUSINESS_DEADLINE'});
  const runId=args.action==='test'||args.action==='acceptance'?await readApplyVerificationRun(ctx.sessionKey):null;
  ${lintRequirement ? `if(args.action==='lint'){
    const {status,success,reason,snapshotSha256,build,lint}=await runArktsRequiredLint({projectRoot:root,toolRoot,javaHome,
      outputRoot:receiptRoot,requirement:lintRequirement,timeoutMs,signal});
    return result({action:args.action,status,success,reason,snapshotSha256,hapSha256:build?.hapSha256,
      lint:lint ? {diagnosticCount:lint.diagnosticCount,sourceChanged:lint.sourceChanged,issues:lint.issues} : null});
  }` : ''}
  ${publicAcceptance ? `if(args.action==='acceptance'){
    const {sha256,checks,status,exitCode,reason,snapshotSha256,diagnostics,observed}=await runArktsRequirementProbe({
      project:root,toolRoot,javaHome,...publicAcceptance,timeoutMs,signal,publicTestWorker,instrument});
    const value={action:args.action,sha256,checks:checks.map(({id,status})=>({id,status})),status,exitCode,reason,snapshotSha256,
      ...(diagnostics?.length ? {diagnostics:diagnostics.map(line=>redactEvaluationText(line).slice(0,320))} : {})};
    const pinned=sha256===publicAcceptance.sha256&&checks.length===publicAcceptance.testIds.length
      &&checks.every(({id},index)=>id===publicAcceptance.testIds[index]);
    const attempted=reason==='REQUIREMENT_PROBE_COMPILE_FAILED'
      ||reason!=='REQUIREMENT_PROBE_DEADLINE'&&observed?.some(id=>publicAcceptance.testIds.includes(id));
    return verificationResult(value,ctx.sessionKey,runId,pinned&&attempted?{kind:'acceptance',status}:null);
  }` : ''}
  const started=Date.now();
  const directory=path.join(root,'.runtime-correction/bench-checks'); await fs.mkdir(directory,{recursive:true});
  const outputPath=path.join(directory,String(started)+'-'+args.action+'.log');
  let fullOutput='', checked, testRun;
  if(args.action==='test'){
    testRun=await runArktsLocalTest({projectRoot:root,toolRoot,javaHome,timeoutMs,signal,publicTestWorker,instrument});
    checked=testRun.execution;
    fullOutput=testRun.output;
  }else{
    const tool=arktsToolchainCommand({toolRoot,javaHome,projectRoot:root,phase:args.action});
    checked=await runBoundedProcess(tool.command,tool.args,{env:tool.env,cwd:root,signal,processGroup:true,timeoutMs,onOutput(value){fullOutput+=value;}});
  }
  await fs.writeFile(outputPath,fullOutput);
  let localTests, verification;
  if(testRun){
    const {raw,freshReport}=testRun;
    const reportPath=freshReport?outputPath.slice(0,-4)+'.coverage.log':null;
    if(reportPath)await fs.writeFile(reportPath,raw,{flag:'wx'});
    const current=localTestEvidence(raw,checked,{freshReport,compileOutput:fullOutput});
    localTests={...publicLocalTestEvidence(current,baselineLocalTests),reportPath,sourceReportPath:freshReport?path.join(root,arktsLocalTestCoveragePath):null,
      interpretation:'Only tests present in this business workspace; no hidden evaluation tests or expected benchmark IDs.'};
    verification=supportingTestVerification(current,checked);
  }
  return verificationResult({action:args.action,...checked,outputPath,...(localTests?{localTests}:{}),notice:'Compiler/test runner exit alone does not prove every required behavior. An interrupted or incomplete output cannot certify checks.'},ctx.sessionKey,runId,verification);
 }}, {names:['bench_check']});
}};
`);
  return { id: 'rc-arkts-bench-tools', path: directory };
}
