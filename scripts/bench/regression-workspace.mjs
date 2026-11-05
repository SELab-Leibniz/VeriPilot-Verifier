import fs from 'node:fs/promises';
import path from 'node:path';

const generated = new Set(['.git', '.hvigor', '.test', 'oh_modules', 'node_modules', '.runtime-correction', '.runtime-corrector']);

// A Stop may already have observed the source tree, including build caches.
// Run the mutating toolchain in a sibling snapshot, outside that observed tree.
export async function prepareRegressionWorkspace(project) {
  const source = await fs.realpath(project);
  const workspace = await fs.mkdtemp(path.join(path.dirname(source), 'rc-regression-'));
  await fs.cp(source, workspace, { recursive: true, dereference: true,
    filter(file) { return file === source || !generated.has(path.basename(file)); } });
  await fs.writeFile(workspace + '.json', JSON.stringify({ source, workspace, createdAt: new Date().toISOString(),
    purpose: 'Current public local tests; toolchain outputs are isolated from the Stop evidence tree.' }, null, 2));
  return workspace;
}
