// RC-owned agent workspace boundary and official prediction patch collection.
// This never reads gold patches, evaluator scripts or test-group definitions.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const reserved = ['.runtime-corrector', '.runtime-correction'];
const environment = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', ...extra });

async function git(project, args, { env = {}, maxBytes = 32 * 1024 * 1024, allowDifference = false } = {}) {
  try {
    const result = await execute('git', ['-c', `safe.directory=${project}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'core.quotePath=true', ...args], { cwd: project, env: environment(env), encoding: 'buffer',
      maxBuffer: maxBytes, timeout: 120000 });
    return result.stdout;
  } catch (error) { if (allowDifference && error.code === 1) return null; throw fail('LITE_GIT_COMMAND_FAILED'); }
}

async function repository(projectRoot, baseCommit) {
  if (!/^[a-f0-9]{40}$/u.test(baseCommit ?? '')) throw fail('LITE_BASE_COMMIT_INVALID');
  const project = await fs.realpath(projectRoot), metadata = path.join(project, '.git');
  const stat = await fs.lstat(metadata);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('LITE_GIT_DIRECTORY_REQUIRED');
  const top = (await git(project, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  if (await fs.realpath(top) !== project) throw fail('LITE_WORKSPACE_ROOT_MISMATCH');
  const commit = (await git(project, ['rev-parse', '--verify', `${baseCommit}^{commit}`])).toString('utf8').trim();
  if (commit !== baseCommit) throw fail('LITE_BASE_COMMIT_MISMATCH');
  const collision = await git(project, ['ls-tree', '--name-only', baseCommit, '--', ...reserved]);
  if (collision.length) throw fail('LITE_RESERVED_METADATA_TRACKED_BY_TASK');
  return { project, metadata };
}

export async function prepareLiteWorkspace({ projectRoot, baseCommit, forbiddenPaths = [] }) {
  const { project, metadata } = await repository(projectRoot, baseCommit);
  for (const file of forbiddenPaths) {
    if (!path.isAbsolute(file)) throw fail('LITE_GRADER_BOUNDARY_PATH_INVALID');
    if (await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))
      throw fail('LITE_PRIVATE_GRADER_ARTIFACT_PRESENT');
  }
  const head = (await git(project, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  // No diff or untracked content is printed. Unexpected initial material needs
  // qualification before a model can inspect it.
  if (await git(project, ['diff', '--quiet', '--no-ext-diff', head, '--'], { allowDifference: true }) === null
    || await git(project, ['diff', '--cached', '--quiet', '--no-ext-diff', head, '--'], { allowDifference: true }) === null)
    throw fail('LITE_INITIAL_TRACKED_CONTENT_CHANGED');
  if ((await git(project, ['ls-files', '--others', '--exclude-standard', '-z'])).length)
    throw fail('LITE_INITIAL_UNTRACKED_CONTENT_REQUIRES_QUALIFICATION');
  // Official images may be built at an environment-setup commit. Establish
  // the declared public task base without inspecting any future source diff.
  if (head !== baseCommit) await git(project, ['checkout', '--detach', '--force', baseCommit]);
  if (await git(project, ['diff', '--quiet', '--no-ext-diff', baseCommit, '--'], { allowDifference: true }) === null
    || await git(project, ['diff', '--cached', '--quiet', '--no-ext-diff', baseCommit, '--'], { allowDifference: true }) === null)
    throw fail('LITE_PUBLIC_BASE_CHECKOUT_NOT_CLEAN');
  const tree = (await git(project, ['rev-parse', `${baseCommit}^{tree}`])).toString('utf8').trim();
  if ((await git(project, ['ls-tree', '-r', baseCommit])).toString('utf8').split('\n').some(line => line.startsWith('160000 ')))
    throw fail('LITE_SUBMODULE_WORKSPACE_NOT_QUALIFIED');
  const scratch = await fs.mkdtemp(path.join(project, '.rc-git-boundary-'));
  const fresh = path.join(scratch, 'fresh.git'), backup = path.join(scratch, 'original.git');
  let moved = false, accepted = false, rollbackFailed = false, backupMode = 'rename';
  try {
    await git(project, ['-c', 'init.templateDir=', 'init', '--bare', fresh]);
    // file:// forces upload-pack, rather than a local clone's hardlinked
    // object store. Depth1 includes the actual base commit/tree/blobs only.
    await git(project, ['--git-dir', fresh, '-c', 'protocol.file.allow=always', 'fetch',
      '--depth=1', '--no-tags', '--no-recurse-submodules', pathToFileURL(project).href, baseCommit]);
    await git(project, ['--git-dir', fresh, 'config', 'core.bare', 'false']);
    await git(project, ['--git-dir', fresh, 'symbolic-ref', 'HEAD', 'refs/heads/rc-evaluation']);
    await git(project, ['--git-dir', fresh, 'update-ref', 'refs/heads/rc-evaluation', baseCommit]);
    await git(project, ['--git-dir', fresh, '--work-tree', project, 'read-tree', baseCommit]);
    try { await fs.rename(metadata, backup); moved = true; }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      // Docker overlayfs can reject a lower-layer directory rename even
      // within one mount. Finish an opaque backup before removing the old
      // metadata; the same rollback path then restores it on any failure.
      await fs.cp(metadata, backup, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      moved = true; backupMode = 'copy_after_EXDEV';
      await fs.rm(metadata, { recursive: true, force: true });
    }
    await fs.rename(fresh, metadata);
    const actualHead = (await git(project, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    const actualTree = (await git(project, ['rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
    const commits = (await git(project, ['rev-list', '--all', '--count'])).toString('utf8').trim();
    const objects = new Set((await git(project, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])).toString('utf8').trim().split('\n'));
    const reachable = new Set((await git(project, ['rev-list', '--objects', '--all', '--no-object-names'])).toString('utf8').trim().split('\n'));
    if (actualHead !== baseCommit || actualTree !== tree || commits !== '1'
      || objects.size !== reachable.size || [...objects].some(value => !reachable.has(value))
      || (await git(project, ['remote'])).length
      || await git(project, ['diff', '--quiet', '--no-ext-diff', baseCommit, '--'], { allowDifference: true }) === null)
      throw fail('LITE_BASE_ONLY_GIT_BOUNDARY_FAILED');
    accepted = true;
    return { baseCommit, tree, originalBaseAndTrackedBytesPreserved: true, reachableCommits: 1,
      initialImageHeadDifferedFromTaskBase: head !== baseCommit, publicBaseCheckoutPerformed: head !== baseCommit,
      trackedBytesAndIndexEqualPublicBase: true, futureDiffRead: false,
      objectCount: objects.size, allObjectsReachableFromBase: true, remotes: 0,
      futureRefsAndObjectsRemoved: true, businessCommitCreated: false, metadataBackupMode: backupMode,
      qualificationScope: 'Base-only Git boundary and declared artifact paths; whole-image hidden-material absence requires separate image qualification.' };
  } catch (error) {
    if (moved) {
      try { await fs.rm(metadata, { recursive: true, force: true }); await fs.rename(backup, metadata); }
      catch { rollbackFailed = true; throw fail('LITE_GIT_BOUNDARY_ROLLBACK_FAILED'); }
    }
    throw error;
  } finally {
    if (accepted || !rollbackFailed) await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function collectLitePatch({ projectRoot, baseCommit, maxPatchBytes = 8 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes < 1) throw fail('LITE_PATCH_LIMIT_INVALID');
  const { project, metadata } = await repository(projectRoot, baseCommit);
  const indexPath = path.join(metadata, 'index');
  const before = await fs.readFile(indexPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-lite-collector-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    if (before) await fs.writeFile(env.GIT_INDEX_FILE, before, { flag: 'wx', mode: 0o600 });
    else await git(project, ['read-tree', baseCommit], { env });
    const exclusions = [];
    for (const name of reserved) {
      // Explicit negative pathspecs for ignored paths make some Git versions
      // return an addIgnoredFile error. Ignored metadata is already skipped;
      // only unignored reserved names need an explicit exclusion.
      const ignored = await git(project, ['check-ignore', '--no-index', '-q', '--', name], { allowDifference: true });
      if (ignored === null) exclusions.push(`:(top,exclude,literal)${name}`);
    }
    await git(project, ['add', '-A', '--', '.', ...exclusions], { env });
    await git(project, ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...reserved], { env });
    const bytes = await git(project, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', baseCommit, '--'],
      { env, maxBytes: maxPatchBytes });
    // Official predictions are UTF-8 JSON strings; do not silently replace
    // invalid bytes if a task needs a different patch transport.
    let patch;
    try { patch = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw fail('LITE_PATCH_UTF8_TRANSPORT_UNQUALIFIED'); }
    const after = await fs.readFile(indexPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if ((before === null) !== (after === null) || before && !before.equals(after))
      throw fail('LITE_COLLECTOR_CHANGED_BUSINESS_INDEX');
    return { patch, metadata: { baseCommit, bytes: bytes.length, sha256: digest(bytes),
      businessIndexUnchanged: true, automaticCommit: false, includesNewBusinessFiles: true,
      excludedOnlyRcOwnedMetadata: reserved } };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  const spec = JSON.parse(await fs.readFile(arg('--spec'), 'utf8'));
  const project = await fs.realpath(spec.projectRoot);
  for (const file of [arg('--result'), arg('--patch')].filter(Boolean)) {
    const relative = path.relative(project, path.resolve(file));
    if (relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
      throw fail('LITE_OUTPUT_MUST_STAY_OUTSIDE_BUSINESS_WORKSPACE');
  }
  try {
    let result;
    if (arg('--operation') === 'prepare') result = await prepareLiteWorkspace(spec);
    else if (arg('--operation') === 'collect') {
      const collected = await collectLitePatch(spec); result = collected.metadata;
      if (!arg('--patch')) throw fail('LITE_PATCH_OUTPUT_REQUIRED');
      await fs.writeFile(arg('--patch'), collected.patch, { flag: 'wx', mode: 0o600 });
    } else throw fail('LITE_WORKSPACE_OPERATION_INVALID');
    await fs.writeFile(arg('--result'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(JSON.stringify({ code: error.code ?? 'LITE_WORKSPACE_FAILED' })); process.exitCode = 1; }
}
