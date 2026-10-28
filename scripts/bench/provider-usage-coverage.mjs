// A host may append a zero-usage aborted message after a successful tool
// completion, or for a genuinely interrupted HTTP request. Only observed
// request/positive-usage counts distinguish a fully accounted run here.
export function providerUsageCoverage(requestCount, nonzeroUsageRecords) {
  if (!Number.isSafeInteger(nonzeroUsageRecords) || nonzeroUsageRecords < 0) throw new Error('Invalid usage record count');
  const known = Number.isSafeInteger(requestCount) && requestCount >= 0;
  return { providerRequests: known ? requestCount : null, nonzeroUsageRecords,
    unreportedRequests: known ? Math.max(0, requestCount - nonzeroUsageRecords) : null,
    unexpectedUsageRecords: known ? Math.max(0, nonzeroUsageRecords - requestCount) : null,
    complete: known && requestCount === nonzeroUsageRecords,
    note: 'Count coverage only. Zero-usage terminal messages do not prove an interrupted provider request consumed zero tokens. Missing usage is unknown.' };
}
