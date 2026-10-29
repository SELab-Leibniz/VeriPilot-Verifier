import test from 'node:test';
import assert from 'node:assert/strict';
import { localTestEvidence, publicLocalTestEvidence } from '../scripts/bench/local-test-evidence.mjs';
const lines = (name, status) => `[Hypium]start running case '${name}'\nOHOS_REPORT_STATUS: class=Local\n[Hypium][${status}]${name} ; consuming 1ms\nOHOS_REPORT_STATUS: class=Local\nOHOS_REPORT_STATUS: test=${name}\nOHOS_REPORT_STATUS_CODE: ${status === 'pass' ? 0 : -2}\n`;
const observe = (raw, extra = {}) => localTestEvidence(raw + '[Hypium][end] run suites end', { outputComplete: true, interrupted: false, exitCode: 0, ...extra },
  { freshReport: true, compileOutput: 'Finished :entry:default@UnitTestArkTS' });
test('exit zero cannot conceal actual local failures and public evidence includes their exact IDs', () => {
  const evidence = observe(lines('broken', 'fail') + lines('old', 'pass'));
  assert.equal(evidence.completeRuntime, true); assert.equal(evidence.allObservedPassed, false);
  assert.deepEqual(publicLocalTestEvidence(evidence).failures, [{ id: 'entry::Local::broken', status: 'FAIL' }]);
  assert.equal(publicLocalTestEvidence(evidence).statuses, undefined);
});
test('existing failures, regressions, removed tests and new failing tests remain distinct', () => {
  const baseline = observe(lines('existing', 'fail') + lines('regressed', 'pass') + lines('removed', 'pass'));
  const current = observe(lines('existing', 'fail') + lines('regressed', 'fail') + lines('new', 'fail'));
  const diff = publicLocalTestEvidence(current, baseline).baselineComparison;
  assert.deepEqual(diff.regressions, ['entry::Local::regressed']);
  assert.deepEqual(diff.persistingFailures, ['entry::Local::existing']);
  assert.deepEqual(diff.noLongerObserved, ['entry::Local::removed']);
  assert.deepEqual(diff.newFailures, ['entry::Local::new']);
  assert.equal(current.allObservedPassed, false);
});
test('an interrupted report or incomplete baseline cannot establish regression attribution', () => {
  const current = observe(lines('old', 'pass'));
  const partial = observe(lines('old', 'fail'), { outputComplete: false });
  assert.equal(partial.completeRuntime, false);
  for (const [after, before] of [[partial, current], [current, partial]]) {
    const diff = publicLocalTestEvidence(after, before).baselineComparison;
    assert.equal(diff.comparable, false); assert.equal(diff.regressions, undefined);
  }
});

test('public local evidence includes exact native assertion messages and report lines without changing scoring', () => {
  const diagnostic = 'OHOS_REPORT_STATUS: stream=Error in broken, expect bluetooth_dispatch_failed equals unsupported_policy';
  const raw = lines('broken', 'fail') + diagnostic + '\n';
  const before = observe(lines('broken', 'fail')), after = observe(raw);
  assert.deepEqual(after.statuses, before.statuses);
  assert.equal(after.allObservedPassed, false);
  const exposed = publicLocalTestEvidence(after).runtimeDiagnostics;
  assert.equal(exposed.available, true);
  assert.equal(exposed.matchedLines, 1);
  assert.equal(exposed.messages[0].line, raw.split('\n').indexOf(diagnostic) + 1);
  assert.equal(exposed.messages[0].text, 'Error in broken, expect bluetooth_dispatch_failed equals unsupported_policy');
});

test('stale native report text is never exposed as a new failure diagnostic', () => {
  const raw = 'OHOS_REPORT_STATUS: stream=Error in old, stale assertion\n';
  const current = localTestEvidence(raw, { outputComplete: true, interrupted: false },
    { freshReport: false, compileOutput: 'Finished :entry:default@UnitTestArkTS' });
  assert.equal(current.runtimeDiagnostics.available, false);
  assert.deepEqual(current.runtimeDiagnostics.messages, []);
  assert.equal(current.completeRuntime, false);
});

test('diagnostics bound line count and message length while keeping all parsed failures', () => {
  const raw = Array.from({ length: 25 }, (_, i) => lines(`failure-${i}`, 'fail')
    + `OHOS_REPORT_STATUS: stream=Error in failure-${i}, ${'详情'.repeat(1000)}\n`).join('');
  const current = observe(raw), diagnostics = current.runtimeDiagnostics;
  assert.equal(current.failures.length, 25);
  assert.equal(diagnostics.matchedLines, 25);
  assert.equal(diagnostics.messages.length, 16);
  assert.equal(diagnostics.truncated, true);
  assert(diagnostics.messages.every(message => message.text.length <= 800 && message.truncated));
  assert.equal(current.allObservedPassed, false);
});
