import test from 'node:test';
import assert from 'node:assert/strict';
import {compactSemanticNavigation} from '../lib/runtime-v2/stop-workspace-review.mjs';
test('large repeated semantic navigation becomes a lossless readable pointer, without granting source proof',async()=>{
  const links=Array.from({length:100},(_,i)=>({symbol:'caller-'+i,context:'x'.repeat(200)}));
  let saved;const result=await compactSemanticNavigation(links,[],async value=>{saved=structuredClone(value);return ['basis/semantic-navigation.json'];});
  assert.deepEqual(saved.currentSemanticLinks,links);
  assert.deepEqual(result.semanticNavigationFiles,['basis/semantic-navigation.json']);
  assert.equal(result.navigationOnly,true);
  assert(!('currentSemanticLinks' in result));assert(Buffer.byteLength(JSON.stringify(result))<1000);
});
test('small navigation retains its existing inline contract',async()=>{
  let saved=false;const links=[{symbol:'one'}],removed=[{literal:'old'}];
  const result=await compactSemanticNavigation(links,removed,async()=>{saved=true;});
  assert.deepEqual(result,{currentSemanticLinks:links,removedLiteralUses:removed});assert.equal(saved,false);
});
