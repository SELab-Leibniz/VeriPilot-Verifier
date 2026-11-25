// All offsets are raw file bytes; endByte is exclusive, including across UTF-8 scalars.
export function contiguousBytes(citations, file, hash, start, end) {
  const ranges = [...citations].filter(c => c.path === file && c.sha256 === hash)
    .sort((a, b) => a.byteStart - b.byteStart);
  let cursor = start;
  for (const range of ranges) {
    if (range.byteStart > cursor) break;
    cursor = Math.max(cursor, range.byteEnd);
    if (cursor >= end) return true;
  }
  return false;
}

export function bytePage(bytes, file, hash, args, citeId) {
  const { byteOffset: startByte, byteLimit } = args;
  if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte > bytes.length
    || !Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 8192 || args.contextOnly || args.offset !== undefined || args.limit !== undefined)
    throw new Error('Use an exact byteOffset and byteLimit between 1 and 8192 on a cited original.');
  const endByte = Math.min(bytes.length, startByte + byteLimit);
  let start = 1, end = 1, lines = 1;
  for (let offset = bytes.indexOf(10); offset !== -1; offset = bytes.indexOf(10, offset + 1)) {
    lines++;
    if (offset < startByte) start++;
    if (offset < endByte - 1 || startByte === endByte && offset < startByte) end++;
  }
  const page = { path: file, sha256: hash, totalBytes: bytes.length, startByte, endByte,
    nextByteOffset: endByte < bytes.length ? endByte : null, encoding: 'base64', data: bytes.subarray(startByte, endByte).toString('base64'), citeId,
    startsAtLineBoundary: !startByte || bytes[startByte - 1] === 10, endsAtLineBoundary: endByte === bytes.length || bytes[endByte - 1] === 10 };
  return { page, lines, citation: { citeId, path: file, sha256: hash, start, end, byteStart: startByte, byteEnd: endByte, rangeKind: 'bytes' } };
}

export function byteReceiptMatches(body, c, bytes) {
  let page;
  try { page = JSON.parse(body).page; } catch { return false; }
  if (!page || page.citeId !== c.citeId || page.path !== c.path || page.sha256 !== c.sha256 || page.encoding !== 'base64'
    || page.startByte !== c.byteStart || page.endByte !== c.byteEnd || !Number.isSafeInteger(page.totalBytes)
    || c.byteStart < 0 || c.byteEnd < c.byteStart || c.byteEnd > page.totalBytes || typeof page.data !== 'string') return false;
  const decoded = Buffer.from(page.data, 'base64');
  return decoded.length === c.byteEnd - c.byteStart && decoded.toString('base64') === page.data
    && (!bytes || page.totalBytes === bytes.length && decoded.equals(bytes.subarray(c.byteStart, c.byteEnd)));
}
