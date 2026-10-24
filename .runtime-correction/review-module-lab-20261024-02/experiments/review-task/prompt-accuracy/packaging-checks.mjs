import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFixturePaths, resolveFixtureList } from './fixture-paths.mjs';
import { reviewRunExitCode } from './run-outcome.mjs';

async function fixture(t, { workspace = true } = {}) {
  const parent = fileURLToPath(new URL('../../../prompt-accuracy-20261024-01/packaging-test-runs/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'relocated-'));
  const directory = path.join(root, 'fixtures/kitchen/K01');
  await fs.mkdir(directory, { recursive: true });
  if (workspace) {
    await fs.mkdir(path.join(directory, 'workspace'));
    await fs.writeFile(path.join(directory, 'workspace/source.md'), 'Current source only.');
  }
  await fs.writeFile(path.join(directory, 'task.json'), '{"id":"K01"}\n');
  await fs.writeFile(path.join(directory, 'oracle.json'), '{"expected":"PASS"}\n');
  t.diagnostic(`artifacts: ${root}`);
  return { root, directory, descriptor: { caseId: 'K01', domain: 'kitchen', metricId: 'M01', split: 'dev' } };
}

test('legacy absolute descriptors rebase to the current checkout without opening the old checkout', async t => {
  const f = await fixture(t), legacy = { ...f.descriptor };
  for (const [key, leaf] of Object.entries({ workspace: 'workspace', task: 'task.json', oracle: 'oracle.json' }))
    legacy[key] = `Z:\\retired-checkout\\fixtures\\kitchen\\K01\\${leaf}`;
  const before = JSON.stringify(legacy), resolved = await resolveFixturePaths(f.root, legacy);
  assert.equal(resolved.workspace, await fs.realpath(path.join(f.directory, 'workspace')));
  assert.equal(resolved.task, await fs.realpath(path.join(f.directory, 'task.json')));
  assert.equal(resolved.oracle, await fs.realpath(path.join(f.directory, 'oracle.json')));
  assert.equal(JSON.stringify(legacy), before, 'historical descriptor bytes are not rewritten');
  assert.deepEqual(await fs.readdir(resolved.workspace), ['source.md'], 'oracle is not in the model source root');
});

test('portable relative paths and identity-only descriptors resolve identically', async t => {
  const f = await fixture(t), relative = { ...f.descriptor, workspace: 'fixtures/kitchen/K01/workspace',
    task: 'fixtures/kitchen/K01/task.json', oracle: 'fixtures/kitchen/K01/oracle.json' };
  const result = await resolveFixturePaths(f.root, relative);
  assert.deepEqual(result, await resolveFixturePaths(f.root, f.descriptor));
});

test('foreign paths, visible oracle locations and duplicate identities are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveFixturePaths(f.root, { ...f.descriptor, oracle: 'fixtures/kitchen/K01/workspace/oracle.json' }), /does not match/u);
  await assert.rejects(resolveFixturePaths(f.root, { ...f.descriptor, task: 'fixtures/kitchen/K02/task.json' }), /does not match/u);
  await assert.rejects(resolveFixturePaths(f.root, { ...f.descriptor, workspace: '../fixtures/kitchen/K01/workspace' }), /does not match/u);
  await assert.rejects(resolveFixturePaths(f.root, { ...f.descriptor, caseId: 'F01' }), /Invalid fixture domain/u);
  await assert.rejects(resolveFixtureList(f.root, [f.descriptor, f.descriptor]), /unique case/u);
});

test('a workspace junction cannot expose another directory as model input', async t => {
  const f = await fixture(t, { workspace: false }), other = path.join(f.root, 'private');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'oracle.json'), '{"expected":"PASS"}');
  try { await fs.symlink(other, path.join(f.directory, 'workspace'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Filesystem does not permit a symlink/junction fixture'); throw error; }
  await assert.rejects(resolveFixturePaths(f.root, f.descriptor), /cannot be a symlink/u);
});

test('an incomplete live review exits nonzero while a valid UNVERIFIED submission remains complete', () => {
  const state = { protectedInputs: true, live: true, rows: [{ result: { completed: true, verdict: 'PASS' } }] };
  assert.equal(reviewRunExitCode(state), 0);
  assert.equal(reviewRunExitCode({ ...state, rows: [...state.rows, { result: { completed: false, verdict: 'UNVERIFIED' } }] }), 1);
  assert.equal(reviewRunExitCode({ ...state, rows: [{ result: { completed: true, verdict: 'UNVERIFIED' } }] }), 0);
  assert.equal(reviewRunExitCode({ ...state, rows: [{ error: 'Provider failed' }] }), 1);
  assert.equal(reviewRunExitCode({ ...state, protectedInputs: false }), 1);
  assert.equal(reviewRunExitCode({ protectedInputs: true, live: false, rows: [{ preflight: true }] }), 0);
});
