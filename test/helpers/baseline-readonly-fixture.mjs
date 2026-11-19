// Shared setup only; importing this module registers no tests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sharedBasisFixture as fixture, user, operation } from './runtime-v2-shared-basis-fixture.mjs';
import { withTaskState, decisionGuard } from '../../lib/runtime-v2/task-store.mjs';
import { outsideDecision } from '../../lib/runtime-v2/decision-scope.mjs';
import { readJson } from '../../lib/runtime-v2/utils.mjs';

export const transient = () => Object.assign(new Error('Controlled retryable graph transport failure.'), { reviewerRuntimeFailure: true });
export const budgetView = handle => {
  const { journal, ...view } = handle.baselineTask.budget.verifyClosed(); return view;
};
export async function prepared(t) {
  const f = await fixture(t); f.state.useNativeGraph = true; await f.select();
  const task = await f.task();
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => {
    delete state.groundTruth.sharedBasis;
    for (const watcher of Object.values(state.watchers)) watcher.status = 'PASS';
  });
  await fs.rm(await f.graphFile());
  const revised = user('U2'); revised.message.content = 'Preserve the revised requested feature.';
  await fs.appendFile(f.transcript, JSON.stringify(revised) + '\n');
  f.state.forceOperations = true; f.state.deltaOperation = { ...operation('transcript:U2#L1-L1'), text: revised.message.content };
  const counts = { actors: 0, graphs: 0, handle: null }, auditStart = f.audits().length;
  const cursors = structuredClone((await f.task()).groundTruth.sourceCursors);
  f.state.afterBaseline = async handle => { counts.actors++; counts.handle = handle; };
  const stop = options => f.invoke('Stop', { last_assistant_message: 'The requested work is complete.' }, options ?? {
    assessmentContext: { assessmentId: 'same-assessment-readonly', guard: decisionGuard(task),
      deadlineAt: Date.now() + f.plan.runtimeV2.stopCorrection.assessmentTimeoutMs } });
  const rollback = async () => {
    assert.equal((await f.truth()).version, 1);
    assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
    assert.deepEqual((await f.task()).groundTruth.sourceCursors, cursors);
    assert.equal(await readJson(await f.graphFile()), null);
  };
  return { f, counts, stop, rollback, audits: () => f.audits().length - auditStart };
}

export function useLastTurnAndRepair(f, counts) {
  f.state.beforeBaselineSave = async ({ call }) => {
    for (let i = 0; i < 3; i++) await assert.rejects(call('finish_baseline', {
      batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Controlled incomplete finish before the actual batch.' }), { code: 'BASELINE_INCOMPLETE' });
  };
  f.state.coverageMutation = async ({ params }) => {
    const budget = counts.handle.baselineTask.budget;
    const initial = budget.snapshot(); assert.equal(initial.maxTurns, 200); assert.equal(initial.maxRepairs, 3);
    while (budget.snapshot().turns < initial.maxTurns - 1) {
      params.onAssistantMessageStart();
      await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Controlled original-turn boundary.' }] } }) + '\n');
    }
  };
}
