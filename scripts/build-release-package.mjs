#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const usage = `node scripts/build-release-package.mjs --commit=<sha|ref> --out=<new directory> [--host=openclaw] [--expect-sha256=<sha>]
  git archive <commit> -> npm ci (only when a lockfile declares dependencies) -> node scripts/build-plugin.mjs -> npm pack --json
  writes <out>/release.json {packageSha256, sourceCommit, version, archive} and <out>/npm-pack.json`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function releaseMetadata({ pack, archiveBytes, archive, sourceCommit, packageJson, pluginManifest }) {
  assert(/^[0-9a-f]{40}$/u.test(sourceCommit), 'sourceCommit must be a full commit');
  assert(Array.isArray(pack) && pack.length === 1, 'npm pack must produce exactly one archive');
  const [entry] = pack;
  assert.equal(entry.name, packageJson.name);
  assert.equal(entry.version, packageJson.version);
  assert.equal(path.basename(archive), entry.filename);
  if (pluginManifest) assert.equal(pluginManifest.version, entry.version, 'plugin manifest and package versions differ');
  const shasum = createHash('sha1').update(archiveBytes).digest('hex');
  assert.equal(shasum, entry.shasum, 'archive bytes differ from npm pack output');
  return { version: entry.version, sourceCommit, packageSha256: sha256(archiveBytes), archive,
    npm: { name: entry.name, filename: entry.filename, shasum, integrity: entry.integrity, entryCount: entry.entryCount ?? entry.files?.length } };
}

const needsInstall = lock => Object.keys(lock?.packages ?? {}).some(key => key !== '') || Object.keys(lock?.dependencies ?? {}).length > 0;

export async function buildReleasePackage({ commit, out, host = 'openclaw', cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }) {
  const run = (file, args, options = {}) => execFileSync(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
  const sourceCommit = run('git', ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  const root = path.resolve(out), source = path.join(root, 'source');
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root);
  await fs.mkdir(source);
  run('git', ['archive', '--format=tar', '-o', path.join(root, 'source.tar'), sourceCommit], { cwd });
  run('tar', ['-xf', path.join(root, 'source.tar'), '-C', source]);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const npm = (args, dir) => existsSync(npmCli) ? run(process.execPath, [npmCli, ...args], { cwd: dir, encoding: 'utf8' })
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  const lock = await fs.readFile(path.join(source, 'package-lock.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  const installed = needsInstall(lock);
  if (installed) npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  const built = run(process.execPath, ['scripts/build-plugin.mjs', '--host', host], { cwd: source, encoding: 'utf8' }).trim().split(/\r?\n/u).at(-1);
  const artifact = path.resolve(source, built);
  assert.equal(path.relative(path.join(source, 'dist'), artifact).split(/[\\/]/u).length, 1, 'build-plugin wrote outside dist');
  const pack = JSON.parse(npm(['pack', '--json', '--pack-destination', root], artifact));
  await fs.writeFile(path.join(root, 'npm-pack.json'), JSON.stringify(pack, null, 2) + '\n', { flag: 'wx' });
  const archive = path.join(root, pack[0].filename);
  const pluginManifest = await fs.readFile(path.join(source, `packaging/hosts/${host}/${host}.plugin.json`), 'utf8').then(JSON.parse, () => null);
  const release = { ...releaseMetadata({ pack, archiveBytes: await fs.readFile(archive), archive, sourceCommit,
    packageJson: JSON.parse(await fs.readFile(path.join(artifact, 'package.json'), 'utf8')), pluginManifest }), host, npmCi: installed };
  await fs.writeFile(path.join(root, 'release.json'), JSON.stringify(release, null, 2) + '\n', { flag: 'wx' });
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values: args } = parseArgs({ options: { commit: { type: 'string' }, out: { type: 'string' }, host: { type: 'string' },
    'expect-sha256': { type: 'string' }, help: { type: 'boolean' } } });
  if (args.help || !args.commit || !args.out) { console.log(usage); process.exit(args.help ? 0 : 2); }
  const release = await buildReleasePackage({ commit: args.commit, out: args.out, host: args.host ?? 'openclaw' });
  if (args['expect-sha256']) assert.equal(release.packageSha256, args['expect-sha256'], 'rebuilt package differs from the expected digest');
  console.log(JSON.stringify(release, null, 2));
}
