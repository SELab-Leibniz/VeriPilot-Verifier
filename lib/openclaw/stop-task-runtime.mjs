import path from "node:path";
import { randomUUID } from "node:crypto";
import { runStopTaskReview } from "../runtime-v2/stop-task-review.mjs";
import { runStopTaskGroup } from "../runtime-v2/stop-task-group.mjs";
import { taskDirectory } from "../runtime-v2/task-store.mjs";
import { createInternalRunLease, releaseInternalRunLease } from "../runtime-v2/internal-run.mjs";
import { runInternalExecution } from "./internal-context.mjs";

// Secrets are registered in memory only; no provider config or auth store is
// copied into project inputs, native sessions, traces or model task documents.
export async function runOpenClawStopTask(input, { selection, env, options = {} }) {
  const resolve = value => typeof value === "string" ? value.replace(/\$\{([^}]+)\}/gu, (_match, name) => {
    if (!env[name]) throw new Error("Configured reviewer credential is unavailable.");
    return env[name];
  }) : value;
  const provider = Object.entries(selection.config.models?.providers ?? {})
    .find(([id]) => id.toLowerCase() === selection.provider.toLowerCase())?.[1];
  const definition = provider?.models?.find(item => item.id === selection.model || item.id === `${selection.provider}/${selection.model}`);
  const contextWindow = Math.min(definition?.contextWindow ?? Infinity,
    selection.config.agents?.defaults?.contextTokens ?? Infinity);
  if (!provider || !definition || !Number.isInteger(contextWindow) || contextWindow < 4096)
    throw Object.assign(new Error("Configured reviewer needs a known model context window."), { code: "REVIEW_TASK_MODEL_UNAVAILABLE" });
  const key = resolve(provider.apiKey);
  if (typeof key !== "string" || !key.trim()) throw Object.assign(new Error("Configured reviewer authentication is unavailable."), { code: "REVIEW_TASK_MODEL_UNAVAILABLE" });
  const runId = randomUUID(), sessionId = randomUUID();
  const lease = await createInternalRunLease({ projectRoot: input.projectRoot, taskId: input.taskId, role: input.role,
    ttlMs: Math.max(1800000, (input.reviewer?.timeoutMs ?? 120000) * 4) });
  // Notification callbacks are telemetry; neither callback failures nor slow
  // cleanup may erase a submitted decision or hold the Stop collector open.
  let activity = Promise.resolve();
  const notify = callback => { activity = activity.then(callback).catch(() => {}); };
  notify(() => options.onRunStart?.(runId, { role: input.role, attemptPhase: "isolated-task", startedAt: Date.now() }));
  try {
    const { ModelRuntime } = await import("../review-task/sdk.mjs");
    const runtime = await ModelRuntime.create({ authPath: path.join(taskDirectory(input.projectRoot, input.taskId), "unused-review-auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("runtime-corrector-task", { api: provider.api, baseUrl: provider.baseUrl, apiKey: key,
      headers: Object.fromEntries(Object.entries(provider.headers ?? {}).map(([name, value]) => [name, resolve(value)])),
      models: [{ ...definition, id: selection.model, name: definition.name ?? selection.model, contextWindow, input: ["text"],
        // Host configurations may omit prices. The SDK needs a cost shape;
        // zeros mean unknown billing metadata, never a claim of free usage.
        cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const execute = input.request.reviewScope?.kind === "stop-group" ? runStopTaskGroup : runStopTaskReview;
    const result = await runInternalExecution(sessionId, () => execute({ ...input,
      pluginRoot: options.pluginRoot, skillRoots: options.skillRoots,
      abortSignal: input.abortSignal ?? options.abortSignal,
      onReviewEvent: event => {
        if (event.type === "tool") notify(() => options.onTool?.({ runId, role: input.role, name: `source_${event.name}`, args: event.args }));
      } }, { modelRuntime: runtime, model: runtime.getModel("runtime-corrector-task", selection.model) }));
    return { ...result, lease, sessionId };
  } catch (error) {
    // Provider errors may echo request headers. Preserve a public code, never a
    // raw network message containing authentication or provider configuration.
    const code = typeof error.code === "string" ? error.code : "REVIEW_TASK_FAILED";
    const diagnostic = error.reviewDiagnostic;
    const allowed = new Set(["CONTEXT_UNSAFE", "CONTEXT_COMPACTION_FAILED", "CHECKPOINT_FAILED", "TURN_LIMIT", "NO_VALID_SUBMISSION"]);
    const diagnosticRoot = path.resolve(taskDirectory(input.projectRoot, input.taskId), "review-task-runs");
    const relative = typeof diagnostic?.resultPath === "string" ? path.relative(diagnosticRoot, path.resolve(diagnostic.resultPath)) : null;
    const safeDiagnostic = allowed.has(diagnostic?.cause) && relative && relative !== ".."
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(relative) === "result.json"
      ? { cause: diagnostic.cause, resultPath: path.resolve(diagnostic.resultPath) } : null;
    throw Object.assign(new Error(safeDiagnostic
      ? `Isolated Stop review did not complete (${safeDiagnostic.cause}). Details: ${safeDiagnostic.resultPath}`
      : `Isolated Stop review did not complete (${code}); inspect its saved trace.`),
    { code, ...(safeDiagnostic ? { reviewDiagnostic: safeDiagnostic } : {}) });
  } finally {
    notify(() => options.onRunEnd?.(runId, { role: input.role, endedAt: Date.now() }));
    void releaseInternalRunLease(lease).catch(() => {});
  }
}
