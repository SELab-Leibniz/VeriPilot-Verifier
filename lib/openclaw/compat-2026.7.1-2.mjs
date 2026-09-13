import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { targetVersion } from "../hosts/openclaw.mjs";

// Read-only, deliberately pinned bridge. Never write into the host, patch an
// export, or substitute the deprecated optimistic boolean queue API.
export async function loadSupervisedCompatibility() {
  let packageFile;
  try { packageFile = createRequire(import.meta.url).resolve("openclaw/package.json"); }
  catch {
    const executable = await fs.realpath(process.argv[1]);
    packageFile = path.join(path.dirname(executable), "package.json");
  }
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (pkg.name !== "openclaw" || pkg.version !== targetVersion) {
    throw new Error(`Supervised execution requires the installed OpenClaw ${targetVersion} package.`);
  }
  const dist = path.join(path.dirname(packageFile), "dist");
  const sdk = await import(pathToFileURL(path.join(dist, "plugin-sdk/agent-harness.js")));
  const queueFile = path.join(dist, "runs-B0SQhu92.js");
  const source = await fs.readFile(queueFile, "utf8");
  if (!source.includes("queueEmbeddedAgentMessageWithOutcomeAsync as g")
    || !source.includes("waitForTranscriptCommit")) throw new Error("OpenClaw acknowledged steering contract changed.");
  const runs = await import(pathToFileURL(queueFile));
  const selection = await import(pathToFileURL(path.join(dist, "selection-BDanZBTQ.js")));
  const transcript = await import(pathToFileURL(path.join(dist, "user-turn-transcript-K2ELDNX3.js")));
  const sandbox = await import(pathToFileURL(path.join(dist, "plugin-sdk/sandbox.js")));
  const diagnostics = await import(pathToFileURL(path.join(dist, "plugin-sdk/diagnostic-runtime.js")));
  for (const key of ["setActiveEmbeddedRun", "clearActiveEmbeddedRun", "abortAgentHarnessRun",
    "appendSessionTranscriptMessage", "acquireSessionWriteLock", "emitAgentEvent"]) {
    if (typeof sdk[key] !== "function") throw new Error(`OpenClaw supervised capability missing: ${key}`);
  }
  if (typeof runs.g !== "function" || typeof selection.selectAgentHarness !== "function" || typeof transcript.r !== "function"
    || typeof sandbox.resolveSandboxRuntimeStatus !== "function"
    || typeof diagnostics.emitTrustedDiagnosticEvent !== "function" || typeof diagnostics.onInternalDiagnosticEvent !== "function") {
    throw new Error("OpenClaw native harness/acknowledged steering capability unavailable.");
  }
  return { ...sdk,
    onRunActivity: diagnostics.onInternalDiagnosticEvent,
    reportProgress: (params, reason) => diagnostics.emitTrustedDiagnosticEvent({ type: "run.progress", reason,
      sessionId: params.sessionId, sessionKey: params.sessionKey, runId: params.runId }),
    workerRecorder: (message, target) => transcript.r({ message, target }),
    workerPolicy: (params, workerKey) => inheritWorkerPolicy(params, workerKey, sandbox.resolveSandboxRuntimeStatus),
    nativeHarness: (params) => selection.selectAgentHarness({ ...params,
    agentHarnessId: undefined, agentHarnessRuntimeOverride: "openclaw" }),
  async queueAcknowledged(sessionId, text, options = {}) {
    const outcome = await runs.g(sessionId, text, { ...options, steeringMode: "all", waitForTranscriptCommit: true });
    if (outcome?.queued !== true || !Number.isFinite(outcome.deliveredAtMs)) {
      throw new Error(`OpenClaw did not acknowledge the requirement: ${outcome?.reason ?? "invalid queue response"}`);
    }
    return outcome;
  } };
}

export function inheritWorkerPolicy(params, workerKey, resolveStatus) {
  let config = params.config ?? {};
  const parent = resolveStatus({ cfg: config, sessionKey: params.sandboxSessionKey ?? params.sessionKey });
  const initial = resolveStatus({ cfg: config, sessionKey: workerKey });
  if (parent.agentId !== initial.agentId) throw new Error("Worker policy must retain the parent agent identity.");
  if (parent.sandboxed !== initial.sandboxed) {
    config = structuredClone(config);
    config.agents ??= {};
    const agents = config.agents.list ??= [];
    let agent = agents.find((entry) => entry.id === parent.agentId);
    if (!agent) { agent = { id: parent.agentId }; agents.push(agent); }
    // Resolve the parent's main/non-main exemption once. This is a private
    // per-run config; all other sandbox settings and tool policy are retained.
    agent.sandbox = { ...agent.sandbox, mode: parent.sandboxed ? "all" : "off" };
  }
  const worker = resolveStatus({ cfg: config, sessionKey: workerKey });
  if (parent.sandboxed !== worker.sandboxed || JSON.stringify(parent.toolPolicy) !== JSON.stringify(worker.toolPolicy)) {
    throw new Error("OpenClaw could not preserve the parent's sandbox/tool policy for a private worker.");
  }
  // 2026.7.1-2 also uses sandboxSessionKey for global assistant/lifecycle
  // events. A parent key here leaks pre-assessment candidates to the UI.
  return { config, sandboxSessionKey: workerKey };
}
