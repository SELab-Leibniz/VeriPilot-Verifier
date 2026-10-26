import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {groundTruthSourceCatalog,rejectedGroundTruthSource} from '../lib/runtime-v2/ground-truth-provenance.mjs';

test('an observer-owned ancestor name cannot turn legitimate business materials into internal reviewer evidence',async t=>{
 const parent=path.resolve('.runtime-correction/provenance-tests');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'project-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'materials'));const file=path.join(root,'materials/requirements.md');await fs.writeFile(file,'Original business requirement');
 const catalog=await groundTruthSourceCatalog({projectRoot:root,materials:{entries:[{root:path.dirname(file),path:path.basename(file)}]}});
 const operation={authority:'MATERIAL_DERIVED',source:{ref:file,kind:'MATERIAL',subject:'MAIN_TASK'}};
 assert.equal(rejectedGroundTruthSource(operation,catalog),null);
 assert.equal(rejectedGroundTruthSource({...operation,source:{...operation.source,ref:path.join(root,'.runtime-correction/tasks/t/request.json')}},catalog),'INTERNAL_SOURCE');
 const privateFile=path.join(root,'.runtime-correction/reviewer.md');
 const privateCatalog=await groundTruthSourceCatalog({projectRoot:root,materials:{entries:[{root:path.dirname(privateFile),path:path.basename(privateFile)}]}});
 assert.equal(rejectedGroundTruthSource({...operation,source:{...operation.source,ref:privateFile}},privateCatalog),'INTERNAL_SOURCE');
});
