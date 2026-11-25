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

// The pinned official reporter taskDone uses assertion failures for its aggregate
// code and reports runtime ERROR outcomes separately. No SDK module is imported.
// Unmodified fixture from OpenHarmony-6.1-Release:
// https://github.com/openharmony/testfwk_arkxtest/blob/3d3416b34dd33b45df6f6665a1144a7c98397006/jsunit/src/module/report/OhReport.js
async function officialSummary(summary) {
  const fs = await import('node:fs/promises');
  const vm = await import('node:vm');
  const source = await fs.readFile(new URL('./fixtures/OhReport.official.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async taskDone() {');
  const end = source.indexOf('\n  incorrectFormat()', start);
  assert(start >= 0 && end > start);
  const printed = []; let finishCode;
  const context = {
    SysTestKit: { workerPort: null, print: async value => printed.push(value) },
    PrintTag: Object.fromEntries(['OHOS_REPORT_RESULT','OHOS_REPORT_CODE','OHOS_REPORT_STATUS'].map(x => [x,x])),
    TAG: '[Hypium]', console: { info() {} },
    collectCoverageData: async () => assert.fail('Coverage must not run in this pure reporter fixture'),
  };
  const reporter = vm.runInNewContext('({' + source.slice(start, end) + '})', context);
  const suite = { getSummary: () => summary }, spec = { skipSpecNum: 0 };
  const config = { coverage: 'false', isBreakOnError: () => false };
  await reporter.taskDone.call({ abilityDelegatorArguments: {}, suiteService: suite,
    coreContext: { getDefaultService: name => ({ config, suite, spec })[name] },
    delegator: { finishTest(_message, code) { finishCode = code; } } });
  assert.equal(finishCode, 0);
  return printed.join('\n') + '\nTestFinished-ResultCode: ' + finishCode + '\nuser test finished.';
}
async function errorOnlyReport() {
  return [frame('Example',1,'keeps working',1), frame('Example',1,'keeps working',0),
    frame('Example',2,'throws an exception',1), frame('Example',2,'throws an exception',-1),
    await officialSummary({ total: 2, failure: 0, error: 1, pass: 1, ignore: 0, duration: 1 })].join('\n');
}

test('official reporter error-only aggregate zero completes frames while retaining ERROR', async () => {
  const raw = await errorOnlyReport();
  assert.match(raw, /OHOS_REPORT_CODE: 0/u);
  assert.deepEqual(parseArktsInstrumentResults(raw), {
    statuses: { 'entry::Example::keeps working': 'PASS', 'entry::Example::throws an exception': 'ERROR' },
    errors: [], finished: true,
  });
});

test('complete error-only report never turns a regression ERROR into a passing grade', async () => {
  const { gradeArkts } = await import('../scripts/bench/hypium-results.mjs');
  const raw = await errorOnlyReport(), parsed = parseArktsInstrumentResults(raw);
  const execution = { runtime: arktsInstrumentRuntime, compileSucceeded: true, exitCode: 0,
    outputComplete: true, interrupted: false, timedOut: false, freshReport: true };
  const grade = gradeArkts({ instance_id: 'generic', FAIL_TO_PASS: ['entry::Example::keeps working'],
    PASS_TO_PASS: ['entry::Example::throws an exception'] }, parsed, execution);
  assert.equal(grade.executed, true); // Report completion is distinct from a passing grade.
  assert.deepEqual(grade.testInventory, { expected: 2, observed: 2, extra: 0, extraFailed: 0,
    observedIdsSha256: grade.testInventory.observedIdsSha256 });
  assert.deepEqual(grade.p2p.testErrors, ['entry::Example::throws an exception']);
  assert.equal(grade.resolved, false); assert.equal(grade.validFailToPassBase, false);
  const evidence = localTestEvidence(raw, execution, { freshReport: true, compileOutput: '' });
  assert.equal(evidence.counts.ERROR, 1); assert.equal(evidence.allObservedPassed, false);
  assert.notEqual(supportingTestVerification(evidence, execution).status, 'PASS');
});

test('official aggregate with assertion failure and ERROR keeps both distinct', async () => {
  const raw = [frame('Example',1,'assertion fails',1),frame('Example',1,'assertion fails',-2),
    frame('Example',2,'throws an exception',1),frame('Example',2,'throws an exception',-1),
    await officialSummary({ total:2, failure:1, error:1, pass:0, ignore:0, duration:1 })].join('\n');
  assert.match(raw, /OHOS_REPORT_CODE: -1/u);
  assert.deepEqual(parseArktsInstrumentResults(raw), { statuses: {
    'entry::Example::assertion fails':'FAIL','entry::Example::throws an exception':'ERROR' }, errors:[],finished:true });
});

test('aggregate status must still agree with the official failure-only contract', async () => {
  for (const raw of [(await errorOnlyReport()).replace('OHOS_REPORT_CODE: 0','OHOS_REPORT_CODE: -1'),
    result.replace('OHOS_REPORT_CODE: -1','OHOS_REPORT_CODE: 0')]) {
    const parsed = parseArktsInstrumentResults(raw);
    assert.equal(parsed.finished,false);assert(parsed.errors.some(e=>e.code==='INCOMPLETE_DEVICE_REPORT'));
  }
});

test('aggregate zero cannot hide erased error totals or missing inventory', async () => {
  const raw = await errorOnlyReport();
  for (const invalid of [raw.replace('Error: 1','Error: 0'),raw.replace('Pass: 1','Pass: 2'),
    raw.replace('numtests=2','numtests=3'),raw.replace(frame('Example',2,'throws an exception',-1),''),
    raw.replace('user test finished.','')]) {
    const parsed=parseArktsInstrumentResults(invalid);assert.equal(parsed.finished,false);assert(parsed.errors.length>0);
  }
});
