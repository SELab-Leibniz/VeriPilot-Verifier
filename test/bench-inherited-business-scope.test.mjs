import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inheritedBusinessMutationScope } from '../scripts/bench/business-mutations.mjs';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-inherited-scope-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'rc-inherited-scope-'))) throw new Error('Unsafe cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, 'project'); await fs.mkdir(projectRoot);
  async function run(name, actualBusinessStart, mutationPaths, resumedFrom, override = {}) {
    const directory = path.join(root, name); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ projectRoot, instanceId: 'task', datasetDigest: 'digest', preparedHead: 'head', resumedFrom, ...override }));
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ actualBusinessStart, businessCompleted: false }));
    await fs.writeFile(path.join(directory, 'candidate-scope.json'), JSON.stringify({ mutationPaths }));
    return directory;
  }
  return { root, projectRoot, run };
}
test('a memory-only failure retains prior unfinished business edits while excluding maintenance writes', async t => {
  const f = await fixture(t), business = await f.run('business', true, ['src/permission.ets']);
  const maintenance = await f.run('maintenance', false, ['src/permission.ets', 'memory/today.md'], business);
  const result = await inheritedBusinessMutationScope(maintenance, f.projectRoot);
  assert.deepEqual(result.mutationPaths, ['src/permission.ets']);
  assert.equal(result.sourceRun, business); assert.deepEqual(result.skippedStartupRuns, [maintenance]);
});
test('cross-task ancestry and control-state paths cannot become product edits', async t => {
  const f = await fixture(t), business = await f.run('business', true, ['src/code.ets']);
  const foreign = await f.run('foreign', false, [], business, { instanceId: 'other-task' });
  await assert.rejects(inheritedBusinessMutationScope(foreign, f.projectRoot), /task or prepared HEAD/u);
  const unsafe = await f.run('unsafe', true, ['.runtime-correction/owner.json']);
  await assert.rejects(inheritedBusinessMutationScope(unsafe, f.projectRoot), /control state/u);
});
test('startup without business creates no scope, and ancestry cycles fail explicitly', async t => {
  const f = await fixture(t), empty = await f.run('empty', false, ['memory/today.md']);
  assert.deepEqual((await inheritedBusinessMutationScope(empty, f.projectRoot)).mutationPaths, []);
  const cycle = await f.run('cycle', false, [], path.join(f.root, 'cycle'));
  await assert.rejects(inheritedBusinessMutationScope(cycle, f.projectRoot), /Cyclic/u);
});
