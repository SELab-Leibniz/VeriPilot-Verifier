import test from 'node:test';
import assert from 'node:assert/strict';
import { stopReviewCoverage } from '../lib/runtime-v2/stop-review-coverage.mjs';

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
