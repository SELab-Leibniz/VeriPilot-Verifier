import { parseHypium } from './hypium-results.mjs';

// These are original, public workspace tests, never the hidden test oracle.
export function localTestEvidence(raw, execution, { freshReport, compileOutput }) {
  const parsed = freshReport ? parseHypium(raw) : { statuses: {}, errors: [], finished: false };
  const completeRuntime = Boolean(freshReport && execution.outputComplete && !execution.interrupted
    && parsed.finished && !parsed.errors.length && /Finished :entry:.*@UnitTestArkTS/u.test(compileOutput));
  const counts = {};
  for (const status of Object.values(parsed.statuses)) counts[status] = (counts[status] ?? 0) + 1;
  return { freshReport, finished: parsed.finished, completeRuntime, statuses: parsed.statuses, counts,
    allObservedPassed: completeRuntime && Object.keys(parsed.statuses).length > 0 && Object.values(parsed.statuses).every(status => status === 'PASS'),
    failures: Object.entries(parsed.statuses).filter(([, status]) => status !== 'PASS').map(([id, status]) => ({ id, status })),
    metadataErrors: parsed.errors };
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
