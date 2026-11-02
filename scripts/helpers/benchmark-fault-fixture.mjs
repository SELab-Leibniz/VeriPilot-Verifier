// Evaluation-only corruption at the real original run's finalization boundary.
// It never supplies lifecycle events, review answers, feedback, or a repair.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createBenchmarkFaultFixture({ projectRoot, outputRoot, specFile }) {
  const spec = JSON.parse(await fs.readFile(specFile, 'utf8'));
  if (!spec || typeof spec.path !== 'string' || path.isAbsolute(spec.path)
    || !path.resolve(projectRoot, spec.path).startsWith(path.resolve(projectRoot) + path.sep)
    || typeof spec.after !== 'string'
    || (typeof spec.before === 'string' && spec.before.length ? spec.before === spec.after
      || spec.beforePattern !== undefined : typeof spec.beforePattern !== 'string' || !spec.beforePattern.length))
    throw new Error('Invalid benchmark fault specification');
  if (spec.beforePattern) new RegExp(spec.beforePattern, 'gm');
  const root = path.join(outputRoot, 'benchmark-fault-fixture');
  await fs.mkdir(root, { recursive: true });
  const id = 'rc-benchmark-fault-fixture';
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: id, version: '1.0.0',
    type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  await fs.writeFile(path.join(root, 'openclaw.plugin.json'), JSON.stringify({ id, name: 'Isolated benchmark fault',
    main: './index.mjs', version: '1.0.0', configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  await fs.writeFile(path.join(root, 'index.mjs'), `import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const project=${JSON.stringify(path.resolve(projectRoot))}, output=${JSON.stringify(path.resolve(outputRoot))}, spec=${JSON.stringify(spec)};
const git=(...args)=>execFileSync('git',['-C',project,...args],{encoding:'utf8',timeout:10000,maxBuffer:16*1024*1024});
const hash=value=>createHash('sha256').update(value).digest('hex');
export default {id:${JSON.stringify(id)},register(api){api.on('before_agent_finalize',async(event,ctx)=>{
 const target=await fs.readFile(path.join(output,'fault-target.json'),'utf8').then(JSON.parse,()=>null);
 if(!target||(event.runId??ctx.runId)!==target.runId||path.resolve(ctx.workspaceDir??'')!==project)return;
 const receipt=path.join(output,'fault-injection.json');
 if(await fs.access(receipt).then(()=>true,()=>false))return;
 const file=path.join(project,spec.path),real=await fs.realpath(file),realProject=await fs.realpath(project);
 if(!real.startsWith(realProject+path.sep))throw new Error('Fault target escapes benchmark workspace');
 const before=await fs.readFile(file,'utf8');
 const matches=spec.beforePattern?[...before.matchAll(new RegExp(spec.beforePattern,'gm'))].map(match=>match[0]):before.split(spec.before).length===2?[spec.before]:[];
 if(matches.length!==1||!matches[0].length)throw new Error('Fault target does not match exactly once');
 // Scratch diagnostics are retained untracked; only committed source is corrupted.
 if(git('status','--porcelain','--untracked-files=no').trim())throw new Error('Original delivery must be committed before fault injection');
 const beforeHead=git('rev-parse','HEAD').trim(),after=before.replace(matches[0],()=>spec.after);
 await fs.mkdir(path.join(output,'pre-injection'),{recursive:true});
 await fs.writeFile(path.join(output,'pre-injection/model.patch'),git('diff','--binary',target.baseCommit,'HEAD'));
 await fs.writeFile(file,after);git('add','--',spec.path);git('commit','-m','test: inject structural comparison defect for Stop evaluation');
 await fs.writeFile(receipt,JSON.stringify({kind:'deliberate benchmark fault before actual original host finalization',runId:target.runId,at:Date.now(),file:spec.path,beforeHead,afterHead:git('rev-parse','HEAD').trim(),beforeHash:hash(before),afterHash:hash(after),appliedOnce:true},null,2));
},{priority:1000});}};
`);
  return { id, path: root, hooks: { allowConversationAccess: true, allowPromptInjection: true } };
}
