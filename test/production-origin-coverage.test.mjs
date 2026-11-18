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
test('origin discovery distinguishes a resolved empty caller set from an unresolved entry range', async t => {
  const f = await fixture(t), file = 'entry.mjs';
  const body = 'export function first(value) {\n  return value;\n}\nvoid 0;\nexport function second(value) {\n  return value + 1;\n}\n';
  await fs.writeFile(path.join(f.root, file), body);
  const graph = await buildSemanticGraph(f.root, { snapshotPaths: [file] });
  const origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: 'entry-ranges' });
  for (const [start, end, status, reason] of [
    [1, 3, 'READY', 'OBSERVED_CANDIDATES_RECORDED'],
    [4, 4, 'UNKNOWN', 'ENTRY_SYMBOL_UNRESOLVED'],
    [1, 7, 'UNKNOWN', 'ENTRY_SYMBOL_UNRESOLVED'],
  ]) {
    const entry = { path: path.join(f.root, file), start, end, sha256: sha256(body) };
    const receipt = await origin.discover({ objectId: 'entry-range', entry });
    assert.equal(receipt.status, status, `${start}-${end}: ${receipt.reason}`);
    assert.equal(receipt.reason, reason);
    assert.deepEqual(receipt.candidates, []);
    assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'entry-range', entry })).status, status);
  }
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

test('opaque origins use exact query-scoped lexical witnesses without inventing callers', async t => {
  for (const [label, statement, expected] of [
    ['hidden-literal', '`${emit({ view: "views/ExportView", params: input })}`;', 'UNKNOWN'],
    ['escaped-selector', '`${emit({ view: "views\\u002fExportView", params: input })}`;', 'UNKNOWN'],
    ['hidden-symbol', '`${renderExport(input)}`;', 'UNKNOWN'],
    ['hidden-alias', '`${encode(input)}`;', 'UNKNOWN'],
    ['hidden-namespace', '`${renderer.renderExport(input)}`;', 'UNKNOWN'],
    ['division-symbol', 'left / renderExport(input) / right;', 'UNKNOWN'],
    ['division-selector', 'left / emit({ view: "views/ExportView", params: input }) / right;', 'UNKNOWN'],
    ['unrelated-log', '`${amount}`;', 'READY'],
    ['near-symbol', '`${renderExportExtra(input)}`;', 'READY'],
    ['near-path', '`${emit({ view: "views/ExportViewExtra" })}`;', 'READY'],
    ['path-suffix', '`${emit({ view: "other/views/ExportView" })}`;', 'READY'],
    ['static-symbol-text', '`renderExport ${amount}`;', 'READY'],
    ['static-quoted-path-text', '`"views/ExportView" ${amount}`;', 'READY'],
    ['ordinary-string', "'${renderExport(input)}';", 'READY'],
    ['comment', '// `${renderExport(input)}`;', 'READY'],
  ]) await t.test(label, async t => {
    const f = await fixture(t);
    const caller = ['import { renderExport, renderExport as encode } from "./views/ExportView.mjs";',
      'import * as renderer from "./views/ExportView.mjs";',
      'export function run(input, emit, amount, left, right) {', `  ${statement}`, '}'].join('\n') + '\n';
    await fs.writeFile(path.join(f.root, 'caller.mjs'), caller);
    const graph = await buildSemanticGraph(f.root, { snapshotPaths: ['views/ExportView.mjs', 'caller.mjs'] });
    assert.equal(graph.status, 'ready', 'opaque metadata does not globally disable ordinary source navigation');
    const origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: label });
    const receipt = await origin.discover({ objectId: 'required-export', entry: f.entry });
    assert.equal(receipt.status, expected, receipt.reason);
    assert.deepEqual(receipt.candidates, [], 'an opaque witness is not a fabricated call or partial candidate set');
    if (expected === 'UNKNOWN') {
      assert(['UNPARSED_POTENTIAL_ORIGIN', 'OPAQUE_ORIGIN_UNRESOLVED'].includes(receipt.reason), receipt.reason);
      assert.equal(receipt.unparsedOrigin.path, 'caller.mjs');
      assert.equal(receipt.unparsedOrigin.start, 4);
      assert.equal(receipt.unparsedOrigin.sha256, sha256(caller));
      assert.equal(receipt.unparsedOrigin.sourceReadAcknowledged, false);
      assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'required-export', entry: f.entry })).status, 'UNKNOWN');
    } else {
      assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'required-export', entry: f.entry })).status, 'READY');
      await fs.appendFile(path.join(f.root, 'caller.mjs'), '\n');
      assert.equal((await origin.lookup(receipt.receiptId, { objectId: 'required-export', entry: f.entry })).reason, 'ORIGIN_INDEX_CHANGED');
    }
  });
});

