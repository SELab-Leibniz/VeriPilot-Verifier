// Read-only observation. Never dispatches, restarts, stages or scores a run.
import { inspectArktsProgress } from './bench/progress-snapshot.mjs';
const directory = process.argv.find(value => value.startsWith('--run='))?.slice(6);
if (!directory) throw new Error('--run=<existing run directory> required');
console.log(JSON.stringify(await inspectArktsProgress(directory), null, 2));
