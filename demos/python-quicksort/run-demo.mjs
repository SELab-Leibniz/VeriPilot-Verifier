#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const load = file => import(pathToFileURL(path.join(root, 'runner', file)));
let stopped = false;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node run-demo.mjs [--machine machine.yaml] [--plan | --prepare-only]\nnode run-demo.mjs --status <run-directory>\nnode run-demo.mjs --resume <run-directory>');
  } else if (args[0] === '--status' && args.length === 2) {
    const { queryExperimentStatus } = await load('lib/experiment-status.mjs');
    console.log(JSON.stringify(await queryExperimentStatus(args[1]), null, 2));
  } else {
    const { run, resume, experimentExitCode } = await load('lib/runner.mjs');
    let completed;
    if (args[0] === '--resume' && args.length === 2) completed = await resume(args[1], { shouldStop: () => stopped });
    else {
      let machine = path.join(root, 'machine.yaml');
      const at = args.indexOf('--machine');
      if (at >= 0) {
        if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error('Missing --machine value');
        machine = path.resolve(args[at + 1]); args.splice(at, 2);
      }
      if (args.length > 1 || args.some(a => !['--plan', '--prepare-only'].includes(a))) throw new Error('Unknown arguments; see --help');
      const { loadInputs, publicPlan } = await load('lib/config.mjs');
      const input = await loadInputs(path.join(root, 'experiment.yaml'), machine);
      if (!input.paths.python) throw new Error('Set paths.python to the actual Python executable in machine.yaml');
      if (args.includes('--plan')) console.log(JSON.stringify(publicPlan(input), null, 2));
      else {
        const { correctionFixture } = await load('test/support/install-correction-fixture.mjs');
        completed = await run(input, { ...correctionFixture, prepareOnly: args.includes('--prepare-only'), shouldStop: () => stopped });
      }
    }
    if (completed) {
      console.log(`${completed.result.status}: ${completed.record.runDir}`);
      console.log(`Status: ${path.join(completed.record.runDir, 'experiment-status.json')}`);
      process.exitCode = experimentExitCode(completed.result);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
await Promise.all([new Promise(resolve => process.stdout.write('', resolve)), new Promise(resolve => process.stderr.write('', resolve))]);
process.exit(process.exitCode ?? 0);
