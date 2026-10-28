// Shared presentation primitive only. Callers retain path permissions, frozen
// identities, source hashes and receipt validation; a page grants no evidence.
// Count UTF-8 bytes incrementally instead of rebuilding each growing prefix.
export function boundedLinePage(lines, { start, count, byteLimit, separatorBytes = 0, render = line => line }) {
  const selected = []; let bytes = 0;
  for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index++) {
    const value = render(lines[index], index + 1);
    const size = Buffer.byteLength(value) + (selected.length ? separatorBytes : 0);
    if (bytes + size > byteLimit) break;
    selected.push(value); bytes += size;
  }
  const end = start - 1 + selected.length;
  return { lines: selected, bytes, start, end, next: end < lines.length ? end + 1 : null, totalLines: lines.length };
}
