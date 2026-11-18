import { parseHypium } from './hypium-results.mjs';
import { arktsInstrumentRuntime, parseArktsInstrumentResults } from './arkts-instrument-results.mjs';

function runtimeDiagnostics(raw, freshReport) {
  const messages = [];
  let matchedLines = 0;
  if (freshReport) for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const marker = 'OHOS_REPORT_STATUS: stream=Error in ';
    const start = line.indexOf(marker);
    if (start < 0) continue;
    matchedLines++;
    if (messages.length >= 16) continue;
    const text = line.slice(start + 'OHOS_REPORT_STATUS: stream='.length);
    messages.push({ line: index + 1, text: text.slice(0, 800), truncated: text.length > 800 });
  }
  return { available: Boolean(freshReport), messages, matchedLines, truncated: matchedLines > messages.length,
    interpretation: 'Fresh original local runtime assertion messages only. Diagnostic text does not establish test identity, completion or score; use the parsed results separately. Line numbers refer to the supplied report; bench_check exposes its archived reportPath.' };
}

// These are original, public workspace tests, never the hidden test oracle.
export function localTestEvidence(raw, execution, { freshReport, compileOutput }) {
  const instrument = execution.runtime === arktsInstrumentRuntime;
  const parse = instrument ? parseArktsInstrumentResults : parseHypium;
  const parsed = freshReport ? parse(raw) : { statuses: {}, errors: [], finished: false };
  const compiled = instrument ? execution.compileSucceeded === true : /Finished :entry:.*@UnitTestArkTS/u.test(compileOutput);
  const completeRuntime = Boolean(freshReport && execution.outputComplete && !execution.interrupted
    && parsed.finished && !parsed.errors.length && compiled);
  const counts = {};
  for (const status of Object.values(parsed.statuses)) counts[status] = (counts[status] ?? 0) + 1;
  return { freshReport, finished: parsed.finished, completeRuntime, statuses: parsed.statuses, counts,
    allObservedPassed: completeRuntime && Object.keys(parsed.statuses).length > 0 && Object.values(parsed.statuses).every(status => status === 'PASS'),
    failures: Object.entries(parsed.statuses).filter(([, status]) => status !== 'PASS').map(([id, status]) => ({ id, status })),
    metadataErrors: parsed.errors, runtimeDiagnostics: runtimeDiagnostics(raw, freshReport) };
}

export function supportingTestVerification(current, execution) {
  const attempted = current.finished || Object.keys(current.statuses).length > 0
    || execution.device && Number.isFinite(execution.deviceDurationMs);
  if (!attempted) return null;
  const kind = 'supporting';
  if (current.allObservedPassed && execution.exitCode === 0) return { kind, status: 'PASS' };
  if (current.completeRuntime && current.counts.FAIL > 0) return { kind, status: 'FAIL' };

  const incompleteReport = execution.runtime === arktsInstrumentRuntime && execution.compileSucceeded === true
    && execution.exitCode === 0 && execution.outputComplete === true && !execution.interrupted
    && current.freshReport && !current.completeRuntime && !current.counts.FAIL && !current.counts.ERROR
    && current.metadataErrors.length === 2 && current.metadataErrors[0].code === 'FAILED_TEST_SESSION'
    && current.metadataErrors[1].code === 'INCOMPLETE_DEVICE_REPORT' && current.metadataErrors[1].activeCaseId;
  return { kind, status: 'INCOMPLETE', ...(incompleteReport ? { incompleteReason: 'RUNNER_REPORT_INCOMPLETE' } : {}) };
}

export function publicLocalTestEvidence(current, baseline) {
  const { statuses, ...summary } = current;
  if (!baseline) return { ...summary, baselineComparison: { available: false } };
  const comparable = baseline.completeRuntime === true && current.completeRuntime === true;
  return { ...summary, baselineComparison: { available: true, comparable,
    baselineCounts: baseline.counts, baselineFailures: baseline.failures,
    ...(comparable ? {
      regressions: Object.keys(baseline.statuses).filter(id => baseline.statuses[id] === 'PASS' && statuses[id] && statuses[id] !== 'PASS'),
      noLongerObserved: Object.keys(baseline.statuses).filter(id => !Object.hasOwn(statuses, id)),
      persistingFailures: current.failures.filter(({ id, status }) => baseline.statuses[id] === status).map(({ id }) => id),
      newFailures: current.failures.filter(({ id }) => !Object.hasOwn(baseline.statuses, id)).map(({ id }) => id),
    } : {}),
    interpretation: 'Observed original local tests only. Existing failures remain failures; matching a baseline is not proof of correctness.' } };
}
