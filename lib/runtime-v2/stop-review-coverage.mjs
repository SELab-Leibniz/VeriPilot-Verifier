// Describes the host's selected denominator, never whether the inventory itself
// includes every obligation in the original request. This is display metadata;
// it does not grant a verdict, execution permission or approval authority.
export function stopReviewDenominator({ requirements = [], originalRequirements = false, approvedProposalInventory } = {}) {
  const selected = requirements.filter(item => !item.programStanding);
  const ids = new Set(selected.map(item => item.objectId));
  const atoms = approvedProposalInventory?.requiredAtoms;
  const boundInventory = /^[a-f0-9]{64}$/u.test(approvedProposalInventory?.inventorySha256 ?? '')
    && Array.isArray(atoms) && atoms.length > 0
    && atoms.every(atom => atom && typeof atom.id === 'string' && typeof atom.objectId === 'string')
    && new Set(atoms.map(atom => atom.id)).size === atoms.length
    && atoms.every(atom => ids.has(atom.objectId));
  return { kind: boundInventory ? 'APPROVED_REQUIRED_INVENTORY'
    : originalRequirements ? 'REVIEWER_SELECTED_CHECKLIST' : 'TASK_BASELINE',
    requirementCount: selected.length,
    ...(boundInventory ? { inventorySha256: approvedProposalInventory.inventorySha256, requiredAtomCount: atoms.length } : {}),
    originalRequirementCompleteness: 'NOT_PROVEN_BY_DENOMINATOR' };
}

export function describeStopReviewDenominator(denominator, locale = 'en') {
  const zh = String(locale).startsWith('zh');
  const count = Number.isSafeInteger(denominator?.requirementCount) && denominator.requirementCount >= 0
    ? denominator.requirementCount : '?';
  const qualifier = zh ? '该分母本身不证明清单已完整覆盖原始需求。'
    : 'This denominator does not establish that the checklist covers every original requirement.';
  if (denominator?.kind === 'APPROVED_REQUIRED_INVENTORY') {
    const atoms = Number.isSafeInteger(denominator.requiredAtomCount) && denominator.requiredAtomCount > 0
      ? denominator.requiredAtomCount : '?';
    return zh ? `审查分母：已绑定的封存必需清单 ${atoms} 项；本轮清单义务 ${count} 项。${qualifier}`
      : `Review denominator: sealed required inventory (${atoms} atoms); ${count} checklist obligations in this scope. ${qualifier}`;
  }
  if (denominator?.kind === 'REVIEWER_SELECTED_CHECKLIST')
    return zh ? `审查分母：审查器从原文选择的 ${count} 项清单义务；完成仅指这份清单。${qualifier}`
      : `Review denominator: ${count} checklist obligations selected by the reviewer from original sources; completion refers to that checklist. ${qualifier}`;
  if (denominator?.kind === 'TASK_BASELINE')
    return zh ? `审查分母：任务基线中的 ${count} 项清单义务。${qualifier}`
      : `Review denominator: ${count} checklist obligations from the task baseline. ${qualifier}`;
  return zh ? '审查分母来源未记录；清单数量不能证明原始需求已全部覆盖。'
    : 'Review denominator provenance was not recorded; checklist counts do not establish coverage of every original requirement.';
}

export function summarizeStopReviewCoverage(coverage, locale = 'en') {
  if (!coverage) return null;
  const source = coverage.denominator;
  const denominator = source && ['APPROVED_REQUIRED_INVENTORY', 'REVIEWER_SELECTED_CHECKLIST', 'TASK_BASELINE'].includes(source.kind)
    ? { kind: source.kind, requirementCount: source.requirementCount,
      ...(source.kind === 'APPROVED_REQUIRED_INVENTORY' ? { inventorySha256: source.inventorySha256, requiredAtomCount: source.requiredAtomCount } : {}),
      originalRequirementCompleteness: 'NOT_PROVEN_BY_DENOMINATOR' } : null;
  return { total: coverage.total, unverified: coverage.unverified,
    ...(denominator ? { denominator } : {}),
    description: describeStopReviewDenominator(denominator, locale) };
}

/** Count distinct reviewed subjects, retaining the item-level denominator. */
export function stopReviewCoverage({ requirements = [], judgements = [], followUps = [], fileAssessments = [],
  regressionCases = [], frameItems = [], unverifiedItems = [], denominator } = {}) {
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
  return { total: items.length, unverified, unverifiedRatio: items.length ? unverified / items.length : null, items,
    ...(denominator ? { denominator: structuredClone(denominator) } : {}) };
}
