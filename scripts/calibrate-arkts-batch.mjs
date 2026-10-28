// Native Previewer uses shared ports: run evaluator jobs strictly serially.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const dataset = path.resolve(arg('--dataset') ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench');
const output = path.resolve(arg('--output') ?? `.runtime-correction/system-optimization/calibration-batch-${Date.now()}`);
await fs.mkdir(output, { recursive: false });
const cases = arg('--cases')?.split(',') ?? (await fs.readdir(dataset)).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5));
const results = [], startedAt = Date.now();
for (const id of cases) {
  const runDirectory = path.join(output, id), log = await fs.open(path.join(output, `${id}.log`), 'wx');
  const child = spawn(process.execPath, ['scripts/calibrate-arkts-bench.mjs', `--case=${id}`, `--dataset=${dataset}`, `--output=${runDirectory}`],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ phase: 'RUNNING', instanceId: id, pid: child.pid, ownerPid: process.pid, startedAt, results }, null, 2));
  child.stdout.on('data', data => { void log.write(data); process.stdout.write(data); });
  child.stderr.on('data', data => { void log.write(data); });
  const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', resolve); });
  await log.close();
  const report = await fs.readFile(path.join(runDirectory, 'results.json'), 'utf8').then(JSON.parse, () => null);
  results.push({ id, code, runDirectory, validBase: report?.results[0]?.validFailToPassBase ?? false, goldResolved: report?.results[1]?.resolved ?? false });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ kind: 'serial-native-evaluator-calibration', results }, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ phase: 'SETTLED', startedAt, endedAt: Date.now(), results }, null, 2));
process.exitCode = results.every(row => row.code === 0 && row.validBase && row.goldResolved) ? 0 : 1;
