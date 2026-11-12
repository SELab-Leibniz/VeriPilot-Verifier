import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyFrozenCandidate, assertFrozenTaskStart, markHistoricalStopFeedback } from '../scripts/bench/simplify-arkts-frozen.mjs';
import { captureTaskStart, taskChanges, taskStartManifestPath } from '../lib/runtime-v2/task-changes.mjs';

const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=RC Test', '-c', 'user.email=rc@example.invalid', '-c', 'core.autocrlf=false',
  '-C', root, ...args], { windowsHide: true });
const head = root => git(root, 'rev-parse', 'HEAD').toString().trim();

test('historical Stop feedback retains transcript ancestry and cannot become original user input', () => {
  const user = { id: 'first', message: { role: 'user', content: 'Update the selected option.' } };
  const feedback = { id: 'next', parentId: 'first', message: { role: 'user', content: [
    { type: 'text', text: '[runtime-corrector:stop-reference]\nReview result.' },
  ] } };
  const [original, marked] = markHistoricalStopFeedback([user, feedback]);
  assert.equal(original, user);
  assert.equal(marked.id, feedback.id);
  assert.equal(marked.parentId, feedback.parentId);
  assert.equal(marked.message.content[0].text, '[runtime-corrector:internal]\n[runtime-corrector:stop-reference]\nReview result.');
  assert.equal(feedback.message.content[0].text, '[runtime-corrector:stop-reference]\nReview result.');
});

async function frozenFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frozen-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/settings.ets'), 'export const LIMIT = 10;\n');
  await fs.writeFile(path.join(root, 'src/legacy.ets'), 'export const OLD = true;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'prepared');
  const preparedHead = head(root);
  await fs.writeFile(path.join(root, 'src/settings.ets'), 'export const LIMIT = 0;\n');
  await fs.writeFile(path.join(root, 'src/added.ets'), 'export const ADDED = 1;\n');
  await fs.rm(path.join(root, 'src/legacy.ets'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'frozen candidate');
  const commit = head(root), patch = git(root, 'diff', '--binary', preparedHead, commit);
  git(root, 'checkout', '-q', '--detach', preparedHead);
  return { root, preparedHead, commit, patch, mutationPaths: ['src/added.ets', 'src/legacy.ets', 'src/settings.ets'] };
}

test('a frozen replay captures the task start on the prepared tree and applies the candidate as uncommitted business changes', async t => {
  const f = await frozenFixture(t);
  assert.equal(await captureTaskStart({ projectRoot: f.root, taskId: 'task-1' }), true);
  const { start } = await assertFrozenTaskStart({ taskStartManifestPath, projectRoot: f.root, taskId: 'task-1', preparedHead: f.preparedHead });
  assert.deepEqual(start.entries, {}, 'the start manifest predates the candidate');
  await applyFrozenCandidate({ git: 'git', projectRoot: f.root, patch: f.patch, commit: f.commit, mutationPaths: f.mutationPaths });
  assert.equal(head(f.root), f.preparedHead, 'the candidate is never committed');
  const changed = await taskChanges({ projectRoot: f.root, taskId: 'task-1' });
  assert.equal(changed.startHead, f.preparedHead);
  assert.deepEqual(changed.changes.map(change => [change.path, change.status, change.owner]), [
    ['src/added.ets', 'UNTRACKED', 'STOP'], ['src/legacy.ets', 'DELETED', 'STOP'], ['src/settings.ets', 'MODIFIED', 'STOP']]);
});

test('a start captured on the frozen commit, a missing start or a diverging candidate fails before the terminal hooks', async t => {
  const f = await frozenFixture(t);
  await assert.rejects(assertFrozenTaskStart({ taskStartManifestPath, projectRoot: f.root, taskId: 'missing', preparedHead: f.preparedHead }),
    /did not capture task-start\.json/u);
  git(f.root, 'checkout', '-q', '--detach', f.commit);
  await captureTaskStart({ projectRoot: f.root, taskId: 'late' });
  await assert.rejects(assertFrozenTaskStart({ taskStartManifestPath, projectRoot: f.root, taskId: 'late', preparedHead: f.preparedHead }),
    new RegExp(`recorded head ${f.commit}`, 'u'));
  git(f.root, 'checkout', '-q', '--detach', f.preparedHead);
  await assert.rejects(applyFrozenCandidate({ git: 'git', projectRoot: f.root, patch: f.patch, commit: f.preparedHead, mutationPaths: f.mutationPaths }),
    /differs from the frozen commit/u);
});
