/** Keep unresolved observations separate from confirmed deviations and run failures. */
export function summarizeStopUnverified({ requirements = [], judgements = [], followUps = [], fileAssessments = [],
  regressionCheck, unresolvedPaths = [] } = {}) {
  const items = [];
  for (const row of judgements.filter(row => row.judgement === 'UNVERIFIED'))
    items.push({ id: row.objectId, objectId: row.objectId, type: row.citationFailure ? 'CITATION' : 'REQUIREMENT', reason: row.reason });
  for (const row of followUps.filter(row => row.judgement === 'UNVERIFIED'))
    items.push({ id: row.objectId, objectId: row.objectId, type: 'DEVIATION_RECHECK', reason: row.reason,
      ...(row.familyId ? { familyId: row.familyId } : {}), ...(row.observationId ? { observationId: row.observationId } : {}) });
  for (const file of fileAssessments.filter(file => file.status === 'UNVERIFIED'))
    items.push({ id: `file:${file.path}`, type: file.citationFailure ? 'CITATION' : 'FILE_QUALITY', reason: file.reason });
  for (const entry of unresolvedPaths) for (const binding of entry.paths)
    items.push({ id: `${entry.objectId}:output:${binding.requiredPath}`, objectId: entry.objectId,
      type: 'OUTPUT_PATH', reason: binding.reason ?? `The original output path is ambiguous: ${binding.requiredPath}` });
  if (regressionCheck?.status === 'UNVERIFIED') {
    if (regressionCheck.cases) {
      for (const entry of regressionCheck.cases.filter(entry => entry.verdict === 'UNVERIFIED'))
        items.push({ id: entry.id, type: 'REGRESSION_CHECK', reason: entry.reason });
    } else {
    const explained = new Set((regressionCheck.explanations ?? []).map(entry => entry.failure));
    const failures = (regressionCheck.failureInventory?.failures ?? []).filter(entry => !explained.has(entry.id));
    for (const failure of failures.length ? failures : [{ id: 'regression-check' }])
      items.push({ id: failure.id, type: 'REGRESSION_CHECK', reason: regressionCheck.reason });
    }
  }
  const originalIds = new Set(requirements.filter(item => !item.programStanding).map(item => item.objectId));
  const unresolved = new Set(items.filter(item => ['REQUIREMENT', 'OUTPUT_PATH'].includes(item.type)
    && originalIds.has(item.objectId)).map(item => item.objectId));
  return { items, originalRequirements: originalIds.size, unresolvedRequirements: unresolved.size,
    majorityUnverified: originalIds.size > 0 && unresolved.size > originalIds.size / 2 };
}
