import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './utils.mjs';

// Validate attachment contents inside the item tool, so a malformed range can
// use the same bounded repair/downgrade path as a missing file or stale hash.
export const STOP_CITATIONS_SCHEMA = { description: 'Evidence attachments: an array of {path,start,end}. Required only for deviations; validated per item with one repair opportunity.' };

const invalid = message => Object.assign(new Error(message), { code: 'TASK_CITATION_INVALID' });
const changed = () => Object.assign(new Error('Cited evidence changed during this review.'), { code: 'BASELINE_INPUT_CHANGED' });
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** Bind references to current bytes without claiming the reviewer read them. */
export async function resolveStopCitations(ctx, { citeIds = [], citations = [] }, projectRoot, { attachment = false, allowedFiles = [] } = {}) {
  if (!Array.isArray(citeIds) || !Array.isArray(citations)) throw invalid('Use an array of {path,start,end} attachments.');
  const references = citeIds.map(id => {
    const known = ctx.evidence.lookupCitation?.(id) ?? ctx.evidence.registry.get(id);
    if (known) return known;
    const match = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(id);
    if (!match) throw invalid(`Unknown citation ${id}. Use an issued ID, path#Lstart-Lend, or citations with path/start/end.`);
    return { path: match[1], start: Number(match[2]), end: Number(match[3] ?? match[2]) };
  }).concat(citations);
  const resolved = [];
  for (const ref of references) {
    ctx.active();
    if (!ref || typeof ref.path !== 'string' || !ref.path || ref.path.includes('\0')) throw invalid('Use citations: [{path,start,end}].');
    const requested = path.resolve(projectRoot, ref.path);
    let real, before, after, bytes;
    try {
      real = await fs.realpath(requested);
      const relative = path.relative(projectRoot, real);
      if ((relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) && !allowedFiles.includes(real))
        throw invalid(`Citation is outside the allowed project files: ${ref.path}`);
      before = await fs.stat(real, { bigint: true });
      if (!before.isFile()) throw invalid(`Citation is not a regular file: ${ref.path}`);
      bytes = await fs.readFile(real);
      after = await fs.stat(real, { bigint: true });
    } catch (error) { if (error.code === 'TASK_CITATION_INVALID') throw error; throw invalid(`Cannot read cited file: ${ref.path}`); }
    ctx.active();
    const stale = () => attachment ? invalid('The cited file no longer matches this review snapshot.') : changed();
    if (version(before) !== version(after) || await fs.realpath(requested).catch(() => null) !== real) throw stale();
    const hash = sha256(bytes), lines = bytes.toString('utf8').split('\n').length;
    if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 1 || ref.end < ref.start || ref.end > lines)
      throw invalid(`Citation range is outside ${ref.path} (1-${lines}).`);
    if (ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || ref.sha256.toLowerCase() !== hash)) throw invalid(`Citation content hash does not match ${ref.path}.`);
    const attachmentSnapshot = ctx.evidence.attachmentSnapshot ??= new Map();
    const captured = ctx.evidence.snapshot.get(real) ?? attachmentSnapshot.get(real);
    if (captured && captured.sha256 !== hash || ctx.evidence.resolutions.has(requested) && ctx.evidence.resolutions.get(requested) !== real)
      throw stale();
    if (attachment) attachmentSnapshot.set(real, { sha256: hash, lines, bytes: bytes.length });
    else { ctx.evidence.resolutions.set(requested, real); ctx.evidence.snapshot.set(real, { sha256: hash, lines, bytes: bytes.length }); }
    const byteSpan = ref.rangeKind === 'bytes' || !ref.rangeKind && (ref.byteStart !== undefined || ref.byteEnd !== undefined);
    if (byteSpan) {
      if (!Number.isSafeInteger(ref.byteStart) || !Number.isSafeInteger(ref.byteEnd) || ref.byteStart < 0 || ref.byteEnd <= ref.byteStart || ref.byteEnd > bytes.length)
        throw invalid('Invalid half-open original byte citation.');
      const first = 1 + bytes.subarray(0, ref.byteStart).reduce((n, b) => n + Number(b === 10), 0);
      const last = first + bytes.subarray(ref.byteStart, ref.byteEnd - 1).reduce((n, b) => n + Number(b === 10), 0);
      if (first !== ref.start || last !== ref.end) throw invalid('The byte citation and its named original lines disagree.');
    }
    resolved.push({ ...ref, path: real, sha256: hash,
      ...(byteSpan ? { rangeKind: 'bytes', excerptSha256: sha256(bytes.subarray(ref.byteStart, ref.byteEnd)) } : {}),
      ...(attachment ? { attachment: true, requestedPath: requested, exactQuote: byteSpan ? bytes.subarray(ref.byteStart, ref.byteEnd).toString('utf8')
        : bytes.toString('utf8').split('\n').slice(ref.start - 1, ref.end).join('\n') } : {}),
      citeId: ref.citeId ?? `path-${sha256([real, hash, ref.start, ref.end, ...(byteSpan ? [ref.byteStart, ref.byteEnd] : [])]).slice(0, 24)}` });
  }
  return resolved;
}

