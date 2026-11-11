/** Only a completed, exact single-test run can establish an isolation failure. */
export function isolatedRegressionResult(run, id) {
  if (run.reason || run.exitCode !== 0) return null;
  const reports = [...(run.outputTail ?? '').matchAll(/^RC_REGRESSION_CASE (.+)$/gmu)];
  if (reports.length !== 1) return null;
  try {
    const result = JSON.parse(reports[0][1]);
    return result.id === id && result.complete === true && result.status === 'PASS'
      && result.observed?.length === 1 && result.observed[0] === id ? result : null;
  } catch { return null; }
}

export async function triageRegressionFailures({ failures, baseline, isolate, signal }) {
  const cases = [];
  for (const failure of failures) {
    signal?.throwIfAborted();
    const original = baseline?.completeRuntime === true ? baseline.statuses?.[failure.id] : null;
    if (['FAIL', 'ERROR'].includes(original)) {
      cases.push({ id: failure.id, type: 'PRE_EXISTING_FAILURE', reason: `The task-start baseline already reported ${original}.` });
      continue;
    }
    const isolated = isolate ? await isolate(failure.id) : null;
    if (isolatedRegressionResult(isolated ?? {}, failure.id))
      cases.push({ id: failure.id, type: 'TEST_ISOLATION', reason: 'The full suite failed but the exact test passed alone in a fresh process.',
        isolatedRun: isolated });
    else cases.push({ id: failure.id, type: 'REVIEW_REQUIRED',
      reason: isolated?.reason ?? (isolate ? 'The isolated run did not establish a clean pass.' : 'No exact single-test runner is configured.'),
      ...(isolated ? { isolatedRun: isolated } : {}) });
  }
  return { version: 1, cases };
}
