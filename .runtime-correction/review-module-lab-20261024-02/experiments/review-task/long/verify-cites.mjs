// Independent saved-artifact check: do not reuse worker extraction or validation code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
function lineSpan(bytes, start, end) {
  const starts = [0];
  for (let offset = 0; offset < bytes.length; offset++) if (bytes[offset] === 10) starts.push(offset + 1);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > starts.length) throw new Error('Invalid source line interval');
  // A range omits its final LF, preserves CR and all internal newlines, and
  // includes an original trailing LF only when the final empty line is selected.
  return { byteStart: starts[start - 1], byteEnd: end < starts.length ? starts[end] - 1 : bytes.length, totalLines: starts.length };
}
function disclosed(reads, file, start, end) {
  let next = start;
  const pages = reads.filter(page => page.path === file).sort((a, b) => a.start - b.start);
  for (const page of pages) {
    if (page.start > next) break;
    if (page.end >= next) next = page.end + 1;
  }
  return next > end;
}
export async function verifyCites(directory) {
  const root = await fs.realpath(directory), errors = [], verified = [];
  let evidence, input, result, decision, reads, issued;
  try {
    [evidence, input, result, reads, issued] = await Promise.all(['evidence.json', 'input.json', 'result.json', 'reads.json', 'citations.json'].map(file => json(path.join(root, file))));
    if (result.completed) decision = await json(path.join(root, 'decision.json'));
  } catch (error) { return { passed: false, errors: [`Missing or unreadable completed-review artifact: ${error.message}`], verified }; }
  const metadata = new Map(input.files);
  const frozen = path.join(root, 'frozen-source');
  const reportError = message => errors.push(message);
  const checkRange = async (entry, category) => {
    try {
      if (!entry || typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.includes('\\')
        || entry.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Noncanonical evidence path');
      const known = metadata.get(entry.path);
      if (!known) throw new Error('Evidence file was not in the input snapshot');
      const bytes = await fs.readFile(path.join(frozen, entry.path));
      if (hash(bytes) !== known.sha256 || entry.sha256 !== known.sha256) throw new Error('Frozen source file hash mismatch');
      const span = lineSpan(bytes, entry.start, entry.end);
      if (entry.rangeKind === 'file') {
        if (category !== 'basis' || entry.start !== 1 || entry.end !== span.totalLines) throw new Error('Invalid full-file basis reference');
      } else {
        if (entry.rangeKind !== 'range' || entry.byteStart !== span.byteStart || entry.byteEnd !== span.byteEnd) throw new Error('Line interval and byte offsets disagree');
        const selected = bytes.subarray(span.byteStart, span.byteEnd);
        if (typeof entry.text !== 'string' || !Buffer.from(entry.text, 'utf8').equals(selected)) throw new Error('Extracted original text differs from frozen bytes');
        if (entry.sha256Excerpt !== hash(selected)) throw new Error('Extracted original text hash mismatch');
        if (category === 'citations' && !disclosed(reads, entry.path, entry.start, entry.end)) throw new Error('Citation range was not fully disclosed by read');
      }
      verified.push({ category, citeId: entry.citeId ?? null, path: entry.path, start: entry.start, end: entry.end, sha256: known.sha256 });
    } catch (error) { reportError(`${category}:${entry?.path ?? '?'}:${entry?.start ?? '?'}-${entry?.end ?? '?'}: ${error.message}`); }
  };
  if (evidence.taskId !== input.task.id || result.taskId !== input.task.id || (decision && decision.taskId !== input.task.id)) reportError('Evidence/result/decision task ownership mismatch');
  if (result.scope !== (input.task.scope ?? null) || (decision && decision.scope !== (input.task.scope ?? null))) reportError('Review scope differs from the assigned proof scope');
  for (const [key, values] of [['basis', evidence.basis], ['basisAnchors', evidence.basisAnchors], ['citations', evidence.citations]]) {
    if (!Array.isArray(values)) { reportError(`${key} is not an array`); continue; }
    for (const value of values) await checkRange(value, key);
  }
  const basisPaths = (evidence.basis ?? []).map(entry => entry.path).sort();
  if (JSON.stringify(basisPaths) !== JSON.stringify([...new Set(input.task.basisFiles)].sort())) reportError('Evidence omits or duplicates a required basis file');
  const expectedAnchors = input.task.basisAnchors ?? [];
  const anchorKey = item => JSON.stringify([item.claimId ?? null, item.path, item.start, item.end]);
  if (JSON.stringify((evidence.basisAnchors ?? []).map(anchorKey).sort()) !== JSON.stringify(expectedAnchors.map(anchorKey).sort())) reportError('Saved basis anchors differ from the program-assigned claim anchors');
  const citations = evidence.citations ?? [], ids = citations.map(entry => entry.citeId);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) reportError('Citation IDs are missing or duplicated');
  if (!Array.isArray(issued)) reportError('Issued citation registry is not an array');
  for (const item of citations) {
    const registered = Array.isArray(issued) ? issued.find(entry => entry.citeId === item.citeId) : null;
    if (!registered || ['path', 'start', 'end', 'sha256', 'byteStart', 'byteEnd', 'rangeKind'].some(key => registered[key] !== item[key])) reportError(`Citation was not issued for this captured range: ${item.citeId}`);
  }
  const savedIds = [...(result.citeIds ?? [])].sort();
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(savedIds)) reportError('Result does not reference exactly its saved evidence IDs');
  if (decision && JSON.stringify([...(decision.citeIds ?? [])].sort()) !== JSON.stringify(savedIds)) reportError('Decision/result cite IDs disagree');
  for (const ref of result.refs ?? []) {
    const item = citations.find(entry => entry.citeId === ref.citeId);
    if (!item || ['path', 'start', 'end', 'sha256', 'byteStart', 'byteEnd', 'rangeKind'].some(key => item[key] !== ref[key])) reportError(`Result ref differs from extracted evidence: ${ref.citeId}`);
  }
  if ((result.refs ?? []).length !== citations.length) reportError('Result/evidence citation count mismatch');
  if (result.conclusive) {
    if (!result.completed || !['PASS', 'DEVIATION'].includes(result.verdict)) reportError('Invalid conclusive status');
    for (const file of input.task.basisFiles) {
      if (!disclosed(reads, file, 1, metadata.get(file)?.lines)) reportError(`Required basis was not fully disclosed: ${file}`);
    }
    if (!citations.some(entry => input.task.targetFiles.includes(entry.path))) reportError('No current target source citation for a conclusive review');
  }
  return { passed: errors.length === 0, taskId: input.task.id, scope: input.task.scope ?? null, completed: result.completed, conclusive: result.conclusive,
    originalBytesChecked: true, errors, verified, limitation: 'Byte integrity, ownership and read coverage only; this check does not prove semantic support.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node verify-cites.mjs REVIEW_OUTPUT_DIRECTORY');
  const report = await verifyCites(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
