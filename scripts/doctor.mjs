#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInputs } from '../lib/config.mjs';
import { inspectEnvironment } from '../lib/doctor.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name); if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  const value = args[at + 1]; args.splice(at, 2); return value;
}
try {
  if (args.includes('--help')) console.log('node scripts/doctor.mjs [--machine machine.yaml] [--sample experiment.yaml] [--network]');
  else {
    const machine = option('--machine', path.join(root, 'machine.yaml'));
    const sample = option('--sample', path.join(root, 'examples/quicksort/experiment.yaml'));
    if (args.some(a => a !== '--network')) throw new Error('Unknown option; see --help');
    const report = await inspectEnvironment(await loadInputs(sample, machine), { network: args.includes('--network') });
    for (const row of report.checks) console.log(`[${row.status}] ${row.name}: ${row.detail}`);
    console.log(report.note); process.exitCode = report.ok ? 0 : 1;
  }
} catch (error) { console.error(`[FAIL] ${error.message}`); process.exitCode = 1; }
