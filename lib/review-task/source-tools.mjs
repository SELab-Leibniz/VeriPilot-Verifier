// RC's frozen-source protocol. These are evidence tools, not an agent runtime.
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { boundedLinePage } from '../line-page.mjs';

export const PAGE_LINES = 400, PAGE_BYTES = 51200;
// Keep source pages in manageable blocks for host output and telemetry.
// Read proof comes from the final original message, never its redacted copy.
export const toolText = result => (result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
export function textBlocks(text) {
  const blocks = []; let chunk = '', size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > 6000) { blocks.push({ type: 'text', text: chunk }); chunk = ''; size = 0; }
    chunk += char; size += bytes;
  }
  if (chunk || !blocks.length) blocks.push({ type: 'text', text: chunk });
  return blocks;
}
const result = (value, details = {}) => ({ content: textBlocks(value), details });
const hanCharacter = /\p{Script=Han}/u;

// These facts describe all original bytes of this named file, not a larger
// document behind a frozen part. They never expand the disclosed line range.
function namedFileFacts(bytes, text, sha256) {
  let nonAsciiCodePoints = 0, hanCodePoints = 0;
  for (const character of text) {
    if (character.codePointAt(0) <= 0x7f) continue;
    nonAsciiCodePoints++;
    if (hanCharacter.test(character)) hanCodePoints++;
  }
  return { scope: 'entire-named-file', sha256: sha256 ?? createHash('sha256').update(bytes).digest('hex'),
    utf8Valid: true, asciiOnly: nonAsciiCodePoints === 0, nonAsciiCodePoints, hanCodePoints };
}
export function literalFindHint(pattern, hits, offset = 0) {
  if (hits.length || offset > 0) return null;
  return 'find matches case-sensitive literal path fragments; use grep for code identifiers or file contents. '
    + (/[*?]/u.test(pattern) ? '* and ? are ordinary characters. ' : '')
    + 'Check the path/fragment or narrow the search. A navigation miss never proves a file is absent.';
}

// Keep only a snippet and enough overlap to match a literal across chunks.
// Both result accumulation and scanning stop at the remaining global hit cap.
async function grepFile(file, relative, pattern, limit, signal, startLine = 1) {
  const stream = nativeFs.createReadStream(file, { highWaterMark: 64 * 1024, signal });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const hits = [];
  let line = 1, snippet = '', overlap = '', matched = false, emitted = false;
  const scan = text => {
    let position = 0;
    while (position < text.length) {
      signal?.throwIfAborted();
      const newline = text.indexOf('\n', position), end = newline < 0 ? text.length : newline;
      const part = text.slice(position, end);
      if (snippet.length < 300) snippet += part.slice(0, 300 - snippet.length);
      if (!matched) matched = (overlap + part).includes(pattern);
      overlap = pattern.length > 1 ? (overlap + part).slice(-(pattern.length - 1)) : '';
      if (line >= startLine && !emitted && matched && (snippet.length >= 300 || newline >= 0)) {
        hits.push(`${relative}:${line}:${snippet}`); emitted = true;
        if (hits.length === limit) return true;
      }
      if (newline < 0) break;
      line++; snippet = ''; overlap = ''; matched = false; emitted = false;
      position = newline + 1;
    }
    return false;
  };
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const text = decoder.decode(chunk, { stream: true });
      if (text.includes('\0')) return [];
      if (scan(text)) return hits;
    }
    signal?.throwIfAborted();
    if (scan(decoder.decode())) return hits;
    if (line >= startLine && matched && !emitted) hits.push(`${relative}:${line}:${snippet}`);
    return hits;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return [];
    throw error;
  } finally { stream.destroy(); }
}

function parseSource(bytes, sha256, legacyPageFormat = false) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text.includes('\0')) throw new Error('Only UTF-8 text is readable evidence');
  const lines = text.split('\n');
  return { lines, fileFacts: legacyPageFormat ? null : namedFileFacts(bytes, text, sha256) };
}

function renderSourcePage({ lines, fileFacts }, { offset = 1, limit = PAGE_LINES, numbered = false, overlapBoundary = false } = {}) {
  if (!Number.isInteger(offset) || offset < 1 || offset > lines.length || !Number.isInteger(limit) || limit < 1)
    throw Object.assign(new Error(`Read offset/limit must be positive integers within the named file (${lines.length} lines). Offset is part-local, never the original source's global line; follow nextOffset. null means this file is complete.`),
      { code: 'SOURCE_READ_RANGE_INVALID' });
  if (typeof numbered !== 'boolean') throw new Error('numbered must be boolean');
  const selected = boundedLinePage(lines, { start: offset, count: Math.min(limit, PAGE_LINES), byteLimit: PAGE_BYTES, separatorBytes: 1,
    ...(numbered ? { render: (line, number) => `[${number}] ${line}` } : {}) }).lines;
  if (!selected.length) throw new Error('First line exceeds the evidence page byte limit');
  const range = { start: offset, end: offset + selected.length - 1 };
  // Exact original intervals exclude their final LF. With overlap enabled,
  // the next page actually discloses it between two lines. A one-line page
  // must still advance; a separate overlapping read can cover that gap.
  const nextOffset = range.end < lines.length ? overlapBoundary && range.end > range.start ? range.end : range.end + 1 : null;
  const page = { ...range, totalLines: lines.length, nextOffset,
    ...(numbered ? { numbered: true } : {}) };
  // The third argument is internal compatibility for previously observed
  // receipts, never a reader tool parameter. New reads always expose facts.
  const facts = fileFacts ? { fileFacts: { ...fileFacts } } : {};
  return result(`${selected.join('\n')}\n[RC page ${JSON.stringify({ ...page, ...facts })}]`, { page, ...facts });
}

