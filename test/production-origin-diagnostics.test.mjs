import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { createProductionOriginCoverage } from '../lib/runtime-v2/production-origin-coverage.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

async function fixture(t, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-origin-diagnostic-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const body = 'export function transform(input) {\n  return input + 1;\n}\n';
  const file = path.join(root, 'transform.mjs');
  await fs.writeFile(file, body);
  const graph = { ...await buildSemanticGraph(root, { snapshotPaths: ['transform.mjs'] }), ...overrides };
  const entry = { path: file, start: 1, end: 1, sha256: sha256(body) };
  const origin = createProductionOriginCoverage({ projectRoot: root, graph, contextId: 'current-review' });
  const receipt = await origin.discover({ objectId: 'M16:required-transform', entry });
  return { root, graph, entry, origin, receipt, objectId: 'M16:required-transform' };
}

function diagnostic(result, category, code) {
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.diagnostic.category, category);
  assert.equal(result.diagnostic.code, code);
  assert.equal(result.diagnostic.authority, 'DIAGNOSTIC_ONLY');
  assert.equal(result.diagnostic.navigationOnly, true);
  assert.equal(result.diagnostic.sourceReadAcknowledged, false);
  assert(Buffer.byteLength(JSON.stringify(result.diagnostic)) <= 1536);
  return result.diagnostic;
}

test('origin lookup distinguishes absent, unissued and exact owned binding mismatches without weakening READY', async t => {
  const f = await fixture(t);
  assert.equal(f.receipt.status, 'READY', f.receipt.reason);
  const args = { objectId: f.objectId, entry: f.entry };
  for (const id of [undefined, null, '', '   ']) {
    const result = await f.origin.lookup(id, args);
    assert.equal(result.reason, 'MISSING_OR_FOREIGN_ORIGIN_RECEIPT');
    const d = diagnostic(result, 'LOOKUP_MISMATCH', 'ID_MISSING');
    assert.equal(d.requested.entryFingerprint, sha256(f.entry));
    assert.equal(d.issued, undefined);
  }
  const unknownId = randomUUID();
  const unissued = diagnostic(await f.origin.lookup(unknownId, args), 'LOOKUP_MISMATCH', 'NOT_ISSUED_CURRENT_REVIEW');
  assert.equal(unissued.requested.receiptId, unknownId);
  assert.equal(unissued.issued, undefined, 'an unknown ID says nothing about another review');
  const wrongObject = diagnostic(await f.origin.lookup(f.receipt.receiptId, { ...args, objectId: 'M16:other' }),
    'LOOKUP_MISMATCH', 'OBJECT_MISMATCH');
  assert.equal(wrongObject.requested.objectId, 'M16:other');
  assert.equal(wrongObject.issued.objectId, f.objectId);
  assert.equal(wrongObject.issued.contextFingerprint, wrongObject.currentContextFingerprint);
  for (const [change, difference] of [
    [{ start: 2 }, 'RANGE'], [{ end: 2 }, 'RANGE'], [{ sha256: '0'.repeat(64) }, 'SOURCE_HASH'],
    [{ path: path.join(f.root, 'other.mjs') }, 'PATH'],
  ]) {
    const entry = { ...f.entry, ...change };
    const d = diagnostic(await f.origin.lookup(f.receipt.receiptId, { ...args, entry }), 'LOOKUP_MISMATCH', 'ENTRY_BINDING_MISMATCH');
    assert.deepEqual(d.entryDifferences, [difference]);
    assert.equal(d.requested.entryFingerprint, sha256(entry));
    assert.equal(d.issued.entryFingerprint, sha256(f.entry));
    assert.equal(d.requested.entry.path, path.basename(entry.path));
  }
  assert.equal((await f.origin.lookup(f.receipt.receiptId, args)).status, 'READY');
  const another = createProductionOriginCoverage({ projectRoot: f.root, graph: f.graph, contextId: 'different-review' });
  diagnostic(await another.lookup(f.receipt.receiptId, args), 'LOOKUP_MISMATCH', 'NOT_ISSUED_CURRENT_REVIEW');
  diagnostic(await another.lookup(JSON.parse(JSON.stringify(wrongObject)).requested.receiptId, args),
    'LOOKUP_MISMATCH', 'NOT_ISSUED_CURRENT_REVIEW');
  // Only controlled host-memory corruption can make a known local record
  // carry a different context; a foreign JSON ID above remains unissued.
  const owned = await f.origin.lookup(f.receipt.receiptId, args);
  owned.receipt.contextId = 'changed-host-context';
  const context = diagnostic(await f.origin.lookup(f.receipt.receiptId, args), 'LOOKUP_MISMATCH', 'CONTEXT_MISMATCH');
  assert.notEqual(context.issued.contextFingerprint, context.currentContextFingerprint);
});

test('origin lookup separates an issued UNKNOWN discovery from stale current source', async t => {
  const unknown = await fixture(t, { originOpaqueReference: () => ({ status: 'UNKNOWN', reason: 'OPAQUE_ORIGIN_UNRESOLVED' }) });
  assert.equal(unknown.receipt.status, 'UNKNOWN');
  const issue = await unknown.origin.lookup(unknown.receipt.receiptId, { objectId: unknown.objectId, entry: unknown.entry });
  assert.equal(issue.reason, 'OPAQUE_ORIGIN_UNRESOLVED');
  const d = diagnostic(issue, 'DISCOVERY_UNKNOWN', 'OPAQUE_ORIGIN_UNRESOLVED');
  assert.equal(d.issued.status, 'UNKNOWN');
  const f = await fixture(t);
  await fs.appendFile(f.entry.path, '\n');
  const stale = await f.origin.lookup(f.receipt.receiptId, { objectId: f.objectId, entry: f.entry });
  assert.equal(stale.reason, 'ORIGIN_INDEX_CHANGED');
  diagnostic(stale, 'STALE_INDEX', 'ORIGIN_INDEX_CHANGED');
});

test('origin diagnostic projections are bounded data and omit arbitrary text and outside paths', async t => {
  const f = await fixture(t);
  const secretText = 'arbitrary-private-note-'.repeat(1000);
  const entry = { ...f.entry, path: '/outside-project/private-document.mjs', note: secretText };
  const result = await f.origin.lookup(secretText, { objectId: secretText, entry });
  const d = diagnostic(result, 'LOOKUP_MISMATCH', 'NOT_ISSUED_CURRENT_REVIEW');
  assert.equal(d.requested.receiptId, null);
  assert.equal(d.requested.objectId, null);
  assert.equal(d.requested.entryFingerprint, null);
  assert.equal(d.requested.entry.pathOutsideProject, true);
  assert(!JSON.stringify(d).includes(secretText));
  assert(!JSON.stringify(d).includes('private-document'));
  const longPath = path.join(f.root, '界'.repeat(300), 'source.mjs');
  const long = diagnostic(await f.origin.lookup(f.receipt.receiptId, {
    objectId: f.objectId, entry: { ...f.entry, path: longPath },
  }), 'LOOKUP_MISMATCH', 'ENTRY_BINDING_MISMATCH');
  assert.equal(long.requested.entry.pathOmitted, true);
  assert(!JSON.stringify(long).includes('界'));
  assert.equal((await f.origin.lookup(f.receipt.receiptId, { objectId: f.objectId, entry: f.entry })).status, 'READY',
    'diagnostics cannot mutate the private receipt or confer acknowledgement');
});
