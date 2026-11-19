import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareLiteWorkspace, collectLitePatch } from '../scripts/bench/swebench-lite-workspace.mjs';
const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })).stdout.trim();
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-lite-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'source with # space'); await fs.mkdir(repo);
  await git(repo, 'init'); await git(repo, 'config', 'user.name', 'Fictional Fixture');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(repo, 'main.py'), 'value = 1\n');
  await fs.writeFile(path.join(repo, 'guide.md'), 'Original business document.\n');
  await fs.writeFile(path.join(repo, 'data.bin'), Buffer.from([0, 1, 2, 255]));
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'fictional base');
  const base = await git(repo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'future-only.txt'), 'Fictional future content must never reach the agent.\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'fictional future');
  const future = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'tag', 'fictional-future-ref'); await git(repo, 'checkout', '--detach', base);
  return { root, repo, base, future };
}

test('base-only Git boundary preserves exact commit/tree while removing future refs and unreachable objects', async t => {
  const { repo, base, future } = await fixture(t);
  const tree = await git(repo, 'rev-parse', 'HEAD^{tree}');
  const result = await prepareLiteWorkspace({ projectRoot: repo, baseCommit: base });
  assert.equal(result.originalBaseAndTrackedBytesPreserved, true);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(repo, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.equal(await git(repo, 'rev-list', '--all', '--count'), '1');
  assert.equal(await git(repo, 'remote'), '');
  await assert.rejects(git(repo, 'cat-file', '-e', `${future}^{commit}`));
  assert.equal(await fs.readFile(path.join(repo, 'main.py'), 'utf8'), 'value = 1\n');
});

test('clean official-image-style non-base HEAD is checked out to public base before the object boundary', async t => {
  const { repo, base, future } = await fixture(t);
  await git(repo, 'checkout', '--detach', future);
  const result = await prepareLiteWorkspace({ projectRoot: repo, baseCommit: base });
  assert.equal(result.initialImageHeadDifferedFromTaskBase, true);
  assert.equal(result.publicBaseCheckoutPerformed, true);
  assert.equal(result.futureDiffRead, false);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(repo, 'rev-list', '--all', '--count'), '1');
  assert.equal(await fs.stat(path.join(repo, 'future-only.txt')).catch(() => null), null);
  await assert.rejects(git(repo, 'cat-file', '-e', `${future}^{commit}`));
});

test('unexpected dirty source, visible untracked material or known evaluator paths fail before Git replacement', async t => {
  const { root, repo, base, future } = await fixture(t);
  await fs.writeFile(path.join(repo, 'main.py'), 'changed\n');
  await assert.rejects(prepareLiteWorkspace({ projectRoot: repo, baseCommit: base }), { code: 'LITE_INITIAL_TRACKED_CONTENT_CHANGED' });
  await git(repo, 'checkout', '--', 'main.py');
  await fs.writeFile(path.join(repo, 'unexpected.txt'), 'fictional material');
  await assert.rejects(prepareLiteWorkspace({ projectRoot: repo, baseCommit: base }), { code: 'LITE_INITIAL_UNTRACKED_CONTENT_REQUIRES_QUALIFICATION' });
  await fs.unlink(path.join(repo, 'unexpected.txt'));
  const grader = path.join(root, 'fictional-private-grader.sh'); await fs.writeFile(grader, 'not read by the boundary');
  await assert.rejects(prepareLiteWorkspace({ projectRoot: repo, baseCommit: base, forbiddenPaths: [grader] }), { code: 'LITE_PRIVATE_GRADER_ARTIFACT_PRESENT' });
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(repo, 'cat-file', '-t', future), 'commit');
});

