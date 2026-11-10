import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';

test('indexes current definitions and relative dependencies in both directions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-semantic-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true });
  git('init', '-q');
  await fs.mkdir(path.join(root, '.runtime-correction'));
  await fs.mkdir(path.join(root, 'private'));
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
  await fs.writeFile(path.join(root, 'ignored.ts'), 'export const ignored = 1;\n');
  await fs.writeFile(path.join(root, '.runtime-correction', 'hidden.ets'), 'export const hidden = 1;\n');
  await fs.writeFile(path.join(root, 'private', 'excluded.ets'), 'export const excluded = 1;\n');
  await fs.writeFile(path.join(root, 'service.ets'), 'export struct Service {}\n');
  await fs.writeFile(path.join(root, 'entry.ets'), [
    '// import "./ignored";',
    '/* export function fake() {} */',
    'import type { Service } from',
    '  "./service";',
    'export { Service } from "./service";',
    'export function entry() { return import("./service"); }',
  ].join('\r\n'));
  git('add', '--', 'entry.ets', 'service.ets');
  const graph = await buildSemanticGraph(root, { excludedPaths: ['private'], budgetMs: 5000 });
  assert.deepEqual(graph.query({ operation: 'summary' }), { status: 'ready', navigationOnly: true, files: 2, unresolved: 0 });
  assert.deepEqual(graph.query({ operation: 'definition', symbol: 'Service' }).hits,
    [{ path: 'service.ets', symbol: 'Service', kind: 'struct', line: 1 }]);
  const edges = [
    { from: 'entry.ets', to: 'service.ets', kind: 'import', line: 3 },
    { from: 'entry.ets', to: 'service.ets', kind: 'export', line: 5 },
  ];
  assert.deepEqual(graph.query({ operation: 'dependencies', file: 'service.ets' }).hits, edges);
  assert.deepEqual(graph.query({ operation: 'dependencies', file: 'entry.ets' }).hits, edges);
  for (const symbol of ['fake', 'hidden', 'ignored', 'excluded'])
    assert.deepEqual(graph.query({ operation: 'definition', symbol }).hits, []);

  await fs.writeFile(path.join(root, 'new.ts'), 'export { Service } from "./service";\n');
  assert.equal(graph.query({ operation: 'dependencies', file: 'new.ts' }).indexed, false);
  const updated = await buildSemanticGraph(root, { excludedPaths: ['private'], budgetMs: 5000 });
  assert.equal(updated.query({ operation: 'dependencies', file: 'new.ts' }).hits[0].to, 'service.ets');
  await assert.rejects(buildSemanticGraph(root, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
