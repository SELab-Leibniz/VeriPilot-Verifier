import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { createProductionOriginCoverage } from '../lib/runtime-v2/production-origin-coverage.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

async function project(t, files) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-callable-origin-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
  const graph = await buildSemanticGraph(root, { snapshotPaths: Object.keys(files), budgetMs: 5000 });
  const origin = createProductionOriginCoverage({ projectRoot: root, graph, contextId: 'entry-test' });
  const entry = (file, start, end) => ({ path: path.join(root, file), start, end, sha256: sha256(files[file]) });
  return { root, graph, origin, entry };
}

test('a typed static-member callback resolves exact header, body and whole ranges as navigation only', async t => {
  const f = await project(t, {
    'handlers/input.ts': 'import { record } from "../store";\nport.receive = (item: Payload): void => {\n  record(item);\n};\n',
    'store.ts': 'export function record(item) { return item; }\n',
    'client.ts': 'export function connect(make) {\n  return make("handlers/input");\n}\n',
  });
  const identities = new Set();
  for (const [start, end] of [[2, 2], [3, 3], [2, 4]]) {
    const entry = f.entry('handlers/input.ts', start, end);
    const receipt = await f.origin.discover({ objectId: 'delivery', entry });
    assert.equal(receipt.status, 'READY', receipt.reason);
    assert.equal(receipt.entryResolution.navigationOnly, true);
    assert.equal(receipt.entryResolution.definition.kind, 'callback');
    assert.equal(receipt.entryResolution.frame.bindingKind, 'ANONYMOUS');
    assert.equal(receipt.entryResolution.sourceSha256, entry.sha256);
    identities.add(receipt.entryResolution.frame.id);
    assert.equal(receipt.sourceReadAcknowledged, false);
    assert.deepEqual(receipt.candidates.map(row => [row.path, row.kinds]), [
      ['client.ts', ['FILE_SELECTOR_LITERAL_CANDIDATE']],
    ], 'a module selector is a possible source location, not an invented callback caller');
    assert.equal((await f.origin.lookup(receipt.receiptId, { objectId: 'delivery', entry })).status, 'READY');
  }
  assert.equal(identities.size, 1, 'precision does not change the lexical callback identity');
});

test('exported const arrows keep their actual alias callers', async t => {
  const f = await project(t, {
    'format.ts': 'export const format = (item: unknown): unknown => {\n  return item;\n};\n',
    'client.ts': 'import { format as encode } from "./format";\nexport function start(item) { return encode(item); }\n',
  });
  const receipt = await f.origin.discover({ objectId: 'format', entry: f.entry('format.ts', 1, 3) });
  assert.equal(receipt.status, 'READY', receipt.reason);
  assert.equal(receipt.entryResolution.definition.symbol, 'format');
  assert.equal(receipt.entryResolution.frame.bindingKind, 'VARIABLE');
  assert(receipt.candidates.some(row => row.path === 'client.ts' && row.kinds.includes('RESOLVED_REFERENCE')));
});

test('nested callbacks own their calls and cannot borrow the outer registration callers', async t => {
  const f = await project(t, {
    'handler.ts': 'import { record } from "./store";\nexport function attach(register) {\n  register((item: unknown): void => {\n    record(item);\n  });\n}\n',
    'store.ts': 'export function record(item) { return item; }\n',
    'client.ts': 'import { attach } from "./handler";\nexport function connect(register) { attach(register); }\n',
  });
  const child = f.graph.originEntry({ file: 'handler.ts', start: 4, end: 4 });
  assert.equal(child.status, 'READY', child.reason);
  assert.equal(child.definition.kind, 'callback');
  const incoming = f.graph.query({ operation: 'incoming', file: 'handler.ts', symbol: child.definition.symbol, depth: 3 });
  assert.deepEqual(incoming.hits, [], 'registering a callback does not fabricate its invocation');
  const outer = f.graph.query({ operation: 'outgoing', file: 'handler.ts', symbol: 'attach' });
  assert(!outer.hits.some(row => row.target?.symbol === 'record'));
  const inside = f.graph.query({ operation: 'outgoing', file: 'handler.ts', symbol: child.definition.symbol });
  assert(inside.hits.some(row => row.target?.symbol === 'record'));
  const receipt = await f.origin.discover({ objectId: 'delivery', entry: f.entry('handler.ts', 4, 4) });
  assert.equal(receipt.status, 'READY', receipt.reason);
  assert.deepEqual(receipt.candidates, []);
  assert.equal(f.graph.originEntry({ file: 'handler.ts', start: 2, end: 6 }).definition.symbol, 'attach');
  for (const [start, end] of [[2, 4], [4, 6]]) {
    const crossing = f.graph.originEntry({ file: 'handler.ts', start, end });
    assert.equal(crossing.status, 'UNKNOWN');
    assert.equal(crossing.reason, 'ENTRY_RANGE_CROSSES_CALLABLE');
  }
});

