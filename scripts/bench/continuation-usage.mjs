import { createHash } from 'node:crypto';

const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const records = text => text.split('\n').filter(line => line.trim()).map(JSON.parse);
function summarize(rows) {
  const result = { records: rows.length, assistantTurns: 0, reportedUsageRecords: 0,
    nonzeroUsageRecords: 0, missingUsageRecords: 0, incompleteUsageRecords: 0,
    ...Object.fromEntries(keys.map(key => [key, 0])) };
  for (const row of rows) {
    if (row.message?.role !== 'assistant') continue;
    result.assistantTurns++;
    const usage = row.message.usage;
    if (!usage || typeof usage !== 'object') { result.missingUsageRecords++; continue; }
    result.reportedUsageRecords++;
    const valid = key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0;
    if (keys.some(key => !valid(key))) result.incompleteUsageRecords++;
    if (keys.some(key => valid(key) && usage[key] > 0)) result.nonzeroUsageRecords++;
    for (const key of keys) if (valid(key)) result[key] += usage[key];
  }
  return result;
}

/** Verify the actual copied bytes before excluding restored history. Reported
 * assistant usage excludes invisible compaction and RC-private calls; it is
 * deliberately not a complete provider bill or a dollar cost estimate. */
export function continuationUsage({ transcript, restoredSource, sourceSha256 }) {
  const source = Buffer.from(restoredSource), current = Buffer.from(transcript);
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceSha256)
    || createHash('sha256').update(source).digest('hex') !== sourceSha256
    || !current.subarray(0, source.length).equals(source)) {
    throw Object.assign(new Error('Restored history bytes do not match the captured continuation evidence.'),
      { code: 'CONTINUATION_USAGE_HISTORY_MISMATCH' });
  }
  const appended = current.subarray(source.length).toString('utf8');
  // A source without its final newline must still end at a record boundary.
  if (source.length && source.at(-1) !== 10 && appended && !appended.startsWith('\n') && !appended.startsWith('\r\n')) {
    throw new Error('Continuation source does not end at a complete record boundary.');
  }
  return { restoredHistory: summarize(records(source.toString('utf8'))),
    currentContinuation: summarize(records(appended)), sourceSha256,
    scope: 'Business transcript only. Restored history is excluded from currentContinuation. Missing, zero or incomplete usage does not prove zero provider consumption. Compaction and RC-private usage may be absent.' };
}
