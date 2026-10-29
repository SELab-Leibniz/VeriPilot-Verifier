import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeModelContextWindow, createNativeGatewayEvaluation } from '../scripts/helpers/native-gateway-evaluation.mjs';
test('model capacity keeps the legacy default and accepts an explicit documented larger window', () => {
  assert.equal(nativeModelContextWindow(), 128000);
  assert.equal(nativeModelContextWindow('1000000'), 1000000);
});
test('invalid capacities cannot become an unbounded or fractional context declaration', async () => {
  for (const value of [null, '', 'not-a-number', 0, -1, Infinity, 1000000.5, 32768, 2097153]) {
    assert.throws(() => nativeModelContextWindow(value), /context capacity/);
    await assert.rejects(createNativeGatewayEvaluation({ contextWindowTokens: value }), /context capacity/);
  }
});
