import assert from 'node:assert/strict';
import test from 'node:test';
import { latestBenchmarkRepairReview } from '../scripts/helpers/benchmark-final-review.mjs';

const fixture = () => ({
  admissions: [{ executionId: 'rc-stop-repair', endedAt: 20 }],
  ledger: { used: 1, stops: { 'rc-stop-repair': { startedAt: 21, assessmentFinishedAt: 30, reviewStatus: 'PASS' } } },
  verification: { assessmentId: 'rc-stop-repair:stop', evaluationId: 'fresh-evaluation', status: 'PASS' },
});

test('a first successful repair is recognized without the quota-only finalReview field', () => {
  assert.equal(latestBenchmarkRepairReview(fixture()).evaluationId, 'fresh-evaluation');
});

test('stale source, unfinished repair, and mismatched review cannot end the benchmark', () => {
  for (const change of [
    f => { f.verification.assessmentId = 'original:stop'; },
    f => { f.admissions[0].endedAt = undefined; },
    f => { f.ledger.stops['rc-stop-repair'].assessmentFinishedAt = undefined; },
    f => { f.ledger.stops['rc-stop-repair'].startedAt = undefined; },
    f => { f.ledger.stops['rc-stop-repair'].startedAt = 19; },
    f => { f.verification.status = 'DEVIATION'; },
    f => { f.admissions.push({ executionId: 'newer-repair', endedAt: 40 }); },
  ]) {
    const f = fixture(); change(f); assert.equal(latestBenchmarkRepairReview(f), null);
  }
});

test('the third repair still requires its own review before budget exhaustion', () => {
  const f = fixture(); f.ledger.used = 3;
  f.verification.status = f.ledger.stops['rc-stop-repair'].reviewStatus = 'DEVIATION';
  assert.equal(latestBenchmarkRepairReview(f).status, 'DEVIATION');
  f.ledger.stops['rc-stop-repair'].assessmentFinishedAt = undefined;
  assert.equal(latestBenchmarkRepairReview(f), null);
});
