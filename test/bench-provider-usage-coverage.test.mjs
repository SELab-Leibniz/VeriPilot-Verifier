import test from 'node:test';
import assert from 'node:assert/strict';
import { providerUsageCoverage } from '../scripts/bench/provider-usage-coverage.mjs';

test('synthetic terminals do not hide a request with no positive provider usage record', () => {
  assert.equal(providerUsageCoverage(4, 4).complete, true);
  const interrupted = providerUsageCoverage(5, 4);
  assert.equal(interrupted.complete, false); assert.equal(interrupted.unreportedRequests, 1);
});

test('missing request observation and extra usage records remain explicitly incomplete', () => {
  const missing = providerUsageCoverage(null, 4);
  assert.equal(missing.complete, false); assert.equal(missing.unreportedRequests, null);
  const extra = providerUsageCoverage(3, 4);
  assert.equal(extra.complete, false); assert.equal(extra.unexpectedUsageRecords, 1);
});
