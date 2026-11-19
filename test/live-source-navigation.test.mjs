import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLiveSourceTools } from '../lib/review-task/live-source-tools.mjs';
import { toolText, createSourceTools } from '../lib/review-task/source-tools.mjs';
import { captureFiles } from '../lib/review-task/evidence-utils.mjs';
import { validateJsonSchema } from '../lib/json-schema-validator.mjs';

test('live source_read accepts the numbered option required by original-basis instructions', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-numbered-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'original.txt'), 'first\nsecond\n');
  const tool = createLiveSourceTools(root).find(tool => tool.name === 'read');
  const args = { path: 'original.txt', numbered: true, limit: 1 };
  assert.deepEqual(validateJsonSchema(args, tool.parameters), []);
  const result = await tool.execute('numbered', args);
  assert.match(toolText(result), /^\[1\] first\n/u);
  assert.equal(result.details.page.start, 1);
  assert.equal(result.details.page.end, 1);
  assert.equal(result.details.page.nextOffset, 2);
  assert.equal(result.details.page.numbered, true);
  assert(validateJsonSchema({ ...args, numbered: 'true' }, tool.parameters).length);
});

test('broad navigation omits caches but preserves project build sources and explicit cache access', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-nav-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ['src/main.ets', 'build/entry.ts', 'target/manual.py', 'vendor/adapter.js',
    '.hvigor/cache.ets', 'oh_modules/dependency.ets', '.test/generated.ets', '.venv/lib.py', '__pycache__/cached.py'];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), 'needle\n');
  }
  const observed = [];
  const tools = new Map(createLiveSourceTools(root, { onSearchFile: file => observed.push(path.relative(root, file).replaceAll('\\', '/')) }).map(t => [t.name, t]));
  const call = async (name, args) => JSON.parse(toolText(await tools.get(name).execute('id', args)));
  const first = await call('grep', { pattern: 'needle', limit: 2 });
  assert.equal(first.nextOffset, 2);
  const second = await call('grep', { pattern: 'needle', limit: 2, offset: first.nextOffset });
  assert.equal(second.nextOffset, null);
  assert.equal(first.hits.length + second.hits.length, 4);
  assert.deepEqual([...new Set(observed)].sort(), files.slice(0, 4).sort());
  assert.equal(first.navigationOnly, true);
  assert.equal((await call('grep', { pattern: 'needle', includeGenerated: true })).hits.length, files.length);
  assert.equal((await call('grep', { path: 'oh_modules', pattern: 'needle' })).hits.length, 1);
  assert.match(toolText(await tools.get('read').execute('read', { path: '.hvigor/cache.ets' })), /needle/);
});

test('navigation checks original paths, rereads changes, and honors cancellation', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-fresh-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'main.ts'); await fs.writeFile(file, 'before\n');
  const observations = [], paths = [];
  const tools = new Map(createLiveSourceTools(root, {
    onPath(requested, real) { paths.push([requested, real]); },
    onSearchFile(_file, bytes) { observations.push(bytes.toString()); },
  }).map(t => [t.name, t]));
  await tools.get('grep').execute('first', { pattern: 'before' });
  await fs.writeFile(file, 'after\n');
  const changed = JSON.parse(toolText(await tools.get('grep').execute('second', { pattern: 'after' })));
  assert.equal(changed.hits.length, 1);
  assert.deepEqual(observations, ['before\n', 'after\n']);
  assert(paths.some(([requested, real]) => requested === file && real === file));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.get('find').execute('cancelled', { pattern: 'main' }, controller.signal), { name: 'AbortError' });
});

test('live and frozen find explain wildcard misses without silently changing literal semantics', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-literal-find-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.ets'), 'original NEEDLE_IN_CONTENT\n');
  for (const tools of [createLiveSourceTools(root), createSourceTools(root, await captureFiles(root))]) {
    const find = tools.find(tool => tool.name === 'find');
    const missing = JSON.parse(toolText(await find.execute('wildcard', { pattern: '*.ets' })));
    assert.deepEqual(missing.hits, []); assert.match(missing.hint, /literal path fragments/);
    assert.equal(missing.navigationOnly, true);
    const found = JSON.parse(toolText(await find.execute('literal', { pattern: 'main.ets' })));
    assert.equal(found.hits.length, 1); assert.equal(found.hint, undefined);
    const symbol = JSON.parse(toolText(await find.execute('symbol', { pattern: 'NEEDLE_IN_CONTENT' })));
    assert.equal(symbol.hits.length, 0); assert.match(symbol.hint, /use grep/);
    const grep = tools.find(tool => tool.name === 'grep');
    assert.equal(JSON.parse(toolText(await grep.execute('contents', { pattern: 'NEEDLE_IN_CONTENT' }))).hits.length, 1);
    const end = JSON.parse(toolText(await find.execute('end', { pattern: 'NEEDLE_IN_CONTENT', offset: 1 })));
    assert.equal(end.hint, undefined);
  }
});

