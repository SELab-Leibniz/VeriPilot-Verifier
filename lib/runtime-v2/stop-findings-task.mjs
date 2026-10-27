import { runStopProtocolTask } from './stop-protocol-task.mjs';
export const runStopFindingsTask = (input, dependencies) => runStopProtocolTask(input, { ...dependencies, kind: 'findings' });
