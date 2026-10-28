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
  await assert.rejects(nav.execute('escape', { action: 'ls', path: '..' }), /Outside benchmark workspace/);
  assert.equal(factories[1]({ sessionKey: 'agent:main:business' }).name, 'bench_check');
});
