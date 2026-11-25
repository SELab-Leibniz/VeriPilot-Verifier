export const arktsInstrumentRuntime = 'harmonyos-instrument-test-v1';
const identityFields = new Set(['class', 'current', 'id', 'numtests', 'test', 'skipReason']);
const outcomeByCode = { '0': 'PASS', '-2': 'FAIL', '-1': 'ERROR' };
const totalsPattern = /^OHOS_REPORT_RESULT: stream=Tests run: (\d+), Failure: (\d+), Error: (\d+), Pass: (\d+), Ignore: (\d+)$/u;

// Device-mode Hypium emits AbilityManager frames on stdout. The corresponding
// console-only [Hypium] markers are available in Previewer logs only.
export function parseArktsInstrumentResults(text, module = 'entry') {
  const statuses = new Map(), errors = [];
  const counts = { FAIL: 0, ERROR: 0, PASS: 0, IGNORED: 0 };
  let frame = new Map(), active, declaredTotal, summary, reportCode, runnerFinished = false, commandFinished = false, ordinal = 0;
  function fault(code, details = {}) {
    errors.push({ code, ...details });
  }
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const property = /^OHOS_REPORT_STATUS: ([A-Za-z]+)=(.*)$/u.exec(line);
    if (property && identityFields.has(property[1])) {
      const [, name, value] = property;
      // A suite lifecycle class may immediately precede the case class.
      if (frame.has(name) && (name !== 'class' || frame.has('current'))) fault('DUPLICATE_FIELD', { name });
      frame.set(name, value);
      continue;
    }
    const status = /^OHOS_REPORT_STATUS_CODE: (-?\d+)$/u.exec(line);
    if (status) {
      const test = frame, code = status[1];
      frame = new Map();
      const indexText = test.get('current') ?? '', countText = test.get('numtests') ?? '';
      const current = Number(indexText), total = Number(countText);
      const klass = test.get('class'), name = test.get('test');
      if (summary || reportCode !== undefined || runnerFinished || test.get('id') !== 'JS' || !klass || !name
        || !/^\d+$/u.test(indexText) || !/^\d+$/u.test(countText) || !Number.isSafeInteger(current) || !Number.isSafeInteger(total)
        || current <= 0 || current > total || declaredTotal !== undefined && declaredTotal !== total) {
        fault('INVALID_CASE_FRAME', { current, total });
        continue;
      }
      declaredTotal ??= total;
      const id = `${module}::${klass}::${name}`;
      if (code === '1') {
        if (active || current !== ordinal + 1) fault('UNEXPECTED_CASE_START', { id, current });
        active = { current, id };
        continue;
      }
      const outcome = code === '0' && test.has('skipReason') ? 'IGNORED' : outcomeByCode[code];
      if (!outcome || !active || active.current !== current || active.id !== id || statuses.has(id)) {
        fault('UNBOUND_CASE_OUTCOME', { id, current, status: code });
        continue;
      }
      active = undefined;
      ordinal = current;
      statuses.set(id, outcome);
      counts[outcome]++;
      continue;
    }
    const finalTotals = totalsPattern.exec(line);
    if (finalTotals) {
      if (summary || reportCode !== undefined || runnerFinished) fault('UNEXPECTED_TEST_SUMMARY');
      summary = finalTotals.slice(1).map(Number);
      continue;
    }
    const aggregate = /^OHOS_REPORT_CODE: (-?\d+)$/u.exec(line);
    if (aggregate) {
      if (!summary || reportCode !== undefined || runnerFinished) fault('UNEXPECTED_AGGREGATE_STATUS');
      reportCode = Number(aggregate[1]);
      continue;
    }
    const finished = /^TestFinished-ResultCode: (-?\d+)$/u.exec(line);
    if (finished) {
      if (runnerFinished || reportCode === undefined || finished[1] !== '0') fault('FAILED_TEST_SESSION');
      runnerFinished = true;
      continue;
    }
    if (line === 'user test finished.') {
      if (!runnerFinished || commandFinished) fault('UNEXPECTED_COMMAND_FINISH');
      commandFinished = true;
    }
  }
  const observed = [ordinal, counts.FAIL, counts.ERROR, counts.PASS, counts.IGNORED];
  // Hypium's aggregate code reflects assertion failures; ERROR statuses stay separate.
  const finished = declaredTotal > 0 && ordinal === declaredTotal && !active && runnerFinished && commandFinished
    && summary?.every((value, index) => value === observed[index]) === true
    && reportCode === (counts.FAIL ? -1 : 0);
  if (!finished) fault('INCOMPLETE_DEVICE_REPORT', active ? { activeCaseId: active.id } : undefined);
  return { statuses: Object.fromEntries(statuses), errors, finished: finished && errors.length === 0 };
}
