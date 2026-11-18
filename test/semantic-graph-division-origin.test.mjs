import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { scanSemanticSource, discoverSiblingLiteralDispatches, discoverFileSelectorSiblingDispatches }
  from '../lib/semantic-graph-syntax.mjs';
import { createProductionOriginCoverage } from '../lib/runtime-v2/production-origin-coverage.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const target = 'export function format(rows) {\n  return rows.join(",");\n}\n';
async function discover(t, statement, arithmetic = null) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-division-origin-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const caller = 'import { format as encode } from "./format.mjs";\n'
    + 'import * as renderer from "./format.mjs";\n'
    + 'export function run(input, count, width, left, right, emit) {\n'
    + `  ${statement}\n}\n`;
  const files = { 'format.mjs': target, 'caller.mjs': caller, ...(arithmetic ? { 'arithmetic.mjs': arithmetic } : {}) };
  for (const [file, source] of Object.entries(files))
    await fs.writeFile(path.join(root, file), source);
  const graph = await buildSemanticGraph(root, { snapshotPaths: Object.keys(files) });
  const origin = createProductionOriginCoverage({ projectRoot: root, graph, contextId: 'division-test' });
  const entry = { path: path.join(root, 'format.mjs'), start: 1, end: 3, sha256: sha256(target) };
  return { root, caller, graph, origin, entry, receipt: await origin.discover({ objectId: 'format', entry }) };
}

test('bounded division operators retain visible operand and call tokens without opaque syntax', async t => {
  for (const [name, statement, calls] of [
    ['identifier operands', 'const ratio = count / width;', false],
    ['numeric divisor', 'const ratio = count / 2;', false],
    ['call argument', 'const ratio = Math.floor(count / width);', false],
    ['compound assignment', 'count /= width;', false],
    ['preceding comment is inert', 'const ratio = count /* encode(input) */ / width;', false],
    ['strings are inert', 'const note = "left / encode(input)"; const ratio = count / width;', false],
    ['visible alias call', 'return count / encode(input);', true],
    ['assignment with visible alias call', 'count /= encode(input);', true],
    ['visible namespace call', 'return count / renderer.format(input);', true],
  ]) await t.test(name, async t => {
    const f = await discover(t, statement);
    assert.deepEqual(scanSemanticSource(f.caller, 'caller.mjs').opaqueOrigins, []);
    assert.equal(f.receipt.status, 'READY', f.receipt.reason);
    assert.equal(f.receipt.candidates.some(c => c.path === 'caller.mjs'), calls,
      'division operands remain normal source references, not hidden opaque text');
    assert.equal((await f.origin.lookup(f.receipt.receiptId, { objectId: 'format', entry: f.entry })).status, 'READY');
    assert.equal((await f.origin.lookup(f.receipt.receiptId, { objectId: 'other', entry: f.entry })).reason,
      'MISSING_OR_FOREIGN_ORIGIN_RECEIPT');
    await fs.appendFile(path.join(f.root, 'caller.mjs'), '\n');
    assert.equal((await f.origin.lookup(f.receipt.receiptId, { objectId: 'format', entry: f.entry })).reason,
      'ORIGIN_INDEX_CHANGED');
  });
});

test('unrelated bounded arithmetic does not suppress an independently resolved caller', async t => {
  const f = await discover(t, 'return encode(input);',
    'export function cellRow(cell, width) {\n  return Math.floor(cell / width);\n}\n');
  assert.equal(f.receipt.status, 'READY', f.receipt.reason);
  assert.deepEqual(f.receipt.candidates.map(c => c.path), ['caller.mjs']);
});

