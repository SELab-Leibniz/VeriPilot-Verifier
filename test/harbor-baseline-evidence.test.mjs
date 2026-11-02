import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectHarborBaselineEvidence } from '../scripts/bench/harbor-gateway-runner.mjs';
import { ensureTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';

test('an unpublished baseline returns an explicit negative result and retained task evidence', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-bench-evidence-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, 'output'); await fs.mkdir(outputRoot);
  const task = await ensureTask({ projectRoot: root, sessionId: 'business' });
  const input = { projectRoot: root, pluginRoot: path.resolve('.'), sessionId: 'business', outputRoot };
  const result = await collectHarborBaselineEvidence(input);
  assert.equal(result.publication, 'UNPUBLISHED'); assert.equal(result.baselineVersion, 0);
  assert.deepEqual(result.claims, []); assert.equal(result.verification, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.evidenceRoot, 'task.json'), 'utf8')).taskId, task.taskId);
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.groundTruth.version = 1; });
  await assert.rejects(collectHarborBaselineEvidence({ ...input, outputRoot }), error => error.code === 'ENOENT');
});
