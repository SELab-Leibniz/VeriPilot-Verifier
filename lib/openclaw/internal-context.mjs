import { AsyncLocalStorage } from "node:async_hooks";

// Native review runs can reload the plugin. Share the execution scope across
// module copies, but never mark the entire process (other tasks can be active).
const key = Symbol.for("runtime-corrector.openclaw.internal-context.v1");
const execution = globalThis[key] ??= new AsyncLocalStorage();

export function isInternalExecution() {
  return execution.getStore()?.kind === "reviewer";
}

export function assertCanCreateOpenClawReviewer() {
  if (!isInternalExecution()) return;
  const error = new Error("Runtime Corrector internal runs cannot create nested reviewers.");
  error.code = "SKIPPED_INTERNAL";
  throw error;
}

export function runInternalExecution(sessionId, callback) {
  assertCanCreateOpenClawReviewer();
  // Descendant callbacks retain this scope after timeout/cleanup, even when
  // the host omits the reviewer session key from a late lifecycle event.
  return execution.run({ kind: "reviewer", sessionId }, callback);
}
