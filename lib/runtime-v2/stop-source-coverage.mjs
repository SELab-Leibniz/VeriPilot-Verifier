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
  LONG_SOURCE_UNDISPOSED: '长原件仍有范围未逐项核对',
  SOURCE_NOT_REPRESENTED: '清单未处置这份来源',
  SOURCE_NOT_ADMISSIBLE: '声明的来源不在可读取的原件范围内',
  SOURCE_UNAVAILABLE: '声明的原件不可用',
  SOURCE_ORIGINAL_UNAVAILABLE: '缺少任务开始时的原件',
  SOURCE_UNREADABLE: '来源格式无法按原文读取',
  SOURCE_VERSION_CHANGED: '来源版本已变化',
  SOURCE_ROLE_UNRESOLVED: '附录声明的约束力待核实',
  SOURCE_LINK_UNRESOLVED: '声明的附录尚未定位到原件',
};

const directive = /\b(?:must|shall|should|require[ds]?|ensure|never|always|only|mandatory|prohibit\w*|do not|may not|needs? to|has to)\b|必须|不得|严禁|禁止|仅限|务必|不应|应当|须(?:[^求]|$)|需(?:要|使用|提供|保留|包含|支持|执行|具备)/iu;
const structure = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s*|\||>|\[|~~~|\x60{3}|\{|<)/u;
const backgroundTitle = /^(?:background|historical background|history|背景|历史背景|历史沿革)(?:\s*[（(](?:non[- ]normative|informative|非规范性|仅供参考)[）)])?$/iu;

// Each long source still needs line-level dispositions. Only bounded
// paragraphs can represent a multi-line obligation. A background declaration
// can cover plain prose under a recognized heading, never a new clause.
export function longOriginalLines(text) {
  const lines = text.split(/\r?\n/u);
  const formatting = new Set(), background = new Set(), newClauses = new Set();
  let inBackground = false, fence = null;
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const marker = /^\s*(\x60{3,}|~{3,})(.*)$/u.exec(text);
    if (fence || marker) {
      newClauses.add(line);
      if (!fence) fence = marker[1];
      else if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = null;
      continue;
    }
    const title = /^\s*(#{1,6})[ \t]+(.+?)\s*$/u.exec(text);
    if (title) inBackground = backgroundTitle.test(title[2]);
    const constrained = directive.test(text);
    const blank = !text.trim();
    if (blank || title && !constrained && !/[:：=\d]/u.test(title[2])) formatting.add(line);
    if (blank || structure.test(text) || constrained) newClauses.add(line);
    else if (inBackground && !/[:：=`]/u.test(text)) background.add(line);
  }
  return { formatting, background, newClauses };
}

function skipJsonWhitespace(bytes, offset) {
  while (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0d || bytes[offset] === 0x0a) offset++;
  return offset;
}

function jsonObjectEnd(bytes, start) {
  let depth = 0, quoted = false;
  for (let offset = start; offset < bytes.length; offset++) {
    const byte = bytes[offset];
    if (quoted && byte === 0x5c) offset++; // Escaped character in a JSON string.
    else if (byte === 0x22) quoted = !quoted;
    else if (!quoted && byte === 0x7b) depth++;
    else if (!quoted && byte === 0x7d && --depth === 0) return offset + 1;
  }
  return -1;
}

function coveredJsonArrayEnd(bytes, opening, ranges) {
  let offset = opening + 1, records = 0;
  while (offset < bytes.length) {
    const start = skipJsonWhitespace(bytes, offset);
    if (bytes[start] !== 0x7b) return -1; // {
    const end = jsonObjectEnd(bytes, start);
    if (end < 0 || !ranges.has(`${start}:${end}`)) return -1;
    try { JSON.parse(bytes.toString('utf8', start, end)); } catch { return -1; }
    records++;
    offset = skipJsonWhitespace(bytes, end);
    if (bytes[offset] === 0x5d) return records >= 2 ? offset + 1 : -1; // ]
    if (bytes[offset++] !== 0x2c) return -1; // ,
  }
  return -1;
}

function jsonStringEnd(bytes, start) {
  for (let offset = start + 1; offset < bytes.length; offset++) {
    if (bytes[offset] === 0x5c) offset++; // Escaped character in a JSON string.
    else if (bytes[offset] === 0x22) return offset + 1;
  }
  return -1;
}

function coveredJsonEnvelopeEnd(bytes, opening, ranges) {
  let offset = opening + 1, seenArray = false;
  const keys = new Set();
  while (offset < bytes.length) {
    const start = skipJsonWhitespace(bytes, offset);
    if (bytes[start] !== 0x22) return -1;
    const keyEnd = jsonStringEnd(bytes, start);
    if (keyEnd < 0) return -1;
    let key;
    try { key = JSON.parse(bytes.toString('utf8', start, keyEnd)); } catch { return -1; }
    if (keys.has(key)) return -1;
    keys.add(key);
    offset = skipJsonWhitespace(bytes, keyEnd);
    if (bytes[offset++] !== 0x3a) return -1; // :
    const valueStart = skipJsonWhitespace(bytes, offset);
    if (bytes[valueStart] === 0x5b) {
      offset = coveredJsonArrayEnd(bytes, valueStart, ranges);
      if (offset < 0) return -1;
      seenArray = true;
    } else {
      if (bytes[valueStart] === 0x7b) return -1; // A whole nested object can hide independent fields.
      offset = bytes[valueStart] === 0x22 ? jsonStringEnd(bytes, valueStart) : valueStart;
      if (offset < 0) return -1;
      if (offset === valueStart) {
        while (offset < bytes.length && bytes[offset] !== 0x2c && bytes[offset] !== 0x7d
          && skipJsonWhitespace(bytes, offset) === offset) offset++;
      }
      if (offset === valueStart || !ranges.has(`${start}:${offset}`)) return -1;
      try { JSON.parse(bytes.toString('utf8', valueStart, offset)); } catch { return -1; }
    }
    offset = skipJsonWhitespace(bytes, offset);
    if (bytes[offset] === 0x7d) return seenArray ? offset + 1 : -1; // }
    if (bytes[offset++] !== 0x2c) return -1; // ,
  }
  return -1;
}

// Require one exact original UTF-8 span per record and per scalar envelope
// field. An array span or an umbrella covering the document grants no coverage.
export function coversSingleLineJsonRecords(bytes, sources) {
  const ranges = new Set(sources.filter(item => item.start === 1 && item.end === 1
    && Number.isSafeInteger(item.byteStart) && Number.isSafeInteger(item.byteEnd))
    .map(item => `${item.byteStart}:${item.byteEnd}`));
  if (ranges.size < 2) return false;
  const start = skipJsonWhitespace(bytes, 0);
  const end = bytes[start] === 0x5b ? coveredJsonArrayEnd(bytes, start, ranges)
    : bytes[start] === 0x7b ? coveredJsonEnvelopeEnd(bytes, start, ranges) : -1;
  return end >= 0 && skipJsonWhitespace(bytes, end) === bytes.length;
}

export function retainLongSourceGaps(coverage, sources, checklist, proofs = new Map(), checkedGroupSources = new Set()) {
  if (!coverage || !checklist) return;
  for (const row of coverage.sources) {
    const source = sources.find(candidate => candidate.ref === row.ref && candidate.sha256 === row.sha256);
    if (!['REPRESENTED', 'NO_APPLICABLE_REQUIREMENT'].includes(row.disposition) || !(source?.bytes > ORIGINAL_PART_BYTES)) continue;
    const proof = proofs.get(row.ref);
    const disposed = new Set(proof?.formatting);
    for (const { start, end } of proof?.confirmedBackground ?? [])
      for (let line = start; line <= end; line++) disposed.add(line);
    for (const { source: item } of checklist) {
      if (item.ref !== row.ref || item.sha256 !== row.sha256) continue;
      if (item.memberLines) {
        if (checkedGroupSources.has(item)) for (const line of item.memberLines) disposed.add(line);
        continue;
      }
      if (item.start !== item.end) {
        if (!proof || item.end - item.start >= 8) continue;
        const continuation = Array.from({ length: item.end - item.start }, (_, offset) => item.start + offset + 1);
        if (continuation.some(line => proof.newClauses.has(line))) continue;
      }
      for (let line = item.start; line <= item.end; line++) disposed.add(line);
    }
    const open = [];
    let first = 1;
    for (const line of [...disposed].sort((a, b) => a - b)) {
      if (line > first) open.push([first, line - 1]);
      first = line + 1;
    }
    if (first <= row.totalLines) open.push([first, row.totalLines]);
    if (row.totalLines === 1 && !proof?.completeJsonRecords) open.push([1, 1]);
    if (!open.length) continue;
    row.unextractedRanges = merge(open);
    row.disposition = 'LONG_SOURCE_UNDISPOSED';
    coverage.complete = false;
  }
}

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
  const pending = Array.isArray(report.unreviewedScope) && Array.isArray(report.missingEvidence)
    ? ['尚未核实的范围（' + report.unverifiedItems.length + '）', section('已审但缺证', report.missingEvidence),
      section('尚未审到', report.unreviewedScope)]
    : [section('尚未核实的范围', report.unverifiedItems)];
  return [section('已证实的偏差', report.confirmedDeviations), ...pending].join('\n');
}
