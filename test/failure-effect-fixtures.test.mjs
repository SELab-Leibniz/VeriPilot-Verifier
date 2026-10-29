import test from 'node:test';
import assert from 'node:assert/strict';
import { failureEffectCases } from '../scripts/helpers/failure-effect-fixtures.mjs';

const load = (fixture, suffix) => import(`data:text/javascript;base64,${Buffer.from(fixture.code).toString('base64')}#${fixture.id}-${suffix}`);
test('failure-path review fixtures have independently calibrated state effects and verdicts', async () => {
  for (const fixture of failureEffectCases.filter(row => row.id !== 'failure-condition-scope')) {
    for (const mode of ['false', 'throw']) {
      const module = await load(fixture, mode);
      assert.equal(await module.update('kept', async () => true), true);
      const before = module.read();
      assert.equal(await module.update('failed', async () => { if (mode === 'throw') throw Error('controlled persistence failure'); return false; }), false);
      assert.equal(JSON.stringify(module.read()) === JSON.stringify(before), fixture.expected === 'PASS', fixture.id);
    }
  }
});

test('conditional scope fixture preserves dispatch rejection without promising persistence atomicity', async () => {
  const fixture = failureEffectCases.find(row => row.id === 'failure-condition-scope');
  const module = await load(fixture, 'scope');
  let calls = 0;
  assert.equal(await module.update('rejected', async () => false, async () => { calls++; return true; }), false);
  assert.deepEqual(module.read(), ['initial']);
  assert.equal(calls, 0);
  assert.equal(await module.update('retained', async () => true, async () => { calls++; return false; }), false);
  assert.deepEqual(module.read(), ['initial', 'retained']);
  assert.equal(calls, 1);
  assert.equal(fixture.expected, 'PASS');
});
