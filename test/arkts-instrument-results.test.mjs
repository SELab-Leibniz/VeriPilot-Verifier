import assert from 'node:assert/strict';
import test from 'node:test';
import { arktsInstrumentRuntime, parseArktsInstrumentResults } from '../scripts/bench/arkts-instrument-results.mjs';
import { localTestEvidence, supportingTestVerification } from '../scripts/bench/local-test-evidence.mjs';

const frame = (klass, current, title, code) => [
  'OHOS_REPORT_STATUS: class=' + klass,
  'OHOS_REPORT_STATUS: current=' + current,
  'OHOS_REPORT_STATUS: id=JS',
  'OHOS_REPORT_STATUS: numtests=2',
  'OHOS_REPORT_STATUS: stream=',
  'OHOS_REPORT_STATUS: test=' + title,
  'OHOS_REPORT_STATUS_CODE: ' + code,
].join('\n');
const result = [
  'OHOS_REPORT_STATUS: class=preceding suite lifecycle metadata',
  frame('Example', 1, 'keeps working', 1), frame('Example', 1, 'keeps working', 0),
  frame('Example', 2, 'needs a fix', 1), frame('Example', 2, 'needs a fix', -2),
  'OHOS_REPORT_RESULT: stream=Tests run: 2, Failure: 1, Error: 0, Pass: 1, Ignore: 0',
  'OHOS_REPORT_CODE: -1',
  'TestFinished-ResultCode: 0', 'TestFinished-ResultMsg: your test finished!!!', 'user test finished.',
].join('\n');

test('uses the device case frames and confirms summary totals despite an exit-zero host runner', () => {
  assert.deepEqual(parseArktsInstrumentResults(result), {
    statuses: { 'entry::Example::keeps working': 'PASS', 'entry::Example::needs a fix': 'FAIL' },
    errors: [], finished: true,
  });
});

test('rejects unpaired outcomes, duplicate IDs, misleading totals and missing completion', () => {
  for (const [invalid, code] of [
    [result.replace(frame('Example', 2, 'needs a fix', -2), frame('WrongClass', 2, 'needs a fix', -2)), 'UNBOUND_CASE_OUTCOME'],
    [result.replaceAll('needs a fix', 'keeps working'), 'UNBOUND_CASE_OUTCOME'],
    [result.replace('Failure: 1', 'Failure: 0'), 'INCOMPLETE_DEVICE_REPORT'],
    [result.replace('user test finished.', ''), 'INCOMPLETE_DEVICE_REPORT'],
  ]) {
    const parsed = parseArktsInstrumentResults(invalid);
    assert.equal(parsed.finished, false);
    assert(parsed.errors.some(error => error.code === code), JSON.stringify(parsed.errors));
  }
});

test('classifies an incomplete runner report only after a clean compile and an unfinished named case', () => {
  const execution = { runtime: arktsInstrumentRuntime, compileSucceeded: true, exitCode: 0, outputComplete: true, interrupted: false };
  const prefix = [frame('Example', 1, 'keeps working', 1), frame('Example', 1, 'keeps working', 0), frame('Example', 2, 'unfinished', 1)];
  const aborted = [...prefix, 'TestFinished-ResultCode: -1', 'TestFinished-ResultMsg: App died', 'user test finished.'].join('\n');
  const summarize = (raw, options = {}) => {
    const currentExecution = { ...execution, ...options };
    return supportingTestVerification(localTestEvidence(raw, currentExecution, { freshReport: true, compileOutput: '' }), currentExecution);
  };
  assert.deepEqual(parseArktsInstrumentResults(aborted).errors, [
    { code: 'FAILED_TEST_SESSION' }, { code: 'INCOMPLETE_DEVICE_REPORT', activeCaseId: 'entry::Example::unfinished' },
  ]);
  assert.deepEqual(summarize(aborted), { kind: 'supporting', status: 'INCOMPLETE', incompleteReason: 'RUNNER_REPORT_INCOMPLETE' });
  assert.deepEqual(summarize(result), { kind: 'supporting', status: 'FAIL' });
  const incomplete = { kind: 'supporting', status: 'INCOMPLETE' };
  for (const report of [prefix.join('\n'), aborted.replace(prefix[1], frame('Example', 1, 'keeps working', -2)),
    result.replace('user test finished.', '')]) assert.deepEqual(summarize(report), incomplete);
  for (const executionOverride of [{ interrupted: true }, { compileSucceeded: false }, { exitCode: 1 }])
    assert.deepEqual(summarize(aborted, executionOverride), incomplete);
});
