import { runStopProtocolTask } from './stop-protocol-task.mjs';
export const runStopClassificationTask = (input, dependencies) => runStopProtocolTask(input, { ...dependencies, kind: 'classification' });
