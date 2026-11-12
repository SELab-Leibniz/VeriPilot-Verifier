import test from 'node:test';
import assert from 'node:assert/strict';
import { stopReviewCoverage } from '../lib/runtime-v2/stop-review-coverage.mjs';
import { renderReport } from '../lib/openclaw/report.mjs';

test('coverage retains the full denominator and counts unresolved subjects once', () => {
  const coverage = stopReviewCoverage({ requirements: [{ objectId: 'R1' }, { objectId: 'R2' }, { objectId: 'standing', programStanding: 'REGRESSION' }],
    followUps: [{ objectId: 'R1', judgement: 'PASS', reason: 'The original deviation is fixed.' }],
    unverifiedItems: [{ id: 'path', objectId: 'R2', type: 'OUTPUT_PATH', reason: 'Ambiguous output.' },
      { id: 'R2', objectId: 'R2', type: 'REQUIREMENT', reason: 'Unresolved.' }],
    regressionCases: [{ id: 'test-1', verdict: 'UNVERIFIED', reason: 'An isolated failure is still unexplained.' }],
    frameItems: [{ id: 'G1', type: 'FRAME_GUIDANCE', disposition: 'CHECKED' },
      { id: 'S1', type: 'FRAME_SCENARIO', disposition: 'UNVERIFIED', reason: 'No observable runtime evidence.' }] });
  assert.equal(coverage.total, 5);
  assert.equal(coverage.unverified, 3);
  assert.equal(coverage.unverifiedRatio, 3 / 5);
  assert.deepEqual(coverage.items.map(item => item.id), ['R1', 'R2', 'test-1', 'G1', 'S1']);
  assert.equal(coverage.items[0].disposition, 'PASS');
  assert.equal(stopReviewCoverage().unverifiedRatio, null);
});

test('the human report retains unresolved IDs, types and reasons and each frame disposition', () => {
  const text = renderReport({ taskId: 'review-report', verification: 'NO_DEVIATION_FOUND', phase: 'COMPLETED_WITH_ISSUES',
    requirementVersion: 1, budget: { correctionsUsed: 0, infrastructureConsecutiveFailures: 0 }, files: [], findings: [],
    unverifiedItems: [{ id: 'test-1', type: 'REGRESSION_CHECK', reason: 'The assertion remains unsettled.' },
      { id: 'R2', type: 'REQUIREMENT', reason: 'The output meaning remains ambiguous.' }],
    frameCoverage: { items: [{ id: 'G1', type: 'FRAME_GUIDANCE', disposition: 'CHECKED',
      evidence: [{ path: 'source.mjs', start: 1, end: 2, sha256: 'a'.repeat(64) }] },
      { id: 'S1', type: 'FRAME_SCENARIO', disposition: 'UNVERIFIED', reason: 'No attributable observation.' }] } });
  for (const expected of ['test-1 [REGRESSION_CHECK]', 'R2 [REQUIREMENT]', 'The assertion remains unsettled.',
    'Frame G1 [FRAME_GUIDANCE]：CHECKED', 'Frame S1 [FRAME_SCENARIO]：UNVERIFIED', 'No attributable observation.',
    '本次 Stop 未发现已确认偏差', '验收中断原因：无']) assert(text.includes(expected), expected);
});
