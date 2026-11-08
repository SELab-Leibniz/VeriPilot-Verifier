import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const generated = new Set(['.git', '.hvigor', '.test', 'oh_modules', 'node_modules', '.runtime-correction', '.runtime-corrector']);
const run = promisify(execFile);
const suiteRoot = /(?:^|\/)src\/test(?=\/|$)/u;

// A Stop may already have observed the source tree, including build caches.
// Run the mutating toolchain in a sibling snapshot, outside that observed tree.
export async function prepareRegressionWorkspace(project, { originalTestCommit, signal } = {}) {
  const source = await fs.realpath(project);
  const options = { cwd: source, windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 };
  let testRoots = [];
  if (originalTestCommit !== undefined) {
    if (!/^[a-f0-9]{40}$/u.test(originalTestCommit)) throw new Error('Original tests require the exact baseline commit.');
    const { stdout } = await run('git', ['ls-tree', '-r', '--full-tree', '--name-only', '-z', originalTestCommit], options);
    testRoots = [...new Set(stdout.split('\0').flatMap(file => {
      const match = suiteRoot.exec(file);
      return match ? [file.slice(0, match.index + match[0].length)] : [];
    }))];
    if (!testRoots.length) throw new Error('The original commit has no public ArkTS unit test directories.');
  }
  const workspace = await fs.mkdtemp(path.join(path.dirname(source), 'rc-regression-'));
  await fs.cp(source, workspace, { recursive: true, dereference: true,
    filter(file) {
      if (file === source) return true;
      return !generated.has(path.basename(file)) && (!originalTestCommit || !suiteRoot.test(path.relative(source, file).replaceAll('\\', '/')));
    } });
  if (originalTestCommit) {
    const archive = `${workspace}.tar`;
    try {
      await run('git', ['--literal-pathspecs', 'archive', '--format=tar', `--output=${archive}`, originalTestCommit, '--', ...testRoots], options);
      await run('tar', ['-xf', archive, '-C', workspace], options);
    } finally { await fs.rm(archive, { force: true }); }
  }
  await fs.writeFile(workspace + '.json', JSON.stringify({ source, workspace, createdAt: new Date().toISOString(),
    ...(originalTestCommit ? { originalTestCommit, testRoots } : {}),
    purpose: 'Public local tests; toolchain outputs are isolated from the Stop evidence tree.' }, null, 2));
  return workspace;
}
