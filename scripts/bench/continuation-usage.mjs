import { createHash } from 'node:crypto';
import { providerUsageCoverage } from './provider-usage-coverage.mjs';

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

/** Current-role accounting is provable when no private history predates the
 * resume. Otherwise missing private prefix boundaries remain unknown. */
export function currentRunUsage({ result, sourceResult, accounting, continuation }) {
  const unknown = reason => ({ available: false, reason });
  if (!sourceResult || !Array.isArray(sourceResult.privateRuns) || sourceResult.privateRuns.length)
    return unknown('Historical private usage needs captured prefix boundaries; it is not assumed to be zero.');
  if (['instanceId', 'datasetDigest', 'preparedHead', 'projectRoot', 'sessionId', 'sessionKey']
    .some(key => typeof result[key] !== 'string' || result[key] !== sourceResult[key]))
    return unknown('Continuation/source task identity mismatch.');
  if (!accounting || accounting.sessions.some(row => row.missing)) return unknown('Persisted session accounting is incomplete.');
  const business = accounting.sessions.filter(row => row.owner === 'business');
  const workers = accounting.sessions.filter(row => row.owner === 'rc-private');
  const nativeFiles = new Set((accounting.nativeRuns ?? []).map(row => row.sessionFile));
  if (business.length !== 1 || workers.some(row => !nativeFiles.has(row.file)))
    return unknown('Private transcripts are not all attributed by the current native run registry.');
  const { restoredHistory: before, currentContinuation: current } = continuation;
  if ([before, current].some(row => row.missingUsageRecords || row.incompleteUsageRecords)
    || accounting.sessions.some(row => row.missingUsage || keys.some(key => row[`${key}Missing`])))
    return unknown('One or more usage records have missing token fields.');
  if (keys.some(key => business[0][key] !== before[key] + current[key]))
    return unknown('Business session does not match verified restored-prefix accounting.');
  const recordedUsage = Object.fromEntries(keys.map(key => [key, current[key] + workers.reduce((sum, row) => sum + row[key], 0)]));
  if (Object.values(recordedUsage).some(value => !Number.isFinite(value) || value < 0)) return unknown('Invalid reported token values.');
  const nonzeroUsageRecords = current.nonzeroUsageRecords + workers.reduce((sum, row) => sum + row.nonzeroUsageRecords, 0);
  return { available: true, recordedUsage, business: current, privateSessions: workers.length, nonzeroUsageRecords,
    providerRequests: accounting.providerRequests,
    providerUsageCoverage: providerUsageCoverage(accounting.providerRequests, nonzeroUsageRecords),
    scope: 'Current reported business plus registered private sessions; verified restored business history excluded. Count coverage is not a bill. Missing usage from previous interrupted attempts remains unknown.' };
}