test('regex-shaped, hidden and ambiguous slash syntax keeps conservative origin uncertainty', async t => {
  for (const [name, statement] of [
    ['paired hidden alias', 'left / encode(input) / right;'],
    ['paired hidden namespace', 'left / renderer.format(input) / right;'],
    ['paired hidden selector', 'left / emit({ view: "nested/format", params: input }) / right;'],
    ['regex alias vocabulary', 'const pattern = /encode/;'],
    ['regex next to division', 'const ratio = count / /encode/.test(input);'],
    ['division next to template', 'const ratio = count / `${encode(input)}`;'],
    ['escaped operand', 'const ratio = count / \\u0065ncode(input);'],
    ['newline ambiguity', 'const ratio = count\n  / width;'],
    ['unbalanced grouping', 'const ratio = Math.floor(count / width;'],
    ['unbalanced close', 'const ratio = count / width);'],
    ['invalid parameter division', 'function broken(count / width) {}'],
    ['dangling operator', 'const ratio = count / ;'],
    ['unsupported closed expression', 'const ratio = (count + 1) / width;'],
    ['unsupported member operand', 'const ratio = input.count / width;'],
    ['division assignment then regex', 'count /= /encode/.test(input);'],
    ['escaped alias after division', 'const ratio = count / width; return \\u0065ncode(input);'],
    ['escaped alias before division', 'const result = \\u0065ncode(input); const ratio = count / width;'],
    ['escaped member after division', 'const ratio = count / width; return renderer.\\u0066ormat(input);'],
    ['paired escaped alias', 'left / \\u0065ncode(input) / right;'],
    ['paired escaped member', 'left / renderer.\\u0066ormat(input) / right;'],
    ['paired braced escape', 'left / \\u{65}ncode(input) / right;'],
    ['escaped alias without division', 'return \\u0065ncode(input);'],
    ['non-operand keyword', 'debugger / width;'],
    ['comment-adjacent ambiguous token', 'const ratio = count / /* renderer.format(input) */ width;'],
    ['bounded nesting', `const ratio = ${'('.repeat(70)}count / width${')'.repeat(70)};`],
  ]) await t.test(name, async t => {
    const f = await discover(t, statement);
    assert.equal(f.receipt.status, 'UNKNOWN', f.receipt.reason);
    assert(['OPAQUE_ORIGIN_UNRESOLVED', 'UNPARSED_POTENTIAL_ORIGIN'].includes(f.receipt.reason), f.receipt.reason);
    assert.equal(f.receipt.unparsedOrigin.path, 'caller.mjs');
    assert.deepEqual(f.receipt.candidates, []);
    assert.equal((await f.origin.lookup(f.receipt.receiptId, { objectId: 'format', entry: f.entry })).status, 'UNKNOWN');
  });
});

test('unrelated regex and inert escaped text remain query scoped', async t => {
  for (const statement of [
    'const pattern = /unrelated/; // left / encode(input) / right\n'
      + '  const note = "${encode(input)}"; const ratio = count / width;',
    'const pattern = /\\d+\\s+\\w/; const ratio = count / width;',
    'const note = "\\u0065ncode(input)"; const ratio = count / width;',
    '// \\u0065ncode(input)\n  const ratio = count / width;',
    'const note = `\\u0065ncode(input)`; const ratio = count / width;',
    'const note = `\\${encode(input)}`; const ratio = count / width;',
  ]) await t.test(statement, async t => {
    const f = await discover(t, statement);
    assert.equal(f.receipt.status, 'READY', f.receipt.reason);
    assert.deepEqual(f.receipt.candidates, []);
  });
});

test('origin indexing does not broaden the independent sibling-dispatch execution parser', () => {
  const source = 'function run(router, count, width) {\n'
    + '  const ratio = count / width;\n'
    + '  router.open({ view: "screens/Result", params: { ratio } });\n}\n';
  assert.deepEqual(scanSemanticSource(source, 'route.mjs').opaqueOrigins, []);
  for (const result of [discoverSiblingLiteralDispatches(source, { start: 3, end: 3 }),
    discoverFileSelectorSiblingDispatches(source, { start: 3, end: 3 }, ['screens/Result'])]) {
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'UNSUPPORTED_EXECUTABLE_SYNTAX');
    assert.equal(result.complete, false);
    assert.deepEqual(result.siblings, []);
  }
});
