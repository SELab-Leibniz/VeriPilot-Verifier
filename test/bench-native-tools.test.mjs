import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createArktsBenchTools } from '../scripts/bench/native-arkts-tools.mjs';

test('generated business tools load, confine navigation, and remain absent from private workers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-bench-generated-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project); await fs.writeFile(path.join(project, 'main.ets'), 'needle\n');
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: project, toolRoot: root, stableNavigationRoot: process.cwd() });
  const factories = [];
  (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({ registerTool: factory => factories.push(factory) });
  assert.equal(factories.length, 2);
  assert(factories.every(factory => factory({ sessionKey: 'agent:main:runtime-corrector:private' }) === null));
  const nav = factories[0]({ sessionKey: 'agent:main:business' });
  const result = await nav.execute('nav', { action: 'grep', pattern: 'needle' });
  assert.equal(JSON.parse(result.content[0].text).hits.length, 1);
  const alternatives = JSON.parse((await nav.execute('literal', { action: 'grep', pattern: 'needle|absent' })).content[0].text);
  assert.deepEqual(alternatives.hits, []); assert.match(alternatives.hint, /pipe character is not OR/);
  await fs.writeFile(path.join(project, 'literal.ets'), 'literal|pipe\n');
  const actualPipe = JSON.parse((await nav.execute('pipe', { action: 'grep', pattern: 'literal|pipe' })).content[0].text);
  assert.equal(actualPipe.hits.length, 1); assert.equal(actualPipe.hint, undefined);
  await assert.rejects(nav.execute('escape', { action: 'ls', path: '..' }), /Outside benchmark workspace/);
  assert.equal(factories[1]({ sessionKey: 'agent:main:business' }).name, 'bench_check');
});

test('optional business reads bound every page while retaining all UTF-8 lines and path confinement', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-bench-paged-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const lines = Array.from({ length: 633 }, (_, i) => `第 ${i + 1} 行`);
  await fs.writeFile(path.join(project, 'large.ets'), lines.join('\n'));
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: project, toolRoot: root,
    stableNavigationRoot: process.cwd(), pagedReads: true });
  const manifest = JSON.parse(await fs.readFile(path.join(plugin.path, 'openclaw.plugin.json')));
  assert(manifest.contracts.tools.includes('bench_read'));
  const factories = [];
  (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({ registerTool: factory => factories.push(factory) });
  assert(factories.every(factory => factory({ sessionKey: 'agent:main:runtime-corrector:private' }) === null));
  const read = factories.map(factory => factory({ sessionKey: 'agent:main:business' })).find(tool => tool.name === 'bench_read');
  let offset = 1; const observed = [];
  while (offset !== null) {
    const result = await read.execute('page', { path: 'large.ets', offset });
    const text = result.content.map(block => block.text).join('');
    const page = result.details.page;
    assert(page.end - page.start + 1 <= 120);
    observed.push(...text.split('\n[RC page ')[0].split('\n'));
    offset = page.nextOffset;
  }
  assert.deepEqual(observed, lines);
  await assert.rejects(read.execute('oversized', { path: 'large.ets', limit: 2000 }), /1 to 250/);
  await assert.rejects(read.execute('escape', { path: '../outside.ets' }), /ENOENT|Outside benchmark workspace/);
  await fs.writeFile(path.join(root, 'outside.ets'), 'outside');
  await assert.rejects(read.execute('escape-existing', { path: '../outside.ets' }), /Outside benchmark workspace/);
});
