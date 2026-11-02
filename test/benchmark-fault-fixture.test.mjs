import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createBenchmarkFaultFixture } from '../scripts/helpers/benchmark-fault-fixture.mjs';

async function fixture(t, spec = { path: 'diff.go', before: 'good comparison', after: 'always equal' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark-fault-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), outputRoot = path.join(root, 'output');
  await fs.mkdir(projectRoot); await fs.mkdir(outputRoot);
  const git = (...args) => execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(projectRoot, 'diff.go'), 'good comparison\n');
  git('add', '.'); git('commit', '-qm', 'completed real delivery');
  const head = git('rev-parse', 'HEAD'), specFile = path.join(root, 'spec.json');
  await fs.writeFile(specFile, JSON.stringify(spec));
  const extra = await createBenchmarkFaultFixture({ projectRoot, outputRoot, specFile });
  const plugin = (await import(pathToFileURL(path.join(extra.path, 'index.mjs')).href)).default;
  let hook;
  plugin.register({ on(name, callback) { assert.equal(name, 'before_agent_finalize'); hook = callback; } });
  await fs.writeFile(path.join(outputRoot, 'fault-target.json'), JSON.stringify({ runId: 'original', baseCommit: head }));
  return { root, projectRoot, outputRoot, git, head, hook, specFile };
}

test('fault commits once at the exact original finalization and retains the good delivery', async t => {
  const f = await fixture(t), ctx = { workspaceDir: f.projectRoot };
  await f.hook({ runId: 'private-review' }, ctx);
  await f.hook({ runId: 'original' }, { workspaceDir: f.outputRoot });
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  await fs.mkdir(path.join(f.projectRoot, '.openclaw'));
  await fs.writeFile(path.join(f.projectRoot, '.openclaw', 'scratch.log'), 'diagnostics');
  await f.hook({ runId: 'original' }, ctx);
  const receipt = JSON.parse(await fs.readFile(path.join(f.outputRoot, 'fault-injection.json')));
  assert.equal(receipt.beforeHead, f.head);
  assert.notEqual(receipt.afterHead, f.head);
  assert.equal(f.git('show', 'HEAD:diff.go'), 'always equal');
  assert.equal(f.git('show', `${f.head}:diff.go`), 'good comparison');
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(await fs.readFile(path.join(f.projectRoot, '.openclaw', 'scratch.log'), 'utf8'), 'diagnostics');
  await fs.writeFile(path.join(f.projectRoot, 'diff.go'), 'repaired comparison\n');
  await f.hook({ runId: 'original' }, ctx);
  assert.equal(await fs.readFile(path.join(f.projectRoot, 'diff.go'), 'utf8'), 'repaired comparison\n');
});

test('uncommitted or changed delivery is rejected without corruption', async t => {
  const f = await fixture(t), file = path.join(f.projectRoot, 'diff.go');
  await fs.writeFile(file, 'good comparison\nnot committed\n');
  await assert.rejects(f.hook({ runId: 'original' }, { workspaceDir: f.projectRoot }), /must be committed/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  await fs.writeFile(file, 'different implementation\n');
  await assert.rejects(f.hook({ runId: 'original' }, { workspaceDir: f.projectRoot }), /exactly once/);
  assert.equal(await fs.readFile(file, 'utf8'), 'different implementation\n');
});

test('fault cannot escape the isolated benchmark through traversal or a symlink', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside.go');
  await fs.writeFile(outside, 'good comparison\n');
  await fs.writeFile(f.specFile, JSON.stringify({ path: '../outside.go', before: 'good', after: 'bad' }));
  await assert.rejects(createBenchmarkFaultFixture({ ...f, specFile: f.specFile }), /Invalid/);
  await fs.rm(path.join(f.projectRoot, 'diff.go'));
  await fs.symlink(outside, path.join(f.projectRoot, 'diff.go'));
  await assert.rejects(f.hook({ runId: 'original' }, { workspaceDir: f.projectRoot }), /escapes/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'good comparison\n');
});

test('a declaration pattern accepts a changed committed implementation but rejects ambiguity', async t => {
  const f = await fixture(t, { path: 'diff.go', beforePattern: '^good [^\\n]+', after: 'always equal' });
  const file = path.join(f.projectRoot, 'diff.go');
  await fs.writeFile(file, 'good newer comparison\ngood another comparison\n');
  f.git('add', '.'); f.git('commit', '-qm', 'ambiguous declarations');
  await assert.rejects(f.hook({ runId: 'original' }, { workspaceDir: f.projectRoot }), /exactly once/);
  await fs.writeFile(file, 'good newer comparison\n');
  f.git('add', '.'); f.git('commit', '-qm', 'new implementation');
  await f.hook({ runId: 'original' }, { workspaceDir: f.projectRoot });
  assert.equal(await fs.readFile(file, 'utf8'), 'always equal\n');
});
