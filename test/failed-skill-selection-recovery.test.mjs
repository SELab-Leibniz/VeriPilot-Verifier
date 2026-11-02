import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sharedBasisFixture as fixture } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';

async function selectedRead(f, id) {
  const content = await fs.readFile(f.skillFile, 'utf8');
  await fs.appendFile(f.transcript, JSON.stringify({ type: 'assistant', uuid: `A-${id}`, message: { role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Read', input: { path: f.skillFile } }] } }) + '\n'
    + JSON.stringify({ type: 'user', uuid: `R-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
      content: [{ type: 'text', text: content }], is_error: false }] } }) + '\n');
  const result = await f.invoke('PreToolUse', { tool_name: 'Skill', tool_use_id: id, tool_input: { skill: 'demo' } });
  await f.invoke('PostToolUse', { tool_name: 'Read', tool_use_id: id, tool_input: { path: f.skillFile },
    tool_response: { content: [{ type: 'text', text: content }], isError: false } });
  return result;
}
async function failedSelection(t) {
  const f = await fixture(t, { wireMode: 'draft' });
  f.state.sourceFrom = true; f.state.draftActual = true; f.state.useNativeGraph = true;
  let reports = 0;
  f.state.formatCoverageReport = value => ++reports === 1 ? 'Unstructured failed audit, no report.' : JSON.stringify(value);
  const result = await selectedRead(f, 'actual-selected-read');
  assert.equal(result.reason, 'SKILL_WATCH_NOT_ESTABLISHED');
  const task = await f.task(), rows = Object.values(task.watchers);
  assert.equal(rows.length, 1); const watcher = rows[0];
  assert.equal(watcher.status, 'UNVERIFIED_RECOVERY'); assert.equal(watcher.sourceInterpretationChecked, false);
  assert(watcher.pendingSelection); assert(watcher.invocationIds.includes('actual-selected-read'));
  assert.equal((await f.truth()).version, 0); assert.equal(task.groundTruth.sharedBasis, undefined);
  assert.equal(await readJson(await f.graphFile()), null); assert.equal(f.audits().length, 1, 'No synchronous retry pool after failure');
  const pointer = watcher.pendingSelection.pointer, bytes = await fs.readFile(pointer.path), origin = JSON.parse(bytes);
  assert.equal(sha256(bytes), pointer.bytesDigest); assert.equal(sha256(origin), pointer.digest);
  assert.equal(origin.source.files.find(file => file.path === 'SKILL.md').content, await fs.readFile(f.skillFile, 'utf8'));
  assert.equal(origin.rootSessionId, task.rootSessionId); assert.equal(origin.invocationId, 'actual-selected-read');
  assert(!pointer.path.includes('/skills/'), 'Historical source evidence is outside the graph inventory');
  return { f, watcher, task };
}
async function document(f) {
  await fs.writeFile(path.join(f.root, 'guide.md'), 'The requested feature is preserved.');
  const artifact = { nodeId: 'guide', path: 'guide.md', stage: 'implementation', metrics: [], metricCheckpoint: false };
  const outcome = await f.invoke('PostToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(f.root, 'guide.md') } }, { artifact });
  await outcome.reviewerHandle?.close(); return outcome;
}
const stop = f => f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' });

test('failed selected read survives document alignment and Stop runs the same Skill independent checker', async t => {
  const { f, watcher } = await failedSelection(t);
  await document(f);
  const aligned = await f.task();
  assert(aligned.groundTruth.sharedBasis.sources.some(source => source.ref === f.skillFile));
  assert(aligned.groundTruth.sharedBasis.adoptedSkills.some(skill => skill.skillId === 'demo'));
  assert(aligned.watchers[watcher.watcherId].pendingSelection);
  const result = await stop(f); assert.equal(result.stop.status, 'PASS', JSON.stringify(result));
  const current = await f.task(); assert.deepEqual(Object.keys(current.watchers), [watcher.watcherId]);
  const recovered = current.watchers[watcher.watcherId];
  assert.equal(recovered.status, 'PASS'); assert.equal(recovered.sourceInterpretationChecked, true);
  assert.equal(recovered.pendingSelection, undefined); assert.equal(recovered.maxTurn, watcher.maxTurn);
  assert.deepEqual(recovered.invocationIds, watcher.invocationIds); assert.deepEqual(recovered.selectionOrigins, watcher.selectionOrigins);
  assert(f.calls.some(call => call.role === 'skill-reviewer' && call.request.watcher.watcherId === watcher.watcherId));
  assert(f.state.auditInputs.at(-1).identity.sources.some(source => source.ref === f.skillFile));
});

for (const invalid of ['sustained-audit', 'missing', 'changed', 'snapshot', 'foreign-owner', 'cancel'])
  test(`failed selection stays unverified after ${invalid}`, async t => {
    const { f, watcher, task } = await failedSelection(t);
    if (invalid === 'sustained-audit') f.state.formatCoverageReport = () => 'Still no final audit report.';
    if (invalid === 'missing') await fs.rm(f.skillFile);
    if (invalid === 'changed') await fs.appendFile(f.skillFile, '\nA changed original duty.\n');
    if (invalid === 'snapshot') await fs.appendFile(watcher.pendingSelection.pointer.path, 'forged');
    if (invalid === 'foreign-owner' || invalid === 'cancel') await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => {
      if (invalid === 'foreign-owner') state.watchers[watcher.watcherId].pendingSelection.rootSessionId = 'foreign-owner';
      else { state.control ??= {}; state.control.cancelled = true; state.control.cancelEpoch = (state.control.cancelEpoch ?? 0) + 1; }
    });
    const result = await stop(f);
    assert.notEqual(result.stop?.status ?? result.status, 'PASS');
    const current = await f.task(); assert(current.watchers[watcher.watcherId].pendingSelection);
    assert.equal(current.watchers[watcher.watcherId].maxTurn, watcher.maxTurn);
    assert.equal((await f.truth()).version, 0); assert.equal(current.groundTruth.sharedBasis, undefined);
    assert.equal(await readJson(await f.graphFile()), null); assert(!f.calls.some(call => call.role === 'skill-reviewer'));
  });

test('a genuine later read of changed original recovers the pending identity without resetting its window', async t => {
  const { f, watcher } = await failedSelection(t);
  await fs.appendFile(f.skillFile, '\nDescriptive edition note.\n');
  const selected = await selectedRead(f, 'new-current-selection');
  assert.equal(selected.watcher.status, 'ACTIVE', JSON.stringify(selected));
  const row = (await f.task()).watchers[watcher.watcherId];
  assert.equal(row.watcherId, watcher.watcherId); assert.equal(row.maxTurn, watcher.maxTurn);
  assert(row.invocationIds.includes('actual-selected-read')); assert(row.invocationIds.includes('new-current-selection'));
  assert(row.selectionOrigins.length > watcher.selectionOrigins.length);
  assert.notEqual(row.skillDigest, watcher.skillDigest);
  const result = await stop(f); assert.equal(result.stop.status, 'PASS', JSON.stringify(result));
  assert.deepEqual(Object.keys((await f.task()).watchers), [watcher.watcherId]);
});
