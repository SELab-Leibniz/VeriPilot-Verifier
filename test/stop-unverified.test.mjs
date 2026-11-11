import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeStopUnverified } from '../lib/runtime-v2/stop-unverified.mjs';

test('majority counts distinct original requirements and excludes regression and frame observations', () => {
  const requirements = [{ objectId: 'R1' }, { objectId: 'R2' }, { objectId: 'standing', programStanding: 'REGRESSION' }];
  const input = { requirements, judgements: [{ objectId: 'R1', judgement: 'UNVERIFIED', reason: 'Unclear return value.' }],
    followUps: [{ objectId: 'R1', judgement: 'UNVERIFIED', reason: 'The earlier deviation remains open.' }],
    regressionCheck: { status: 'UNVERIFIED', reason: 'A test substitute leaked.', failureInventory: { failures: [{ id: 'test-1' }, { id: 'test-2' }] },
      explanations: [{ failure: 'test-1' }] },
    unresolvedPaths: [{ objectId: 'R1', paths: [{ requiredPath: 'report.md' }] }] };
  const one = summarizeStopUnverified(input);
  assert.equal(one.originalRequirements, 2);
  assert.equal(one.unresolvedRequirements, 1);
  assert.equal(one.majorityUnverified, false);
  assert.deepEqual(one.items.filter(item => item.type === 'REGRESSION_CHECK').map(item => item.id), ['test-2']);
  const both = summarizeStopUnverified({ ...input, judgements: [...input.judgements,
    { objectId: 'R2', judgement: 'UNVERIFIED', reason: 'Another unresolved requirement.' }] });
  assert.equal(both.majorityUnverified, true);
  assert.equal(summarizeStopUnverified().majorityUnverified, false);
});
