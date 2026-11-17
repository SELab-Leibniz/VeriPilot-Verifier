#!/usr/bin/env node
import { queryExperimentStatus, EXPERIMENT_STATUS_SCHEMA } from '../lib/experiment-status.mjs';

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/experiment-status.mjs <run-directory>\nOutputs JSON; exit 0 means the query succeeded, regardless of experiment outcome.');
  } else {
    if (args.length !== 1 || args[0].startsWith('--')) throw Object.assign(new Error('Expected one run directory; see --help'), { code: 'INVALID_ARGUMENTS' });
    console.log(JSON.stringify(await queryExperimentStatus(args[0]), null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: EXPERIMENT_STATUS_SCHEMA, status: 'UNKNOWN', terminal: false,
    resourcesReleased: null, canScheduleNext: false, error: { code: error.code ?? 'STATUS_QUERY_FAILED', message: error.message } }, null, 2));
  process.exitCode = 1;
}
await new Promise(resolve => process.stdout.write('', resolve));
process.exit(process.exitCode ?? 0);
