import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyFrozenArtifact } from '../scripts/bench/frozen-artifact-verification.mjs';
const gitExecutable = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
let root, commit;
const files = { 'lib/权限.mjs': 'export const text = "实际内容";\n', 'a file.txt': 'first\nsecond\n' };
const git = args => execFileSync(gitExecutable, args, { cwd: root, windowsHide: true, encoding: 'utf8' });
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frozen-verify-'));
  await fs.mkdir(path.join(root, 'packaging')); await fs.mkdir(path.join(root, 'lib'));
  for (const [name, value] of Object.entries(files)) await fs.writeFile(path.join(root, name), value);
  await fs.writeFile(path.join(root, 'packaging/runtime-modules.json'), JSON.stringify({ common: Object.keys(files), openclaw: [] }));
  git(['init', '--quiet']); git(['-c', 'core.autocrlf=false', 'add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'Fixture']);
  commit = git(['rev-parse', 'HEAD']).trim();
});
after(async () => {
  if (!path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'rc-frozen-verify-'))) throw new Error('Unsafe fixture cleanup path');
  await fs.rm(root, { recursive: true, force: true });
});
async function artifact() {
  const directory = await fs.mkdtemp(path.join(root, 'artifact-')); await fs.mkdir(path.join(directory, 'lib'));
  for (const [name, value] of Object.entries(files)) await fs.writeFile(path.join(directory, name), value.replaceAll('\n', '\r\n'));
  return directory;
}
test('batch verification preserves UTF-8, space-containing paths and CRLF equivalence', async () => {
  const directory = await artifact();
  const result = await verifyFrozenArtifact({ gitExecutable, cwd: root, reference: commit, artifact: directory });
  assert.equal(result.gitProcesses, 3); assert.equal(result.baselineCommit, commit);
  assert.deepEqual(result.checks, await Promise.all(Object.keys(files).map(async file => ({ file,
    actualSha256: createHash('sha256').update(await fs.readFile(path.join(directory, file), 'utf8')).digest('hex') }))));
});
test('a modified package is rejected on the next verification, never accepted from a prior cache', async () => {
  const directory = await artifact(), params = { gitExecutable, cwd: root, reference: commit, artifact: directory };
  await verifyFrozenArtifact(params);
  await fs.writeFile(path.join(directory, 'lib/权限.mjs'), 'changed');
  await assert.rejects(verifyFrozenArtifact(params), /differs from baseline: lib\/权限.mjs/u);
});
test('missing package files and missing references fail closed', async () => {
  const directory = await artifact(); await fs.unlink(path.join(directory, 'a file.txt'));
  await assert.rejects(verifyFrozenArtifact({ gitExecutable, cwd: root, reference: commit, artifact: directory }), { code: 'ENOENT' });
  await assert.rejects(verifyFrozenArtifact({ gitExecutable, cwd: root, reference: 'missing-reference', artifact: directory }));
});
