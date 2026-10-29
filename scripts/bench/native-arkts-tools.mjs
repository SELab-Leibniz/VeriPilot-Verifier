// Controlled business-agent tools, identical in both benchmark arms. They
// expose only workspace navigation and fixed build/test operations, no shell,
// Git history, evaluator paths, hidden tests or gold answers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function createArktsBenchTools({ outputRoot, projectRoot, toolRoot, stableNavigationRoot, checkTimeoutMs = 180000, baselineLocalTests = null, pagedReads = false }) {
  if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1000) throw new Error('A positive project-check timeout is required.');
  const directory = path.join(outputRoot, 'bench-tools'); await fs.mkdir(directory);
  const checkScript = fileURLToPath(new URL('./run-arkts-toolchain.ps1', import.meta.url));
  const navigationModule = pathToFileURL(path.join(stableNavigationRoot, 'lib/review-task/live-source-tools.mjs')).href;
  const boundedProcessModule = new URL('./bounded-process.mjs', import.meta.url).href;
  const localEvidenceModule = new URL('./local-test-evidence.mjs', import.meta.url).href;
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'rc-arkts-bench-tools', version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  await fs.writeFile(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id: 'rc-arkts-bench-tools', name: 'Controlled ArkTS benchmark tools',
    main: './index.mjs', activation: { onStartup: true }, contracts: { tools: ['bench_nav', 'bench_check', ...(pagedReads ? ['bench_read'] : [])] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  await fs.writeFile(path.join(directory, 'index.mjs'), `import path from 'node:path';
import {createLiveSourceTools} from ${JSON.stringify(navigationModule)};
import {runBoundedProcess} from ${JSON.stringify(boundedProcessModule)};
import fs from 'node:fs/promises';
import {localTestEvidence,publicLocalTestEvidence} from ${JSON.stringify(localEvidenceModule)};
const baselineLocalTests=${JSON.stringify(baselineLocalTests)};
const root=${JSON.stringify(projectRoot)}, toolRoot=${JSON.stringify(toolRoot)}, script=${JSON.stringify(checkScript)}, checkTimeoutMs=${checkTimeoutMs};
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const inside=file=>{const r=path.relative(root,file);if(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r))throw Error('Outside benchmark workspace');};
export default {id:'rc-arkts-bench-tools',name:'Controlled ArkTS tools',register(api){
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
 async execute(id,args,signal){return tools.get(args.action).execute(id,args,signal);}}, {names:['bench_nav']});
 api.registerTool(ctx=>ctx.sessionKey?.includes(':runtime-corrector:')?null:{name:'bench_check',label:'Project check',
 description:'Run a fixed project check with the installed HarmonyOS toolchain. build uses devecocli; test returns actual runtime pass/fail counts for the available original local tests. Full output is saved at outputPath. No arbitrary commands.',
 parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['build','test']}}},
 async execute(id,args,signal){
  if(!['build','test'].includes(args.action))throw Error('Unknown check');
  const started=Date.now(), coverage=path.join(root,'entry/.test/default/intermediates/test/coverage_data/coverage.log');
  if(args.action==='test')await fs.rm(coverage,{force:true});
  const directory=path.join(root,'.runtime-correction/bench-checks'); await fs.mkdir(directory,{recursive:true});
  const outputPath=path.join(directory,String(started)+'-'+args.action+'.log');
  let fullOutput='';
  const checked=await runBoundedProcess('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Project',root,'-ToolRoot',toolRoot,'-Phase',args.action],{cwd:root,signal,timeoutMs:checkTimeoutMs,onOutput(value){fullOutput+=value;}});
  await fs.writeFile(outputPath,fullOutput);
  let localTests;
  if(args.action==='test'){
    const stat=await fs.stat(coverage).catch(()=>null), fresh=Boolean(stat&&stat.mtimeMs>=started-2000);
    const current=localTestEvidence(fresh?await fs.readFile(coverage,'utf8'):'',checked,{freshReport:fresh,compileOutput:fullOutput});
    localTests={...publicLocalTestEvidence(current,baselineLocalTests),reportPath:fresh?coverage:null,
      interpretation:'Only tests present in this business workspace; no hidden evaluation tests or expected benchmark IDs.'};
  }
  return result({action:args.action,...checked,outputPath,...(localTests?{localTests}:{}),notice:'Compiler/test runner exit alone does not prove every required behavior. An interrupted or incomplete output cannot certify checks.'});
 }}, {names:['bench_check']});
}};
`);
  return { id: 'rc-arkts-bench-tools', path: directory };
}
