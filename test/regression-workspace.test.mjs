import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { prepareRegressionWorkspace } from '../scripts/bench/regression-workspace.mjs';
import { createTaskEvidence } from '../lib/review-task/task-evidence.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-regression-isolation-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, 'project');
  await fs.mkdir(path.join(source, 'entry/src/test'), { recursive: true });
  await fs.writeFile(path.join(source, 'entry/src/test/widget.test.ets'), 'assert(widget.value === 7)\n');
  await fs.writeFile(path.join(source, 'new-public-source.ets'), 'export const widget = { value: 7 }\n');
  await fs.mkdir(path.join(source, '.hvigor'));
  await fs.writeFile(path.join(source, '.hvigor/old.log'), 'old output\n');
  return { root, source };
}

test('regression snapshot preserves current public tests and untracked source, without old outputs', async t => {
  const f = await fixture(t);
  for (const dir of ['.runtime-correction', '.runtime-corrector', 'oh_modules', 'node_modules', '.test']) {
    await fs.mkdir(path.join(f.source, dir)); await fs.writeFile(path.join(f.source, dir, 'old.txt'), 'old');
  }
  const copy = await prepareRegressionWorkspace(f.source);
  assert.equal(path.dirname(copy), f.root);
  assert.equal(await fs.readFile(path.join(copy, 'entry/src/test/widget.test.ets'), 'utf8'), 'assert(widget.value === 7)\n');
  assert.equal(await fs.readFile(path.join(copy, 'new-public-source.ets'), 'utf8'), 'export const widget = { value: 7 }\n');
  for (const dir of ['.hvigor', '.runtime-correction', '.runtime-corrector', 'oh_modules', 'node_modules', '.test'])
    await assert.rejects(fs.access(path.join(copy, dir)), { code: 'ENOENT' });
});

test('toolchain writes in the snapshot leave a previously searched source inventory valid', async t => {
  const f = await fixture(t);
  const evidence = await createTaskEvidence({ root: f.root, workspaceRoot: f.source, active() {}, journal: { appendMessage() {} } });
  await evidence.tools.find(tool => tool.name === 'source_find').execute('observe', { path: '.', pattern: 'not-present', includeGenerated: true });
  const copy = await prepareRegressionWorkspace(f.source);
  await fs.mkdir(path.join(copy, '.hvigor'));
  await fs.writeFile(path.join(copy, '.hvigor/new-build.log'), 'new output');
  await evidence.assertFrozen();
  await fs.writeFile(path.join(f.source, '.hvigor/in-place-build.log'), 'mutates evidence');
  await assert.rejects(evidence.assertFrozen(), error => error.code === 'BASELINE_INPUT_CHANGED');
});

test('original test mode restores only the baseline test sources over current production code', async t => {
  const { source } = await fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: source, encoding: 'utf8', windowsHide: true });
  const testFile = 'entry/src/test/widget.test.ets', production = 'new-public-source.ets';
  git('init', '-q'); git('add', '--', testFile, production); git('commit', '-qm', 'original');
  const originalTestCommit = git('rev-parse', 'HEAD').trim();
  await fs.writeFile(path.join(source, testFile), 'assert(widget.value === 8)\n');
  await fs.writeFile(path.join(source, production), 'export const widget = { value: 8 }\n');
  await fs.writeFile(path.join(source, 'entry/src/test/new.test.ets'), 'new candidate test\n');
  const copy = await prepareRegressionWorkspace(source, { originalTestCommit });
  assert.equal((await fs.readFile(path.join(copy, testFile), 'utf8')).replaceAll('\r\n', '\n'), 'assert(widget.value === 7)\n');
  assert.equal(await fs.readFile(path.join(copy, production), 'utf8'), 'export const widget = { value: 8 }\n');
  await assert.rejects(fs.access(path.join(copy, 'entry/src/test/new.test.ets')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(source, testFile), 'utf8'), 'assert(widget.value === 8)\n');
});
