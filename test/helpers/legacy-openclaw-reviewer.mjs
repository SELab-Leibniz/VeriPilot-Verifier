// Explicit development baseline. Production packages never import this file
// or the old Stop copier; modern workspace scopes still use the shared engine.
import { createOpenClawReviewerFactory as createProductionFactory } from '../../lib/openclaw/reviewer.mjs';
import { runOpenClawStopTask } from '../compat/legacy-stop-task-runtime.mjs';
export * from '../../lib/openclaw/reviewer.mjs';

export function createOpenClawReviewerFactory(api, options = {}) {
  const target = options.runStopTask ?? runOpenClawStopTask;
  const execute = Object.assign((...args) => target(...args), {
    assertInput: target.assertInput ?? runOpenClawStopTask.assertInput,
    accepts: target.accepts ?? runOpenClawStopTask.accepts,
  });
  return Object.assign(createProductionFactory(api, { ...options, runStopTask: execute }), { supportsStopGroups: true });
}