/** Recheck the same bytes and path binding immediately before publication. */
export async function stopAttachmentCurrent(ref) {
  if (!ref.attachment) return true;
  try {
    return await fs.realpath(ref.requestedPath ?? ref.path) === ref.path
      && sha256(await fs.readFile(ref.path)) === (ref.contentHash ?? ref.sha256);
  } catch { return false; }
}

/** Local degradation at a publication boundary; basis/lifecycle guards stay separate. */
export async function recheckStopAttachments(handle) {
  if (!handle?.reviewEvidence?.citationAttachments) return [];
  const result = handle.result, refs = handle.sourceCitations ?? [];
  const bad = new Set();
  for (const ref of refs) if (!await stopAttachmentCurrent(ref)) for (const owner of ref.usedBy ?? []) bad.add(owner);
  const changed = [], reason = 'The evidence attachment changed or disappeared before publication.';
  const issue = id => { const row = { id, type: 'CITATION', reason }; changed.push(row); return row; };
  for (const row of result.metricObjectJudgements ?? []) if (row.judgement === 'DEVIATION' && bad.has(row.objectId)) {
    Object.assign(row, { judgement: 'UNVERIFIED', reason, evidence: [], citationFailure: true });
    issue(row.objectId).objectId = row.objectId;
  }
  for (const file of result.fileAssessments ?? []) if (file.status === 'DEVIATION' && bad.has(file.path)) {
    Object.assign(file, { status: 'UNVERIFIED', reason, evidence: [], citationFailure: true }); issue('file:' + file.path);
  }
  result.findings = (result.findings ?? []).filter(finding => {
    if (!bad.has(finding.deviationKey)) return true; issue('finding:' + finding.deviationKey); return false;
  });
  if (!changed.length) return [];
  for (const row of handle.followUps ?? []) if (bad.has(row.objectId)) Object.assign(row, { judgement: 'UNVERIFIED', reason, evidence: [], citationFailure: true });
  for (const entry of result.frameCoverage?.items ?? []) if (entry.disposition === 'DEVIATION' && bad.has(entry.objectId))
    Object.assign(entry, { disposition: 'UNVERIFIED', reason });
  for (const entry of result.regressionCheck?.cases ?? []) if (entry.verdict === 'REGRESSION' && bad.has(entry.objectId))
    Object.assign(entry, { verdict: 'UNVERIFIED', reason });
  const related = [...(result.frameCoverage?.items ?? []).filter(item => item.disposition === 'UNVERIFIED'),
    ...(result.regressionCheck?.cases ?? []).filter(item => item.verdict === 'UNVERIFIED').map(item => ({ ...item, type: 'REGRESSION_CHECK' }))];
  if (result.frameCoverage?.items) for (const name of ['checked', 'deviation', 'unverified'])
    result.frameCoverage[name] = result.frameCoverage.items.filter(item => item.disposition.toLowerCase() === name).length;
  result.unverifiedItems = [...result.unverifiedItems ?? [], ...changed, ...related.map(({id,type,reason}) => ({id,type,reason}))]
    .filter((item, i, all) => all.findIndex(x => x.id === item.id) === i);
  const diagnostics = result.citationDiagnostics ??= { rejectedSubmissions: 0, correctedItems: 0, downgradedItems: 0, events: [] };
  diagnostics.downgradedItems += changed.length;
  diagnostics.events.push(...changed.map(item => ({ itemId: item.id, action: 'DOWNGRADED_BEFORE_PUBLICATION', reason })));
  if (result.reviewCoverage) {
    for (const item of result.reviewCoverage.items) if (bad.has(item.id) || changed.some(x => x.id === item.id) || related.some(x => x.id === item.id))
      Object.assign(item, { disposition: 'UNVERIFIED', unverified: true, reason });
    for (const item of changed) if (!result.reviewCoverage.items.some(x => x.id === item.id))
      result.reviewCoverage.items.push({ ...item, disposition: 'UNVERIFIED', unverified: true });
    result.reviewCoverage.total = result.reviewCoverage.items.length;
    result.reviewCoverage.unverified = result.reviewCoverage.items.filter(x => x.unverified).length;
    result.reviewCoverage.unverifiedRatio = result.reviewCoverage.total ? result.reviewCoverage.unverified / result.reviewCoverage.total : null;
  }
  refs.splice(0, refs.length, ...refs.filter(ref => !ref.usedBy?.some(owner => bad.has(owner))));
  handle.sourceCitations = refs;
  return changed;
}
