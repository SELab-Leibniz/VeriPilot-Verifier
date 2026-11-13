/** Count distinct reviewed subjects, retaining the item-level denominator. */
export function stopReviewCoverage({ requirements = [], judgements = [], followUps = [], fileAssessments = [],
  regressionCases = [], frameItems = [], unverifiedItems = [] } = {}) {
  const byObject = new Map([...judgements, ...followUps].map(row => [row.objectId, row]));
  const items = requirements.filter(item => !item.programStanding).map(item => {
    const row = byObject.get(item.objectId);
    return { id: item.objectId, type: 'REQUIREMENT', disposition: row?.environmentUnexecutable?.proofDigest
      ? 'ENVIRONMENT_UNEXECUTABLE' : row?.judgement ?? 'NO_CONFIRMED_DEVIATION',
      ...(row?.reason ? { reason: row.reason } : {}), unverified: unverifiedItems.some(entry => entry.objectId === item.objectId) };
  });
  for (const file of fileAssessments) items.push({ id: 'file:' + file.path, type: 'FILE_QUALITY', disposition: file.status,
    reason: file.reason, unverified: file.status === 'UNVERIFIED' });
  for (const entry of regressionCases) items.push({ id: entry.id, type: 'REGRESSION_CHECK', disposition: entry.verdict,
    reason: entry.reason, unverified: entry.verdict === 'UNVERIFIED' });
  for (const entry of frameItems) items.push({ id: entry.id, type: entry.type, disposition: entry.disposition,
    ...(entry.reason ? { reason: entry.reason } : {}), unverified: entry.disposition === 'UNVERIFIED' });
  for (const entry of unverifiedItems) if (!items.some(item => item.id === entry.id || entry.objectId && item.id === entry.objectId))
    items.push({ id: entry.id, type: entry.type, disposition: 'UNVERIFIED', reason: entry.reason, unverified: true });
  const unverified = items.filter(item => item.unverified).length;
  return { total: items.length, unverified, unverifiedRatio: items.length ? unverified / items.length : null, items };
}
