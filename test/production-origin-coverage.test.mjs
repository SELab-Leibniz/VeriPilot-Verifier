import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { createProductionOriginCoverage, qualifiedFileSelectors } from '../lib/runtime-v2/production-origin-coverage.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const files = {
  'views/ExportView.mjs': 'export function renderExport(payload, rows) {\n  return rows.join(payload.separator ?? ",");\n}\n',
  'cli.mjs': 'export function wire(register, emit, separator, cached) {\n  register("export", () => {\n    if (cached) {\n      emit({ view: "views/ExportView", params: { cached } });\n      return;\n    }\n    emit({ view: "views/ExportView", params: { separator } });\n  });\n}\n',
  'view.test.mjs': 'const sample = "views/ExportView";\n',
  'imports.mjs': 'import "views/ExportView";\nconst label = "ExportView";\n',
};
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-origin-contract-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  }
  const graph = await buildSemanticGraph(root, { snapshotPaths: Object.keys(files) });
  const entry = { path: path.join(root, 'views/ExportView.mjs'), start: 1, end: 1, sha256: sha256(files['views/ExportView.mjs']) };
  return { root, graph, entry };
}
test('origin selectors use qualified paths, never single basenames', () => {
  assert.deepEqual(qualifiedFileSelectors('entry/views/ExportView.mjs'), ['entry/views/ExportView', 'views/ExportView']);
  assert.deepEqual(qualifiedFileSelectors('index.mjs'), []);
});
test('origin receipt exposes both indirect producers without turning index reads into acknowledgements', async t => {
  const f = await fixture(t), origin = createProductionOriginCoverage({ projectRoot: f.root, graph: f.graph, contextId: 'review-a' });
  const receipt = await origin.discover({ objectId: 'required-export', entry: f.entry });
  assert.equal(receipt.status, 'READY', receipt.reason);
  assert.equal(receipt.sourceReadAcknowledged, false);
  assert.deepEqual(receipt.candidates.map(row => [row.path, row.start]), [['cli.mjs', 4], ['cli.mjs', 7]]);
  assert(receipt.candidates.every(row => row.kinds.includes('FILE_SELECTOR_LITERAL_CANDIDATE')));
  assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'required-export', entry: f.entry })).status, 'READY');
  assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'another-item', entry: f.entry })).status, 'UNKNOWN');
  const foreign = createProductionOriginCoverage({ projectRoot: f.root, graph: f.graph, contextId: 'review-b' });
  assert.equal((await foreign.lookup(receipt.receiptId, { objectId: 'required-export', entry: f.entry })).status, 'UNKNOWN');
  await fs.appendFile(path.join(f.root, 'cli.mjs'), '\n');
  assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'required-export', entry: f.entry })).reason, 'ORIGIN_INDEX_CHANGED');
});
test('partial and over-limit origins remain unknown without passing truncated candidates', async t => {
  const f = await fixture(t);
  for (const [graph, options, expected] of [
    [{ ...f.graph, originIndexSnapshot: () => ({ ...f.graph.originIndexSnapshot(), status: 'partial' }) }, {}, 'PARTIAL_OR_UNRESOLVED_INDEX'],
    [f.graph, { maxCandidates: 1 }, 'CANDIDATE_LIMIT'],
  ]) {
    const origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: 'review', ...options });
    const receipt = await origin.discover({ objectId: 'required-export', entry: f.entry });
    assert.equal(receipt.status, 'UNKNOWN'); assert.equal(receipt.reason, expected);
    assert.deepEqual(receipt.candidates, []);
  }
});
test('resolved direct callers are observed even for flat module names', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'format.mjs'), 'export function format(rows, separator) { return rows.join(separator); }\n');
  await fs.writeFile(path.join(f.root, 'entry.mjs'), 'import { format } from "./format.mjs";\nexport function start(rows, separator) { return format(rows, separator); }\n');
  const graph = await buildSemanticGraph(f.root, { snapshotPaths: ['format.mjs', 'entry.mjs'] });
  const body = await fs.readFile(path.join(f.root, 'format.mjs'));
  const origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: 'direct' });
  const receipt = await origin.discover({ objectId: 'format', entry: { path: path.join(f.root, 'format.mjs'), start: 1, end: 1, sha256: sha256(body) } });
  assert.equal(receipt.status, 'READY', receipt.reason);
  assert(receipt.candidates.some(row => row.path === 'entry.mjs' && row.kinds.includes('RESOLVED_REFERENCE')));
});
test('listed deletions remain usable but recreating an absent source invalidates the index', async t => {
  const f = await fixture(t);
  const graph = await buildSemanticGraph(f.root, { snapshotPaths: [...Object.keys(files), 'removed.mjs'] });
  assert.equal(graph.status, 'ready');
  assert.deepEqual(graph.originIndexSnapshot().absentSources, ['removed.mjs']);
  assert.equal((await graph.checkOriginIndexCurrent()).current, true);
  await fs.writeFile(path.join(f.root, 'removed.mjs'), 'export const view = "views/ExportView";\n');
  assert.deepEqual(await graph.checkOriginIndexCurrent(), { current: false, reason: 'INDEX_SOURCE_RECREATED' });
});
test('an oversized origin response becomes explicit unknown instead of a passing partial group', async t => {
  const f = await fixture(t);
  const origin = createProductionOriginCoverage({ projectRoot: f.root, graph: f.graph, contextId: 'bounded', maxReceiptBytes: 1000 });
  const receipt = await origin.discover({ objectId: 'required-export', entry: f.entry });
  assert.equal(receipt.status, 'UNKNOWN'); assert.equal(receipt.reason, 'RESPONSE_LIMIT');
  assert.deepEqual(receipt.candidates, []);
  assert(Buffer.byteLength(JSON.stringify(receipt)) <= 1000);
  assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'required-export', entry: f.entry })).status, 'UNKNOWN');
});
