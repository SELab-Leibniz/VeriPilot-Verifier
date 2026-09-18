import { AsyncLocalStorage } from "node:async_hooks";

// Native review runs can reload the plugin. Share the execution scope across
// module copies, but never mark the entire process (other tasks can be active).
const key = Symbol.for("runtime-corrector.openclaw.internal-context.v1");
const execution = globalThis[key] ??= new AsyncLocalStorage();

export function isInternalExecution() {
  return ["reviewer", "background"].includes(execution.getStore()?.kind);
}
export function runBackgroundExecution(sessionId, callback) {
  assertCanCreateOpenClawReviewer();
  return execution.run({ kind: "background", sessionId }, callback);
}

export function runDelegatedExecution(sessionId, callback) {
  if (execution.getStore()?.kind === "reviewer") throw new Error("Internal runs cannot delegate execution.");
  return execution.run({ kind: "background", sessionId }, callback);
}

export function isManagedExecution() { return execution.getStore()?.kind === "worker"; }

export function runManagedExecution(sessionId, callback) {
  if (isInternalExecution() || isManagedExecution()) throw new Error("Internal runs cannot create nested controllers.");
  return execution.run({ kind: "worker", sessionId }, callback);
}

export function assertCanCreateOpenClawReviewer() {
  if (!isInternalExecution()) return;
  const error = new Error("Runtime Corrector internal runs cannot create nested reviewers.");
  error.code = "SKIPPED_INTERNAL";
  throw error;
}

export async function observeInternalTool(name, args) { await execution.getStore()?.observeTool?.(name, args); }

export function runInternalExecution(sessionId, callback, observeTool) {
  assertCanCreateOpenClawReviewer();
  // Descendant callbacks retain this scope after timeout/cleanup, even when
  // the host omits the reviewer session key from a late lifecycle event.
  return execution.run({ kind: "reviewer", sessionId, observeTool }, callback);
}
