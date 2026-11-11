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

/** Reviewer decisions carry meaning. The program binds case and deviation identities. */
export function reviewedRegressionFailures({ inventory, disposition, hasDeviation }) {
  const entries = disposition.cases ?? (disposition.explanations ?? []).map(item => ({
    id: item.failure, verdict: 'AUTHORIZED_CHANGE', reason: item.reason }));
  const failures = inventory?.failures?.length ? inventory.failures : [{ id: 'regression-check' }];
  const assigned = new Set(failures.map(item => item.id)), byId = new Map();
  for (const entry of entries) {
    if (!assigned.has(entry.id) || byId.has(entry.id))
      throw Object.assign(new Error('Regression case IDs must be assigned and unique.'), { code: 'REVIEW_ITEM_OWNERSHIP_INVALID' });
    byId.set(entry.id, entry);
  }
  const cases = failures.map(({ id }) => {
    const entry = byId.get(id);
    const confirmed = entry?.verdict === 'AUTHORIZED_CHANGE' || entry?.verdict === 'REGRESSION' && hasDeviation(entry.objectId);
    return { id, verdict: confirmed ? entry.verdict : 'UNVERIFIED', reason: entry?.verdict === 'REGRESSION' && !confirmed
      ? 'The reported regression has no saved evidence-backed deviation.' : entry?.reason ?? disposition.reason,
      ...(confirmed && entry.objectId ? { objectId: entry.objectId } : {}) };
  });
  return { cases, status: cases.some(item => item.verdict === 'UNVERIFIED') ? 'UNVERIFIED'
    : cases.some(item => item.verdict === 'REGRESSION') ? 'REVIEWED' : 'EXPLAINED' };
}