test('actual exported patch applies staged/unstaged/new/binary/doc changes, excludes RC metadata and preserves original index', async t => {
  const { root, repo, base } = await fixture(t);
  await prepareLiteWorkspace({ projectRoot: repo, baseCommit: base });
  await fs.writeFile(path.join(repo, 'main.py'), 'value = 2\n'); await git(repo, 'add', 'main.py');
  await fs.appendFile(path.join(repo, 'main.py'), 'other = True\n');
  await fs.writeFile(path.join(repo, 'guide.md'), 'Updated business document.\n');
  await fs.writeFile(path.join(repo, 'data.bin'), Buffer.from([0, 8, 7, 255, 128]));
  const newName = process.platform === 'win32' ? 'new file with 空格.py' : 'new file\nwith newline.py';
  await fs.writeFile(path.join(repo, newName), 'new_value = 3\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'explicitly-staged.txt\n');
  await fs.writeFile(path.join(repo, 'explicitly-staged.txt'), 'Included because business explicitly staged it.\n');
  await git(repo, 'add', '-f', 'explicitly-staged.txt');
  await fs.mkdir(path.join(repo, '.runtime-corrector')); await fs.writeFile(path.join(repo, '.runtime-corrector/config.yaml'), 'private operational metadata');
  await fs.mkdir(path.join(repo, '.runtime-correction')); await fs.writeFile(path.join(repo, '.runtime-correction/transcript.json'), 'fictional transcript');
  await git(repo, 'add', '-f', '.runtime-corrector/config.yaml');
  const index = await fs.readFile(path.join(repo, '.git/index'));
  const result = await collectLitePatch({ projectRoot: repo, baseCommit: base });
  assert.deepEqual(await fs.readFile(path.join(repo, '.git/index')), index);
  assert.equal(result.metadata.automaticCommit, false);
  assert(!result.patch.includes('.runtime-corrector') && !result.patch.includes('.runtime-correction'));
  const target = path.join(root, 'apply-target'); await fs.mkdir(target); await git(target, 'init');
  await git(target, 'fetch', '--depth=1', repo, base); await git(target, 'checkout', '--detach', 'FETCH_HEAD');
  const patchFile = path.join(root, 'candidate.diff'); await fs.writeFile(patchFile, result.patch);
  await git(target, 'apply', '--binary', patchFile);
  for (const name of ['main.py', 'guide.md', 'data.bin', newName, 'explicitly-staged.txt'])
    assert.deepEqual(await fs.readFile(path.join(target, name)), await fs.readFile(path.join(repo, name)));
});

test('collector compares with frozen base even when business agent committed; clean no-op stays an empty official patch', async t => {
  const { repo, base } = await fixture(t);
  await prepareLiteWorkspace({ projectRoot: repo, baseCommit: base });
  assert.equal((await collectLitePatch({ projectRoot: repo, baseCommit: base })).patch, '');
  await git(repo, 'config', 'user.name', 'Fictional Agent'); await git(repo, 'config', 'user.email', 'agent@example.invalid');
  await fs.writeFile(path.join(repo, 'main.py'), 'value = 4\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'actual business change');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const result = await collectLitePatch({ projectRoot: repo, baseCommit: base });
  assert(result.patch.includes('+value = 4')); assert.equal(await git(repo, 'rev-parse', 'HEAD'), head);
});

test('ignored RC metadata does not turn a valid business patch into git add failure', async t => {
  const { repo, base } = await fixture(t);
  await prepareLiteWorkspace({ projectRoot: repo, baseCommit: base });
  await fs.mkdir(path.join(repo, '.git/info'), { recursive: true });
  await fs.writeFile(path.join(repo, '.git/info/exclude'), '.runtime-corrector/\n.runtime-correction/\n');
  for (const name of ['.runtime-corrector', '.runtime-correction']) {
    await fs.mkdir(path.join(repo, name));
    await fs.writeFile(path.join(repo, name, 'operational.json'), '{"fictional":true}\n');
  }
  await fs.writeFile(path.join(repo, 'main.py'), 'value = 9\n');
  const index = await fs.readFile(path.join(repo, '.git/index'));
  const result = await collectLitePatch({ projectRoot: repo, baseCommit: base });
  assert(result.patch.includes('+value = 9'));
  assert(!result.patch.includes('.runtime-corrector') && !result.patch.includes('.runtime-correction'));
  assert.deepEqual(await fs.readFile(path.join(repo, '.git/index')), index);
});

test('copied index stat timestamps cannot hide an equal-size business edit', async t => {
  const { root, repo, base } = await fixture(t);
  await prepareLiteWorkspace({ projectRoot: repo, baseCommit: base });
  // A legitimate coarse-stat configuration makes the alias deterministic;
  // the original index's racy timestamp still detects the changed content.
  await git(repo, 'config', 'core.checkStat', 'minimal');
  await git(repo, 'config', 'core.trustctime', 'false');
  const file = path.join(repo, 'main.py'), indexFile = path.join(repo, '.git/index');
  const aliasedTime = new Date(1000000000000);
  await fs.utimes(file, aliasedTime, aliasedTime);
  await git(repo, 'update-index', '--refresh');
  await fs.utimes(indexFile, aliasedTime, aliasedTime);
  await fs.writeFile(file, 'value = 9\n');
  await fs.utimes(file, aliasedTime, aliasedTime);
  const index = await fs.readFile(indexFile), indexTime = (await fs.stat(indexFile)).mtimeMs;
  assert.equal((await fs.stat(file)).mtimeMs, indexTime);
  assert((await git(repo, '--no-optional-locks', 'diff', '--', 'main.py')).includes('+value = 9'));
  assert.deepEqual(await fs.readFile(indexFile), index);
  const result = await collectLitePatch({ projectRoot: repo, baseCommit: base });
  assert(result.patch.includes('+value = 9'));
  assert.deepEqual(await fs.readFile(indexFile), index);
  assert.equal((await fs.stat(indexFile)).mtimeMs, indexTime);
  const target = path.join(root, 'apply-racy-target'); await fs.mkdir(target); await git(target, 'init');
  await git(target, 'fetch', '--depth=1', repo, base); await git(target, 'checkout', '--detach', 'FETCH_HEAD');
  const patchFile = path.join(root, 'racy-candidate.diff'); await fs.writeFile(patchFile, result.patch);
  await git(target, 'apply', '--binary', patchFile);
  assert.deepEqual(await fs.readFile(path.join(target, 'main.py')), await fs.readFile(file));
});
