import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyTree, hash, manifest, writeJson, within, json } from './files.mjs';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function powershell(command) {
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
}
export async function archiveDemoBundle(outDir) {
  outDir = path.resolve(outDir);
  // The distributed bundle never includes a local profile or private run.
  for (const forbidden of ['machine.yaml', 'runs', '.git']) {
    try { await fs.lstat(path.join(outDir, forbidden)); throw new Error(`Do not distribute private ${forbidden}; keep it outside the demo bundle`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const zip = `${outDir}.zip`;
  await powershell(`Compress-Archive -LiteralPath ${quote(outDir)} -DestinationPath ${quote(zip)} -Force`);
  return zip;
}
export const buildQuicksortDemo = options => buildDemoBundle({ ...options, demo: 'python-quicksort' });
export const buildSecurityTool2Demo = options => buildDemoBundle({ ...options, demo: 'security-tool-2' });
async function buildDemoBundle({ packageFile, outDir, git = 'git', demo }) {
  if (process.platform !== 'win32') throw new Error('This demo bundle targets Windows');
  outDir = path.resolve(outDir);
  const template = path.join(root, 'demos', demo);
  if (within(template, outDir)) throw new Error('Output must be outside the demo source template');
  const commit = (await execute(git, ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  const parts = ['lib', 'scripts', 'test', 'demos', 'examples', 'tutorials', 'validation', 'README.md', 'package.json', 'machine.example.yaml',
    'VALIDATION.md', 'CORRECTION-VALIDATION.md', 'FLOW-VALIDATION.md'];
  const tracked = (await execute(git, ['ls-tree', '--name-only', commit], { cwd: root, windowsHide: true })).stdout.trim().split(/\r?\n/);
  const archivedParts = parts.filter(part => tracked.includes(part));
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir); // Never overwrite a previous demo or its evidence.
  const runner = path.join(outDir, 'runner'); await fs.mkdir(runner);
  const sourceZip = path.join(outDir, '.runner-source.zip');
  await execute(git, ['-c', 'core.autocrlf=false', 'archive', '--format=zip', '--output', sourceZip, commit, '--', ...archivedParts], { cwd: root, windowsHide: true, timeout: 60000 });
  await powershell(`Expand-Archive -LiteralPath ${quote(sourceZip)} -DestinationPath ${quote(runner)}`);
  await fs.unlink(sourceZip);
  const modified = [...new Set((await Promise.all([
    execute(git, ['diff', '--name-only', commit, '--', ...parts], { cwd: root, windowsHide: true }),
    execute(git, ['ls-files', '--others', '--exclude-standard', '--', ...parts], { cwd: root, windowsHide: true })
  ])).flatMap(result => result.stdout.trim().split(/\r?\n/).filter(Boolean)))].sort();
  for (const file of modified) {
    const target = path.join(runner, file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
  }
  await copyTree(template, outDir);
  if (demo === 'security-tool-2') {
    const source = await json(path.join(outDir, 'SOURCE.json'));
    const archive = path.join(outDir, 'assets/security-tool-2-base.zip');
    if (hash(await fs.readFile(archive)) !== source.archiveSha256) throw new Error('SecurityTool original archive hash mismatch');
    await powershell(`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(path.join(outDir, 'project'))}`);
  }
  await fs.mkdir(path.join(outDir, 'packages'));
  const plugin = path.join(outDir, 'packages/runtime-corrector-ma-1.11.0.tgz');
  await fs.copyFile(packageFile, plugin);
  const metadata = { schemaVersion: demo === 'python-quicksort' ? 'rc-quicksort-demo.v1' : 'rc-security-tool-2-demo.v1', builtAt: new Date().toISOString(), runnerCommit: commit,
    runnerWorktreeOverrides: modified,
    plugin: { file: 'packages/runtime-corrector-ma-1.11.0.tgz', sha256: hash(await fs.readFile(plugin)) },
    files: await manifest(outDir), note: 'Experiment program base commit plus listed working-tree overrides, sample and RC package; actual files pinned by SHA256. No local machine profile, credentials or private run data.' };
  await writeJson(path.join(outDir, 'BUNDLE.json'), metadata);
  return { outDir, zip: await archiveDemoBundle(outDir), runnerCommit: commit };
}
