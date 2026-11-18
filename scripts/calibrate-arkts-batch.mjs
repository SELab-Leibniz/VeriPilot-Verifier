// Native Previewer uses shared ports: run evaluator jobs strictly serially.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const evaluatorOptions = ['tool-root', 'java-home', 'cache', 'workspace-root', 'json5-package', 'phase-timeout-ms', 'git', 'instrument-config'];
const { values: args } = parseArgs({ options: {
  ...Object.fromEntries(['dataset', 'output', 'cases', ...evaluatorOptions].map(key => [key, { type: 'string' }])),
  'pin-toolchain': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (args.help) {
  console.log(`node scripts/calibrate-arkts-batch.mjs --dataset=<task JSON directory> --output=<new calibration directory>
  [--cases=<comma-separated IDs>] [--pin-toolchain] [${evaluatorOptions.map(key => `--${key}=<value>`).join(' ')}]
  Calibrates base and gold serially on Windows x64 or macOS arm64. No model is called.`);
  process.exit(0);
}
const dataset = path.resolve(args.dataset ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench');
const output = path.resolve(args.output ?? `.runtime-correction/system-optimization/calibration-batch-${Date.now()}`);
const cases = args.cases?.split(',') ?? (await fs.readdir(dataset)).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort();
if (!cases.length || new Set(cases).size !== cases.length || cases.some(id => !/^[a-z0-9_-]+$/u.test(id))) {
  throw new Error('Supply distinct, valid benchmark case IDs.');
}
const options = evaluatorOptions.filter(key => args[key] !== undefined).map(key => `--${key}=${args[key]}`);
if (args['pin-toolchain']) options.push('--pin-toolchain');
const evaluator = fileURLToPath(new URL('./calibrate-arkts-bench.mjs', import.meta.url));
await fs.mkdir(output, { recursive: false });
const results = [], startedAt = Date.now();
for (const id of cases) {
  const runDirectory = path.join(output, id), log = await fs.open(path.join(output, `${id}.log`), 'wx');
  const child = spawn(process.execPath, [evaluator, `--case=${id}`, `--dataset=${dataset}`, `--output=${runDirectory}`, ...options],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', resolve); });
  child.stdout.on('data', data => { void log.write(data); process.stdout.write(data); });
  child.stderr.on('data', data => { void log.write(data); });
  await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ phase: 'RUNNING', instanceId: id, pid: child.pid, ownerPid: process.pid, startedAt, results }, null, 2));
  const code = await finished;
  await log.close();
  const report = await fs.readFile(path.join(runDirectory, 'results.json'), 'utf8').then(JSON.parse, () => null);
  results.push({ id, code, runDirectory, validBase: report?.results[0]?.validFailToPassBase ?? false, goldResolved: report?.results[1]?.resolved ?? false });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ kind: 'serial-native-evaluator-calibration', results }, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ phase: 'SETTLED', startedAt, endedAt: Date.now(), results }, null, 2));
process.exitCode = results.every(row => row.code === 0 && row.validBase && row.goldResolved) ? 0 : 1;
