import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { discoverSiblingLiteralDispatches, discoverFileSelectorSiblingDispatches, findSiblingLiteralDispatches, scanSemanticSource } from '../lib/semantic-graph-syntax.mjs';
import { bindTaskTools, registerTaskTools } from '../lib/openclaw/task-tools.mjs';

test('finds static dispatches in sibling branches of the same ArkTS callback', () => {
  const source = [
    'struct Entry {',
    '  build() {',
    "    Button('Resume').onClick(() => {",
    "      router.pushUrl({ url: 'pages/GamePage', params: previous });",
    '    });',
    "    Button('Start').onClick(() => {",
    '      if (seedInput) {',
    '        router.pushUrl({',
    "          url: 'pages/GamePage',",
    '          params: { seedId: seedInput },',
    '        });',
    '      } else if (importedBoard) {',
    '        router.pushUrl({',
    "          url: 'pages/GamePage',",
    '          params: { importedPuzzle: importedBoard },',
    '        });',
    '      } else {',
    '        router.pushUrl({',
    '          url: "pages/GamePage",',
    '          params: { variantType: selected },',
    '        });',
    '      }',
    '    });',
    '  }',
    '}',
  ].join('\n');
  const siblings = [
    { start: 8, end: 11, callee: 'router.pushUrl', destination: 'pages/GamePage' },
    { start: 13, end: 16, callee: 'router.pushUrl', destination: 'pages/GamePage' },
  ];
  assert.deepEqual(findSiblingLiteralDispatches(source, { start: 18, end: 21 }), siblings);
  assert.deepEqual(findSiblingLiteralDispatches(source, { start: 19, end: 19 }), siblings);
  assert.deepEqual(findSiblingLiteralDispatches(source, { start: 4, end: 4 }), []);
  assert.deepEqual(findSiblingLiteralDispatches(source, { start: 8, end: 21 }), []);
});

test('literal dispatch discovery excludes lookalikes, ambiguous options and calls in other scopes', () => {
  const source = [
    'export function start(mode, data) {',
    '  if (data) {',
    "    // dispatch('generate', mode);",
    '    const lookalike = "dispatch(\'generate\', mode)";',
    "    handle(() => dispatch('generate', 'later'));",
    "    handle(() => { dispatch('generate', 'later'); });",
    "    handle({ run() { dispatch('generate', 'later'); } });",
    "    log('generate', mode);",
    "    dispatch({ route: 'generate', note: 'extra' }, mode);",
    "    dispatch({ route: 'generate', ...options }, mode);",
    "    dispatch({ differentProperty: 'generate' }, mode);",
    "    dispatch('generate' + suffix, data);",
    "    dispatch('generate', data);",
    '  } else {',
    "    dispatch('generate', mode);",
    '  }',
    '}',
    'function resume(previous) {',
    "  dispatch('generate', previous);",
    '}',
  ].join('\n');
  assert.deepEqual(findSiblingLiteralDispatches(source, { start: 15, end: 15 }), [
    { start: 13, end: 13, callee: 'dispatch', destination: 'generate' },
  ]);
  for (const line of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19])
    assert.deepEqual(findSiblingLiteralDispatches(source, { start: line, end: line }), []);
  const many = ["function start(value) {", "  dispatch('generate', value);",
    ...Array.from({ length: 5 }, (_, branch) => `  if (value === ${branch}) { dispatch('generate', value); }`),
    '}'].join('\n');
  assert.deepEqual(findSiblingLiteralDispatches(many, { start: 2, end: 2 }), [], 'an overfull group is not a partial witness');
});

test('detailed literal discovery distinguishes a bounded singleton from an unrecognized boundary', () => {
  const source = [
    'function submit(value) {',
    "  return dispatch('export', { value, options: { if: true, switch: false } });",
    '}',
  ].join('\n');
  assert.deepEqual(discoverSiblingLiteralDispatches(source, { start: 2, end: 2 }), {
    status: 'READY', complete: true, scope: 'SAME_LEXICAL_CALLABLE', reason: 'STATIC_LITERAL_GROUP', siblings: [],
    anchor: { start: 2, end: 2, callee: 'dispatch', destination: 'export' }, observedSiblingCount: 0,
  });
  assert.deepEqual(discoverSiblingLiteralDispatches(source, { start: 1, end: 1 }), {
    status: 'NOT_APPLICABLE', complete: false, scope: 'SAME_LEXICAL_CALLABLE',
    reason: 'NO_LITERAL_DISPATCH_AT_ANCHOR', siblings: [],
  });
  const alternatives = [
    'function submit(value) {',
    '  if (value.cached) {',
    "    return dispatch('export', value.cached);",
    '  }',
    "  return dispatch('export', value);",
    '}',
  ].join('\n');
  const observed = discoverSiblingLiteralDispatches(alternatives, { start: 5, end: 5 });
  assert.equal(observed.status, 'READY');
  assert.equal(observed.complete, true);
  assert.deepEqual(observed.siblings, [{ start: 3, end: 3, callee: 'dispatch', destination: 'export' }]);
});

