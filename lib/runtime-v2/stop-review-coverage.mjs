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


// Display only the scope retained by the current host assessment. These counts
// neither extend ordinary checklist coverage nor validate reviewer semantics.
export function summarizeStopReviewMethodScope({ binding = {}, mode, challenges, publicVerifierConfigured, requirementCheck } = {}) {
  const selection = challenges?.selection;
  const selectedCount = Array.isArray(selection?.selected) && selection.selected.length <= 3 ? selection.selected.length : null;
  const eligibleCount = Number.isSafeInteger(selection?.eligibleCount) && selection.eligibleCount >= (selectedCount ?? 0)
    ? selection.eligibleCount : null;
  const status = ['PARTIAL_SCOPE', 'METHOD_NOT_EXERCISED'].includes(challenges?.status) ? challenges.status : 'NOT_RECORDED';
  const configured = publicVerifierConfigured === true;
  const verifierStatus = !configured ? 'NOT_CONFIGURED'
    : ['PASS', 'FAIL', 'INCOMPLETE'].includes(requirementCheck?.status) ? requirementCheck.status : 'NOT_OBSERVED';
  return { version: 1, binding: { taskId: binding.taskId, evaluationId: binding.evaluationId, assessmentId: binding.assessmentId },
    implementationChallenges: { mode: mode === 'sampled' ? 'sampled' : 'optional', status,
      ...(mode === 'sampled' ? { selectedCount, eligibleCount } : {}), exhaustive: false, semanticsVerified: false },
    publicRequirementVerifier: { configured, status: verifierStatus,
      ...(configured && Array.isArray(requirementCheck?.checks) ? { checkCount: requirementCheck.checks.length } : {}) } };
}

// Call only after the existing host/current-assessment checks. Retained scope
// from another assessment cannot become this assessment's public summary.
export function currentStopReviewMethodScope(scope, identity) {
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const identities = ['taskId', 'evaluationId', 'assessmentId'];
  if (!exactKeys(scope, ['version', 'binding', 'implementationChallenges', 'publicRequirementVerifier']) || scope.version !== 1
    || !exactKeys(scope.binding, identities) || identities.some(key => typeof identity?.[key] !== 'string'
      || !identity[key] || identity[key].length > 4096 || scope.binding[key] !== identity[key])) return null;
  const method = scope.implementationChallenges, verifier = scope.publicRequirementVerifier;
  const sampled = method?.mode === 'sampled';
  if (!exactKeys(method, ['mode', 'status', ...(sampled ? ['selectedCount', 'eligibleCount'] : []), 'exhaustive', 'semanticsVerified'])
    || !['sampled', 'optional'].includes(method.mode) || !['PARTIAL_SCOPE', 'METHOD_NOT_EXERCISED', 'NOT_RECORDED'].includes(method.status)
    || method.exhaustive !== false || method.semanticsVerified !== false) return null;
  if (sampled && (method.selectedCount !== null && (!Number.isSafeInteger(method.selectedCount) || method.selectedCount < 0 || method.selectedCount > 3)
    || method.eligibleCount !== null && (!Number.isSafeInteger(method.eligibleCount) || method.eligibleCount < (method.selectedCount ?? 0)))) return null;
  const hasCount = Object.hasOwn(verifier ?? {}, 'checkCount');
  if (!exactKeys(verifier, ['configured', 'status', ...(hasCount ? ['checkCount'] : [])]) || typeof verifier.configured !== 'boolean'
    || (!verifier.configured ? verifier.status !== 'NOT_CONFIGURED' || hasCount : !['PASS', 'FAIL', 'INCOMPLETE', 'NOT_OBSERVED'].includes(verifier.status))
    || hasCount && (!Number.isSafeInteger(verifier.checkCount) || verifier.checkCount < 0)) return null;
  return { version: 1, binding: Object.fromEntries(identities.map(key => [key, identity[key]])),
    implementationChallenges: { mode: method.mode, status: method.status,
      ...(sampled ? { selectedCount: method.selectedCount, eligibleCount: method.eligibleCount } : {}), exhaustive: false, semanticsVerified: false },
    publicRequirementVerifier: { configured: verifier.configured, status: verifier.status, ...(hasCount ? { checkCount: verifier.checkCount } : {}) } };
}

export function describeStopReviewMethodScope(scope, locale = 'en') {
  if (!scope) return null;
  const zh = String(locale).startsWith('zh'), method = scope.implementationChallenges, verifier = scope.publicRequirementVerifier;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : '?';
  const meaningfulMethod = method?.mode === 'sampled' || method?.status === 'PARTIAL_SCOPE';
  if (!meaningfulMethod && verifier?.configured !== true) return null;
  const challenge = method?.mode === 'sampled'
    ? (zh ? `实现质疑抽查：${count(method.selectedCount)}/${count(method.eligibleCount)} 项可供抽查的义务。抽查范围有限，审查器的判断不构成语义正确性证明。`
      : `Implementation challenge sample: ${count(method.selectedCount)} of ${count(method.eligibleCount)} eligible duties. The sample is partial; reviewer appraisals do not prove semantics.`)
    : method?.status === 'PARTIAL_SCOPE'
      ? (zh ? '本轮已记录部分实现质疑；审查器的判断不构成语义正确性证明。' : 'Implementation challenges cover a partial scope; reviewer appraisals do not prove semantics.') : '';
  const verifierStatus = ['NOT_CONFIGURED', 'NOT_OBSERVED', 'PASS', 'FAIL', 'INCOMPLETE'].includes(verifier?.status) ? verifier.status : 'NOT_RECORDED';
  const check = verifierStatus === 'NOT_CONFIGURED'
    ? (zh ? '未配置公开需求验证器。' : 'No public requirement verifier is configured.')
    : verifierStatus === 'NOT_OBSERVED'
      ? (zh ? '已配置公开需求验证器，本轮没有当前执行结果。' : 'A public requirement verifier is configured; no current result was observed.')
      : (zh ? `公开需求验证器：${verifierStatus}。有限检查不证明未测试行为。`
        : `Public requirement verifier: ${verifierStatus}. Finite checks do not establish untested behavior.`);
  return [challenge, check].filter(Boolean).join(' ');
}
