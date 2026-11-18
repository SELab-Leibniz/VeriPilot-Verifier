import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { arktsBusinessDiffScope, captureBusinessCheckpoint, compareOpenSpecApplyScope, isArktsCheckpointPath, sameApplyRecoveryScope, sameProposalRepairScope } from '../scripts/bench/business-checkpoint.mjs';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { businessMutationPaths, sealableMutationPaths } from '../scripts/bench/business-mutations.mjs';

test('checkpoint includes new source and modified assertions without changing the live index or private state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-checkpoint-'));
  t.after(async () => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, 'project'); await fs.mkdir(projectRoot);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot, windowsHide: true, encoding: 'utf8' });
  await fs.writeFile(path.join(projectRoot, 'main.ets'), 'old\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  const preparedHead = git('rev-parse', 'HEAD').trim();
  await fs.writeFile(path.join(projectRoot, 'main.ets'), 'changed\n');
  await fs.writeFile(path.join(projectRoot, 'new.ets'), 'new source\n');
  await fs.mkdir(path.join(projectRoot, 'openspec'));
  await fs.writeFile(path.join(projectRoot, 'openspec', 'proposal.md'), 'workflow proposal\n');
  await fs.mkdir(path.join(projectRoot, '.runtime-corrector'));
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector', 'private.json'), 'private');
  await fs.mkdir(path.join(projectRoot, '.openclaw/tmp'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.openclaw/tmp', 'worker scratch.ets'), 'host scratch\n');
  const indexBefore = await fs.readFile(path.join(projectRoot, '.git/index'));
  const receipt = await captureBusinessCheckpoint({ projectRoot, preparedHead, outputRoot: root, runId: 'run', stopReason: 'stop', includeBusinessPatch: true });
  assert.deepEqual(receipt.paths, ['main.ets', 'new.ets', 'openspec/proposal.md']);
  const fullPatch = await fs.readFile(path.join(receipt.directory, 'candidate.patch'), 'utf8');
  assert.match(fullPatch, /workflow proposal/u);
  const businessPatch = await fs.readFile(path.join(receipt.directory, 'business-candidate.patch'), 'utf8');
  assert.match(businessPatch, /new source/u);
  assert.doesNotMatch(businessPatch, /workflow proposal/u);
  assert.equal(digest(businessPatch), receipt.businessPatchSha256);
  assert.deepEqual(await fs.readFile(path.join(projectRoot, '.git/index')), indexBefore);
  assert.equal(git('rev-parse', 'HEAD').trim(), preparedHead);
  const observed = ['main.ets', 'new.ets', 'openspec/proposal.md', '.openclaw/tmp/worker scratch.ets'];
  git('--literal-pathspecs', 'add', '--all', '--', ...observed.filter(isArktsCheckpointPath));
  assert.equal(git('diff', '--cached', '--binary', preparedHead, '--', ...arktsBusinessDiffScope), businessPatch);
  assert.equal(git('diff', '--cached', '--binary', preparedHead), fullPatch);
});

test('final freeze stages surviving mutations and tracked deletions without expanding the observed scope', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-sealable-mutations-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = async (relative, contents) => {
    const file = path.join(projectRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  const added = 'entry/src/main/new.ets';
  const odd = 'entry/src/test/[fallback] case.ets';
  const transient = 'entry/src/test/ZzDiagnostic.tmp.ets';
  const deleted = 'deleted.ets';
  const nestedDeletion = 'entry/src/retired/deleted.ets';
  const unobserved = 'entry/src/test/f case.ets';
  for (const file of [deleted, nestedDeletion, unobserved]) await put(file, 'original\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  const trackedPaths = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
  await put(added, 'new source\n');
  await put(odd, 'literal filename\n');
  await put(transient, 'diagnostic only\n');
  for (const file of [transient, deleted, nestedDeletion]) await fs.unlink(path.join(projectRoot, file));
  await fs.rmdir(path.join(projectRoot, 'entry/src/retired'));
  await put(unobserved, 'modified outside the observed scope\n');

  const records = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'add', name: 'apply_patch' }] },
    { role: 'toolResult', toolCallId: 'add', toolName: 'apply_patch', details: {
      summary: { added: [added, odd, transient], modified: [], deleted: [] } } },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'remove', name: 'apply_patch' }] },
    { role: 'toolResult', toolCallId: 'remove', toolName: 'apply_patch', details: {
      summary: { added: [], modified: [], deleted: [transient, deleted, nestedDeletion] } } },
  ];
  const paths = businessMutationPaths(records, projectRoot);
  assert(paths.includes(transient));
  assert.throws(() => git('--literal-pathspecs', 'add', '--dry-run', '--all', '--', ...paths), error => {
    assert.equal(error.status, 128);
    assert(error.stderr.includes(transient));
    return true;
  });
  const selected = await sealableMutationPaths({ projectRoot, paths, trackedPaths });
  assert.deepEqual([...selected].sort(), [added, odd, deleted, nestedDeletion].sort());
  git('--literal-pathspecs', 'add', '--all', '--', ...selected);

  assert.deepEqual(git('diff', '--cached', '--name-status', '--no-renames', '-z').split('\0').filter(Boolean),
    ['D', deleted, 'A', added, 'D', nestedDeletion, 'A', odd]);
  assert.equal(git('show', `:${added}`), 'new source\n');
  assert.equal(git('show', `:${odd}`), 'literal filename\n');
  assert.equal(git('diff', '--name-only').trim(), unobserved);
});

