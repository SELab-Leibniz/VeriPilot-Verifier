import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { prefix, tasks, approvedFixture } from './support/openclaw-approved-task-progress-fixture.mjs';

test('opt-in authenticated checkbox progress preserves mutation evidence without another semantic worker or fresh PASS', async t => {
  const f = await approvedFixture(t), before = f.calls.length;
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert.equal(f.calls.length, before, JSON.stringify({ warnings: f.warnings, rows: rows.map(row => ({type:row.type,reason:row.reasonCode})) }));
  const skipped = rows.find(row => row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS');
  assert.equal(skipped?.approvedPlanIntegrity.freshSemanticReview, false);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT'));
  assert(rows.some(row => row.type === 'OPENCLAW_FILE_CHANGED'));
  assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW'));
  assert.equal(f.state.nativeNeedsStop, true);
  assert.deepEqual(f.warnings, []);
});

for (const skipProgress of [null, false]) test(`${skipProgress === null ? 'absent' : 'disabled'} option retains a fresh checkbox semantic review`, async t => {
  const f = await approvedFixture(t, { skipProgress }), before = f.calls.length;
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  assert.equal(f.calls.length, before + 1);
  assert(!(await f.journal()).some(row => row.toolCallId === toolCallId && row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('repeated permitted checkbox markers remain eligible without publishing semantic results', async t => {
  const f=await approvedFixture(t),before=f.calls.length;
  await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[X]'));
  assert.equal(f.calls.length,before);
  assert((await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

for(const file of ['design.md','tasks.md'])test(`real approved ${file} text changes retain immediate plan-drift enforcement`,async t=>{
  const f=await approvedFixture(t),before=f.calls.length;
  const body=file==='tasks.md'?tasks.replace('Retain','Discard'):'# Design\n\nUse a different default.\n';
  const {outcome,toolCallId}=await f.edit(`${prefix}/${file}`,body);
  assert.match(JSON.stringify(outcome),/Apply changed the approved OpenSpec plan/u);
  assert.equal(f.calls.length,before);
  const rows=(await f.journal()).filter(row=>row.toolCallId===toolCallId);
  assert(rows.some(row=>row.reasonCode==='OPENSPEC_APPLY_PLAN_CHANGED'));
  assert(!rows.some(row=>row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

for(const mode of ['blocked','unavailable'])test(`a newer ${mode} manual review retires the earlier clean shortcut`,async t=>{
  const f=await approvedFixture(t);f.setReviewMode(mode);
  const checked=await f.check(`${prefix}/design.md`);assert.notEqual(checked.result.status,'passed');
  const before=f.calls.length;f.setReviewMode('clean');
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  assert.equal(f.calls.length,before+1);
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('a later automatic semantic review retires shortcut reuse even when it passes', async t => {
  const f = await approvedFixture(t), before = f.calls.length;
  await f.edit(`${prefix}/design.md`, f.documents[`${prefix}/design.md`]);
  assert.equal(f.calls.length, before + 1);
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  assert.equal(f.calls.length, before + 2);
  assert(!(await f.journal()).some(row => row.toolCallId === toolCallId && row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS'));
});
