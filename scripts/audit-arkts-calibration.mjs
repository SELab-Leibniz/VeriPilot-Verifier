// Offline audit: replay original runtime evidence, retaining initial results.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadArktsTask } from './bench/arkts-dataset.mjs';
import { parseHypium, gradeArkts } from './bench/hypium-results.mjs';
const base = path.resolve('.runtime-correction/system-optimization');
const roots = [path.join(base, 'calibration/happyword12-001')];
for (const parent of ['calibration-dev-001', 'calibration-heldout-001', ...process.argv.filter(arg => arg.startsWith('--batch=')).map(arg => arg.slice(8))]) {
  const directory = path.join(base, parent);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) roots.push(path.join(directory, entry.name));
}
const records = [];
const dataset = process.argv.find(arg => arg.startsWith('--dataset='))?.slice('--dataset='.length) ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench';
for (const root of roots) {
  const original = await fs.readFile(path.join(root, 'results.json'), 'utf8').then(JSON.parse, () => null);
  const id = original?.instanceId ?? path.basename(root), phases = [];
  if (!original) { records.push({ id, root, state: 'INFRASTRUCTURE_FAILED_BEFORE_RESULTS' }); continue; }
  const { task, datasetDigest } = await loadArktsTask(dataset, id);
  if (datasetDigest !== original.environment.datasetDigest) throw new Error(`Changed dataset: ${id}`);
  for (const prior of original.results) {
    const raw = await fs.readFile(path.join(root, `${prior.phase}-coverage.log`), 'utf8'), parsed = parseHypium(raw);
    phases.push({ phase: prior.phase, ...gradeArkts(task, parsed, prior.execution), recovered: parsed.recovered,
      runtimeSha256: createHash('sha256').update(raw).digest('hex') });
  }
  records.push({ id, root, state: 'AUDITED_EXISTING_NATIVE_RUN', originalResultsPreserved: true, environment: original.environment,
    baseValid: phases.find(row => row.phase === 'base')?.validFailToPassBase === true,
    goldValid: phases.find(row => row.phase === 'gold')?.resolved === true, phases });
}
const report = { kind: 'offline-native-calibration-audit', createdAt: new Date().toISOString(),
  evaluatorSha256: createHash('sha256').update(await fs.readFile(new URL('./bench/hypium-results.mjs', import.meta.url))).digest('hex'), records,
  scope: 'Original native runtime only; no model or test rerun. Initial failures and parser results remain in their original files.' };
await fs.writeFile(path.join(base, 'calibration-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(records.map(({ id, state, baseValid, goldValid }) => ({ id, state, baseValid, goldValid }))));
