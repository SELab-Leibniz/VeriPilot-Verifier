import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function prepareArktsModelWorkspace({ task, outputRoot, cacheRoot,
  gitExecutable = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git' }) {
  const cache = path.join(cacheRoot, task.repo.replace('/', '--') + '.git'), projectRoot = path.join(outputRoot, 'project');
  const git = argv => execute(gitExecutable, ['-c', 'core.longpaths=true', ...argv], { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 180000 });
  await fs.mkdir(outputRoot, { recursive: false });
  await git(['--git-dir', cache, 'cat-file', '-e', `${task.base_commit}^{commit}`]);
  await git(['--git-dir', cache, 'worktree', 'add', '--detach', projectRoot, task.base_commit]);
  const json5 = createRequire(path.join(process.env.APPDATA, 'npm/node_modules/@deveco/deveco-cli/package.json'))('json5');
  const profilePath = path.join(projectRoot, 'build-profile.json5'), profile = json5.parse(await fs.readFile(profilePath, 'utf8'));
  profile.app.signingConfigs = [];
  for (const product of profile.app.products) { delete product.signingConfig; product.targetSdkVersion = '6.1.1(24)'; product.compatibleSdkVersion = '6.1.1(24)'; }
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2));
  // A preparation-only commit separates common environment changes from the
  // candidate patch. No test_patch or gold patch is installed in this tree.
  await git(['-C', projectRoot, 'add', 'build-profile.json5']);
  await git(['-C', projectRoot, '-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=nonexistent',
    'commit', '--quiet', '--allow-empty', '-m', 'Common API24 benchmark environment']);
  const preparedHead = (await git(['-C', projectRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  return { projectRoot, preparedHead, baseCommit: task.base_commit, environmentAdapted: true };
}
