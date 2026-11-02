import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProjectConfig } from '../lib/policy/config-loader.mjs';
import { compileRuntimePolicy } from '../lib/policy/compiler.mjs';
import { resolveStopTaskLimits } from '../lib/review-task/stop-policy.mjs';
import { createRepairStepBudget } from '../lib/openclaw/repair-step-budget.mjs';

const base = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: true } };

test('large Stop budgets compile independently from the three-repair quota', () => {
  const document = { ...base, stopCorrection: { enabled: true, assessmentTimeoutMs: 86400000,
    maxReviewSteps: 2000, maxRepairSteps: 2000, maxCorrectionsPerSession: 3, maxCorrectionsPerFlow: 3 },
    reviewers: { defaults: { timeoutMs: 86370000 } } };
  validateProjectConfig(document, 'config.yaml');
  const stop = compileRuntimePolicy(document).runtimeV2.stopCorrection;
  assert.equal(stop.maxReviewSteps, 2000);
  assert.equal(stop.maxRepairSteps, 2000);
  assert.equal(stop.maxCorrectionsPerSession, 3);
  assert.equal(stop.maxCorrectionsPerFlow, 3);
  assert.equal(resolveStopTaskLimits(stop.maxReviewSteps).maxTurns, 2000);
  for (const field of ['maxReviewSteps', 'maxRepairSteps'])
    for (const value of [0, -1, 1.5, '2000', null, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = { ...base, stopCorrection: { enabled: true, [field]: value } };
      assert.throws(() => validateProjectConfig(invalid, 'config.yaml'));
      assert.throws(() => compileRuntimePolicy(invalid));
    }
});

test('a repair step cap counts unique trusted starts for the exact owned run', () => {
  const identity = { runId: `rc-stop-${'a'.repeat(64)}`, sessionId: 'session', sessionKey: 'key' };
  const budget = createRepairStepBudget({ ...identity, maxSteps: 2 });
  const event = seq => ({ ...identity, type: 'model.call.started', seq });
  assert.deepEqual(budget.observe(event(10)), { steps: 1, firstExceeded: false });
  assert.deepEqual(budget.observe(event(10)), { steps: 1, firstExceeded: false });
  assert.deepEqual(budget.observe({ ...event(11), runId: 'original-user-run' }), { steps: 1, firstExceeded: false });
  assert.deepEqual(budget.observe({ ...event(11), sessionKey: 'replacement-session' }), { steps: 1, firstExceeded: false });
  assert.deepEqual(budget.observe(event(12)), { steps: 2, firstExceeded: false });
  assert.deepEqual(budget.observe(event(13)), { steps: 3, firstExceeded: true });
  assert.deepEqual(budget.observe(event(14)), { steps: 4, firstExceeded: false });
  assert.throws(() => createRepairStepBudget({ ...identity, runId: 'original-user-run', maxSteps: 2000 }));
  assert.throws(() => createRepairStepBudget({ ...identity, maxSteps: 0 }));
});
