// Original line ranges are inclusive. Splitting a user message can divide one
// original line between two physical parts. A missing fragment leaves that line unread.
export const ORIGINAL_PART_BYTES = 16 * 1024;
export const sddHeading = /^\s*(?:#{1,6}\s+)?(?:SDD\b|software (?:design|requirements) (?:document|specification)|(?:软件)?(?:设计|需求)规格说明书)(?:\s*[:：—–-]|[^\n.]{0,80}\r?$)/imu;
export function inlineAcceptanceOriginal(text) {
  return Buffer.byteLength(text) > ORIGINAL_PART_BYTES || sddHeading.test(text);
}

export function unstartedSourceCoverage(originals) {
  if (!originals) return null;
  const declarations = (originals.acceptanceSources ?? []).map(({ path: ref, sha256, declaredBy, issue, lines }) =>
    ({ ref, sha256, declaredBy, issue, lines }));
  for (const message of originals.userMessages ?? []) if (inlineAcceptanceOriginal(message.text))
    declarations.push({ ref: message.ref, sha256: message.sha256, lines: message.text.split('\n').length });
  return originalSourceCoverage(declarations.map(source => ({ ...source,
    parts: source.lines ? [{ offset: 0, length: source.lines }] : [] })));
}

function merge(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function originalSourceCoverage(sources, evidence, checklist, noApplicable = new Map(), pendingExtraction = new Map()) {
  if (!sources.length) return null;
  const reads = new Map();
  for (const { path, start, end } of evidence?.reads ?? []) {
    if (!reads.has(path)) reads.set(path, []);
    reads.get(path).push([start, end]);
  }
  const rows = sources.map(({ ref, declaredBy, sha256, lines, issue, parts }) => {
    const unread = [];
    for (const { file, offset, length, hash } of parts) {
      let next = 1;
      if (evidence?.snapshot.get(file)?.sha256 === hash) {
        for (const [start, end] of merge(reads.get(file) ?? [])) {
          if (start > next) unread.push([offset + next, offset + start - 1]);
          next = Math.max(next, end + 1);
        }
      }
      if (next <= length) unread.push([offset + next, offset + length]);
    }
    const unreadRanges = merge(unread);
    const checklistItems = checklist?.filter(item => item.source.ref === ref && item.source.sha256 === sha256).length ?? 0;
    const exclusion = noApplicable.get(ref);
    const unextractedRanges = merge(pendingExtraction.get(ref) ?? []);
    const disposition = issue ?? (!checklist ? 'CHECKLIST_NOT_SUBMITTED' : unreadRanges.length ? 'SOURCE_PARTLY_READ'
      : unextractedRanges.length ? 'SOURCE_PARTLY_EXTRACTED' : checklistItems ? 'REPRESENTED' : exclusion ? 'NO_APPLICABLE_REQUIREMENT' : 'SOURCE_NOT_REPRESENTED');
    return { ref, ...(declaredBy ? { declaredBy } : {}), sha256: sha256 ?? null, totalLines: lines ?? null,
      readLines: issue ? null : lines - unreadRanges.reduce((sum, [start, end]) => sum + end - start + 1, 0),
      unreadRanges, ...(unextractedRanges.length ? { unextractedRanges } : {}), checklistItems, disposition, ...(exclusion ? { reason: exclusion } : {}) };
  });
  return { checklistSubmitted: Boolean(checklist), complete: rows.every(row => ['REPRESENTED', 'NO_APPLICABLE_REQUIREMENT'].includes(row.disposition)),
    sources: rows };
}

const reasons = {
  CHECKLIST_NOT_SUBMITTED: '条款清单尚未提交，已读原文的要求也待核实',
  SOURCE_PARTLY_READ: '原文尚未完整交付',
  SOURCE_PARTLY_EXTRACTED: '已知条款尚未全部进入清单',
  SOURCE_NOT_REPRESENTED: '清单未处置这份来源',
  SOURCE_NOT_ADMISSIBLE: '声明的来源不在可读取的原件范围内',
  SOURCE_UNAVAILABLE: '声明的原件不可用',
  SOURCE_ORIGINAL_UNAVAILABLE: '缺少任务开始时的原件',
  SOURCE_UNREADABLE: '来源格式无法按原文读取',
  SOURCE_VERSION_CHANGED: '来源版本已变化',
  SOURCE_ROLE_UNRESOLVED: '附录声明的约束力待核实',
  SOURCE_LINK_UNRESOLVED: '声明的附录尚未定位到原件',
};

export function unverifiedSources(coverage) {
  const describeRanges = ranges => ranges.slice(0, 3).map(([start, end]) => start === end ? start : start + '–' + end).join('、')
    + (ranges.length > 3 ? ' 等' : '');
  const items = (coverage?.sources ?? []).filter(row => !['REPRESENTED', 'NO_APPLICABLE_REQUIREMENT'].includes(row.disposition)).map(row => {
    const unread = row.unreadRanges.length ? '，未读第 ' + describeRanges(row.unreadRanges) + ' 行' : '';
    const pending = row.unextractedRanges?.length ? '，第 ' + describeRanges(row.unextractedRanges) + ' 行尚未完整列入清单' : '';
    return { id: 'original:' + row.ref, type: 'ORIGINAL_SOURCE', ...(row.unreadRanges.length || row.unextractedRanges?.length || ['SOURCE_NOT_REPRESENTED','CHECKLIST_NOT_SUBMITTED'].includes(row.disposition) ? { reviewState: 'UNREVIEWED' } : {}), reason: row.ref + '：' + (reasons[row.disposition] ?? '来源待核实') + unread + pending };
  });
  if (Number.isInteger(coverage?.awaitingScopeSelection)) items.push({ id: 'original-checklist:scope',
    type: 'ORIGINAL_CHECKLIST', reviewState: 'UNREVIEWED', reason: '清单已提交 ' + coverage.awaitingScopeSelection + ' 项，本轮适用范围和逐项判定尚待核实' });
  return items;
}

export function acceptanceNotice(report) {
  if (!report) return '';
  const section = (label, items) => label + '（' + items.length + '）' + (items.length ? '\n'
    + items.slice(0, 3).map(item => '- ' + String(item.reason).slice(0, 300)).join('\n')
    + (items.length > 3 ? '\n完整列表见审查记录。' : '') : '');
  const pending = report.unreviewedScope?.length && report.missingEvidence?.length
    ? ['尚未核实的范围（' + report.unverifiedItems.length + '）', section('已审但缺证', report.missingEvidence),
      section('尚未审到', report.unreviewedScope)]
    : [section('尚未核实的范围', report.unverifiedItems)];
  return [section('已证实的偏差', report.confirmedDeviations), ...pending].join('\n');
}
