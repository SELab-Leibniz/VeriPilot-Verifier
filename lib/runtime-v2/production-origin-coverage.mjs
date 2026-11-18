import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './utils.mjs';
import { isTestEvidencePath } from './regression-evidence.mjs';

const supported = /\.(?:ets|[cm]?[jt]s|[jt]sx)$/iu;
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** File selectors are possible references, not framework routing assertions.
 * Single basenames are deliberately excluded: "index" or "result" is not an
 * adequate project-wide origin query. Imports are excluded by graph.literal. */
export function qualifiedFileSelectors(relative) {
  const parts = relative.replaceAll('\\', '/').replace(supported, '').split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join('/'));
}

/** Host-owned bounded navigation. These hashes bind the index and actual
 * current files, but only the Stop task's native registry proves reading. */
export function createProductionOriginCoverage({ projectRoot, graph, contextId, signal, active = () => {},
  maxCandidates = 24, maxQueryPages = 64, maxSelectors = 24, maxReceiptBytes = 24 * 1024 }) {
  const receipts = new Map();
  const readCurrent = async relative => {
    const absolute = path.resolve(projectRoot, relative);
    if (!within(projectRoot, absolute) || isTestEvidencePath(relative) || await fs.realpath(absolute) !== absolute) return null;
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const bytes = await fs.readFile(absolute, { signal });
    active();
    return { path: absolute, relative, sha256: sha256(bytes), bytes: bytes.length };
  };
  async function discover({ objectId, entry }) {
    const receipt = { id: randomUUID(), objectId, contextId, entry: { ...entry }, status: 'UNKNOWN',
      reason: 'INDEX_UNAVAILABLE', candidates: [], scope: 'OBSERVED_UPSTREAM_REFERENCES',
      guarantee: 'Accounts for observed candidates; query selection, relevance and input propagation remain semantic judgments.' };
    const index = graph?.originIndexSnapshot?.();
    if (!index || !graph?.query || !graph?.checkOriginIndexCurrent) {
      return storeReceipt(receipt);
    }
    receipt.indexFingerprint = index.fingerprint;
    receipt.indexScope = index.scope;
    receipt.indexFiles = index.sources.length;
    const relative = path.relative(projectRoot, entry.path).replaceAll('\\', '/');
    if (!supported.test(relative)) receipt.reason = 'UNSUPPORTED_SOURCE_LANGUAGE';
    else if (index.status !== 'ready' || index.unresolved) receipt.reason = 'PARTIAL_OR_UNRESOLVED_INDEX';
    else if (!(await graph.checkOriginIndexCurrent()).current) receipt.reason = 'INDEX_CHANGED';
    else {
      const queries = [], found = new Map();
      let queryPages = 0, complete = true, reason = 'OBSERVED_CANDIDATES_RECORDED';
      const queryAll = input => {
        const hits = []; let offset = 0;
        do {
          if (++queryPages > maxQueryPages) { complete = false; reason = 'QUERY_LIMIT'; break; }
          const page = graph.query({ ...input, offset });
          queries.push({ input: { ...input, offset }, result: page });
          if (page.status !== 'ready' || page.indexed === false || page.ambiguous) {
            receipt.queryIssue = { operation: input.operation, file: input.file, symbol: input.symbol,
              status: page.status, indexed: page.indexed, ambiguous: page.ambiguous };
            complete = false; reason = 'AMBIGUOUS_OR_PARTIAL_QUERY'; break;
          }
          hits.push(...page.hits ?? []);
          if (page.nextOffset === null) break;
          if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) {
            complete = false; reason = 'INVALID_QUERY_CONTINUATION'; break;
          }
          offset = page.nextOffset;
        } while (true);
        return hits;
      };
      const add = (hit, kind, selector) => {
        if (!hit || hit.testSource || typeof hit.path !== 'string' || !Number.isSafeInteger(hit.line)
          || hit.line < 1 || isTestEvidencePath(hit.path)) return;
        const key = JSON.stringify([hit.path, hit.line]);
        if (!found.has(key)) found.set(key, { relative: hit.path, start: hit.line, end: hit.line, kinds: [] });
        const candidate = found.get(key);
        if (!candidate.kinds.includes(kind)) candidate.kinds.push(kind);
        if (selector) candidate.selectors = [...new Set([...(candidate.selectors ?? []), selector])];
        if (found.size > maxCandidates) { complete = false; reason = 'CANDIDATE_LIMIT'; }
      };
      const definitions = queryAll({ operation: 'outline', file: relative }).filter(row =>
        row.line <= entry.start && row.endLine >= entry.end && !row.kind.startsWith('test'));
      definitions.sort((left, right) => (left.endLine - left.line) - (right.endLine - right.line));
      if (definitions.length) {
        const first = definitions[0];
        if (definitions[1] && first.line === definitions[1].line && first.endLine === definitions[1].endLine) {
          complete = false; reason = 'AMBIGUOUS_ENTRY_SYMBOL';
        } else for (const hit of queryAll({ operation: 'incoming', file: relative,
          symbol: first.qualified ?? first.symbol, depth: 3 })) {
          if (['call', 'reference'].includes(hit.relation)) add(hit, 'RESOLVED_REFERENCE');
        }
      }
      const selectors = qualifiedFileSelectors(relative);
      if (selectors.length > maxSelectors) { complete = false; reason = 'SELECTOR_LIMIT'; }
      else for (const selector of selectors) for (const hit of queryAll({ operation: 'literal', value: selector }))
        add(hit, 'FILE_SELECTOR_LITERAL_CANDIDATE', selector);
      receipt.queryFingerprint = sha256(queries);
      // Even an over-limit observation is not truncated into a passing subset.
      if (complete) {
        for (const candidate of found.values()) {
          const current = await readCurrent(candidate.relative);
          const indexed = index.sources.find(source => source.path === candidate.relative);
          if (!current || current.sha256 !== indexed?.sha256) {
            complete = false; reason = 'CANDIDATE_SOURCE_CHANGED'; break;
          }
          receipt.candidates.push({ id: randomUUID(), ...candidate, path: current.path, sha256: current.sha256 });
        }
      }
      if (!(await graph.checkOriginIndexCurrent()).current) { complete = false; reason = 'INDEX_CHANGED'; }
      receipt.status = complete ? 'READY' : 'UNKNOWN';
      receipt.reason = reason;
      if (!complete) receipt.candidates = [];
    }
    return storeReceipt(receipt);
  }
  function publicReceipt(receipt) {
    return { receiptId: receipt.id, objectId: receipt.objectId, status: receipt.status, reason: receipt.reason,
      entry: { ...receipt.entry, path: path.relative(projectRoot, receipt.entry.path).replaceAll('\\', '/'), sourceReadAcknowledged: true },
      receiptFingerprint: receipt.fingerprint,
      scope: receipt.scope, indexScope: receipt.indexScope, indexFiles: receipt.indexFiles,
      indexFingerprint: receipt.indexFingerprint, queryFingerprint: receipt.queryFingerprint,
      ...(receipt.queryIssue ? { queryIssue: receipt.queryIssue } : {}),
      guarantee: receipt.guarantee, navigationOnly: true, sourceReadAcknowledged: false,
      candidates: receipt.candidates.map(({ id, relative, start, end, kinds, selectors }) =>
        ({ candidateId: id, path: relative, start, end, kinds, ...(selectors ? { selectors } : {}) })) };
  }
  function storeReceipt(receipt) {
    const seal = () => { const { fingerprint, ...value } = receipt; receipt.fingerprint = sha256(value); };
    seal();
    let navigation = publicReceipt(receipt);
    if (Buffer.byteLength(JSON.stringify(navigation)) > maxReceiptBytes) {
      receipt.observedCandidateCount = receipt.candidates.length;
      receipt.status = 'UNKNOWN'; receipt.reason = 'RESPONSE_LIMIT'; receipt.candidates = [];
      seal(); navigation = publicReceipt(receipt);
      if (Buffer.byteLength(JSON.stringify(navigation)) > maxReceiptBytes)
        navigation = { receiptId: receipt.id, objectId: receipt.objectId, status: 'UNKNOWN', reason: 'RESPONSE_LIMIT',
          scope: receipt.scope, navigationOnly: true, sourceReadAcknowledged: false, candidates: [] };
    }
    receipts.set(receipt.id, receipt);
    return navigation;
  }
  async function lookup(id, { objectId, entry }) {
    const receipt = receipts.get(id);
    if (!receipt || receipt.contextId !== contextId || receipt.objectId !== objectId
      || sha256(receipt.entry) !== sha256(entry)) return { status: 'UNKNOWN', reason: 'MISSING_OR_FOREIGN_ORIGIN_RECEIPT' };
    if (receipt.status !== 'READY') return { status: 'UNKNOWN', reason: receipt.reason };
    if (!(await graph.checkOriginIndexCurrent()).current) return { status: 'UNKNOWN', reason: 'ORIGIN_INDEX_CHANGED' };
    return { status: 'READY', receipt };
  }
  return { discover, lookup };
}
