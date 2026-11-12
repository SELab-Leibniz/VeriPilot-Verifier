#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { digest, loadArktsTask } from './arkts-dataset.mjs';
import { businessCompleted } from './business-completion.mjs';
import { validateBusinessMutationPaths } from './business-mutations.mjs';

const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const git = (root, ...args) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', root, ...args],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const write = (file, data) => fs.writeFile(file, data, { flag: 'wx' });
const lf = text => text.replaceAll('\r\n', '\n');

// Reverse only attributable successful native edits, and require an independent
// exact source snapshot for every restored file before making a replay commit.
async function restoreBeforeRepair({ records, project, workspace, snapshots, before }) {
  const toolCalls = new Map(), edits = [];
  for (const { message } of records) {
    if (message?.role === 'assistant') for (const block of message.content ?? []) {
      if (block.type === 'toolCall' && ['edit', 'write', 'apply_patch'].includes(block.name)) toolCalls.set(block.id, block);
    }
    const call = toolCalls.get(message?.toolCallId);
    if (message?.role !== 'toolResult' || message.isError || !call) continue;
    assert.equal(call.name, 'edit', 'A post-Stop mutation cannot be reversed as a native edit.');
    assert.equal(message.toolName, 'edit');
    const [file] = validateBusinessMutationPaths([call.arguments.path ?? call.arguments.file_path], project);
    const changes = call.arguments.edits ?? [call.arguments];
    assert(changes.length && changes.every(edit => typeof edit.oldText === 'string' && typeof edit.newText === 'string' && edit.newText.length));
    edits.push({ file, changes });
  }
  assert(edits.length, 'No attributable correction edits were found.');
  const byFile = new Map();
  for (const { file, changes } of edits.reverse()) {
    let restored = byFile.get(file) ?? lf(await fs.readFile(path.join(workspace, file), 'utf8'));
    for (const { oldText, newText } of changes.toReversed()) {
      const replacement = lf(newText), index = restored.indexOf(replacement);
      assert(index >= 0 && restored.indexOf(replacement, index + 1) === -1, `Ambiguous reverse edit for ${file}`);
      restored = restored.slice(0, index) + lf(oldText) + restored.slice(index + replacement.length);
    }
    byFile.set(file, restored);
  }
  const matches = {};
  for (const name of await fs.readdir(snapshots)) {
    const snapshot = await json(path.join(snapshots, name));
    if (snapshot.omitted || snapshot.recordedAt > before || typeof snapshot.contents !== 'string') continue;
    const [file] = validateBusinessMutationPaths([snapshot.file], project);
    if (!byFile.has(file) || byFile.get(file) !== lf(snapshot.contents) || digest(snapshot.contents) !== snapshot.fingerprint) continue;
    matches[file] = { name, sha256: snapshot.fingerprint, recordedAt: snapshot.recordedAt };
  }
  for (const [file, restored] of byFile) {
    assert(matches[file], `No verified pre-repair snapshot matches ${file}`);
    await fs.writeFile(path.join(workspace, file), restored);
  }
  git(workspace, 'add', '--all');
  git(workspace, '-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'Restore the frozen state before the first repair');
  return matches;
}

export async function importReleaseFreeze({ sourceRun, output, dataset, release, plan, cacheRoot, beforeRepairTask }) {
  const [manifest, result, frozen, sourceRelease] = await Promise.all([
    json(path.join(sourceRun, 'manifest.json')), json(path.join(sourceRun, 'result.json')),
    json(path.join(sourceRun, 'freeze', 'freeze.json')), json(release),
  ]);
  const { task, datasetDigest } = await loadArktsTask(dataset, manifest.instance.id);
  assert.deepEqual(result.instance, manifest.instance);
  assert.equal(datasetDigest, manifest.instance.datasetDigest);
  assert.equal(task.base_commit, manifest.instance.baseCommit);
  assert.equal(manifest.preparedHead, frozen.preparedHead);
  assert.deepEqual(result.frozen, frozen);
  assert.equal(path.resolve(result.projectRoot), path.resolve(manifest.projectRoot));
  assert.equal(manifest.sourceCommit, sourceRelease.sourceCommit);
  assert.equal(manifest.packageSha256, sourceRelease.packageSha256);
  assert.equal(digest(await fs.readFile(sourceRelease.archive)), sourceRelease.packageSha256);
  assert(result.businessNatural && !result.frameworkError && result.nativeStopSettled);
  assert([frozen.commit, frozen.preparedHead].every(id => /^[a-f0-9]{40}$/u.test(id)));
  const last = result.turns.at(-1);
  const terminal = beforeRepairTask ? last.originalTerminal : last.terminal;
  const originalRunId = beforeRepairTask ? last.runId : last.finalRunId;
  assert(businessCompleted(terminal, originalRunId));
  const project = manifest.projectRoot;
  let transcript = await fs.readFile(path.join(sourceRun, 'freeze', 'session.jsonl'));
  let patch = await fs.readFile(path.join(sourceRun, 'freeze', 'candidate.patch'));
  assert.equal(digest(transcript), frozen.sessionSha256);
  assert.equal(digest(patch), frozen.patchSha256);
  assert.equal(digest(git(project, 'cat-file', 'commit', frozen.commit)), frozen.commitSha256);
  const canonicalPatch = git(project, 'diff', '--binary', frozen.preparedHead, frozen.commit);
  assert(canonicalPatch.equals(patch) || git(project, '-c', 'core.quotepath=false', 'diff', '--binary', frozen.preparedHead, frozen.commit).equals(patch));
  patch = canonicalPatch;
  const lines = transcript.toString('utf8').split(/\r?\n/u).filter(Boolean);
  const records = lines.map(JSON.parse);
  assert(result.sessionId && result.sessionKey && records[0]?.id === result.sessionId);
  const cache = path.join(cacheRoot, `${task.repo.replace('/', '--')}.git`);
  await fs.mkdir(cacheRoot, { recursive: true });
  if (!await fs.stat(cache).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))
    git(cacheRoot, 'init', '--bare', cache);
  git(cache, 'fetch', '--quiet', '--no-tags', '--update-shallow', project, `${frozen.commit}:refs/rc-bench/frozen/${frozen.commit}`);
  git(cache, 'merge-base', '--is-ancestor', frozen.preparedHead, frozen.commit);
  let commit = frozen.commit, restoration;
  if (beforeRepairTask) {
    assert.notEqual(last.runId, last.finalRunId, 'There was no separately admitted correction.');
    const stop = result.stopReviews.find(row => row.runId === originalRunId);
    assert(stop?.status === 'DEVIATION' && Number.isFinite(stop.startedAt));
    const boundary = records.findIndex(row => Date.parse(row.timestamp) >= stop.startedAt);
    assert(boundary > 0 && records.slice(0, boundary).findLast(row => row.message?.role === 'assistant')?.message.stopReason === 'stop');
    const workspace = path.resolve(output + '-restore');
    git(cache, 'worktree', 'add', '--detach', workspace, frozen.commit);
    restoration = await restoreBeforeRepair({ records: records.slice(boundary), project, workspace,
      snapshots: path.join(beforeRepairTask, 'artifact-snapshots'), before: stop.startedAt });
    commit = git(workspace, 'rev-parse', 'HEAD').toString().trim();
    git(cache, 'update-ref', `refs/rc-bench/frozen/${commit}`, commit);
    patch = git(cache, 'diff', '--binary', frozen.preparedHead, commit);
    transcript = Buffer.from(lines.slice(0, boundary).join('\n') + '\n');
  }
  const mutationPaths = git(cache, 'diff', '--name-only', '-z', frozen.preparedHead, commit).toString().split('\0').filter(Boolean).sort();
  const allowed = new Set(validateBusinessMutationPaths(frozen.mutationPaths, project));
  assert(mutationPaths.length && mutationPaths.every(file => allowed.has(file)), 'Imported freeze mutation scope differs.');
  const imported = { ...frozen, commit, commitSha256: digest(git(cache, 'cat-file', 'commit', commit)), mutationPaths,
    patchSha256: digest(patch), sessionSha256: digest(transcript), instanceId: task.instance_id, datasetDigest,
    artifactSha256: sourceRelease.packageSha256, planSha256: digest(await fs.readFile(plan)), sourceRun: path.resolve(sourceRun),
    sessionId: result.sessionId, sessionKey: result.sessionKey, originalRunId, terminal,
    ...(restoration ? { restoration } : {}) };
  await fs.mkdir(output);
  await write(path.join(output, 'candidate.patch'), patch);
  await write(path.join(output, 'session.jsonl'), transcript);
  const bytes = JSON.stringify(imported, null, 2) + '\n';
  await write(path.join(output, 'freeze.json'), bytes);
  return { sha256: digest(bytes), commit, mutationPaths };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: Object.fromEntries(['source-run', 'output', 'dataset', 'release', 'plan', 'cache', 'before-repair-task']
    .map(key => [key, { type: 'string' }])) });
  console.log(JSON.stringify(await importReleaseFreeze({ sourceRun: values['source-run'], output: values.output, dataset: values.dataset,
    release: values.release, plan: values.plan, cacheRoot: values.cache, beforeRepairTask: values['before-repair-task'] })));
}
