import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { scanSemanticSource } from '../lib/semantic-graph-syntax.mjs';
import { bindTaskTools, registerTaskTools } from '../lib/openclaw/task-tools.mjs';

test('test-helper argument hints preserve reference identity and exclude control parentheses', () => {
  const source = [
    "import { Store } from './store'",
    "it('registers a substituted member', () => {",
    '  hooks.replace(Store, Store.save)',
    '  if (Store.save) {}',
    '  while (Store.save) {}',
    '  const reference = (Store.save)',
    '})',
  ].join('\n');
  const testReferences = scanSemanticSource(source, 'store.test.ts').uses
    .filter(use => use.label === 'Store.save');
  assert.equal(testReferences.length, 4);
  assert.deepEqual(testReferences.map(use => use.argumentTo), [
    { symbol: 'hooks.replace', line: 3, argumentIndex: 1 }, undefined, undefined, undefined,
  ]);
  assert(testReferences.every(use => use.relation === 'reference'));
  assert(scanSemanticSource(source, 'store.ts').uses.every(use => use.argumentTo === undefined));
});

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
  await fs.writeFile(path.join(root, 'mismatch.ts'), 'import { Service } from "./SeRvIcE";\n');
  const withMismatch = await buildSemanticGraph(root, { snapshotPaths: ['mismatch.ts', 'service.ets'] });
  assert.deepEqual(withMismatch.query({ operation: 'dependencies', file: 'mismatch.ts' }).hits, [
    { from: 'mismatch.ts', kind: 'import', line: 1, resolution: 'case-mismatch', requestedPath: 'SeRvIcE.ets', existingPath: 'service.ets' },
  ]);
  assert.deepEqual(withMismatch.query({ operation: 'dependencies', file: 'service.ets' }).hits, []);
  assert.equal(withMismatch.unresolved, 1);
  const ambiguous = await buildSemanticGraph(root, { snapshotPaths: ['mismatch.ts', 'service.ets', 'Service.ets'] });
  assert.deepEqual(ambiguous.query({ operation: 'dependencies', file: 'mismatch.ts' }).hits, []);
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
      '  static async load(read: () => Promise<number[]>): Promise<number[]> {',
      '    try { return await read() }',
      '    catch (error) {',
      '      const unused = () => {',
      '        try { return [0] } catch { return [1] }',
      '      }',
      '      if (error) { return [] }',
      '      throw error',
      '    }',
      '  }',
      '  static repeat(value: number): number { return Store.repeat(value) }',
      '  static many(): void {',
      ...Array.from({ length: 16 }, (_, index) => `    Store.sink(${index})`),
      '  }',
      '  static sink(value: number): number { return value }',
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
      '  async loadForWrite(read: () => Promise<number[]>): Promise<number[]> {',
      '    return await Storage.load(read)',
      '  }',
      '  repeat(value: number): number { return Storage.repeat(value) }',
      '  many(): void { Storage.many() }',
      '}',
    ],
    'panel.test.ets': [
      "import { Panel } from './panel'",
      "import * as services from './store'",
      "it('uses the public entry point', async () => {",
      '  const panel = new Panel()',
      '  const reference = fixture(services.Store, services.Store.save)',
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
  assert.deepEqual(callers.hits[1].argumentTo, { symbol: 'fixture', line: 5, argumentIndex: 1 });
  assert(graph.query({ operation: 'outline', file: 'panel.ets' }).hits.some(row => row.qualified === 'Panel.shadow'));
  const [testCase] = graph.query({ operation: 'search', query: 'public entry point' }).hits;
  assert.deepEqual([testCase.kind, testCase.symbol, testCase.line], ['test', 'uses the public entry point', 3]);
  assert.equal(graph.query({ operation: 'search', query: 'panel execute' }).hits[0].qualified, 'Panel.execute');
  assert(graph.query({ operation: 'context', symbol: testCase.symbol, file: testCase.path, direction: 'outgoing' })
    .hits.some(hit => hit.target.symbol === 'Panel.execute' && hit.relation === 'call'));
  const flow = graph.query({ operation: 'outgoing', symbol: 'Panel.refresh' });
  assert.deepEqual(flow.controlSites.map(site => [site.kind, site.line]), [['try', 13], ['catch', 14], ['throw', 14], ['finally', 15]]);
  assert(flow.hits.some(hit => hit.target.symbol === 'external.read' && hit.target.resolution === 'unresolved' && hit.awaited));
  const readDependency = graph.query({ operation: 'outgoing', symbol: 'Panel.loadForWrite' })
    .hits.find(hit => hit.relation === 'call' && hit.target.symbol === 'Store.load');
  assert.deepEqual(readDependency.target, { path: 'store.ets', symbol: 'Store.load', line: 3,
    catchReturns: [{ catchLine: 5, line: 9 }], catchReturnCount: 1 });
  const nested = graph.query({ operation: 'outgoing', symbol: 'Panel.loadForWrite', depth: 2 });
  const externalRead = nested.hits.find(hit => hit.target.symbol === 'read' && hit.target.resolution === 'unresolved');
  assert.deepEqual(externalRead.via, [{ path: 'panel.ets', line: 18, within: 'Panel.loadForWrite', target: 'Store.load' }]);
  assert.equal(graph.query({ operation: 'outgoing', symbol: 'Panel.loadForWrite' }).hits.some(hit => hit.via), false);
  assert.equal(graph.query({ operation: 'outgoing', symbol: 'Panel.repeat', depth: 3 }).hits.filter(hit => hit.relation === 'call').length, 2);
  assert.equal(graph.query({ operation: 'outgoing', symbol: 'Panel.shadow', depth: 3 }).hits.some(hit => hit.target.path === 'store.ets'), false);
  assert.throws(() => graph.query({ operation: 'outgoing', symbol: 'Panel.execute', depth: 4 }), { code: 'TASK_SUBMISSION_INVALID' });
  const firstPage = graph.query({ operation: 'outgoing', symbol: 'Panel.many', depth: 2 });
  const secondPage = graph.query({ operation: 'outgoing', symbol: 'Panel.many', depth: 2, offset: firstPage.nextOffset });
  assert.deepEqual([firstPage.hits.length, firstPage.nextOffset, secondPage.hits.length, secondPage.nextOffset], [12, 12, 5, null]);
  assert(secondPage.hits.every(hit => hit.target.symbol === 'Store.sink' && hit.via?.[0].target === 'Store.many'));
  assert(flow.hits.some(hit => hit.target.symbol === 'Panel.state' && hit.relation === 'write' && hit.line === 14));
  assert.deepEqual(graph.query({ operation: 'incoming', symbol: 'Store.save' }).hits, callers.hits);
  const indirectCaller = graph.query({ operation: 'incoming', symbol: 'Store.save', depth: 2 }).hits
    .find(hit => hit.target.symbol === 'Panel.execute' && hit.testSource);
  assert.equal(indirectCaller.within, 'uses the public entry point');
  assert.deepEqual(indirectCaller.via, [{ path: 'panel.ets', line: 5, within: 'Panel.execute', target: 'Store.save' }]);
  assert.equal(graph.query({ operation: 'incoming', symbol: 'Store.repeat', depth: 3 }).hits.length, 2);
  const callerPage = graph.query({ operation: 'incoming', symbol: 'Store.sink', depth: 2 });
  const nextCallerPage = graph.query({ operation: 'incoming', symbol: 'Store.sink', depth: 2, offset: callerPage.nextOffset });
  assert.deepEqual([callerPage.hits.length, callerPage.nextOffset, nextCallerPage.hits.length, nextCallerPage.nextOffset], [12, 12, 5, null]);
  assert.equal(nextCallerPage.hits.at(-1).target.symbol, 'Store.many');
  assert.equal(nextCallerPage.hits.at(-1).via[0].target, 'Store.sink');

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

test('traces exact string contract values to consumer branches and ignores comments and module paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-semantic-literals-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=rc-test', '-c', 'user.email=rc@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim();
  const files = {
    'api.ts': [
      'export type DispatchStatus =',
      "  | 'sent'",
      '  | "queued";',
      "export type ExtensibleStatus = 'sent' | string;",
      "export type EmptyStatus = '';",
    ],
    'ui.ts': [
      "import type { DispatchStatus } from './api';",
      'export function display(status: DispatchStatus) {',
      "  // case 'queued':",
      '  switch (status) {',
      "    case 'queued': return 'Waiting';",
      "    case 'queued_again': return 'Other';",
      '  }',
      '}',
    ],
    'ui.test.ts': ["it('renders pending state', () => {", "  expect(display('queued')).toBe('Waiting');", '});'],
  };
  await Promise.all(Object.entries(files).map(([file, lines]) => fs.writeFile(path.join(root, file), lines.join('\n'))));
  const graph = await buildSemanticGraph(root, { snapshotPaths: Object.keys(files) });
  const status = graph.query({ operation: 'context', symbol: 'DispatchStatus' });
  assert.deepEqual(status.literalMembers, [{ value: 'sent', line: 2 }, { value: 'queued', line: 3 }]);
  assert.equal(status.literalMemberCount, 2);
  assert.equal(status.definitions[0].endLine, 3);
  assert(status.hits.some(hit => hit.direction === 'incoming' && hit.path === 'ui.ts'));
  assert.equal(graph.query({ operation: 'context', symbol: 'ExtensibleStatus' }).literalMembers, undefined);
  const queued = graph.query({ operation: 'literal', value: 'queued' });
  assert.deepEqual(queued.hits.map(hit => [hit.path, hit.line, hit.kind, hit.within]), [
    ['ui.ts', 5, 'case', 'display'],
    ['api.ts', 3, 'union-member', 'DispatchStatus'],
    ['ui.test.ts', 2, 'value', 'renders pending state'],
  ]);
  assert.equal(queued.hits[2].testSource, true);
  assert.deepEqual(graph.query({ operation: 'literal', value: './api' }).hits, []);
  assert.deepEqual(graph.query({ operation: 'literal', value: 'Queued' }).hits, []);
  assert.deepEqual(graph.query({ operation: 'literal', value: '' }).hits.map(hit => hit.within), ['EmptyStatus']);
  assert.deepEqual(graph.query({ operation: 'literal', value: 'queued', file: 'ui.ts', offset: 1 }).hits, []);
  const [impact] = graph.affectedSymbols([{ path: 'api.ts', hunks: [[3, 3]] }]);
  assert.equal(impact.definition.symbol, 'DispatchStatus');
  assert.equal(impact.caller.path, 'ui.ts');

  git('init', '-q'); git('add', '--', ...Object.keys(files)); git('commit', '-qm', 'original status contract');
  const base = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(root, 'api.ts'), [
    "export type DispatchStatus = 'sent';", ...files['api.ts'].slice(3),
  ].join('\n'));
  await fs.writeFile(path.join(root, 'unrelated.ts'), "export function format(kind: string) { switch (kind) { case 'queued': return 0; } }\n");
  const current = await buildSemanticGraph(root);
  assert.equal(current.query({ operation: 'literal', value: 'queued' }).hits.filter(hit => hit.kind === 'case').length, 2);
  const removed = await current.removedLiteralUses([{ path: 'api.ts', hunks: [[1, 2]] }], base);
  assert.deepEqual(removed.map(hint => [hint.definition.symbol, hint.removed.value, hint.cases.map(hit => [hit.path, hit.line])]),
    [['DispatchStatus', 'queued', [['ui.ts', 5]]]]);
});
