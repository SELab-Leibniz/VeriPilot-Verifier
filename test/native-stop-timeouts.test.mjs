import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nativeStopTimeouts } from '../scripts/helpers/native-stop-timeouts.mjs';
import { prepareNativeLoopProject } from '../scripts/helpers/native-stop-loop-case.mjs';
import { loadRuntimePlan } from '../lib/runtime-plan.mjs';
import { stopCorrectionWindow } from '../lib/runtime-v2/stop-correction-config.mjs';

test('twenty-four-hour profile reaches the compiled fixture and retains the parent deadline', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-stop-24h-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = nativeStopTimeouts(86400000);
  const gateway = { stopTimeouts: profile, model: 'configured-review-model',
    pluginRoot: fileURLToPath(new URL('../', import.meta.url)) };
  await prepareNativeLoopProject({ gateway, projectRoot: root, outputRoot: root });
  const plan = await loadRuntimePlan({ cwd: root, pluginRoot: gateway.pluginRoot });
  assert.equal(plan.runtimeV2.stopCorrection.assessmentTimeoutMs, 86400000);
  assert.equal(plan.runtimeV2.reviewers.stopReviewer.timeoutMs, 86370000);
  assert.equal(plan.runtimeV2.reviewers.groundTruthExtractor.timeoutMs, 86370000);
  assert.deepEqual(Object.entries(plan.runtimeV2.stopCorrection.metrics).filter(([, v]) => v).map(([k]) => k),
    ['M08', 'M09', 'M12', 'M13', 'M15', 'M16']);
  const window = stopCorrectionWindow(plan.runtimeV2.stopCorrection, 1000, 101000);
  assert.equal(window.deadlineAt, 101000);
  assert.equal(window.reviewDeadlineAt, 71000);
});

test('invalid or non-integral native windows fail before launch; twenty-minute default remains', () => {
  assert.equal(nativeStopTimeouts().wallMs, 1200000);
  for (const value of [0, 1999, 2001, 86400001, 172800000, NaN, Infinity, '5400000', null])
    assert.throws(() => nativeStopTimeouts(value));
});
