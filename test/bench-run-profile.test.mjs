import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { arktsRunProfile, renderArktsRunConfig } from '../scripts/bench/arkts-run-profile.mjs';
import { shortArktsWorkspace } from '../scripts/bench/short-workspace.mjs';
import { loadRuntimePlan } from '../lib/runtime-plan.mjs';
import { DEFAULT_STOP_METRICS, enabledStopMetricIds } from '../lib/runtime-v2/metric-policy.mjs';

test('an explicit 30-minute profile gives each phase its window and preserves later phases', () => {
  const p = arktsRunProfile('1800000');
  for (const field of ['mainTimeoutMs', 'privateTimeoutMs', 'assessmentTimeoutMs', 'setupTimeoutMs', 'checkTimeoutMs'])
    assert.equal(p[field], 1800000, field);
  assert(p.feedbackReserveMs < p.assessmentTimeoutMs);
  assert(p.totalTimeoutMs > 2 * (p.mainTimeoutMs + p.assessmentTimeoutMs + p.phaseTimeoutMs));
  const base = path.join(os.tmpdir(), 'rc-s2-test');
  assert(shortArktsWorkspace('results/a', 'biz', base).startsWith(path.resolve(base) + path.sep));
  assert(shortArktsWorkspace('results/a', 'grd', base).startsWith(path.resolve(base) + path.sep));
});

test('invalid phase limits cannot silently become zero, fractional, or unbounded', () => {
  for (const value of ['', '0', '-1', '999', '1500', '3601000', 'Infinity', 'abc'])
    assert.throws(() => arktsRunProfile(value), /phase-timeout/);
  assert.equal(arktsRunProfile(undefined).mainTimeoutMs, 600000);
});

test('host no-timeout explicitly removes both host and whole-flow cutoffs without removing RC phase limits', () => {
  const p = arktsRunProfile('1800000', { hostNoTimeout: true });
  assert.equal(p.mainTimeoutMs, 0); assert.equal(p.totalTimeoutMs, null);
  assert.equal(p.privateTimeoutMs, 1800000); assert.equal(p.assessmentTimeoutMs, 1800000);
  assert.throws(() => arktsRunProfile(undefined, { hostNoTimeout: true }), /explicit RC phase/);
});

test('the actual generated project YAML resolves every review role and phase to thirty minutes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-s2-policy-'));
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), renderArktsRunConfig('glm-5.3-flash', arktsRunProfile('1800000')));
  const plan = await loadRuntimePlan({ cwd: root });
  for (const role of ['groundTruthExtractor', 'onboardingAdjudicator', 'skillReviewer', 'artifactReviewer', 'stopReviewer', 'implementationReviewer'])
    assert.equal(plan.runtimeV2.reviewers[role].timeoutMs, 1800000, role);
  assert.equal(plan.limits.semanticReviewTimeoutMs, 1800000);
  assert.equal(plan.runtimeV2.stopCorrection.assessmentTimeoutMs, 1800000);
  assert.equal(plan.runtimeV2.implementationCorrection.deviceBudgetMs, 1800000);
  assert.deepEqual(plan.runtimeV2.stopCorrection.metrics, DEFAULT_STOP_METRICS,
    'The benchmark must inherit the RC metric defaults instead of narrowing review to M16.');
  assert.deepEqual(enabledStopMetricIds(plan.runtimeV2.stopCorrection), ['M08', 'M09', 'M12', 'M13', 'M15', 'M16']);
});
