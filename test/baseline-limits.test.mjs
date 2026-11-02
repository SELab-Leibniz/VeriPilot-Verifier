import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBaselineLimits } from '../lib/review-task/baseline-limits.mjs';
import { resolveReviewTimeoutMs } from '../lib/review-timeout.mjs';
import { resolveHookTimeoutMs, hookReviewBudgetMs } from '../lib/openclaw/hook-timeout.mjs';

test('baseline-only 24-hour 2000-step limits remain finite without changing ordinary reviewer defaults', () => {
  const limits = resolveBaselineLimits({ timeoutMs: 86400000, maxSteps: 2000, maxRepairs: 2000,
    maxAuditCalls: 2000, maxExternalRepairs: 2000 });
  assert.equal(limits.timeoutMs, 86400000); assert.equal(limits.maxTurns, 2000);
  assert.equal(resolveBaselineLimits().maxAuditCalls, 2); assert.equal(resolveBaselineLimits().maxExternalRepairs, 1);
  assert.throws(() => resolveReviewTimeoutMs(86400000));
  assert.equal(resolveHookTimeoutMs(86460000), 3600000);
  assert.equal(resolveHookTimeoutMs(86460000, limits.timeoutMs + 60000), 86460000);
  assert(hookReviewBudgetMs(86460000, Infinity, limits.timeoutMs + 60000) >= limits.timeoutMs);
  for (const value of [0, null, Infinity, -1, 1.5]) assert.throws(() => resolveBaselineLimits({ maxSteps: value }));
  assert.equal(resolveBaselineLimits().auditUnitBytes, 2048);
  assert.equal(resolveBaselineLimits({ auditUnitBytes: 16384 }).auditUnitBytes, 16384);
  for (const auditUnitBytes of [0, 255, 16385, Infinity]) assert.throws(() => resolveBaselineLimits({ auditUnitBytes }));
});
