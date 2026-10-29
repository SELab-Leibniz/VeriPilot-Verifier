// Offline: reuse existing startup evidence instead of replaying 177 processes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyFrozenArtifact } from './bench/frozen-artifact-verification.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
if (!arg('--run')) throw new Error('--run=<prepared native run> required');
const directory = path.resolve(arg('--run'));
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
const original = JSON.parse(await fs.readFile(path.join(directory, 'baseline-artifact-validation.json'), 'utf8'));
assert.equal(manifest.rcSource, original.baselineRef);
const batch = await verifyFrozenArtifact({ gitExecutable: arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git'),
  cwd: process.cwd(), reference: original.baselineRef, artifact: manifest.prebuiltArtifact });
assert.deepEqual(batch.checks, original.checks);
const start = (await fs.stat(path.join(directory, 'skill-validation.json'))).mtimeMs;
const end = (await fs.stat(path.join(directory, 'baseline-artifact-validation.json'))).mtimeMs;
const report = { kind: 'offline-frozen-verification-equivalence', equivalentChecks: true,
  checkedFiles: batch.checks.length, sourceRef: original.baselineRef, artifact: manifest.prebuiltArtifact,
  original: { gitProcesses: original.checks.length + 1, observedPhaseMs: end - start,
    basis: 'Existing startup file markers; old validation was not replayed.' },
  batch: { gitProcesses: batch.gitProcesses, elapsedMs: batch.elapsedMs }, activeRunnerUnchanged: true,
  qualification: 'Observed phase timing; cache warmth and load uncontrolled. Process counts and exact hash equivalence are established. No whole-task speedup claim.' };
if (arg('--output')) await fs.writeFile(path.resolve(arg('--output')), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
