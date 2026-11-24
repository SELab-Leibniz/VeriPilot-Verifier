import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readPluginSource } from '../lib/plugin-source.mjs';
import { hash, writeJson } from '../lib/files.mjs';

test('a plugin source receipt binds the exact package and omits unrelated private fields', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-source-')), archive = path.join(folder, 'runtime-corrector-ma-1.11.0.tgz');
  await fs.writeFile(archive, 'first 1.11.0 build');
  assert.equal(await readPluginSource(archive), null);
  await writeJson(archive + '.source.json', { schemaVersion: 'rc-experiment.plugin-source.v1', sourceCommit: 'a'.repeat(40),
    archiveSha256: hash(await fs.readFile(archive)), sourceBranch: 'fixture', apiKey: 'must not be propagated' });
  const source = await readPluginSource(archive);
  assert.equal(source.sourceCommit, 'a'.repeat(40)); assert.equal(source.apiKey, undefined);
  await fs.writeFile(archive, 'another build with the same version');
  await assert.rejects(() => readPluginSource(archive), /hash mismatch/);
});

test('an invalid source receipt fails rather than silently claiming a source version', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-source-invalid-')), archive = path.join(folder, 'plugin.tgz');
  await fs.writeFile(archive, 'archive');
  await writeJson(archive + '.source.json', { sourceCommit: 'unknown', archiveSha256: hash('archive') });
  await assert.rejects(() => readPluginSource(archive), /Invalid RC plugin source receipt/);
});
