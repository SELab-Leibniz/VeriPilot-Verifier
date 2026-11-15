// Selection is a ledger, not a top-N filter. No valid candidate may vanish
// between the model's review and the brief delivered to the host.
export const FRAME_SELECTION_LIMITS = { guidance: 10, scenario: 6, check: 10, checkFamily: 5 };

// Each accepted receipt survives an unfinished sibling or a later timeout.
// Pending and quota-deferred candidates remain visible in the internal ledger.
export function createFrameSelectionLedger(candidates) {
  const expected = new Map(candidates.map(item => [item.id, item])), receipts = new Map();
  let lastIssues = [];
  const snapshot = () => {
    const selected = new Set(), counts = {}, families = {}, dispositions = [], issues = [...lastIssues];
    for (const row of receipts.values()) {
      const item = expected.get(row.id);
      if (row.decision !== 'select') continue;
      const quota = (counts[item.type] ?? 0) >= FRAME_SELECTION_LIMITS[item.type]
        || item.type === 'check' && (families[item.family] ?? 0) >= FRAME_SELECTION_LIMITS.checkFamily;
      if (quota) continue;
      selected.add(item.id); counts[item.type] = (counts[item.type] ?? 0) + 1;
      if (item.type === 'check') families[item.family] = (families[item.family] ?? 0) + 1;
    }
    for (const item of candidates) {
      const row = receipts.get(item.id);
      let result = row ? { ...row } : { id: item.id, decision: 'pending', reason: 'No accepted selector receipt.' };
      if (row?.decision === 'select' && !selected.has(item.id))
        result = { ...row, decision: 'deferred', reason: `Publication quota reached. Selector reason: ${row.reason}` };
      if (row?.decision === 'covered' && !selected.has(row.coveredBy))
        result = { ...row, decision: 'pending', reason: 'Covering candidate is not an accepted published selection.' };
      if (['pending', 'deferred'].includes(result.decision)) issues.push(`${item.id}: ${result.reason}`);
      dispositions.push({ ...result, type: item.type });
    }
    return { complete: issues.length === 0, publishable: selected.size > 0, issues, dispositions };
  };
  return {
    snapshot,
    submit(rows) {
      const issues = [], duplicates = new Set(), seen = new Set();
      for (const row of rows ?? []) if (seen.has(row?.id)) duplicates.add(row.id); else seen.add(row?.id);
      for (const row of rows ?? []) {
        const item = expected.get(row?.id), target = expected.get(row?.coveredBy);
        let issue;
        if (!item || duplicates.has(row.id)) issue = `Unknown or repeated candidate ${row?.id}.`;
        else if (typeof row.reason !== 'string' || !row.reason.trim()) issue = `${row.id} needs a substantive reason.`;
        else if (!['select', 'reject', 'covered', 'defer'].includes(row.decision)) issue = `${row.id} has an invalid decision.`;
        else if (row.decision !== 'covered' && row.coveredBy) issue = `${row.id} cannot name a covering candidate.`;
        else if (row.decision === 'covered' && (!target || target.id === item.id || target.type !== item.type
          || item.type === 'scenario' && (item.kind !== target.kind || item.entryPoint?.path !== target.entryPoint?.path
            || item.entryPoint?.symbol !== target.entryPoint?.symbol))) issue = `${row.id} cannot cover a different type, behavior kind or public entry.`;
        if (issue) { issues.push(issue); continue; }
        receipts.set(row.id, { id: row.id, decision: row.decision === 'defer' ? 'deferred' : row.decision, reason: row.reason,
          ...(row.coveredBy ? { coveredBy: row.coveredBy } : {}) });
      }
      lastIssues = issues;
      return snapshot();
    },
  };
}

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
      else if (item.type === 'scenario') {
        if (item.kind !== target.kind)
          issues.push(`${row.id} is ${item.kind}, but ${target.id} is ${target.kind}. Select it separately or name a selected candidate with the same behavior kind.`);
        if (item.entryPoint?.path !== target.entryPoint?.path || item.entryPoint?.symbol !== target.entryPoint?.symbol)
          issues.push(`${row.id} checks ${item.entryPoint?.path}#${item.entryPoint?.symbol}, but ${target.id} checks ${target.entryPoint?.path}#${target.entryPoint?.symbol}. Select it separately or name a selected candidate for the same public entry. Mentioning another entry in prose is not an entryPoint binding.`);
        // contractCell is a proposal's classification, not another observable
        // contract. Equal checks may legitimately have different labels.
      }
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