test('proposal retry permits only content edits to the existing regular drafts of its own change', async t => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-proposal-scope-'));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const projectRoot = path.join(outputRoot, 'project');
  await fs.mkdir(projectRoot);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot, windowsHide: true, encoding: 'utf8' });
  const put = async (name, contents) => {
    const file = path.join(projectRoot, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  const remove = name => fs.unlink(path.join(projectRoot, name));
  const fixed = {
    '.gitattributes': '*.md text eol=lf\n',
    '.opencode/instructions.md': 'Existing tool instructions.\n',
    'openspec/config.yaml': 'Original configuration.\n',
    'openspec/specs/platform/spec.md': 'Existing platform scope.\n',
    'entry/build/tracked.txt': 'Tracked under a generated directory.\n',
    'entry/main.ets': 'Existing business code.\n',
  };
  git('init', '-q');
  for (const [name, contents] of Object.entries(fixed)) await put(name, contents);
  git('add', '.'); git('commit', '-qm', 'base');
  const preparedHead = git('rev-parse', 'HEAD').trim();
  const changeName = 'benchmark-change', prefix = `openspec/changes/${changeName}`;
  const proposal = `${prefix}/proposal.md`, design = `${prefix}/design.md`, spec = `${prefix}/specs/feature/spec.md`, checklist = `${prefix}/tasks.md`;
  const checklistText = '## Plan\n- [ ] 1.1 Preserve existing behavior.\n';
  for (const name of [proposal, design, spec]) await put(name, 'Initial draft.\n');
  await put(checklist, checklistText);
  const capture = (requireProposalPolicy = true) => captureBusinessCheckpoint({ outputRoot, projectRoot, preparedHead, runId: 'run',
    stopReason: 'validation-repair', includeBusinessPatch: true, proposalRepairChange: changeName, requireProposalPolicy });
  const missingPolicy = (await capture()).proposalRepairScope;
  assert.equal(missingPolicy.complete, false);
  assert.equal(missingPolicy.policy.status, 'ABSENT');
  assert.equal((await capture(false)).proposalRepairScope.complete, true, 'the RC-off arm can have no policy');
  await put('.runtime-corrector/criteria/reviewer.md', 'Private review policy.');
  assert.equal((await capture()).proposalRepairScope.policy.status, 'UNVERIFIED', 'an active policy requires its config');
  const policyFile = '.runtime-corrector/config.yaml', configText = 'Private config.\n';
  await put(policyFile, configText);
  const before = await capture();
  const proof = before.proposalRepairScope;
  assert.equal(proof.complete, true);
  assert.deepEqual(proof.draftFiles.map(file => file.path), [design, proposal, spec]);
  assert.equal(proof.tasksMdSha256, digest(checklistText));
  assert.match(proof.policy.sha256, /^[a-f0-9]{64}$/u);
  for (const name of [proposal, design, spec]) await put(name, 'Repaired draft.\n');
  const repaired = await capture();
  assert.equal(repaired.businessPatchSha256, before.businessPatchSha256);
  assert.notEqual(repaired.patchSha256, before.patchSha256);
  assert.equal(sameProposalRepairScope(proof, repaired.proposalRepairScope), true);
  assert.equal(sameApplyRecoveryScope(proof, repaired.proposalRepairScope), false, 'Apply recovery retains the approved draft bytes');
  await put(checklist, checklistText.replace('[ ]', '[x]'));
  await put('entry/new.ets', 'Partial implementation.');
  assert.equal(sameApplyRecoveryScope(repaired.proposalRepairScope, (await capture()).proposalRepairScope), true);
  await put(checklist, checklistText.replace('Preserve', 'Remove'));
  assert.equal(sameApplyRecoveryScope(repaired.proposalRepairScope, (await capture()).proposalRepairScope), false);
  await put(checklist, checklistText);
  await remove('entry/new.ets');
  const persisted = JSON.parse(await fs.readFile(path.join(repaired.directory, 'checkpoint.json'), 'utf8'));
  assert.deepEqual(persisted.proposalRepairScope, repaired.proposalRepairScope);
  assert.doesNotMatch(await fs.readFile(path.join(repaired.directory, 'candidate.patch'), 'utf8'), /\.runtime-corrector|Private/u);

  for (const [name, replacement, restore] of [
    ['.opencode/instructions.md', 'Different instructions.', fixed['.opencode/instructions.md']],
    ['openspec/config.yaml', 'Different configuration.', fixed['openspec/config.yaml']],
    ['openspec/specs/platform/spec.md', 'Different platform scope.', fixed['openspec/specs/platform/spec.md']],
    ['openspec/changes/other/proposal.md', 'New change draft.', null],
    [`${prefix}/specs/new/spec.md`, 'New specification.', null],
    [checklist, checklistText.replaceAll('\n', '\r\n'), checklistText],
    [policyFile, 'Changed private config.', configText],
    ['.runtime-corrector/criteria/added.md', 'New private instructions.', null],
    ['entry/build/tracked.txt', 'Changed tracked output.', fixed['entry/build/tracked.txt']],
    ['entry/new.ets', 'New business code.', null],
  ]) {
    await put(name, replacement);
    const current = await capture();
    assert.equal(sameProposalRepairScope(proof, current.proposalRepairScope), false, name);
    if (/^(?:openspec\/|\.opencode\/|\.runtime-corrector\/)/u.test(name))
      assert.equal(sameApplyRecoveryScope(repaired.proposalRepairScope, current.proposalRepairScope), false, name);
    if (name === checklist) {
      assert.equal(proof.fixedEntriesSha256, current.proposalRepairScope.fixedEntriesSha256, 'Git normalizes the raw checklist line ending');
      assert.notEqual(proof.tasksMdSha256, current.proposalRepairScope.tasksMdSha256);
    }
    if (restore === null) await remove(name);
    else await put(name, restore);
  }
  if (process.platform !== 'win32') {
    await remove(policyFile);
    await fs.symlink('../.gitattributes', path.join(projectRoot, policyFile));
    const linkedPolicy = (await capture()).proposalRepairScope;
    assert.equal(linkedPolicy.policy.status, 'UNVERIFIED');
    assert.equal(sameProposalRepairScope(proof, linkedPolicy), false);
    await remove(policyFile);
    await put(policyFile, configText);
  }
  await fs.rename(path.join(projectRoot, spec), path.join(projectRoot, `${prefix}/specs/feature/other.md`));
  assert.equal(sameProposalRepairScope(proof, (await capture()).proposalRepairScope), false, 'renamed draft');
  if (process.platform !== 'win32') {
    await fs.symlink('other.md', path.join(projectRoot, spec));
    assert.equal(sameProposalRepairScope(proof, (await capture()).proposalRepairScope), false, 'symlink replacement');
  }
  assert.equal(git('diff', '--cached', '--name-only'), '', 'all captures use a separate Git index');
});

