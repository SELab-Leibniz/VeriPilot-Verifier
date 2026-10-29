import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertBusinessSessionIdentity, EXPERIMENT_SESSION_RESET } from '../scripts/bench/session-continuity.mjs';

const identity = { sessionId: 'restored', sessionKey: 'agent:main:bench', runId: 'business' };
test('genuine continuation permits private model activity without accepting a replacement business session', () => {
  const entry = { sessionId: identity.sessionId };
  assert.doesNotThrow(() => assertBusinessSessionIdentity(identity, entry, []));
  assert.doesNotThrow(() => assertBusinessSessionIdentity(identity, entry,
    [{ runId: 'business', sessionId: 'restored' }, { runId: 'private', sessionId: 'reviewer' }]));
  for (const replacement of [{ sessionId: 'reset' }, null]) {
    assert.throws(() => assertBusinessSessionIdentity(identity, replacement, []),
      error => error.code === 'ARKTS_SESSION_IDENTITY_DRIFT' && error.evidence.actualBusinessStart === false);
  }
  assert.throws(() => assertBusinessSessionIdentity(identity, entry, [{ runId: 'business', sessionId: 'reset' }]),
    error => error.code === 'ARKTS_SESSION_IDENTITY_DRIFT' && error.evidence.unexpectedBusinessStart === true);
});

test('pinned native reset policy preserves old genuine timestamps across daily and idle boundaries', {
  skip: !process.env.RC_EVAL_HOST_ROOT,
}, async () => {
  const host = process.env.RC_EVAL_HOST_ROOT;
  const { c: resolve, o: evaluate } = await import(pathToFileURL(path.join(host, 'dist/reset-Cmc2g-h4.js')).href);
  const now = new Date(2026, 9, 30, 5, 0).getTime();
  const old = new Date(2026, 9, 29, 3, 0).getTime();
  const times = { sessionStartedAt: old, lastInteractionAt: old, updatedAt: now, now };
  assert.equal(evaluate({ ...times, policy: resolve({ sessionCfg: {}, resetType: 'direct' }) }).staleReason, 'daily');
  const policy = resolve({ sessionCfg: { reset: EXPERIMENT_SESSION_RESET }, resetType: 'direct' });
  assert.equal(policy.mode, 'idle');
  assert.equal(policy.idleMinutes, 0);
  assert.equal(evaluate({ ...times, policy }).fresh, true);
  assert.equal(evaluate({ ...times, now: now + 90 * 86400000, policy }).fresh, true);
});