test('detailed literal discovery keeps unsupported and truncated groups unknown', () => {
  const cases = [
    { source: 'function submit(route, value) {\n  return dispatch(route, value);\n}', line: 2, reason: 'UNSUPPORTED_ARGUMENT' },
    { source: 'function submit(options, value) {\n  return dispatch({ route: "export", ...options }, value);\n}', line: 2, reason: 'UNSUPPORTED_ARGUMENT' },
    { source: 'const submit = value => dispatch("export", value);', line: 1, reason: 'UNSUPPORTED_SCOPE' },
    { source: 'function submit(value) {\n  dispatch("export", value); dispatch("export", value.cached);\n}', line: 2, reason: 'AMBIGUOUS_ANCHOR' },
    { source: 'function submit(value) {\n  if (value.cached) { dispatch("export", value); dispatch("export", value.cached); }\n  dispatch("export", value);\n}', line: 3, reason: 'AMBIGUOUS_LINE_ANCHORS', count: 2 },
    { source: 'function submit(value) {\n  if (value.cached) return dispatch("export", value.cached);\n  return dispatch("export", value);\n}', line: 3, reason: 'UNSUPPORTED_BRANCH_SYNTAX' },
    { source: 'function submit(value) {\n  switch (value.kind) { case 1: return dispatch("export", value.cached); }\n  return dispatch("export", value);\n}', line: 3, reason: 'UNSUPPORTED_BRANCH_SYNTAX' },
    { source: 'function submit(value) {\n  return dispatch("export", value);\n}\n(', line: 2, reason: 'UNBALANCED_DELIMITERS' },
    { source: ' '.repeat(256 * 1024 + 1), line: 1, reason: 'SOURCE_LIMIT' },
    { source: 'return 1;', line: 0, reason: 'INVALID_INPUT' },
    { source: ['function submit(value) {', '  dispatch("export", value);',
      ...Array.from({ length: 5 }, (_, index) => `  if (value.kind === ${index}) { dispatch("export", value); }`),
      '}'].join('\n'), line: 2, reason: 'SIBLING_LIMIT', count: 5 },
  ];
  for (const { source, line, reason, count } of cases) {
    const result = discoverSiblingLiteralDispatches(source, { start: line, end: line });
    assert.equal(result.status, 'UNKNOWN', reason);
    assert.equal(result.complete, false, reason);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.siblings, [], 'unknown results never supply partial authoritative witnesses');
    if (count !== undefined) assert.equal(result.observedSiblingCount, count);
    assert.deepEqual(findSiblingLiteralDispatches(source, { start: line, end: line }), [], 'legacy unknown/overfull navigation remains empty');
  }
});

test('a dynamic alternate destination does not certify a partial static group', () => {
  const source = [
    'function submit(route, value) {',
    '  if (value.cached) {',
    '    return dispatch(route, value.cached);',
    '  }',
    '  if (value.saved) {',
    "    return dispatch('export', value.saved);",
    '  }',
    "  return dispatch('export', value);",
    '}',
  ].join('\n');
  const result = discoverSiblingLiteralDispatches(source, { start: 8, end: 8 });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.reason, 'UNRESOLVED_SIBLING');
  assert.equal(result.complete, false);
  assert.equal(result.observedSiblingCount, 1);
  assert.deepEqual(result.siblings, []);
  assert.deepEqual(findSiblingLiteralDispatches(source, { start: 8, end: 8 }), [
    { start: 6, end: 6, callee: 'dispatch', destination: 'export' },
  ], 'the compatibility API retains static-only navigation without a completeness claim');
});

test('primary file-selector discovery requires a matching literal or same-callee static peer', () => {
  const selectors = ['reports/Result'];
  for (const source of [
    'function transform(input) { return Number(input) + 1; }',
    'function transform(input) { return JSON.stringify(input); }',
    'function transform(input) { return Math.max(Number(input), 0); }',
    'function transform(input, flag) { if (flag) { return Number("0"); } return Number(input); }',
    'function transform(input, flag) { if (flag) { return normalize("0"); } return normalize(input); }',
  ]) assert.equal(discoverFileSelectorSiblingDispatches(source, { start: 1, end: 1 }, selectors).status, 'NOT_APPLICABLE');
  const source = [
    'function send(emit, packet, flag) {',
    '  if (flag) {',
    '    emit(packet);',
    '  } else {',
    '    emit({ view: "reports/Result", params: packet });',
    '  }',
    '}',
  ].join('\n');
  for (const [line, reason] of [[3, 'UNSUPPORTED_ARGUMENT'], [5, 'UNRESOLVED_SIBLING']]) {
    const result = discoverFileSelectorSiblingDispatches(source, { start: line, end: line }, selectors);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, reason);
    assert.deepEqual(result.siblings, []);
  }
  assert.equal(discoverFileSelectorSiblingDispatches(source, { start: 3, end: 3 }, ['other/Result']).status, 'NOT_APPLICABLE');
  const header = 'function send(emit, packet) { emit({ view: "reports/Result", params: packet }); console.info("ready"); }';
  assert.equal(discoverFileSelectorSiblingDispatches(header, { start: 1, end: 1 }, selectors).status, 'READY');
  assert.equal(discoverSiblingLiteralDispatches(header, { start: 1, end: 1 }).status, 'UNKNOWN', 'the existing unscoped API remains unchanged');
});

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

