// Remove prompt-version identity and timing before independent semantic review.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sourceRepo } from '../long/harness-common.mjs';
import { resolveFixtureList } from './fixture-paths.mjs';
const [runName, tag, domain = 'all'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/u.test(runName ?? '') || !/^[A-Z][0-9]*$/u.test(tag ?? '') || !['all', 'kitchen', 'flower'].includes(domain)) throw new Error('Usage: prepare-audit.mjs RUN_DIRECTORY OPAQUE_TAG [DOMAIN]');
const root = path.resolve(await sourceRepo(), process.env.REVIEW_EXPERIMENT_ROOT ?? '.runtime-correction/review-module-lab-20261024-02/prompt-accuracy-20261024-01');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const run = await read(path.join(root, runName, 'report.json')).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return read(path.join(root, runName, 'progress.json'));
});
let cases = (await Promise.all(['kitchen', 'flower'].map(domain => read(path.join(root, 'fixtures', domain, 'cases.json')))))
  .flatMap(value => Array.isArray(value) ? value : value.cases);
const extension = await read(path.join(root, 'freeze-extension.json')).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (extension) cases.push(...extension.descriptors);
cases = await resolveFixtureList(root, cases.filter(item => run.rows.some(row => row.caseId === item.caseId)));
const rows = [];
for (const row of run.rows.filter(item => domain === 'all' || item.domain === domain)) {
  const item = cases.find(candidate => candidate.caseId === row.caseId);
  const task = await read(item.task), oracle = await read(item.oracle);
  rows.push({ caseId: row.caseId, metricId: row.metricId, domain: row.domain, split: row.split,
    inputWorkspace: item.workspace, task, oracle,
    actual: { completed: row.result?.completed ?? false, scope: row.result?.scope ?? null, verdict: row.result?.verdict ?? null,
      reason: row.result?.reason ?? row.error, refs: row.result?.refs ?? [], citationIntegrity: row.citationIntegrity ?? false },
    disclosedReads: row.result ? await read(path.join(root, runName, row.caseId, 'review/reads.json')) : [] });
}
await fs.mkdir(path.join(root, 'semantic-input'), { recursive: true });
await fs.writeFile(path.join(root, 'semantic-input', `${tag}.json`), JSON.stringify({ schemaVersion: 'blind-semantic-review.v1', tag, rows,
  instruction: 'Judge each result from the frozen task, original inputs and evidence. Do not inspect prompt profiles, other batches or run directories. Check the oracle against originals, not by label alone. Return labelCorrect, diagnosisSupported, scopeCorrect and groundedCorrect per case, with short evidence locations. A completed UNVERIFIED needs the right missing-proof reason; infrastructure failure is not correct abstention.' }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ tag, cases: rows.length, output: path.join(root, 'semantic-input', `${tag}.json`) }));
