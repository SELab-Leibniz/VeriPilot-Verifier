import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureFiles } from '../../lib/review-task/review-task.mjs';
import { METRIC_CATALOG } from '../../lib/runtime-v2/metrics.mjs';
const lab=path.dirname(fileURLToPath(import.meta.url)),hash=x=>createHash('sha256').update(x).digest('hex'),read=async p=>JSON.parse(await fs.readFile(path.join(lab,p),'utf8'));
const freeze=await read('freeze.json'),selected=await read('selected.json'),proposal=await read('process-family/v2-proposal.json'),extension=await read('process-family/v2-extension-family.json');
const additions=[];
for(const item of extension.cases){
 assert(!freeze.cases.some(c=>c.id===item.id)&&/^X1[345]-[A-Za-z0-9-]+$/u.test(item.id)&&['M13','M14','M15'].includes(item.metricId)&&['PASS','DEVIATION','UNVERIFIED'].includes(item.expected));
 const directory=path.join(lab,'fixtures',item.id),workspace=path.join(directory,'workspace');await fs.mkdir(workspace,{recursive:true});
 const basis={...item.basisFiles,'basis/metric.json':JSON.stringify({metricId:item.metricId,...METRIC_CATALOG[item.metricId],scope:item.scope})+'\n'};
 for(const [file,body]of Object.entries({...basis,...item.targetFiles})){
  assert(/^(?:basis|project|process)\//u.test(file)&&!file.includes('..')&&!path.isAbsolute(file));
  const target=path.join(workspace,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,body,{flag:'wx'});
 }
 const task={id:item.id,metricId:item.metricId,scope:item.scope,phase:'VERIFICATION',requirement:item.requirement,basisFiles:Object.keys(basis),targetFiles:Object.keys(item.targetFiles),targetPrefixes:['project/','process/']};
 const oracle={expected:item.expected,mechanism:item.expectedMechanism,scope:item.scope};
 await fs.writeFile(path.join(directory,'task.json'),JSON.stringify(task,null,2)+'\n',{flag:'wx'});await fs.writeFile(path.join(directory,'oracle.json'),JSON.stringify(oracle,null,2)+'\n',{flag:'wx'});
 additions.push({id:item.id,metricId:item.metricId,scope:item.scope,split:'holdout',fingerprint:hash(JSON.stringify([...await captureFiles(workspace)].sort(([a],[b])=>a.localeCompare(b)))),taskSha256:hash(await fs.readFile(path.join(directory,'task.json'))),oracleSha256:hash(await fs.readFile(path.join(directory,'oracle.json')))});
}
const v2={...selected,version:'all-metric-selected-v2',selectedAt:new Date().toISOString(),selectionData:'V1 holdout exposed missing-evidence misclassification. Those three old cases are now regression development; six new extension cases frozen before V2 model calls.',profiles:{...selected.profiles,...proposal.profiles}};
await fs.writeFile(path.join(lab,'selected-v2.json'),JSON.stringify(v2,null,2)+'\n',{flag:'wx'});
await fs.writeFile(path.join(lab,'freeze-v2.json'),JSON.stringify({...freeze,extendedAt:new Date().toISOString(),cases:[...freeze.cases,...additions],v2ProfileSha256:hash(await fs.readFile(path.join(lab,'selected-v2.json'))),extensionFamilySha256:hash(await fs.readFile(path.join(lab,'process-family/v2-extension-family.json')))},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'FROZEN',newCases:additions.map(c=>c.id),profileSha256:hash(await fs.readFile(path.join(lab,'selected-v2.json')))}));