export function sourcePage(bytes, args = {}, { legacyPageFormat = false } = {}) {
  return renderSourcePage(parseSource(bytes, undefined, legacyPageFormat), args);
}

// Per-reader bounded cache of decoded content, never of evidence receipts or
// filesystem versions. Every call still reads and hashes the current bytes.
// Identical bytes can share parsing across paths without sharing citations.
export function createSourcePager() {
  const cache = new Map(); let retainedBytes = 0;
  const maxBytes = 4 * 1024 * 1024, maxEntries = 8;
  return (bytes, args) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let entry = cache.get(sha256);
    if (entry) cache.delete(sha256);
    else {
      entry = { parsed: parseSource(bytes, sha256), bytes: bytes.length };
      if (entry.bytes <= maxBytes) retainedBytes += entry.bytes;
    }
    if (entry.bytes <= maxBytes) {
      cache.set(sha256, entry);
      while (cache.size > maxEntries || retainedBytes > maxBytes) {
        const oldest = cache.keys().next().value, removed = cache.get(oldest);
        cache.delete(oldest); retainedBytes -= removed.bytes;
      }
    }
    return renderSourcePage(entry.parsed, args);
  };
}
export function createSourceTools(root, snapshot) {
  // Freeze the physical root once, including aliases in parent directories.
  // Per-request resolution must still stay inside this exact selected root.
  root = nativeFs.realpathSync.native(root);
  const parameters = properties => ({ type: 'object', additionalProperties: false, properties });
  const inventory = [...snapshot.keys()].sort(), cache = new Map(), page = createSourcePager();
  return ['read', 'grep', 'find', 'ls'].map(name => ({
    name, label: `Frozen source ${name}`,
    description: name === 'read' ? 'Read frozen UTF-8 lines. offset is LOCAL to this path/part, never a sourceCatalog global line. fileFacts reports program-computed ASCII/Han counts and original-byte hash for the entire NAMED file; for a split source this covers only this part, not the larger original document. Facts do not expand line citations, mandatory reading coverage or prove business actions. numbered=true displays [local line] prefixes for precise selection; prefixes are navigation, not original text. Follow nextOffset; join text blocks without separators. Oversized single lines are unavailable.'
      : 'Navigate frozen inventory only; no reading coverage. grep/find are literal. Follow nextOffset and nextLine together for complete results; offset is a file cursor, line is a grep line cursor. Narrow path before searching.',
    parameters: parameters({ path: { type: 'string' }, ...(name === 'read' ? { offset: { type: 'integer', minimum: 1, description: 'One-based LOCAL line within the named path/part, not original sourceCatalog coordinates.' }, limit: { type: 'integer', minimum: 1 }, numbered: { type: 'boolean', description: 'Show local line prefixes; program citations still bind original bytes.' } }
      : { offset: { type: 'integer', minimum: 0 }, line: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        ...(name === 'grep' || name === 'find' ? { pattern: { type: 'string', maxLength: 500,
          description: name === 'find' ? 'Case-sensitive literal path fragment, not file contents, glob or regex. Use grep for code symbols.' : 'Literal text in original UTF-8 lines.' } } : {}) }) }),
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const absolute = await fs.realpath(path.resolve(root, args.path ?? '.'));
      signal?.throwIfAborted();
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Source access outside snapshot is forbidden');
      if (name === 'read') {
        if (!snapshot.has(relative)) throw new Error('File is not part of the frozen snapshot');
        const bytes = await fs.readFile(absolute, signal ? { signal } : undefined);
        signal?.throwIfAborted();
        return page(bytes, args);
      }
      if (['grep', 'find'].includes(name) && (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 500)) throw new Error('A short literal pattern is required');
      const offset = args.offset ?? 0, startLine = args.line ?? 1, limit = args.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(startLine) || startLine < 1
        || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid navigation cursor or page limit');
      const files = inventory.filter(file => file === relative || !relative || file.startsWith(`${relative}/`));
      const cacheKey = JSON.stringify([name, relative, args.pattern, offset, startLine, limit]);
      if (cache.has(cacheKey)) return result(cache.get(cacheKey));
      const hits = [];
      let nextOffset = null, nextLine = null, bytes = 0;
      for (let index = offset; index < files.length; index++) {
        const file = files[index];
        signal?.throwIfAborted();
        let found = name === 'ls' || name === 'find' && file.includes(args.pattern) ? [file] : [];
        if (name === 'grep') {
          const absoluteFile = await fs.realpath(path.join(root, file));
          if (absoluteFile !== path.join(root, file)) throw new Error('Linked source is forbidden');
          found = await grepFile(absoluteFile, file, args.pattern, limit - hits.length + 1, signal, index === offset ? startLine : 1);
        }
        for (const hit of found) {
          const size = Buffer.byteLength(JSON.stringify(hit)) + 1;
          if (hits.length >= limit || bytes + size > PAGE_BYTES - 1000) {
            if (!hits.length) throw new Error('Navigation path exceeds the page boundary');
            nextOffset = index; nextLine = name === 'grep' ? Number(hit.slice(file.length + 1).split(':', 1)[0]) : 1;
            break;
          }
          hits.push(hit); bytes += size;
        }
        if (nextOffset !== null) break;
      }
      const hint = name === 'find' ? literalFindHint(args.pattern, hits, offset) : null;
      const encoded = JSON.stringify({ navigationOnly: true, hits, nextOffset, nextLine, possiblyTruncated: nextOffset !== null, ...(hint ? { hint } : {}) });
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, encoded);
      return result(encoded);
    },
  }));
}
