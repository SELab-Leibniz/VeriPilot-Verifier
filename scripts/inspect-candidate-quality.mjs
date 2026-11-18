import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readCandidateQualityEvidence } from './bench/candidate-quality-evidence.mjs';

const { values } = parseArgs({ options: { inputs: { type: 'string' }, 'inputs-sha256': { type: 'string' }, output: { type: 'string' } } });
if (!values.inputs || !values['inputs-sha256']) throw new Error(
  'Usage: node scripts/inspect-candidate-quality.mjs --inputs=<pinned inputs JSON> --inputs-sha256=<sha256> [--output=<new JSON file>]');
const report = await readCandidateQualityEvidence(values.inputs, values['inputs-sha256']);
const bytes = JSON.stringify(report, null, 2) + '\n';
if (values.output) await fs.writeFile(values.output, bytes, { flag: 'wx' });
else process.stdout.write(bytes);
