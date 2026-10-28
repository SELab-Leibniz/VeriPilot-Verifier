// Controlled business-agent tools, identical in both benchmark arms. They
// expose only workspace navigation and fixed build/test operations, no shell,
// Git history, evaluator paths, hidden tests or gold answers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function createArktsBenchTools({ outputRoot, projectRoot, toolRoot, stableNavigationRoot }) {
  const directory = path.join(outputRoot, 'bench-tools'); await fs.mkdir(directory);
  const checkScript = fileURLToPath(new URL('./run-arkts-toolchain.ps1', import.meta.url));
  const navigationModule = pathToFileURL(path.join(stableNavigationRoot, 'lib/review-task/live-source-tools.mjs')).href;
  const boundedProcessModule = new URL('./bounded-process.mjs', import.meta.url).href;
  const hypiumModule = new URL('./hypium-results.mjs', import.meta.url).href;
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'rc-arkts-bench-tools', version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  await fs.writeFile(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id: 'rc-arkts-bench-tools', name: 'Controlled ArkTS benchmark tools',
    main: './index.mjs', activation: { onStartup: true }, contracts: { tools: ['bench_nav', 'bench_check'] },
    configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  await fs.writeFile(path.join(directory, 'index.mjs'), `import path from 'node:path';
import {createLiveSourceTools} from ${JSON.stringify(navigationModule)};
import {runBoundedProcess} from ${JSON.stringify(boundedProcessModule)};
import fs from 'node:fs/promises';
import {parseHypium} from ${JSON.stringify(hypiumModule)};
const root=${JSON.stringify(projectRoot)}, toolRoot=${JSON.stringify(toolRoot)}, script=${JSON.stringify(checkScript)};
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const inside=file=>{const r=path.relative(root,file);if(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r))throw Error('Outside benchmark workspace');};
export default {id:'rc-arkts-bench-tools',name:'Controlled ArkTS tools',register(api){
 const tools=new Map(createLiveSourceTools(root,{onPath(requested,real){inside(requested);inside(real);}}).map(t=>[t.name,t]));
 api.registerTool(ctx=>ctx.sessionKey?.includes(':runtime-corrector:')?null:{name:'bench_nav',label:'Workspace navigation',
 description:'Find source paths, list directories or search literal text inside this workspace. Navigation grants no execution or correctness evidence.',
 parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['ls','find','grep']},path:{type:'string'},pattern:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}}},
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
  const checked=await runBoundedProcess('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Project',root,'-ToolRoot',toolRoot,'-Phase',args.action],{cwd:root,signal,onOutput(value){fullOutput+=value;}});
  await fs.writeFile(outputPath,fullOutput);
  let localTests;
  if(args.action==='test'){
    const stat=await fs.stat(coverage).catch(()=>null), fresh=Boolean(stat&&stat.mtimeMs>=started-2000);
    const parsed=fresh?parseHypium(await fs.readFile(coverage,'utf8')):null;
    const counts={};for(const status of Object.values(parsed?.statuses??{}))counts[status]=(counts[status]??0)+1;
    const completeRuntime=Boolean(fresh&&checked.outputComplete&&!checked.interrupted&&parsed?.finished&&!parsed.errors.length&&/Finished :entry:.*@UnitTestArkTS/u.test(fullOutput));
    localTests={freshReport:fresh,reportPath:fresh?coverage:null,finished:parsed?.finished===true,completeRuntime,
      allObservedPassed:completeRuntime&&Object.keys(parsed.statuses).length>0&&Object.values(parsed.statuses).every(status=>status==='PASS'),counts,metadataErrors:parsed?.errors??[],
      interpretation:'Only tests present in this business workspace; no hidden evaluation tests or expected benchmark IDs.'};
  }
  return result({action:args.action,...checked,outputPath,...(localTests?{localTests}:{}),notice:'Compiler/test runner exit alone does not prove every required behavior. An interrupted or incomplete output cannot certify checks.'});
 }}, {names:['bench_check']});
}};
`);
  return { id: 'rc-arkts-bench-tools', path: directory };
}
