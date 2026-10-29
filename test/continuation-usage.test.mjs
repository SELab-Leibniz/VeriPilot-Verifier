import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { continuationUsage } from '../scripts/bench/continuation-usage.mjs';
const line = usage => JSON.stringify({ message: { role: 'assistant', content: '实际记录', ...(usage ? { usage } : {}) } });
const usage = n => ({ input: n, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: n + 2 });
const sha = text => createHash('sha256').update(text).digest('hex');
test('restored usage is excluded from the current continuation even when message contents repeat', () => {
  const source = `${line(usage(100))}\n`;
  const result = continuationUsage({ transcript: source + `${line(usage(100))}\n${line(usage(3))}\n`, restoredSource: source, sourceSha256: sha(source) });
  assert.equal(result.restoredHistory.totalTokens, 102);
  assert.equal(result.currentContinuation.totalTokens, 107);
  assert.equal(result.currentContinuation.assistantTurns, 2);
});
test('changed original or copied history is rejected instead of guessed from timestamps', () => {
  const source = `${line(usage(100))}\n`;
  for (const data of [{ restoredSource: source + ' ', transcript: source }, { restoredSource: source, transcript: source.replace('100', '101') }]) {
    assert.throws(() => continuationUsage({ ...data, sourceSha256: sha(source) }), { code: 'CONTINUATION_USAGE_HISTORY_MISMATCH' });
  }
});
test('missing and incomplete usage stays explicit alongside zero-usage assistant records', () => {
  const source = '';
  const result = continuationUsage({ transcript: `${line()}\n${line({ input: 4 })}\n${line({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })}\n`, restoredSource: source, sourceSha256: sha(source) });
  assert.equal(result.currentContinuation.missingUsageRecords, 1);
  assert.equal(result.currentContinuation.incompleteUsageRecords, 1);
  assert.equal(result.currentContinuation.reportedUsageRecords, 2);
  assert.equal(result.currentContinuation.nonzeroUsageRecords, 1);
  assert.equal(result.currentContinuation.input, 4);
});
test('UTF-8 restored history without its trailing newline uses an exact record boundary', () => {
  const source = line(usage(5));
  const result = continuationUsage({ transcript: `${source}\n${line(usage(1))}\n`, restoredSource: source, sourceSha256: sha(source) });
  assert.equal(result.currentContinuation.totalTokens, 3);
  assert.throws(() => continuationUsage({ transcript: source + line(usage(1)), restoredSource: source, sourceSha256: sha(source) }), /record boundary/u);
});
