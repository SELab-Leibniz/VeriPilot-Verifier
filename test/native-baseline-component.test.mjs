import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeNativeBaselineTask } from '../scripts/evaluate-native-baseline.mjs';
import { ensureTask, taskStatePath } from '../lib/runtime-v2/task-store.mjs';
import { loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';

test('baseline component completes first explicit refresh without manual control initialization or preseeded claims', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-baseline-lifecycle-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const sessionId = 'component-lifecycle', task = await ensureTask({ projectRoot, sessionId });
  assert.equal(JSON.parse(await fs.readFile(taskStatePath(projectRoot, task.taskId))).control, undefined);
  const transcript = path.join(projectRoot, 'conversation.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'original-user', message: { content: 'Preserve the local-only implementation.' } }) + '\n');
  let closed = 0;
  const refresh = () => refreshRuntimeRequirements({ projectRoot,
    input: { cwd: projectRoot, session_id: sessionId, transcript_path: transcript },
    plan: { runtimeV2: compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [] } }) },
    reviewerFactory: async () => ({ requestDirectory: projectRoot, close: async () => { closed++; },
      result: { summary: 'Controlled lifecycle result, not model semantic evidence.', taskClassification: 'CONTINUATION', skillGroundTruth: null,
        operations: [{ operation: 'ADD', category: 'requirements', text: 'Preserve the local-only implementation.', authority: 'USER_EXPLICIT',
          severity: 'HARD', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', applicabilityKind: 'CURRENT_TASK',
          source: { ref: 'transcript:original-user', kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }] } }) });
  const outcome = await refresh();
  assert.equal(closed, 1); assert.equal(outcome.baselineCommitted, true); assert.equal(outcome.requirementVersion, 1);
  const current = await loadCurrentGroundTruth(projectRoot, task.taskId);
  assert.equal(current.version, 1); assert.equal(current.claims.length, 1);
  const state = JSON.parse(await fs.readFile(taskStatePath(projectRoot, task.taskId)));
  assert.equal(state.control.pendingRequirement, null); assert.equal(state.verification.reason, 'REQUIREMENTS_UPDATED');
  await assert.rejects(initializeNativeBaselineTask({ projectRoot, sessionId }));
  assert.equal((await loadCurrentGroundTruth(projectRoot, task.taskId)).digest, current.digest);
});

test('explicit refresh forwards its deadline and cancellation to the active extractor', async t => {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-cancel-')));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const sessionId = 'cancel-owned-baseline', task = await ensureTask({ projectRoot, sessionId });
  const transcript = path.join(projectRoot, 'conversation.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'original-user',
    message: { content: 'Preserve the local-only implementation.' } }) + '\n');
  const controller = new AbortController(), deadlineAt = Date.now() + 600000;
  let invoked = false;
  await assert.rejects(refreshRuntimeRequirements({ projectRoot,
    input: { cwd: projectRoot, session_id: sessionId, transcript_path: transcript },
    plan: { runtimeV2: compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [] } }) },
    assessmentContext: { deadlineAt, abortSignal: controller.signal },
    reviewerFactory: async options => {
      invoked = true;
      assert.equal(options.deadlineAt, deadlineAt);
      assert.equal(options.abortSignal, controller.signal);
      const failure = Object.assign(new Error('Owned baseline cancelled'), { code: 'BASELINE_CANCELLED' });
      return new Promise((_, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true });
        queueMicrotask(() => controller.abort(failure));
      });
    },
  }));
  assert.equal(invoked, true); assert.equal(controller.signal.aborted, true);
  assert.equal((await loadCurrentGroundTruth(projectRoot, task.taskId)).version, 0);
});