test('ordinary Apply preserves the approved workflow bytes except for real checklist progress', async t => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-apply-scope-'));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const projectRoot = path.join(outputRoot, 'project');
  await fs.mkdir(projectRoot);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = async (relative, contents) => {
    const file = path.join(projectRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  git('init', '-q');
  await put('.gitattributes', '*.md text eol=lf\n');
  await put('entry/main.ets', 'Original business code.\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const preparedHead = git('rev-parse', 'HEAD').trim();
  const changeName = 'benchmark-change', prefix = `openspec/changes/${changeName}`;
  const planFiles = {
    [`${prefix}/proposal.md`]: '# Approved goal\n',
    [`${prefix}/design.md`]: '# Approved design\n\nThe existing caller supplies the mode.\n',
    [`${prefix}/specs/feature/spec.md`]: '# Approved behavior\n\nThe selected mode reaches generation.\n',
  };
  for (const [file, contents] of Object.entries(planFiles)) await put(file, contents);
  const checklist = `${prefix}/tasks.md`;
  const approvedText = [
    '## Apply plan', '- [ ] 1.1 Honor selection.', '* [ ] 1.2 Verify the actual caller.', '',
    '<!-- Preserve these examples as documentation. -->', '  - [ ] Nested example', '+ [ ] Example using a plus marker', '',
  ].join('\n');
  await put(checklist, approvedText);
  const sessionId = 'c232e1b2-8454-45c3-a324-268d9cdb52e9';
  const proposalRunId = 'f2750cf0-fc14-45f2-9246-6d3a71cc50e6', applyRunId = '122c5705-f7e4-4fdc-a580-e24f9ad8fb2f';
  const capture = (runId, stopReason) => captureBusinessCheckpoint({ outputRoot, projectRoot, preparedHead,
    runId, sessionId, stopReason, success: true, includeBusinessPatch: true, proposalRepairChange: changeName, requireProposalPolicy: false });
  const approved = await capture(proposalRunId, 'openspec_proposal_boundary');
  const captureApply = () => capture(applyRunId, 'openspec_apply_boundary');
  const identity = { changeName, sessionId, proposalRunId, applyRunId, preparedHead };
  const compare = (applied, proposal = approved) => compareOpenSpecApplyScope(proposal, applied, identity).status;
  assert.equal(approved.proposalRepairScope.policy.status, 'ABSENT');
  assert.match(approved.proposalRepairScope.approvedDocumentsSha256, /^[a-f0-9]{64}$/u);

  const checked = approvedText.replace('- [ ] 1.1', '- [X] 1.1').replace('* [ ] 1.2', '* [x] 1.2');
  await put(checklist, checked);
  await put('entry/main.ets', 'Completed business implementation.\n');
  const ordinary = await captureApply();
  assert(ordinary.paths.includes('entry/main.ets'));
  assert.notEqual(ordinary.businessPatchSha256, approved.businessPatchSha256);
  assert.notEqual(ordinary.proposalRepairScope.tasksMdSha256, approved.proposalRepairScope.tasksMdSha256);
  assert.equal(compare(ordinary), 'PRESERVED');

  for (const [file, contents] of Object.entries(planFiles).filter(([file]) => !file.endsWith('/proposal.md'))) {
    await put(file, contents.replaceAll('\n', '\r\n'));
    const changed = await captureApply();
    assert.equal(changed.proposalRepairScope.workflowFilesSha256, ordinary.proposalRepairScope.workflowFilesSha256,
      'Git normalizes the raw change to the draft');
    assert.notEqual(changed.proposalRepairScope.approvedDocumentsSha256, approved.proposalRepairScope.approvedDocumentsSha256);
    assert.equal(compare(changed), 'CHANGED', file);
    await put(file, contents);
  }
  for (const [label, altered] of [
    ['heading', checked.replace('## Apply plan', '## Revised heading')],
    ['comment', checked.replace('Preserve these examples', 'Remove these examples')],
    ['ignored indented marker', checked.replace('  - [ ] Nested', '  - [x] Nested')],
    ['ignored plus marker', checked.replace('+ [ ] Example', '+ [x] Example')],
  ]) {
    await put(checklist, altered);
    assert.equal(compare(await captureApply()), 'CHANGED', label);
  }
  for (const [label, receipt] of [
    ['missing Apply', null],
    ['unsettled Apply', { ...ordinary, success: false }],
    ['foreign session', { ...ordinary, sessionId: proposalRunId }],
    ['wrong Apply run', { ...ordinary, runId: proposalRunId }],
    ['wrong base', { ...ordinary, preparedHead: '0'.repeat(40) }],
    ['missing scope', { ...ordinary, proposalRepairScope: null }],
    ['missing raw draft pin', { ...ordinary, proposalRepairScope: { ...ordinary.proposalRepairScope, approvedDocumentsSha256: null } }],
  ]) assert.equal(compare(receipt), 'UNVERIFIED', label);
  assert.equal(compare(ordinary, null), 'UNVERIFIED');
  assert.equal(compare(ordinary, { ...approved, runId: applyRunId }), 'UNVERIFIED');
  assert.equal(git('diff', '--cached', '--name-only'), '');
});
