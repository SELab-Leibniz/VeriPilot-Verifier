// Portable fixture identity. Historical descriptors keep their original bytes;
// only this process's resolved paths are rebased to the current experiment root.
import fs from 'node:fs/promises';
import path from 'node:path';

const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function resolveFixturePaths(experimentRoot, descriptor) {
  if (!descriptor || !['kitchen', 'flower'].includes(descriptor.domain)
    || !/^[KF][0-9]+$/u.test(descriptor.caseId ?? '')
    || descriptor.caseId[0] !== (descriptor.domain === 'kitchen' ? 'K' : 'F'))
    throw new Error('Invalid fixture domain or case identity');
  const relativeCase = `fixtures/${descriptor.domain}/${descriptor.caseId}`;
  const leaves = { workspace: 'workspace', task: 'task.json', oracle: 'oracle.json',
    ...(descriptor.provenance === undefined ? {} : { provenance: 'provenance.json' }) };
  for (const [key, leaf] of Object.entries(leaves)) {
    const value = descriptor[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`Invalid fixture ${key} path`);
    const normalized = value.replaceAll('\\', '/');
    const expected = `${relativeCase}/${leaf}`;
    const absolute = /^(?:[A-Za-z]:\/|\/)/u.test(normalized);
    if (normalized.split('/').some(part => part === '..' || part === '.')
      || (absolute ? !normalized.endsWith(`/${expected}`) : normalized !== expected))
      throw new Error(`Fixture ${key} path does not match its case identity`);
  }
  const root = await fs.realpath(experimentRoot);
  const fixtureRoot = await fs.realpath(path.join(root, 'fixtures'));
  if (!within(root, fixtureRoot)) throw new Error('Fixture root is outside this experiment');
  const casePath = path.join(root, ...relativeCase.split('/'));
  if ((await fs.lstat(casePath)).isSymbolicLink()) throw new Error('Fixture case cannot be a symlink');
  const caseRoot = await fs.realpath(casePath);
  if (!within(fixtureRoot, caseRoot)) throw new Error('Fixture case is outside this experiment');
  const resolved = { ...descriptor };
  for (const [key, leaf] of Object.entries(leaves)) {
    const file = path.join(caseRoot, leaf);
    const metadata = await fs.lstat(file);
    if (metadata.isSymbolicLink()) throw new Error(`Fixture ${key} cannot be a symlink`);
    if (key === 'workspace' ? !metadata.isDirectory() : !metadata.isFile())
      throw new Error(`Fixture ${key} has the wrong file type`);
    resolved[key] = await fs.realpath(file);
    if (!within(caseRoot, resolved[key])) throw new Error(`Fixture ${key} is outside its case`);
  }
  if (within(resolved.workspace, resolved.task) || within(resolved.workspace, resolved.oracle))
    throw new Error('Fixture task and oracle must remain outside the model workspace');
  return resolved;
}

export async function resolveFixtureList(experimentRoot, descriptors) {
  if (!Array.isArray(descriptors) || new Set(descriptors.map(item => item?.caseId)).size !== descriptors.length)
    throw new Error('Fixture descriptors must have unique case identities');
  return Promise.all(descriptors.map(item => resolveFixturePaths(experimentRoot, item)));
}
