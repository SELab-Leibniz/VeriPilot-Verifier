// Selection is a ledger, not a top-N filter. No valid candidate may vanish
// between the model's review and the brief delivered to the host.
export const FRAME_SELECTION_LIMITS = { guidance: 10, scenario: 6, check: 10, checkFamily: 5 };

export function auditFrameSelection(candidates, selection) {
  const issues = [], expected = new Map(candidates.map(item => [item.id, item]));
  const reviews = new Map(), counts = { guidance: 0, scenario: 0, check: 0 }, families = new Map();
  for (const row of selection?.reviews ?? []) {
    if (!expected.has(row.id)) { issues.push(`Unknown candidate ${row.id}.`); continue; }
    if (reviews.has(row.id)) { issues.push(`Repeated candidate ${row.id}.`); continue; }
    reviews.set(row.id, row);
    if (!row.reason?.trim()) issues.push(`${row.id} needs a substantive reason.`);
    if (row.decision === 'select') {
      const item = expected.get(row.id);
      counts[item.type]++;
      if (item.type === 'check') families.set(item.family, (families.get(item.family) ?? 0) + 1);
      if (row.coveredBy) issues.push(`${row.id} is selected and cannot also be covered.`);
    } else if (row.decision === 'covered') {
      const target = expected.get(row.coveredBy), item = expected.get(row.id);
      if (!target || target.id === item.id || target.type !== item.type)
        issues.push(`${row.id} needs a different covering candidate of the same type.`);
      // Two public entries, or changed and preserved behavior, are distinct
      // contracts even when their prose mentions the same feature.
      else if (item.type === 'scenario' && (item.kind !== target.kind
        || item.entryPoint?.path !== target.entryPoint?.path || item.entryPoint?.symbol !== target.entryPoint?.symbol
        || item.contractCell !== target.contractCell))
        issues.push(`${row.id} cannot be covered by a different entry, contract cell or behavior kind.`);
    } else if (row.decision !== 'reject') issues.push(`${row.id} has an invalid decision.`);
    else if (row.coveredBy) issues.push(`${row.id} must use covered for a duplicate.`);
  }
  for (const id of expected.keys()) if (!reviews.has(id)) issues.push(`Missing candidate ${id}.`);
  for (const row of reviews.values()) if (row.decision === 'covered' && reviews.get(row.coveredBy)?.decision !== 'select')
    issues.push(`${row.id} must point directly to a selected candidate, without a chain or cycle.`);
  for (const [type, count] of Object.entries(counts)) if (count > FRAME_SELECTION_LIMITS[type])
    issues.push(`Selected ${count} ${type} items; limit is ${FRAME_SELECTION_LIMITS[type]}. Explicitly cover duplicates or reject unsupported claims; never drop a distinct supported boundary to meet the limit.`);
  for (const [family, count] of families) if (count > FRAME_SELECTION_LIMITS.checkFamily)
    issues.push(`Selected ${count} checks in ${family}; limit is ${FRAME_SELECTION_LIMITS.checkFamily}.`);
  return { complete: issues.length === 0, issues,
    dispositions: candidates.map(item => ({ id: item.id, type: item.type,
      ...(reviews.has(item.id) ? reviews.get(item.id) : { decision: 'unresolved', reason: 'No selector disposition.' }) })) };
}
