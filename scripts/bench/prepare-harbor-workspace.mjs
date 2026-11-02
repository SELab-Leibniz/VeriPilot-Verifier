// Identical operational layout for both arms, prepared before any model work.
// RC state is excluded via repository metadata, never a business .gitignore.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareHarborWorkspace({ projectRoot, pluginRoot, policyPath, criteriaPath }) {
  const project = await fs.realpath(projectRoot), policy = await fs.readFile(policyPath), criteria = await fs.readFile(criteriaPath);
  const directory = path.join(project, '.runtime-corrector'); await fs.mkdir(directory, { recursive: true });
  const existing = await fs.lstat(directory);
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('HARBOR_RC_POLICY_PATH_INVALID');
  for (const [name, bytes] of [['config.yaml', policy], ['harbor-document-review.md', criteria]]) {
    const file = path.join(directory, name);
    try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await fs.lstat(file)).isSymbolicLink() || hash(await fs.readFile(file)) !== hash(bytes))
        throw new Error('HARBOR_EXISTING_RC_POLICY_NEEDS_INDEPENDENT_FREEZE');
    }
  }
  let exclusion = { gitRepository: false };
  const gitMetadata = await fs.lstat(path.join(project, '.git')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  try {
    const gitRoot = (await execute('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' })).stdout.trim();
    if (await fs.realpath(gitRoot) !== project) throw new Error('HARBOR_PROJECT_NOT_REPOSITORY_ROOT');
    const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: project, encoding: 'utf8' });
    const file = result.stdout.trim();
    if (!path.isAbsolute(file) || file.includes('\n')) throw new Error('HARBOR_GIT_METADATA_PATH_INVALID');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const before = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const patterns = ['.runtime-corrector/', '.runtime-correction/'].filter(pattern => !before.split(/\r?\n/u).includes(pattern));
    if (patterns.length) await fs.appendFile(file, `${before && !before.endsWith('\n') ? '\n' : ''}${patterns.join('\n')}\n`);
    exclusion = { gitRepository: true, path: file, appended: patterns };
  } catch (error) {
    if (error.code !== 128 && !(error.code === 'ENOENT' && error.path === 'git')) throw error;
    if (gitMetadata) throw new Error(error.code === 'ENOENT' ? 'HARBOR_GIT_REQUIRED_FOR_EXISTING_REPOSITORY' : 'HARBOR_EXISTING_GIT_METADATA_UNREADABLE');
    exclusion = { gitRepository: false, gitAvailable: error.code !== 'ENOENT', reason: error.code === 'ENOENT' ? 'git executable absent' : 'workspace is not a git repository' };
  }
  const { loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')));
  const plan = await loadConfig({ cwd: project, pluginRoot }), runtime = plan.runtimeV2;
  if (plan.enabled !== true || plan.sessionDefaults?.enabled !== true || !runtime.dynamicGroundTruth.enabled
    || !runtime.skillCorrection.enabled || !runtime.artifactCorrection.groundTruthReviewEnabled || !runtime.implementationCorrection.enabled
    || runtime.implementationCorrection.platform !== null || !runtime.stopCorrection.enabled
    || Object.values(runtime.stopCorrection.metrics).filter(Boolean).length !== 16) throw new Error('HARBOR_FULL_RC_POLICY_NOT_ACTIVE');
  return { policySha256: hash(policy), criteriaSha256: hash(criteria), projectEnabled: plan.enabled,
    firstSessionEnabled: plan.sessionDefaults.enabled, activeMetrics: runtime.stopCorrection.metrics,
    dynamicGroundTruth: runtime.dynamicGroundTruth.enabled, skillCorrection: runtime.skillCorrection.enabled,
    artifactCorrection: runtime.artifactCorrection.groundTruthReviewEnabled, implementationCorrection: runtime.implementationCorrection.enabled,
    platform: runtime.implementationCorrection.platform, stopCorrection: runtime.stopCorrection.enabled,
    configuredPatterns: plan.artifacts.flatMap(artifact => artifact.scanPatterns), exclusion,
    note: 'Available modules are not claimed triggered; original task applicability controls their obligations. No automatic business commit.' };
}
