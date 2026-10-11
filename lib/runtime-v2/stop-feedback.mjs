const unique = values => [...new Set(values.filter(value => value != null && value !== ""))];
const sourceId = value => String(value ?? "").replace(/^M\d+:/u, "").replace(/@\d+$/u, "");
const text = (locale, zh, en) => String(locale).startsWith("zh") ? zh : en;

function selectedLocations(evidence, citations, owners) {
  const selected = unique(evidence.flatMap(value => String(value).match(/raw:[a-f0-9]{32}(?:#L[1-9]\d*(?:-L?[1-9]\d*)?)?/gu) ?? []));
  const resolved = citations.filter(citation => citation.usedBy?.some(owner => owners.includes(owner))
    || selected.includes(citation.selection));
  const positions = resolved.map(citation => {
    const location = citation.frozen === true ? citation.snapshotPath : citation.path ?? citation.source;
    const range = citation.start ? `#L${citation.start}-L${citation.end ?? citation.start}` : "";
    return location ? `${location}${range}` : citation.selection;
  });
  // Raw ids and file positions are selections, not quotations. Never display
  // model-supplied excerpts or generate an apparent quotation from a reason.
  for (const value of evidence) {
    for (const match of String(value).matchAll(/(?:^|[\s(`"])([\w./@-]+\.[A-Za-z\d]+)(?::|#L)([1-9]\d*)(?:-L?([1-9]\d*))?/gu)) {
      positions.push(`${match[1]}#L${match[2]}-L${match[3] ?? match[2]}`);
    }
  }
  return unique([...positions, ...selected]);
}

export function renderStopDetails({ review = {}, report = {}, partialReview = null, citations = [], locale = "en", released = false } = {}) {
  const objects = partialReview?.metricObjectJudgements ?? (report.metrics ?? []).flatMap(metric => metric.objects ?? []);
  const findings = review.findings ?? partialReview?.findings ?? [];
  const counts = {};
  for (const object of objects) counts[object.judgement] = (counts[object.judgement] ?? 0) + 1;
  const lines = [];
  if (partialReview) {
    lines.push(text(locale,
      `部分验收：已保留 ${objects.length}/${partialReview.totalObjects} 项有效判断；最终 Stop 分类尚未确认。`,
      `PARTIAL review: retained ${objects.length}/${partialReview.totalObjects} valid object judgements; final Stop classification is unconfirmed.`));
  }
  if (objects.length) lines.push(text(locale, "已有判断（不是全需求完成率）：", "Available judgements (not whole-task completion): ")
    + Object.entries(counts).map(([state, count]) => `${state} ${count}`).join(", ") + ".");
  const unreviewed = partialReview?.unreviewedObjectIds?.length ?? 0;
  const rejected = partialReview?.rejectedObjectIds?.length ?? 0;
  if (partialReview) lines.push(text(locale,
    `未审定范围：${unreviewed} 项；未采用的草稿：${rejected} 项。未审定不等于业务偏离。`,
    `Unreviewed scope: ${unreviewed} objects; rejected drafts: ${rejected}. Unreviewed is not a business deviation.`));

  const knownSources = unique(objects.map(object => sourceId(object.sourceId ?? object.requirement?.sourceId ?? object.objectId)));
  const canonicalSource = value => {
    const id = sourceId(value);
    const matches = knownSources.filter(known => known === id || known.endsWith(`-${id}`));
    return matches.length === 1 ? matches[0] : id;
  };
  const parent = new Map();
  const find = id => { if (!parent.has(id)) parent.set(id, id); const next = parent.get(id); return next === id ? id : find(next); };
  const idsFor = (finding, index) => unique((finding.violatedGroundTruthIds ?? []).map(canonicalSource)).length
    ? unique(finding.violatedGroundTruthIds.map(canonicalSource)) : [`finding:${finding.deviationKey ?? index}`];
  findings.forEach((finding, index) => {
    const ids = idsFor(finding, index); ids.forEach(find);
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
  });
  const groups = new Map();
  const group = id => {
    const key = find(id);
    if (!groups.has(key)) groups.set(key, { ids: [], objects: [], findings: [] });
    return groups.get(key);
  };
  // Incomplete objects are counted above, rather than repeating their reasons
  // fifty times. Every explicit deviation and every original finding remains.
  for (const object of objects.filter(item => item.judgement === "DEVIATION")) {
    const id = canonicalSource(object.sourceId ?? object.requirement?.sourceId ?? object.objectId);
    const entry = group(id); entry.ids.push(id); entry.objects.push(object);
  }
  findings.forEach((finding, index) => {
    const ids = idsFor(finding, index), entry = group(ids[0]); entry.ids.push(...ids); entry.findings.push(finding);
  });
  for (const entry of groups.values()) {
    const owners = [...entry.objects.map(object => object.objectId), ...entry.findings.map(finding => finding.deviationKey)];
    const evidence = [...entry.objects.flatMap(object => object.evidence ?? []), ...entry.findings.flatMap(finding => finding.actualEvidence ?? finding.evidence ?? []),
      ...entry.objects.flatMap(object => object.requirement?.refs ?? [])];
    lines.push(`- ${unique(entry.ids).join(", ")}${entry.objects.length ? ` [DEVIATION: ${entry.objects.map(object => object.objectId).join(", ")}]` : ""}`);
    for (const reason of unique([...entry.objects.map(object => object.reason), ...entry.findings.map(finding => finding.reason)])) lines.push(`  ${reason}`);
    const locations = selectedLocations(evidence, citations, owners);
    if (locations.length) lines.push(`  ${text(locale, "依据位置", "Evidence locations")}: ${locations.join("; ")}`);
  }
  const checkerErrors = objects.filter(object => object.judgement === "CHECKER_ERROR");
  if (checkerErrors.length) {
    lines.push(text(locale, `检查器未审定：${checkerErrors.length} 项。`, `Checker could not assess ${checkerErrors.length} objects.`));
    for (const reason of unique(checkerErrors.map(object => object.reason))) lines.push(`  ${reason}`);
  }
  for (const issue of report.checkerIssues ?? []) lines.push(`${text(locale, "检查器信息", "Checker issue")}: ${issue.objectId ?? issue.type ?? "unknown"}: ${issue.message ?? issue.type}`);
  if (released) lines.push(text(locale, "本次 Stop 放行；放行不等于验收 PASS。", "This Stop is allowed; ALLOW is not an acceptance PASS."));
  lines.push(text(locale,
    "以上为原判断与依据位置；请结合原需求和当前实现自行判断下一步。未审定或检查器失败不自动产生额外修复、测试义务。",
    "These are the existing judgements and evidence locations; use the requirements and current implementation to decide the next action. Unreviewed objects or checker failures do not add repair or test obligations."));
  return lines.join("\n");
}
