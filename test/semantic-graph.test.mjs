import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { bindTaskTools, registerTaskTools } from '../lib/openclaw/task-tools.mjs';

test('indexes current definitions and relative dependencies in both directions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-semantic-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true });
  git('init', '-q');
  await fs.mkdir(path.join(root, '.runtime-correction'));
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.mkdir(path.join(root, 'private'));
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
  await fs.writeFile(path.join(root, 'ignored.ts'), 'export const ignored = 1;\n');
  await fs.writeFile(path.join(root, '.runtime-correction', 'hidden.ets'), 'export const hidden = 1;\n');
  await fs.writeFile(path.join(root, '.runtime-corrector', 'control.ets'), 'export const control = 1;\n');
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
  for (const symbol of ['fake', 'hidden', 'control', 'ignored', 'excluded'])
    assert.deepEqual(graph.query({ operation: 'definition', symbol }).hits, []);

  await fs.writeFile(path.join(root, 'new.ts'), 'export { Service } from "./service";\n');
  assert.equal(graph.query({ operation: 'dependencies', file: 'new.ts' }).indexed, false);
  const updated = await buildSemanticGraph(root, { excludedPaths: ['private'], budgetMs: 5000 });
  assert.equal(updated.query({ operation: 'dependencies', file: 'new.ts' }).hits[0].to, 'service.ets');
  await assert.rejects(buildSemanticGraph(root, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('the host graph uses the current enabled project without exposing review tools', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-business-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  const file = path.join(root, 'api.ts');
  await fs.writeFile(file, 'export function current() {}\n');
  let factory, resolutions = 0, enabled = true, switchProject = false;
  const ctx = { workspaceDir: root, sessionId: 'business', sessionKey: 'agent:main:business' };
  registerTaskTools({ registerTool: value => { factory = value; } }, {
    resolveGraphScope: async (_event, scope) => {
      assert.equal(scope, ctx);
      resolutions++;
      return { enabled, projectRoot: root, fingerprint: switchProject ? String(resolutions) : 'business' };
    },
  });
  assert.equal(factory({ ...ctx, sandboxed: true }), null);
  const privateCtx = { ...ctx, sessionId: 'review', sessionKey: 'agent:main:runtime-corrector:review' };
  const close = bindTaskTools({ ...privateCtx, active() {}, tools: [{ name: 'source_read' }] });
  try { assert.deepEqual(factory(privateCtx).map(tool => tool.name), ['source_read']); }
  finally { close(); }
  assert.equal(factory(privateCtx), null);

  const tools = factory(ctx);
  assert.deepEqual(tools.map(tool => tool.name), ['semantic_graph']);
  const query = async symbol => JSON.parse((await tools[0].execute('call', { operation: 'definition', symbol })).content[0].text);
  assert.equal((await query('current')).hits[0].path, 'api.ts');
  await fs.writeFile(file, 'export function updated() {}\n');
  assert.equal((await query('updated')).hits[0].path, 'api.ts');
  assert.equal((await query('current')).hits.length, 0);
  enabled = false;
  await assert.rejects(query('updated'), /RC_PROJECT_NOT_ENABLED/u);
  enabled = true;
  switchProject = true;
  await assert.rejects(query('updated'), /RC_PROJECT_SCOPE_CHANGED/u);
});

test('links methods across aliases and re-exports and keeps tests and state writes visible', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-semantic-methods-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'store.ets': [
      'export class Store {',
      '  static async save(value: number): Promise<number> { return value }',
      '}',
    ],
    'barrel.ets': ["export { Store as Repo } from './store'"],
    'panel.ets': [
      "import { Repo as Storage } from './barrel'",
      'export class Panel {',
      '  private state = { value: 0 }',
      '  async execute(value: number): Promise<number> {',
      '    this.state.value = await Storage.save(value)',
      '    return this.state.value',
      '  }',
      '  shadow() {',
      '    const Storage = { save(value: number) { return value } }',
      '    return Storage.save(0)',
      '  }',
      '  async refresh(external: unknown) {',
      '    try { await external.read() }',
      '    catch (error) { this.state.value = 0; throw error }',
      '    finally { this.state.ready = true }',
      '  }',
      '}',
    ],
    'panel.test.ets': [
      "import { Panel } from './panel'",
      "import * as services from './store'",
      "it('uses the public entry point', async () => {",
      '  const panel = new Panel()',
      '  const reference = services.Store.save',
      '  await panel.execute(1)',
      '})',
    ],
    'outside.ets': ['export const outside = 1'],
  };
  await Promise.all(Object.entries(files).map(([file, lines]) => fs.writeFile(path.join(root, file), lines.join('\n') + '\n')));
  const snapshotPaths = Object.keys(files).filter(file => file !== 'outside.ets');
  const graph = await buildSemanticGraph(root, { snapshotPaths, budgetMs: 5000 });
  assert.equal(graph.files, 4);
  assert.deepEqual(graph.query({ operation: 'definition', symbol: 'outside' }).hits, []);

  const method = graph.query({ operation: 'context', symbol: 'Panel.execute' });
  assert.deepEqual(method.definitions.map(row => [row.qualified, row.line, row.endLine]), [['Panel.execute', 4, 7]]);
  assert(method.hits.some(hit => hit.direction === 'outgoing' && hit.relation === 'call' && hit.awaited
    && hit.target.symbol === 'Store.save' && hit.line === 5));
  assert(method.hits.some(hit => hit.direction === 'outgoing' && hit.relation === 'write'
    && hit.target.symbol === 'Panel.state' && hit.access === 'state.value'));
  assert(method.hits.some(hit => hit.direction === 'incoming' && hit.testSource && hit.path === 'panel.test.ets'
    && hit.line === 6 && hit.within === 'uses the public entry point'));

  const callers = graph.query({ operation: 'context', symbol: 'Store.save', direction: 'incoming' });
  assert.deepEqual(callers.hits.map(row => [row.path, row.line, row.relation]), [
    ['panel.ets', 5, 'call'], ['panel.test.ets', 5, 'reference'],
  ]);
  assert(graph.query({ operation: 'outline', file: 'panel.ets' }).hits.some(row => row.qualified === 'Panel.shadow'));
  const [testCase] = graph.query({ operation: 'search', query: 'public entry point' }).hits;
  assert.deepEqual([testCase.kind, testCase.symbol, testCase.line], ['test', 'uses the public entry point', 3]);
  assert.equal(graph.query({ operation: 'search', query: 'panel execute' }).hits[0].qualified, 'Panel.execute');
  assert(graph.query({ operation: 'context', symbol: testCase.symbol, file: testCase.path, direction: 'outgoing' })
    .hits.some(hit => hit.target.symbol === 'Panel.execute' && hit.relation === 'call'));
  const flow = graph.query({ operation: 'outgoing', symbol: 'Panel.refresh' });
  assert.deepEqual(flow.controlSites.map(site => [site.kind, site.line]), [['try', 13], ['catch', 14], ['throw', 14], ['finally', 15]]);
  assert(flow.hits.some(hit => hit.target.symbol === 'external.read' && hit.target.resolution === 'unresolved' && hit.awaited));
  assert(flow.hits.some(hit => hit.target.symbol === 'Panel.state' && hit.relation === 'write' && hit.line === 14));
  assert.deepEqual(graph.query({ operation: 'incoming', symbol: 'Store.save' }).hits, callers.hits);

  const affected = graph.affectedSymbols([
    { path: 'panel.ets', hunks: [[5, 6]] },
    { path: 'store.ets', hunks: [[2, 2]] },
    { path: 'panel.test.ets', hunks: [[3, 6]] },
  ]);
  assert.deepEqual(affected.map(row => row.definition.qualified), ['Panel.execute', 'Store.save']);
  assert.equal(affected[0].test.within, 'uses the public entry point');
  assert.equal(affected[1].caller.within, 'Panel.execute');
  assert.deepEqual(affected[0].effects.map(ref => [ref.relation, ref.target.symbol]), [['call', 'Store.save'], ['write', 'Panel.state']]);
});
