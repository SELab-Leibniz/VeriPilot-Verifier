import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sourcePage } from './source-tools.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');

// Scheduling hints only. A stat never grants coverage or a citation; each
// independent read still requires its own genuine native persistence receipt.
export async function planIndependentReads(root, files, { maxBatchBytes = 32768, maxBatchFiles = 4 } = {}) {
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1 || !Number.isSafeInteger(maxBatchFiles) || maxBatchFiles < 1)
    throw new Error('Finite positive read planning budgets required');
  const batches = []; let current = { files: [], bytes: 0 };
  for (const file of files) {
    const stat = await fs.stat(path.resolve(root, file));
    if (!stat.isFile()) throw new Error('Mandatory read is not a regular file');
    if (current.files.length && (current.bytes + stat.size > maxBatchBytes || current.files.length >= maxBatchFiles)) {
      batches.push(current); current = { files: [], bytes: 0 };
    }
    current.files.push(file); current.bytes += stat.size;
    if (stat.size > maxBatchBytes) { batches.push(current); current = { files: [], bytes: 0 }; }
  }
  if (current.files.length) batches.push(current);
  return { navigationOnly: true, maxBatchBytes, maxBatchFiles, batches };
}

// Verify exact RC page bytes and metadata; requested ranges are never proof.
export function disclosedRange(bytes, args, result) {
  if (result.isError || !result.content?.length || result.content.some(block => block.type !== 'text')) return null;
  try {
    const expected = sourcePage(bytes, args);
    return JSON.stringify(result.details?.page) === JSON.stringify(expected.details.page)
      && JSON.stringify(result.content) === JSON.stringify(expected.content)
      ? { start: expected.details.page.start, end: expected.details.page.end } : null;
  } catch { return null; }
}

export async function captureFiles(root, { signal } = {}) {
  const active = () => signal?.throwIfAborted();
  active();
  const files = new Map();
  async function walk(directory) {
    active();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    active();
    for (const entry of entries) {
      active();
      if (['.git', 'node_modules', '.opencodereview', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Snapshot contains symlink: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolute, signal ? { signal } : undefined);
        active();
        files.set(path.relative(root, absolute).replaceAll('\\', '/'), { sha256: digest(bytes), lines: bytes.toString('utf8').split('\n').length });
      }
    }
  }
  await walk(root);
  active();
  return files;
}

export function covers(reads, file, start, end) {
  let next = start;
  for (const interval of reads.filter(r => r.path === file).sort((a, b) => a.start - b.start)) {
    if (interval.start > next) break;
    next = Math.max(next, interval.end + 1);
  }
  return next > end;
}

// Offsets refer to the exact UTF-8 bytes disclosed by the native text reader.
// An interval excludes the final LF separator unless it includes the next line.
export function excerpt(bytes, start, end) {
  const lines = bytes.toString('utf8').split('\n');
  if (!Buffer.from(lines.join('\n'), 'utf8').equals(bytes) || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 1 || end < start || end > lines.length) throw new Error('Invalid text interval');
  const byteStart = start === 1 ? 0 : Buffer.byteLength(lines.slice(0, start - 1).join('\n')) + 1;
  const byteEnd = byteStart + Buffer.byteLength(lines.slice(start - 1, end).join('\n'));
  const selected = bytes.subarray(byteStart, byteEnd);
  return { byteStart, byteEnd, text: selected.toString('utf8'), sha256Excerpt: digest(selected) };
}

export function registerCitation({ registry, bytes, file, sha256, range }) {
  // Avoid accidental matches with host credential-prefix redaction (e.g. fc-).
  const citeId = 'rccite_' + [...randomBytes(16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  const { byteStart, byteEnd } = excerpt(bytes, range.start, range.end);
  const citation = { citeId, path: file, ...range, sha256, byteStart, byteEnd, rangeKind: 'range' };
  registry.set(citeId, citation);
  return citation;
}
