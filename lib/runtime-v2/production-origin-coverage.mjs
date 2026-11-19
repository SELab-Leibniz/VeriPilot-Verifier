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
    if (!index || !graph?.query || !graph?.originEntry || !graph?.checkOriginIndexCurrent || !graph?.originOpaqueReference) {
      return storeReceipt(receipt);
    }
    receipt.indexFingerprint = index.fingerprint;
    receipt.indexScope = index.scope;
    receipt.indexFiles = index.sources.length;
    const relative = path.relative(projectRoot, entry.path).replaceAll('\\', '/');
    if (!supported.test(relative)) receipt.reason = 'UNSUPPORTED_SOURCE_LANGUAGE';
    else if (index.status !== 'ready' || index.unresolved) receipt.reason = 'PARTIAL_OR_UNRESOLVED_INDEX';
    else if (!index.sources.some(source => source.path === relative && source.sha256 === entry.sha256)) receipt.reason = 'ENTRY_SOURCE_MISMATCH';
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
      const selected = graph.originEntry({ file: relative, start: entry.start, end: entry.end });
      receipt.entryResolution = selected;
      queries.push({ operation: 'entry', file: relative, start: entry.start, end: entry.end, result: selected });
      if (++queryPages > maxQueryPages) { complete = false; reason = 'QUERY_LIMIT'; }
      if (complete && (selected.status !== 'READY' || !selected.definition || selected.sourceSha256 !== entry.sha256)) {
        // A missing or unsupported lexical target cannot borrow an outer owner
        // or become a resolved target with an empty caller set.
        complete = false; reason = selected.status !== 'READY' ? selected.reason ?? 'ENTRY_SYMBOL_UNRESOLVED'
          : !selected.definition ? 'ENTRY_SYMBOL_UNRESOLVED' : 'ENTRY_SOURCE_MISMATCH';
      } else if (complete) {
        const first = selected.definition;
        for (const hit of queryAll({ operation: 'incoming', file: relative,
          symbol: first.qualified ?? first.symbol, depth: 3 })) {
          if (['call', 'reference'].includes(hit.relation)) add(hit, 'RESOLVED_REFERENCE');
        }
      }
      const selectors = qualifiedFileSelectors(relative);
      if (selectors.length > maxSelectors) { complete = false; reason = 'SELECTOR_LIMIT'; }
      else for (const selector of selectors) for (const hit of queryAll({ operation: 'literal', value: selector }))
        add(hit, 'FILE_SELECTOR_LITERAL_CANDIDATE', selector);
      if (complete) {
        const opaque = graph.originOpaqueReference({ file: relative,
          symbol: selected.definition.qualified ?? selected.definition.symbol, selectors });
        queries.push({ operation: 'opaque-origin-reference', result: opaque });
        if (opaque.status !== 'READY' || opaque.witness) {
          complete = false; reason = opaque.status === 'READY' ? 'UNPARSED_POTENTIAL_ORIGIN' : opaque.reason;
          if (opaque.witness) receipt.unparsedOrigin = opaque.witness;
        }
      }
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
      ...(receipt.entryResolution ? { entryResolution: receipt.entryResolution } : {}),
      ...(receipt.unparsedOrigin ? { unparsedOrigin: receipt.unparsedOrigin } : {}),
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
  // These snapshots explain a failed private-registry lookup. They carry no
  // source read acknowledgement, receipt capability or candidate authority.
  const diagnosticFingerprint = value => {
    try {
      const encoded = JSON.stringify(value);
      return typeof encoded === 'string' && Buffer.byteLength(encoded) <= 8192 ? sha256(value) : null;
    } catch { return null; }
  };
  const diagnosticId = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value) ? value : null;
  const diagnosticReceiptId = value => typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value) ? value : null;
  const diagnosticEntry = value => {
    if (!value || typeof value !== 'object') return null;
    const result = {};
    for (const key of ['start', 'end']) if (Number.isSafeInteger(value[key]) && value[key] > 0) result[key] = value[key];
    if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)) result.sha256 = value.sha256;
    if (typeof value.path === 'string' && path.isAbsolute(value.path)) {
      if (within(projectRoot, value.path)) {
        const relative = path.relative(projectRoot, value.path).replaceAll('\\', '/');
        if (Buffer.byteLength(relative) <= 200) result.path = relative;
        else result.pathOmitted = true;
      } else result.pathOutsideProject = true;
    }
    return result;
  };
  const lookupDiagnostic = (category, code, id, objectId, entry, receipt, extra = {}) => {
    const diagnostic = { version: 1, category, code: /^[A-Z0-9_]{1,96}$/u.test(code ?? '') ? code : 'DISCOVERY_STATUS_UNAVAILABLE',
      requested: { receiptId: diagnosticReceiptId(id), receiptIdSupplied: id !== undefined && id !== null && id !== '',
        objectId: diagnosticId(objectId), entryFingerprint: diagnosticFingerprint(entry), entry: diagnosticEntry(entry) },
      ...(receipt ? { issued: { objectId: diagnosticId(receipt.objectId), entryFingerprint: diagnosticFingerprint(receipt.entry),
        entry: diagnosticEntry(receipt.entry), contextFingerprint: diagnosticFingerprint(receipt.contextId),
        status: receipt.status, reason: /^[A-Z0-9_]{1,96}$/u.test(receipt.reason ?? '') ? receipt.reason : null } } : {}),
      currentContextFingerprint: diagnosticFingerprint(contextId), ...extra,
      authority: 'DIAGNOSTIC_ONLY', navigationOnly: true, sourceReadAcknowledged: false };
    if (Buffer.byteLength(JSON.stringify(diagnostic)) > 1536) {
      delete diagnostic.requested.entry;
      if (diagnostic.issued) delete diagnostic.issued.entry;
      diagnostic.detailsOmitted = true;
    }
    return diagnostic;
  };
  async function lookup(id, { objectId, entry }) {
    const receipt = receipts.get(id);
    if (!receipt || receipt.contextId !== contextId || receipt.objectId !== objectId
      || !entry || sha256(receipt.entry) !== sha256(entry)) {
      const code = id === undefined || id === null || typeof id === 'string' && !id.trim() ? 'ID_MISSING'
        : !receipt ? 'NOT_ISSUED_CURRENT_REVIEW' : receipt.contextId !== contextId ? 'CONTEXT_MISMATCH'
          : receipt.objectId !== objectId ? 'OBJECT_MISMATCH' : 'ENTRY_BINDING_MISMATCH';
      const entryDifferences = receipt && entry ? [
        ...(receipt.entry.path !== entry.path ? ['PATH'] : []),
        ...(receipt.entry.sha256 !== entry.sha256 ? ['SOURCE_HASH'] : []),
        ...(receipt.entry.start !== entry.start || receipt.entry.end !== entry.end ? ['RANGE'] : []),
      ] : [];
      return { status: 'UNKNOWN', reason: 'MISSING_OR_FOREIGN_ORIGIN_RECEIPT',
        diagnostic: lookupDiagnostic('LOOKUP_MISMATCH', code, id, objectId, entry, receipt,
          entryDifferences.length ? { entryDifferences } : {}) };
    }
    if (receipt.status !== 'READY') return { status: 'UNKNOWN', reason: receipt.reason,
      diagnostic: lookupDiagnostic('DISCOVERY_UNKNOWN', receipt.reason, id, objectId, entry, receipt) };
    const current = await graph.checkOriginIndexCurrent();
    if (!current.current) return { status: 'UNKNOWN', reason: 'ORIGIN_INDEX_CHANGED',
      diagnostic: lookupDiagnostic('STALE_INDEX', 'ORIGIN_INDEX_CHANGED', id, objectId, entry, receipt,
        { indexReason: /^[A-Z0-9_]{1,96}$/u.test(current.reason ?? '') ? current.reason : null }) };
    return { status: 'READY', receipt,
      diagnostic: lookupDiagnostic('LOOKUP_MATCH', 'MATCH', id, objectId, entry, receipt) };
  }
  return { discover, lookup };
}
