import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeArktsIterations } from '../scripts/bench/iteration-summary.mjs';
const passed = { executed: true, resolved: true, f2p: { expected: 1, passed: ['new'] }, p2p: { expected: 2, passed: ['a', 'b'] } };
test('an unrun task stays in the full-suite denominator and cannot establish the target', () => {
  const report = summarizeArktsIterations([{ id: 'one', f2p: 1, p2p: 2, attempts: [{ grade: passed }] }, { id: 'two', f2p: 1, p2p: 2, attempts: [] }]).latestAttempts;
  assert.equal(report.f2p.observedPassRate, 1); assert.equal(report.f2p.fullSuitePassRate, .5);
  assert.equal(report.targetReached, false); assert.equal(report.accepted, 0);
});
test('latest failures never silently reuse the best attempt or a partial runtime report', () => {
  const report = summarizeArktsIterations([{ id: 'one', f2p: 1, p2p: 2, attempts: [{ grade: passed }, { grade: { ...passed, executed: false } }] }]);
  assert.equal(report.firstAttempts.targetReached, true); assert.equal(report.latestAttempts.graded, 0);
  assert.equal(report.latestAttempts.f2p.passed, 0); assert.equal(report.latestAttempts.targetReached, false);
});
test('changed test populations are rejected rather than improving the score by shrinking the denominator', () => {
  assert.throws(() => summarizeArktsIterations([{ id: 'one', f2p: 2, p2p: 2, attempts: [{ grade: passed }] }]), /population changed/);
});

test('a large passing test population cannot hide a failed small task in the 95 percent target', () => {
  const large = { ...passed, f2p: { expected: 99, passed: Array.from({ length: 99 }, (_, i) => String(i)) } };
  const small = { ...passed, resolved: false, f2p: { expected: 1, passed: [] } };
  const report = summarizeArktsIterations([{ id: 'large', f2p: 99, p2p: 2, attempts: [{ grade: large }] },
    { id: 'small', f2p: 1, p2p: 2, attempts: [{ grade: small }] }]).latestAttempts;
  assert.equal(report.f2p.fullSuitePassRate, .99); assert.equal(report.f2p.fullSuiteMacroPassRate, .5);
  assert.equal(report.resolvedCaseRate, .5); assert.equal(report.allCasesResolved, false);
  assert.equal(report.targetReached, false);
});
