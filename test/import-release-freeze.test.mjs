import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { arktsAgentInput, digest } from '../scripts/bench/arkts-dataset.mjs';
import { arktsBusinessDiffScope } from '../scripts/bench/business-checkpoint.mjs';
import { importReleaseFreeze } from '../scripts/bench/import-release-freeze.mjs';
import { prepareFrozenArktsWorkspace } from '../scripts/bench/simplify-arkts-frozen.mjs';

const id = 'soduku-harmony_11';
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=RC Fixture', '-c', 'user.email=rc@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=nonexistent', ...args], { windowsHide: true, stdio: 'pipe' });
const write = (file, value) => fs.writeFile(file, JSON.stringify(value) + '\n');

async function fixture(t, { paired = true, workflowPath = 'openspec/changes/benchmark-change/specs/example/spec.md' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-release-freeze-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), dataset = path.join(root, 'dataset'), sourceRun = path.join(root, 'business');
  const freezeRoot = path.join(sourceRun, 'freeze'), planRoot = path.join(root, 'plan');
  await Promise.all([projectRoot, dataset, freezeRoot, path.join(planRoot, 'public')].map(directory => fs.mkdir(directory, { recursive: true })));
  git(projectRoot, 'init', '-q');
  await fs.writeFile(path.join(projectRoot, 'sudoku.ets'), 'export const diagonal = false;\n');
  git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-qm', 'task start');
  const preparedHead = git(projectRoot, 'rev-parse', 'HEAD').toString().trim();
  const task = { instance_id: id, repo: 'example/sudoku', base_commit: preparedHead, problem_statement: 'Support diagonal Sudoku.', hints_text: '',
    patch: '', test_patch: '', patch_sha256: digest(''), test_patch_sha256: digest(''), FAIL_TO_PASS: [], PASS_TO_PASS: [] };
  const datasetFile = path.join(dataset, `${id}.json`);
  await write(datasetFile, task);
  const datasetDigest = digest(await fs.readFile(datasetFile));
  const plan = path.join(planRoot, 'plan.json'), publicBytes = Buffer.from(JSON.stringify(arktsAgentInput(task)) + '\n');
  const publicInputSha256 = digest(publicBytes);
  await fs.writeFile(path.join(planRoot, 'public', `${id}.json`), publicBytes);
  const planContent = { kind: 'arkts-openclaw-openspec-instrument-pilot-v1', tasks: [{ id, baseCommit: preparedHead, datasetSha256: datasetDigest, publicSha256: publicInputSha256 }] };
  await write(plan, planContent);
  await fs.writeFile(path.join(sourceRun, 'public-input.json'), publicBytes);
  await fs.writeFile(path.join(projectRoot, 'sudoku.ets'), 'export const diagonal = true;\n');
  await fs.mkdir(path.dirname(path.join(projectRoot, workflowPath)), { recursive: true });
  await fs.writeFile(path.join(projectRoot, workflowPath), '# Workflow artifact\n');
  git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-qm', 'completed business');
  const commit = git(projectRoot, 'rev-parse', 'HEAD').toString().trim();
  const workspacePatch = git(projectRoot, 'diff', '--binary', preparedHead, commit);
  const candidate = paired ? git(projectRoot, 'diff', '--binary', preparedHead, commit, '--', ...arktsBusinessDiffScope) : workspacePatch;
  const sessionId = 'session-1', runId = 'run-1', transcript = Buffer.from(JSON.stringify({ type: 'session', id: sessionId }) + '\n');
  const frozen = { commit, preparedHead, commitSha256: digest(git(projectRoot, 'cat-file', 'commit', commit)), mutationPaths: [workflowPath, 'sudoku.ets'],
    patchSha256: digest(candidate), sessionSha256: digest(transcript), ...(paired ? { workspacePatchSha256: digest(workspacePatch) } : {}) };
  const sourceCommit = 'b'.repeat(40), release = path.join(root, 'release.json'), archive = path.join(root, 'archive');
  await fs.writeFile(archive, 'fixture archive');
  const packageSha256 = digest(await fs.readFile(archive));
  await write(release, { sourceCommit, packageSha256, archive });
  const instance = { id, baseCommit: preparedHead, datasetDigest };
  await write(path.join(sourceRun, 'manifest.json'), { instance, preparedHead, projectRoot, sourceCommit, packageSha256,
    ...(paired ? { publicInputSha256, changeName: 'benchmark-change' } : {}) });
  const result = { instance, projectRoot, businessNatural: true, frameworkError: false, nativeStopSettled: true, sessionId, sessionKey: 'agent:main:test', frozen,
    turns: [{ finalRunId: runId, terminal: { source: 'agent.wait', runId, status: 'ok' } }], ...(paired ? { publicInputSha256 } : {}) };
  const updateFreeze = async () => {
    await write(path.join(freezeRoot, 'freeze.json'), frozen);
    await write(path.join(sourceRun, 'result.json'), result);
  };
  await updateFreeze();
  await Promise.all([['candidate.patch', candidate], ['workspace.patch', workspacePatch], ['session.jsonl', transcript]]
    .map(([name, data]) => fs.writeFile(path.join(freezeRoot, name), data)));
  return { root, task, datasetDigest, planContent, freezeRoot, frozen, workspacePatch, candidate, updateFreeze,
    args: { sourceRun, output: path.join(root, 'imported'), dataset, release, plan, cacheRoot: path.join(root, 'cache') } };
}

