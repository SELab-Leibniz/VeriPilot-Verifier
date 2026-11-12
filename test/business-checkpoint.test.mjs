import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureBusinessCheckpoint } from '../scripts/bench/business-checkpoint.mjs';

test('checkpoint includes new source and modified assertions without changing the live index or private state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-checkpoint-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, 'project'); await fs.mkdir(projectRoot);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot, windowsHide: true, encoding: 'utf8' });
  await fs.writeFile(path.join(projectRoot, 'main.ets'), 'old\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  const preparedHead = git('rev-parse', 'HEAD').trim();
  await fs.writeFile(path.join(projectRoot, 'main.ets'), 'changed\n');
  await fs.writeFile(path.join(projectRoot, 'new.ets'), 'new source\n');
  await fs.mkdir(path.join(projectRoot, '.runtime-corrector'));
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector', 'private.json'), 'private');
  const indexBefore = await fs.readFile(path.join(projectRoot, '.git/index'));
  const receipt = await captureBusinessCheckpoint({ projectRoot, preparedHead, outputRoot: root, runId: 'run', stopReason: 'stop' });
  assert.deepEqual(receipt.paths, ['main.ets', 'new.ets']);
  assert.match(await fs.readFile(path.join(receipt.directory, 'candidate.patch'), 'utf8'), /new source/u);
  assert.deepEqual(await fs.readFile(path.join(projectRoot, '.git/index')), indexBefore);
  assert.equal(git('rev-parse', 'HEAD').trim(), preparedHead);
});