test('line-only citations cannot disambiguate same-line callbacks', async t => {
  const f = await project(t, {
    'callbacks.ts': 'port.first = (item) => { emit(item); }; port.second = (item) => { emit(item); };\n',
  });
  const selected = f.graph.originEntry({ file: 'callbacks.ts', start: 1, end: 1 });
  assert.equal(selected.status, 'UNKNOWN');
  assert.equal(selected.reason, 'AMBIGUOUS_ENTRY_SYMBOL');
  const receipt = await f.origin.discover({ objectId: 'callback', entry: f.entry('callbacks.ts', 1, 1) });
  assert.equal(receipt.status, 'UNKNOWN');
  assert.deepEqual(receipt.candidates, []);
});

test('unsupported inner callables cannot fall back to an enclosing named function', async t => {
  for (const [label, body, start, end] of [
    ['computed registration', 'port[key] = (item) => {\n    emit(item);\n  };', 3, 3],
    ['local variable arrow', 'const local = (item) => {\n    emit(item);\n  };', 3, 3],
    ['function expression', 'port.receive = function (item) {\n    emit(item);\n  };', 3, 3],
    ['expression arrow', 'port.receive = (item) => emit(item);', 2, 2],
  ]) await t.test(label, async t => {
    const f = await project(t, { 'handler.ts': `export function attach() {\n  ${body}\n}\n` });
    const selected = f.graph.originEntry({ file: 'handler.ts', start, end });
    assert.equal(selected.status, 'UNKNOWN', JSON.stringify(selected));
    assert.equal(selected.reason, 'ENTRY_CALLABLE_UNSUPPORTED');
    assert.notEqual(selected.definition?.symbol, 'attach');
  });
});

test('existing class methods and exact whole-class declarations remain navigable', async t => {
  const f = await project(t, {
    'format.ts': 'export class Formatter {\n  format(item: unknown): unknown {\n    return item;\n  }\n}\n',
    'client.ts': 'import { Formatter } from "./format";\nconst formatter = new Formatter();\nexport function start(item) { return formatter.format(item); }\n',
  });
  const method = f.graph.originEntry({ file: 'format.ts', start: 3, end: 3 });
  assert.equal(method.status, 'READY', method.reason);
  assert.equal(method.definition.qualified, 'Formatter.format');
  const whole = f.graph.originEntry({ file: 'format.ts', start: 1, end: 5 });
  assert.equal(whole.status, 'READY', whole.reason);
  assert.equal(whole.definition.symbol, 'Formatter');
});

test('anonymous callback opaque hints remain conservative without becoming receiver edges', async t => {
  for (const [statement, expected] of [
    ['`${port.receive(item)}`;', 'UNKNOWN'],
    ['`${other.receive(item)}`;', 'UNKNOWN'],
    ['`${other.receiveExtra(item)}`;', 'READY'],
  ]) await t.test(statement, async t => {
    const f = await project(t, {
      'handler.ts': 'port.receive = (item) => {\n  emit(item);\n};\n',
      'caller.ts': `export function run(port, other, item) { ${statement} }\n`,
    });
    const receipt = await f.origin.discover({ objectId: 'callback', entry: f.entry('handler.ts', 1, 3) });
    assert.equal(receipt.status, expected, receipt.reason);
    assert.deepEqual(receipt.candidates, []);
    if (expected === 'UNKNOWN') assert.equal(receipt.reason, 'UNPARSED_POTENTIAL_ORIGIN',
      'the static spelling does not establish that a different receiver cannot alias this callback');
  });
});

test('origin entries bind the indexed source version and retain ordinary freshness checks', async t => {
  const f = await project(t, { 'handler.ts': 'port.receive = (item) => {\n  emit(item);\n};\n' });
  const entry = f.entry('handler.ts', 1, 3);
  const wrong = await f.origin.discover({ objectId: 'callback', entry: { ...entry, sha256: '0'.repeat(64) } });
  assert.equal(wrong.status, 'UNKNOWN');
  assert.equal(wrong.reason, 'ENTRY_SOURCE_MISMATCH');
  const receipt = await f.origin.discover({ objectId: 'callback', entry });
  assert.equal(receipt.status, 'READY', receipt.reason);
  const foreign = createProductionOriginCoverage({ projectRoot: f.root, graph: f.graph, contextId: 'other-review' });
  assert.equal((await foreign.lookup(receipt.receiptId, { objectId: 'callback', entry })).status, 'UNKNOWN');
  await fs.appendFile(path.join(f.root, 'handler.ts'), '\n');
  assert.equal((await f.origin.lookup(receipt.receiptId, { objectId: 'callback', entry })).reason, 'ORIGIN_INDEX_CHANGED');
});
