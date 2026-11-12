import path from 'node:path';
import { createHash } from 'node:crypto';
// Native ArkTS caches use deep internal paths. Keep physical worktrees short;
// long, descriptive experiment names belong in the separate result directory.
// Source objects remain in one shared Git cache, with no repository copies.
export function shortArktsWorkspace(outputRoot, kind, repositoryRoot = process.cwd(), workspaceRoot) {
  if (!/^[a-z]{1,3}$/u.test(kind)) throw new Error('Short workspace kind required');
  const id = createHash('sha256').update(path.resolve(outputRoot)).digest('hex').slice(0, 12);
  const root = path.resolve(workspaceRoot ?? path.join(repositoryRoot, '.runtime-correction', 'b'), `${kind}-${id}`);
  const internal = path.join(root, 'entry/.test/default/cache/default/default@UnitTestArkTS/esmodule/debug/filesInfo.txt');
  if (process.platform === 'win32' && internal.length >= 240) throw new Error('RC checkout path is too long for the native ArkTS test cache; use a shorter external RC worktree');
  return root;
}
