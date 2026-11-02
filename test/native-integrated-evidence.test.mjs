import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeIntegratedNativeEvidence } from '../scripts/helpers/native-integrated-evidence.mjs';

// Synthetic records exercise only the read-only audit contract. They are never
// passed to RC or published as native/business/module acceptance evidence.
const fixture = { projectRoot: '/fictional', command: 'fixed public command', deliverables: ['app.mjs', 'docs/guide.md'] };
const business = { sessionId: 'business-session', sessionKey: 'business-key' };
const currentHashes = { 'app.mjs': 'app-hash', 'docs/guide.md': 'guide-hash' };
function pair(name, params, id, at, result = { content: [] }) {
  return [{ phase: 'before', at, ...business, runId: 'actual-run', event: { toolName: name, toolCallId: id, params } },
    { phase: 'result', at: at + 1, ...business, runId: 'actual-run', event: { toolCallId: id, isError: false, result } }];
}
function verification(at, id = 'verify') {
  return pair('exec', { command: fixture.command, workdir: fixture.projectRoot, timeout: 10, background: false }, id, at,
    { details: { status: 'completed', exitCode: 0, aggregated: JSON.stringify({ kind: 'public-delivery-verification-v1',
      appSha256: 'app-hash', guideSha256: 'guide-hash', codePassed: true, guidePassed: true }) } });
}
const summarize = (observations, extras = {}) => summarizeIntegratedNativeEvidence({ observations, fixture, business, currentHashes, ...extras });

test('freshness needs an actual paired successful exec after the last write, even for identical hashes', () => {
  const records = [...pair('write', { path: 'app.mjs' }, 'write-app', 10), ...verification(20),
    ...pair('edit', { path: 'docs/guide.md' }, 'edit-guide', 30)];
  assert.equal(summarize(records).freshSuccessfulVerificationObserved, false);
  records.push(...verification(40, 'fresh-verifier'));
  assert.equal(summarize(records).freshSuccessfulVerificationObserved, true);
  assert.equal(summarize(records).freshVerification.toolCallId, 'fresh-verifier');
  assert.equal(summarize(records).moduleAcceptance, null);
});

test('orphan, unsuccessful, mismatched hashes and pending edits cannot establish fresh verification', () => {
  const records = verification(20);
  assert.equal(summarize([records[1]]).freshSuccessfulVerificationObserved, false);
  assert.equal(summarize([records[0]]).freshSuccessfulVerificationObserved, false);
  const failed = structuredClone(records); failed[1].event.result.details.exitCode = 3;
  assert.equal(summarize(failed).freshSuccessfulVerificationObserved, false);
  const wrong = structuredClone(records); wrong[1].runId = 'other-run';
  assert.equal(summarize(wrong).freshSuccessfulVerificationObserved, false);
  assert.equal(summarize(records, { currentHashes: { ...currentHashes, 'app.mjs': 'new-app' } }).freshSuccessfulVerificationObserved, false);
  assert.equal(summarize([...pair('edit', { path: 'app.mjs' }, 'pending', 10).slice(0, 1), ...records]).freshSuccessfulVerificationObserved, false);
});

test('controlled fault invalidates an earlier success and requires the actual later verifier', () => {
  const initial = [...pair('read', { path: 'skills/delivery-verifier/SKILL.md' }, 'skill-read', 5), ...verification(20)];
  assert.equal(summarize(initial).pairedSkillRead, true);
  assert.equal(summarize(initial, { faultAt: 30 }).freshSuccessfulVerificationObserved, false);
  const repaired = [...initial, ...pair('write', { path: 'app.mjs' }, 'repair', 40), ...verification(50, 'repair-verifier')];
  assert.equal(summarize(repaired, { faultAt: 30 }).freshSuccessfulVerificationObserved, true);
  assert.equal(summarize(repaired, { faultAt: 30 }).successfulVerifications.length, 2);
});
