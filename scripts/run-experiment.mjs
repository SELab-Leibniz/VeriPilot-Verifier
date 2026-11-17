#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInputs, publicPlan } from '../lib/config.mjs';
import { run, resume, experimentExitCode } from '../lib/runner.mjs';

const args = process.argv.slice(2);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  const value = args[i + 1]; args.splice(i, 2); return value;
}
let stopped = false;
process.on('SIGINT', () => { stopped = true; console.error('Controller stopping; original sample deadline remains enforced. Use --resume to observe.'); });
process.on('SIGTERM', () => { stopped = true; });
try {
  if (args.includes('--help') || !args.length) {
    console.log('node scripts/run-experiment.mjs <experiment.yaml> [--machine machine.yaml] [--plan | --prepare-only]\nnode scripts/run-experiment.mjs --resume <run-directory>');
  } else {
    const resumeDir = option('--resume');
    let completed;
    if (resumeDir) {
      if (args.length) throw new Error('Unexpected arguments with --resume');
      completed = await resume(resumeDir, { shouldStop: () => stopped });
    } else {
      const machine = option('--machine', path.join(root, 'machine.yaml'));
      const plan = args.includes('--plan'), prepareOnly = args.includes('--prepare-only');
      const rest = args.filter(a => !['--plan', '--prepare-only'].includes(a));
      if (rest.length !== 1 || (plan && prepareOnly) || rest[0].startsWith('--')) throw new Error('Expected one experiment.yaml; see --help');
      const input = await loadInputs(rest[0], machine);
      if (plan) console.log(JSON.stringify(publicPlan(input), null, 2));
      else completed = await run(input, { prepareOnly, shouldStop: () => stopped });
    }
    if (completed) {
      console.log(`${completed.result.status}: ${completed.record.runDir}`);
      process.exitCode = experimentExitCode(completed.result);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
// Host SDK modules may retain watchers. All result writes are awaited; leaving
// this CLI must not wait for those watchers or close the sample's separate Job.
await Promise.all([new Promise(resolve => process.stdout.write('', resolve)), new Promise(resolve => process.stderr.write('', resolve))]);
process.exit(process.exitCode ?? 0);
