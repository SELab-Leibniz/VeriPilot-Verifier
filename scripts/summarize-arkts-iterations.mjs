import fs from 'node:fs/promises';
import path from 'node:path';
import { loadArktsTask } from './bench/arkts-dataset.mjs';
import { summarizeArktsIterations } from './bench/iteration-summary.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
if (!arg('--suite')) throw new Error('--suite=<iteration directory> required');
const suite = await fs.realpath(arg('--suite'));
const dataset = path.resolve(arg('--dataset') ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench');
const read = file => fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
const ids = (await fs.readdir(dataset)).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5))
  .sort((a, b) => Number(a.split('_').at(-1)) - Number(b.split('_').at(-1)));
const cases = [];
for (const id of ids) {
  const { task, datasetDigest } = await loadArktsTask(dataset, id);
  const root = path.join(suite, id), attempts = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries.filter(row => row.isDirectory() && /^attempt-\d+$/u.test(row.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const directory = path.join(root, entry.name), native = await read(path.join(directory, 'result.json'));
    const manifest = await read(path.join(directory, 'manifest.json'));
    const graded = await read(path.join(root, `${entry.name}-grade`, 'results.json'));
    for (const value of [native, manifest, graded]) if (value && (value.instanceId !== id || (value.datasetDigest ?? value.environment?.datasetDigest) !== datasetDigest))
      throw new Error(`Mismatched run evidence: ${directory}`);
    if (graded && (!native || !graded.candidateSha256)) throw new Error(`Grade has no captured candidate: ${directory}`);
    if (graded) {
      const { digest } = await import('./bench/arkts-dataset.mjs');
      if (digest(await fs.readFile(path.join(directory, 'candidate.patch'))) !== graded.candidateSha256)
        throw new Error(`Candidate changed after grading: ${directory}`);
    }
    attempts.push({ directory, native, grade: graded?.results?.find(row => row.phase === 'candidate') ?? null,
      review: await read(path.join(root, `${entry.name}-review.json`)) });
  }
  cases.push({ id, datasetDigest, f2p: task.FAIL_TO_PASS.length, p2p: task.PASS_TO_PASS.length, attempts });
}
const report = { kind: 'sequential-arkts-development', capturedAt: new Date().toISOString(), ...summarizeArktsIterations(cases), cases };
await fs.writeFile(path.join(suite, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ firstAttempts: report.firstAttempts, latestAttempts: report.latestAttempts }));
