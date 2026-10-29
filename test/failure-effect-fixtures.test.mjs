import test from 'node:test';
import assert from 'node:assert/strict';
import { failureEffectCases, exceptionalFlowCases } from '../scripts/helpers/failure-effect-fixtures.mjs';

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

test('refresh fixtures distinguish returned failure, rejection, cleanup and the original outcome scope', async () => {
  for (const fixture of exceptionalFlowCases) {
    for (const outcome of ['success', 'failure', 'throw']) {
      const module = await load(fixture, outcome);
      const events = [], failure = Error('controlled apply rejection');
      const result = { ok: outcome === 'success' };
      const operation = module.change('next', async value => {
        assert.equal(value, 'next');
        assert.equal(module.read().busy, true);
        events.push('apply');
        if (outcome === 'throw') throw failure;
        return result;
      }, async () => {
        assert.equal(module.read().busy, true);
        events.push('refresh');
        return 'confirmed';
      });
      if (outcome === 'throw') await assert.rejects(operation, error => error === failure);
      else assert.equal(await operation, result);
      const refreshed = outcome !== 'throw' || fixture.id === 'required-refresh-in-finally';
      assert.deepEqual(events, refreshed ? ['apply', 'refresh'] : ['apply']);
      assert.deepEqual(module.read(), { busy: false, view: refreshed ? 'confirmed' : 'stale' });
      const required = outcome !== 'throw' || fixture.id !== 'refresh-return-only-scope';
      assert.equal(required && !refreshed, fixture.expected === 'DEVIATION' && outcome === 'throw');
    }
  }
});
