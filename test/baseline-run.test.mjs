import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineRunSettings, BASELINE_RUN_DEFAULTS } from '../scripts/run-baseline.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';

test('standalone baseline config permits longer finite windows and feeds the production reviewer configuration', () => {
  const settings = baselineRunSettings({ timeoutMs: 1200000, assessmentTimeoutMs: 1800000, requestTimeoutMs: 900000, maxRepairs: 12 });
  const runtime = compileRuntimeV2Config({ version: 2, reviewers: { groundTruthExtractor: {
    timeoutMs: settings.timeoutMs, formatRepairAttempts: settings.maxRepairs,
  } } });
  assert.equal(runtime.reviewers.groundTruthExtractor.timeoutMs, 1200000);
  assert.equal(runtime.reviewers.groundTruthExtractor.formatRepairAttempts, 12);
  assert.equal(settings.requestTimeoutMs, 900000);
  assert.equal(BASELINE_RUN_DEFAULTS.timeoutMs, 600000);
});

test('baseline windows remain finite and assessment cannot expire before the configured extraction window', () => {
  for (const settings of [{ timeoutMs: Infinity }, { assessmentTimeoutMs: 5000 }, { requestTimeoutMs: 0 },
    { maxRepairs: -1 }, { maxRepairs: 21 }, { model: '' }])
    assert.throws(() => baselineRunSettings(settings));
});