test('opaque origin limits stay unknown rather than certifying an empty vocabulary', async t => {
  for (const statement of [
    '`' + '${amount}'.repeat(100) + '`;',
    '`' + ' '.repeat(16 * 1024) + '`;',
    Array.from({ length: 257 }, () => '`plain`;').join('\n'),
  ]) {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'caller.mjs'), `export function log(amount) {\n${statement}\n}\n`);
    const graph = await buildSemanticGraph(f.root, { snapshotPaths: ['views/ExportView.mjs', 'caller.mjs'] });
    const origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: 'bounded-opaque' });
    const receipt = await origin.discover({ objectId: 'required-export', entry: f.entry });
    assert.equal(receipt.status, 'UNKNOWN'); assert.equal(receipt.reason, 'OPAQUE_ORIGIN_UNRESOLVED');
    assert.deepEqual(receipt.candidates, []);
  }
});

test('opaque references preserve known re-export aliases and cap query work', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'barrel.mjs'), 'export { renderExport as encode } from "./views/ExportView.mjs";\n');
  await fs.writeFile(path.join(f.root, 'caller.mjs'), 'import { encode as printRows } from "./barrel.mjs";\nexport function run(input) { `${printRows(input)}`; }\n');
  let graph = await buildSemanticGraph(f.root, { snapshotPaths: ['views/ExportView.mjs', 'barrel.mjs', 'caller.mjs'] });
  let origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: 're-export' });
  let receipt = await origin.discover({ objectId: 'required-export', entry: f.entry });
  assert.equal(receipt.status, 'UNKNOWN'); assert.equal(receipt.reason, 'UNPARSED_POTENTIAL_ORIGIN');
  assert.equal(receipt.unparsedOrigin.symbol, 'printRows');
  const paths = ['views/ExportView.mjs'];
  for (let i = 0; i < 40; i++) {
    const file = `logging-${i}.mjs`; paths.push(file);
    await fs.writeFile(path.join(f.root, file), Array.from({ length: 240 }, () => '`plain`;').join('\n'));
  }
  graph = await buildSemanticGraph(f.root, { snapshotPaths: paths });
  assert.equal(graph.status, 'ready');
  origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: 'query-cap' });
  receipt = await origin.discover({ objectId: 'required-export', entry: f.entry });
  assert.equal(receipt.status, 'UNKNOWN'); assert.equal(receipt.reason, 'OPAQUE_ORIGIN_QUERY_LIMIT');
  assert.deepEqual(receipt.candidates, []);
});

test('static templates retain escaped interpolation text and Unicode line continuations', async t => {
  for (const [relative, token] of [
    ['views/${name}/Export.mjs', '`views/\\${name}/Export`'],
    ['views/ExportView.mjs', '`views/\\\u2028ExportView`'],
    ['views/ExportView.mjs', '`views/\\\u2029ExportView`'],
  ]) {
    const f = await fixture(t), body = files['views/ExportView.mjs'];
    await fs.mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
    await fs.writeFile(path.join(f.root, relative), body);
    await fs.writeFile(path.join(f.root, 'caller.mjs'), `export function run(input, emit) { emit({ view: ${token}, params: input }); }\n`);
    const graph = await buildSemanticGraph(f.root, { snapshotPaths: [relative, 'caller.mjs'] });
    const origin = createProductionOriginCoverage({ projectRoot: f.root, graph, contextId: 'static-escaped' });
    const receipt = await origin.discover({ objectId: 'required-export', entry: {
      path: path.join(f.root, relative), start: 1, end: 1, sha256: sha256(body),
    } });
    assert.equal(receipt.status, 'UNKNOWN'); assert.equal(receipt.reason, 'UNPARSED_POTENTIAL_ORIGIN');
    assert.equal(receipt.unparsedOrigin.selector, relative.slice(0, -4));
  }
});