test('imports exact scoped business and full OpenSpec workspace patches for paired replay', async t => {
  const f = await fixture(t);
  const imported = await importReleaseFreeze(f.args);
  const manifest = JSON.parse(await fs.readFile(path.join(f.args.output, 'freeze.json'), 'utf8'));
  assert.equal(imported.patchSha256, digest(f.workspacePatch));
  assert.equal(imported.businessPatchSha256, digest(f.candidate));
  assert.equal(manifest.workspacePatchSha256, manifest.patchSha256);
  assert((await fs.readFile(path.join(f.args.output, 'business-candidate.patch'))).equals(f.candidate));
  const prepared = await prepareFrozenArktsWorkspace({ frozenRoot: f.args.output, freezeSha256: imported.sha256,
    task: f.task, datasetDigest: f.datasetDigest, artifactSha256: manifest.artifactSha256, planSha256: manifest.planSha256, git: 'git',
    cacheRoot: f.args.cacheRoot, outputRoot: path.join(f.root, 'replay'), workspaceRoot: f.root });
  assert(prepared.patch.equals(f.workspacePatch));
  assert.equal(prepared.preparedHead, f.frozen.preparedHead);
});

test('rejects edited task pins, substituted Git patches, and paired before-repair mode before creating the output', async t => {
  const f = await fixture(t);
  await assert.rejects(importReleaseFreeze({ ...f.args, beforeRepairTask: 'legacy-reversal' }), /do not support before-repair/u);
  const pins = f.planContent.tasks[0], original = pins.publicSha256;
  pins.publicSha256 = '0'.repeat(64);
  await write(f.args.plan, f.planContent);
  await assert.rejects(importReleaseFreeze(f.args), /public input differs/u);
  pins.publicSha256 = original;
  await write(f.args.plan, f.planContent);
  const fullFile = path.join(f.freezeRoot, 'workspace.patch');
  await fs.writeFile(fullFile, f.candidate);
  f.frozen.workspacePatchSha256 = digest(f.candidate);
  await f.updateFreeze();
  await assert.rejects(importReleaseFreeze(f.args), /differs from the full Git diff/u);
  await fs.writeFile(fullFile, f.workspacePatch);
  f.frozen.workspacePatchSha256 = digest(f.workspacePatch);
  f.frozen.patchSha256 = digest(f.workspacePatch);
  await fs.writeFile(path.join(f.freezeRoot, 'candidate.patch'), f.workspacePatch);
  await f.updateFreeze();
  await assert.rejects(importReleaseFreeze(f.args), /differs from the scoped business Git diff/u);
  await assert.rejects(fs.stat(f.args.output), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.args.cacheRoot), { code: 'ENOENT' });
});

test('rejects unexpected workflow mutations and retains the legacy single patch contract', async t => {
  const paired = await fixture(t, { workflowPath: '.opencode/unknown.json' });
  await assert.rejects(importReleaseFreeze(paired.args), /unexpected workflow path/u);
  const legacy = await fixture(t, { paired: false });
  const imported = await importReleaseFreeze(legacy.args);
  assert.equal(imported.businessPatchSha256, undefined);
  assert((await fs.readFile(path.join(legacy.args.output, 'candidate.patch'))).equals(legacy.workspacePatch));
  await assert.rejects(fs.stat(path.join(legacy.args.output, 'business-candidate.patch')), { code: 'ENOENT' });
});
