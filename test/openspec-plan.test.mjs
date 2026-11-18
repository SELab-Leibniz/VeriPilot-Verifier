import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareOpenSpecPlans, openSpecTaskTextSha256, readOpenSpecPlan } from '../lib/openspec-plan.mjs';

const changeName = 'add-mode';
const relativeChange = `openspec/changes/${changeName}`;
const proposal = '## Why\nSupport the requested mode.\n';
const checklist = '## Apply\r\n- [x] First\r\n* [ ] Second\r\n- [ ] Third\r\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-openspec-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const change = path.join(project, relativeChange);
  const put = async (relative, contents) => {
    const file = path.join(change, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  await put('proposal.md', proposal);
  await put('tasks.md', checklist);
  return { root, project, change, put, capture: () => readOpenSpecPlan(project, changeName) };
}

test('OpenSpec snapshots include raw document digests and permit only forward checkbox progress', async t => {
  const { put, capture } = await fixture(t);
  await put('specs/zeta/spec.md', 'Zeta');
  await put('specs/alpha/nested/spec.md', 'Alpha');
  await put('specs/notes.md', 'Ignored');
  await put('design.md', 'Design');
  const approved = await capture();
  assert.equal(approved.changeName, changeName);
  assert.deepEqual(approved.documents, [
    ['design.md', 'Design'], ['proposal.md', proposal], ['specs/alpha/nested/spec.md', 'Alpha'],
    ['specs/zeta/spec.md', 'Zeta'], ['tasks.md', checklist],
  ].map(([name, content]) => ({ path: `${relativeChange}/${name}`, sha256: hash(content) })));
  assert.equal(approved.taskCount, 3);
  assert.equal(approved.completedTaskCount, 1);
  assert.deepEqual(approved.taskCompletion, [true, false, false]);
  assert.equal((await capture()).revision, approved.revision);

  await put('tasks.md', checklist.replace('[ ] Second', '[X] Second'));
  const applied = await capture();
  assert.notEqual(applied.revision, approved.revision);
  assert.equal(applied.taskTextSha256, approved.taskTextSha256);
  assert.equal(applied.completedTaskCount, 2);
  assert.deepEqual(compareOpenSpecPlans(approved, applied), { status: 'PRESERVED', differences: [] });

  await put('tasks.md', checklist.replace('[x] First', '[ ] First').replace('[ ] Second', '[X] Second').replace('[ ] Third', '[x] Third'));
  const reorderedProgress = await capture();
  assert.equal(reorderedProgress.completedTaskCount, 2);
  assert.deepEqual(compareOpenSpecPlans(approved, reorderedProgress), {
    status: 'CHANGED', differences: [`${relativeChange}/tasks.md`],
  });
});

test('OpenSpec comparison reports exact changed artifacts including optional additions and removals', async t => {
  const { change, put, capture } = await fixture(t);
  await put('specs/old/spec.md', 'Old spec');
  const approved = await capture();
  await put('design.md', 'New design');
  await put('proposal.md', `${proposal}\n`);
  await fs.unlink(path.join(change, 'specs/old/spec.md'));
  await put('specs/new/spec.md', 'New spec');
  await put('tasks.md', checklist.replace('Second', 'Rewritten task'));
  assert.deepEqual(compareOpenSpecPlans(approved, await capture()), {
    status: 'CHANGED', differences: ['design.md', 'proposal.md', 'specs/new/spec.md', 'specs/old/spec.md', 'tasks.md']
      .map(name => `${relativeChange}/${name}`),
  });
});

test('task hash matches OpenSpec checkbox forms and preserves unsupported markers and other bytes', () => {
  const unchecked = Buffer.from('- [ ] A\r\n*[ ]B\r\n  - [ ] Nested\r\n+ [ ] Other\r\nText [ ] Placeholder\r\n');
  const marked = Buffer.from(unchecked.toString().replace('[ ] A', '[x] A').replace('[ ]B', '[X]B'));
  assert.equal(openSpecTaskTextSha256(marked), openSpecTaskTextSha256(unchecked));
  for (const alternative of ['[x] Nested', '[x] Other', '[x] Placeholder', '[ ]  A']) {
    const original = alternative.startsWith('[ ]') ? '[ ] A' : alternative.replace('[x]', '[ ]');
    assert.notEqual(openSpecTaskTextSha256(Buffer.from(unchecked.toString().replace(original, alternative))), openSpecTaskTextSha256(unchecked));
  }
  assert.notEqual(openSpecTaskTextSha256(Buffer.from(unchecked.toString().replaceAll('\r\n', '\n'))), openSpecTaskTextSha256(unchecked));
  assert.equal(openSpecTaskTextSha256(Buffer.from([0xff])), null);
});

test('required files, valid checklist text, slugs, and bound sizes are enforced', async t => {
  const { project, change, put, capture } = await fixture(t);
  assert.deepEqual((await capture()).documents.map(doc => doc.path), [`${relativeChange}/proposal.md`, `${relativeChange}/tasks.md`]);
  for (const invalidName of ['../add-mode', '1-add-mode', 'add--mode', 'add-mode-'])
    await assert.rejects(readOpenSpecPlan(project, invalidName), { code: 'OPENSPEC_PLAN_INVALID' });
  await put('tasks.md', Buffer.from([0xff]));
  await assert.rejects(capture(), { code: 'OPENSPEC_PLAN_INVALID' });
  await put('tasks.md', checklist);
  const model = path.join(change, 'proposal.md');
  await fs.truncate(model, 1024 * 1024 + 1);
  await assert.rejects(capture(), { code: 'OPENSPEC_PLAN_LIMIT' });
  await fs.unlink(model);
  await assert.rejects(capture(), { code: 'ENOENT' });
  await fs.mkdir(model);
  await assert.rejects(capture(), { code: 'OPENSPEC_PLAN_UNSAFE' });
  await put('proposal-extra.md', proposal);
  await fs.rmdir(model);
  await fs.rename(path.join(change, 'proposal-extra.md'), model);
  await fs.unlink(path.join(change, 'tasks.md'));
  await assert.rejects(capture(), { code: 'ENOENT' });
});

test('symlinks in selected OpenSpec files and directories are rejected', async t => {
  const { root, project, change, put, capture } = await fixture(t);
  const external = path.join(root, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'spec.md'), 'Outside');
  await fs.writeFile(path.join(external, 'proposal.md'), proposal);
  await fs.writeFile(path.join(external, 'tasks.md'), checklist);
  const design = path.join(change, 'design.md');
  try { await fs.symlink(path.join(external, 'spec.md'), design, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Creating file symlinks requires privilege on this host');
    return;
  }
  await assert.rejects(capture(), { code: 'OPENSPEC_PLAN_UNSAFE' });
  await fs.unlink(design);
  await put('specs/local/spec.md', 'Local spec');
  const link = path.join(change, 'specs/linked');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(capture(), { code: 'OPENSPEC_PLAN_UNSAFE' });
  await fs.unlink(link);
  const changes = path.join(project, 'openspec/changes');
  await fs.rename(changes, `${changes}-original`);
  await fs.symlink(external, changes, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(capture(), { code: 'OPENSPEC_PLAN_UNSAFE' });
});
