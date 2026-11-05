import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadArktsTask } from './arkts-dataset.mjs';

const git = argv => execFileSync('git', ['-c', 'core.longpaths=true', ...argv], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const exists = file => fs.stat(file).then(() => true, () => false);
// Seeds a fresh run root from an old one without writing to it: each bare cache
// is mirrored, the frozen commits (referenced only by old detached worktrees, so
// a mirror of the shallow cache omits them) are fetched by id and pinned by ref,
// and the pinned workflow directory is copied. Existing targets are kept.
export async function seedReleaseRoot({ from, root, frozen = [], dataset, label = 'seed' }) {
  const source = path.resolve(from), target = path.resolve(root);
  assert.notEqual(source.toLowerCase(), target.toLowerCase(), '--seed-from must be a different run root');
  const record = { from: source, caches: [], pinned: [], workflow: false };
  await fs.mkdir(path.join(target, 'cache'), { recursive: true });
  for (const entry of await fs.readdir(path.join(source, 'cache'), { withFileTypes: true })) {
    const cache = path.join(target, 'cache', entry.name);
    if (!entry.isDirectory() || !entry.name.endsWith('.git') || await exists(cache)) continue;
    git(['clone', '--mirror', '--no-hardlinks', '--quiet', path.join(source, 'cache', entry.name), cache]);
    record.caches.push(entry.name);
  }
  for (const sample of frozen) {
    const { task } = await loadArktsTask(dataset, sample.case), freeze = JSON.parse(await fs.readFile(path.join(sample.root, 'freeze.json'), 'utf8'));
    const name = `${task.repo.replace('/', '--')}.git`, cache = path.join(target, 'cache', name);
    for (const commit of [freeze.preparedHead, freeze.commit]) {
      assert.match(commit, /^[0-9a-f]{40}$/u);
      git(['--git-dir', cache, 'fetch', '--quiet', '--no-tags', '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack',
        path.join(source, 'cache', name), `+${commit}:refs/rc-bench/frozen/${commit}`]);
      git(['--git-dir', cache, 'cat-file', '-e', `${commit}^{commit}`]);
      record.pinned.push({ sample: sample.id, commit });
    }
  }
  if (await exists(path.join(source, 'workflow')) && !await exists(path.join(target, 'workflow'))) {
    await fs.cp(path.join(source, 'workflow'), path.join(target, 'workflow'), { recursive: true, errorOnExist: true, force: false });
    record.workflow = true;
  }
  await fs.writeFile(path.join(target, `${label}-${Date.now()}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record;
}