test('joins caller effects to dependency test arguments and preserves setup hook locations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-semantic-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'remote.ts': [
      'export class Remote {',
      '  static send(value: string) { return value.length > 0 }',
      '}',
    ],
    'journal.ts': ['export class Journal { static append(value: string) {} }'],
    'panel.ts': [
      "import { Remote } from './remote'",
      "import { Journal } from './journal'",
      'export class Panel {',
      '  static submit(value: string) {',
      '    if (!Remote.send(value)) return false',
      '    Journal.append(value)',
      '    return true',
      '  }',
      '}',
    ],
    'panel.test.ts': [
      "import { Remote } from './remote'",
      "import { Panel } from './panel'",
      'beforeEach(() => {',
      '  doubles.replace(Remote, Remote.send).returns(true)',
      '})',
      'afterEach(function () { doubles.restore(Remote, Remote.send) })',
      "it('stores a value', () => { Panel.submit('hello') })",
      'const onlyReference = Remote.send',
    ],
    'unrelated.test.ts': [
      'class Remote { static send() {} }',
      'beforeAll(() => { doubles.replace(Remote, Remote.send) })',
    ],
    'production.ts': [
      "import { Remote } from './remote'",
      'function setup() { return Remote.send }',
      'setup()',
    ],
  };
  await Promise.all(Object.entries(files).map(([file, lines]) => fs.writeFile(path.join(root, file), lines.join('\n'))));
  const graph = await buildSemanticGraph(root, { snapshotPaths: Object.keys(files), budgetMs: 5000 });
  const { testBoundaries } = graph.query({ operation: 'context', symbol: 'Panel.submit' });
  assert.equal(testBoundaries.length, 2, 'a plain reference and a shadowed class do not create test arguments');
  const boundary = testBoundaries.find(row => row.testArgument.within === 'beforeEach');
  assert.equal(boundary.caller.qualified, 'Panel.submit');
  assert.equal(boundary.call.target.symbol, 'Remote.send');
  assert.equal(boundary.call.line, 5);
  assert.deepEqual(boundary.testArgument.argumentTo, { symbol: 'doubles.replace', line: 4, argumentIndex: 1 });
  assert.deepEqual(boundary.testArgument.testScope,
    { path: 'panel.test.ts', symbol: 'beforeEach', kind: 'test-hook', line: 3, endLine: 5 });
  assert(boundary.laterSites.some(site => site.target.symbol === 'Journal.append' && site.line === 6));
  assert.equal(testBoundaries.find(row => row.testArgument.within === 'afterEach').testArgument.testScope.line, 6);
  const dependency = graph.query({ operation: 'incoming', symbol: 'Remote.send', file: 'remote.ts' });
  assert(dependency.testBoundaries.some(row => row.caller.qualified === 'Panel.submit'));
  const [impact] = graph.affectedSymbols([{ path: 'remote.ts', hunks: [[2, 2]] }]);
  assert(impact.testBoundaries.some(row => row.testArgument.testScope.symbol === 'beforeEach'
    && row.laterSites.some(site => site.target.symbol === 'Journal.append')),
  'a changed callee exposes the independently callable caller and its later effect to Stop');
  assert.equal(graph.query({ operation: 'outline', file: 'production.ts' }).hits.some(row => row.kind === 'test-hook'), false);
  assert.equal(graph.query({ operation: 'context', symbol: 'send' }).testBoundaries, undefined,
    'ambiguous definitions do not produce a guessed route');
  await fs.appendFile(path.join(root, 'panel.test.ts'), '\n' + Array.from({ length: 8 }, () =>
    'beforeEach(() => { doubles.replace(Remote, Remote.send) })').join('\n'));
  await fs.writeFile(path.join(root, 'other.ts'), [
    "import { Remote } from './remote'",
    'export class Other { static submit() { return Remote.send("hi") } }',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'other.test.ts'), [
    "import { Remote } from './remote'",
    "import { Other } from './other'",
    'beforeEach(() => { doubles.replace(Remote, Remote.send) })',
    "it('calls another entry', () => { Other.submit() })",
  ].join('\n'));
  const crowded = await buildSemanticGraph(root,
    { snapshotPaths: [...Object.keys(files), 'other.ts', 'other.test.ts'], budgetMs: 5000 });
  const routes = crowded.query({ operation: 'incoming', symbol: 'Remote.send', file: 'remote.ts' }).testBoundaries;
  assert.equal(routes.length, 6);
  assert(routes.some(row => row.caller.qualified === 'Panel.submit'));
  assert(routes.some(row => row.caller.qualified === 'Other.submit' && row.testArgument.path === 'other.test.ts'),
    'prefer tests exercising each caller and reserve space across callers instead of filling the result from one fixture');
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
