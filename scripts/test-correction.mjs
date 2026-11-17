#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInputs } from '../lib/config.mjs';
import { run, experimentExitCode } from '../lib/runner.mjs';
import { correctionFixture } from '../test/support/install-correction-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
try {
  const args = process.argv.slice(2), prepareOnly = args.includes('--prepare-only'), withoutFrame = args.includes('--without-frame');
  const files = args.filter(arg => !['--prepare-only', '--without-frame'].includes(arg));
  if (files.length > 1) throw new Error('Usage: node scripts/test-correction.mjs [machine.yaml] [--prepare-only] [--without-frame]');
  const machineFile = files[0] ?? path.join(root, 'machine.yaml');
  const sample = withoutFrame ? 'experiment-no-frame.yaml' : 'experiment.yaml';
  const input = await loadInputs(path.join(root, 'examples/quicksort-correction', sample), machineFile);
  const { record, result } = await run(input, { ...correctionFixture, prepareOnly, shouldStop: () => stop });
  console.log(`${result.status}: ${record.runDir}`);
  process.exitCode = experimentExitCode(result);
} catch (e) { console.error(e.message); process.exitCode = 1; }