test('frozen navigation canonicalizes its selected root and retains traversal and link bounds', async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frozen-scope-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project'), outside = path.join(parent, 'outside'), alias = path.join(parent, 'alias');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'source.txt'), 'inside\n');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n');
  const tools = new Map(createSourceTools(root, await captureFiles(root)).map(tool => [tool.name, tool]));
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = new Map(createSourceTools(alias, await captureFiles(root)).map(tool => [tool.name, tool]));
  assert.deepEqual(JSON.parse(toolText(await aliased.get('ls').execute('list', {}))).hits, ['source.txt']);
  assert.match(toolText(await aliased.get('read').execute('read', { path: 'source.txt' })), /inside/u);
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const selected of [tools, aliased]) {
    for (const name of ['read', 'ls', 'find', 'grep']) for (const target of ['../outside/secret.txt', 'escape/secret.txt'])
      await assert.rejects(selected.get(name).execute('outside', { path: target, pattern: 'outside' }), /outside snapshot/u);
  }
});

test('recursive entry budget reports an incomplete miss and preserves direct and narrowed external access', async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-budget-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project'); await fs.mkdir(root);
  for (const file of ['a.ts', 'b.ts', 'c.ts', 'z.ts']) await fs.writeFile(path.join(parent, file), file === 'z.ts' ? 'needle\n' : 'other\n');
  const tools = new Map(createLiveSourceTools(root, { navigationBudget: { entries: 3, bytes: 1024 } }).map(tool => [tool.name, tool]));
  const partial = JSON.parse(toolText(await tools.get('grep').execute('broad', { path: '..', pattern: 'needle' })));
  assert.deepEqual(partial.hits, []);
  assert.equal(partial.scanIncomplete, true);
  assert.equal(partial.scanned.entries, 3);
  assert.equal(partial.nextOffset, null);
  assert.match(partial.hint, /incomplete.*Narrow/s);
  assert.match(toolText(await tools.get('read').execute('known', { path: '../z.ts' })), /needle/);
  const narrow = JSON.parse(toolText(await tools.get('grep').execute('narrow', { path: '../z.ts', pattern: 'needle' })));
  assert.equal(narrow.hits.length, 1);
  assert.equal(narrow.scanIncomplete, undefined);
});

test('recursive byte and empty-directory budgets bound scans without manufacturing search completeness', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-byte-budget-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.ts'), '12345678');
  await fs.writeFile(path.join(root, 'b.ts'), 'needle');
  const grep = createLiveSourceTools(root, { navigationBudget: { entries: 100, bytes: 8 } }).find(tool => tool.name === 'grep');
  const partial = JSON.parse(toolText(await grep.execute('bytes', { pattern: 'needle' })));
  assert.equal(partial.scanIncomplete, true);
  assert.equal(partial.scanned.bytes, 8);
  assert.deepEqual(partial.hits, []);
  const narrowed = JSON.parse(toolText(await grep.execute('one-file', { path: 'b.ts', pattern: 'needle' })));
  assert.equal(narrowed.hits.length, 1);
  const directories = path.join(root, 'directories'); await fs.mkdir(directories);
  for (let i = 0; i < 6; i++) await fs.mkdir(path.join(directories, String(i)));
  const find = createLiveSourceTools(root, { navigationBudget: { entries: 3, bytes: 8 } }).find(tool => tool.name === 'find');
  const empty = JSON.parse(toolText(await find.execute('empty-dirs', { path: directories, pattern: 'not-present' })));
  assert.equal(empty.scanIncomplete, true);
  assert.equal(empty.scanned.entries, 3);
  assert.deepEqual(empty.hits, []);
});
