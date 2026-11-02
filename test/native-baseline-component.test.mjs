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

test('baseline component completes explicit-refresh lifecycle from an empty task without preseeded claims', async t => {
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
  await assert.rejects(refresh(), /Cannot set properties of undefined \(setting 'pendingRequirement'\)/u);
  assert.equal(closed, 1);
  const initial = await loadCurrentGroundTruth(projectRoot, task.taskId);
  assert.equal(initial.version, 0); assert.deepEqual(initial.claims, [], 'A failed decision must not publish its staged candidate');
  const initialized = await initializeNativeBaselineTask({ projectRoot, sessionId });
  assert.equal(initialized.taskId, task.taskId);
  assert.deepEqual(JSON.parse(await fs.readFile(taskStatePath(projectRoot, task.taskId))).control, {});
  assert.equal((await loadCurrentGroundTruth(projectRoot, task.taskId)).version, 0);
  const outcome = await refresh();
  assert.equal(closed, 2); assert.equal(outcome.baselineCommitted, true); assert.equal(outcome.requirementVersion, 1);
  const current = await loadCurrentGroundTruth(projectRoot, task.taskId);
  assert.equal(current.version, 1); assert.equal(current.claims.length, 1);
  const state = JSON.parse(await fs.readFile(taskStatePath(projectRoot, task.taskId)));
  assert.equal(state.control.pendingRequirement, null); assert.equal(state.verification.reason, 'REQUIREMENTS_UPDATED');
  await assert.rejects(initializeNativeBaselineTask({ projectRoot, sessionId }));
  assert.equal((await loadCurrentGroundTruth(projectRoot, task.taskId)).digest, current.digest);
});
