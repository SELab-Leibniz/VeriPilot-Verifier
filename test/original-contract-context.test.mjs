import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { originalFailureContext, prepareOriginalContractContext } from '../lib/runtime-v2/original-contract-context.mjs';

const testSource = `import { Gate } from '../gate.js';
const originalDispatch = Dispatcher.dispatch;
describe('Gate', () => {
  beforeEach(() => {
    Dispatcher.dispatch = () => ({ success: true });
  });
  afterEach(() => {
    Dispatcher.dispatch = originalDispatch;
  });
  it('uses the original successful substitute', () => {
    const result = Gate.apply('blocked');
    expect(result.allowed).assertTrue();
    expect(result.label).assertEqual('Existing event label');
  });
});
`;

test('failure context carries original setup, cleanup and assertions after the first failure', () => {
  const context = originalFailureContext(testSource, 'test/gate.test.js', 10, 14);
  assert.match(context, /success: true/);
  assert.match(context, /dispatch = originalDispatch/);
  assert.match(context, /result.allowed/);
  assert.match(context, /Existing event label/);
  assert.match(context, /Source SHA256: [a-f0-9]{64}/);
});

test('existing entry lookup supplies original tests to all later stages without a new model protocol', async t => {
  const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-context-'));
  t.after(() => fs.rm(tree, { recursive: true, force: true }));
  const files = new Map([
    ['gate.js', "export class Gate {\n static apply(value) { return {allowed: true, label: 'Existing event label'} }\n}\n"],
    ['test/gate.test.js', testSource],
  ]);
  for (const [file, source] of files) {
    await fs.mkdir(path.dirname(path.join(tree, file)), { recursive: true });
    await fs.writeFile(path.join(tree, file), source);
  }
  const graph = await buildSemanticGraph(tree, { snapshotPaths: files.keys(), budgetMs: 5000 });
  const context = await prepareOriginalContractContext({ tree, inventory: files, graph,
    candidates: [{ entryPoint: { path: 'gate.js', symbol: 'Gate.apply' }, evidence: [{ path: 'gate.js', startLine: 2, endLine: 2 }] }] });
  const original = context.excerpts.filter(excerpt => excerpt.path === 'test/gate.test.js');
  assert(original.length > 0, 'the lookup must follow actual test callers, not candidate-given prose');
  const text = original.map(excerpt => excerpt.text).join('\n');
  assert.match(text, /success: true/);
  assert.match(text, /Existing event label/);
  assert.match(text, /dispatch = originalDispatch/);
  assert.equal(original[0].sha256, createHash('sha256').update(testSource).digest('hex'));
  assert.equal(context.source, 'TASK_START');
  assert.equal(context.omitted.length, 0);
});

test('unavailable siblings and a context limit retain accepted excerpts and expose the gap', async t => {
  const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-context-'));
  t.after(() => fs.rm(tree, { recursive: true, force: true }));
  await fs.writeFile(path.join(tree, 'small.js'), 'export const small = true;\n');
  await fs.writeFile(path.join(tree, 'large.js'), 'export const large = ' + JSON.stringify('x'.repeat(12000)) + ';\n');
  const inventory = new Map(['small.js', 'missing.js', 'large.js'].map(file => [file, null]));
  const context = await prepareOriginalContractContext({ tree, inventory, maxBytes: 5000,
    candidates: [{ evidence: [...inventory.keys()].map(file => ({ path: file, startLine: 1, endLine: 1 })) }] });
  assert.deepEqual(context.excerpts.map(excerpt => excerpt.path), ['small.js']);
  assert.equal(context.omitted.length, 2);
  assert(context.omitted.some(excerpt => excerpt.path === 'missing.js'));
  assert(context.omitted.some(excerpt => excerpt.path === 'large.js'));
  assert(Buffer.byteLength(JSON.stringify(context)) < 5000);
});
