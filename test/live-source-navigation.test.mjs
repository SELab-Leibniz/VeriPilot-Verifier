import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLiveSourceTools } from '../lib/review-task/live-source-tools.mjs';
import { toolText } from '../lib/review-task/source-tools.mjs';

test('broad navigation omits caches but preserves project build sources and explicit cache access', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-nav-'));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-live-fresh-'));
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
