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
  const auth = await import(pathToFileURL(path.join(dist, "plugin-sdk/agent-runtime.js")));
  const discovery = await import(pathToFileURL(path.join(dist, "agent-model-discovery-BuQHUPIv.js")));
  for (const key of ["setActiveEmbeddedRun", "clearActiveEmbeddedRun", "abortAgentHarnessRun",
    "appendSessionTranscriptMessage", "acquireSessionWriteLock", "emitAgentEvent"]) {
    if (typeof sdk[key] !== "function") throw new Error(`OpenClaw supervised capability missing: ${key}`);
  }
  if (typeof runs.g !== "function" || typeof selection.selectAgentHarness !== "function" || typeof transcript.r !== "function"
    || typeof sandbox.resolveSandboxRuntimeStatus !== "function"
    || typeof diagnostics.emitTrustedDiagnosticEvent !== "function" || typeof diagnostics.onInternalDiagnosticEvent !== "function"
    || typeof auth.prepareSimpleCompletionModel !== "function" || typeof auth.applyAuthHeaderOverride !== "function"
    || typeof discovery.t !== "function" || typeof discovery.n !== "function") {
    throw new Error("OpenClaw native harness/acknowledged steering capability unavailable.");
  }
  return { ...sdk,
    async prepareNativeAttempt(params) {
      // A custom harness bypasses native auth bootstrap. Use the official auth
      // preparation API with per-attempt stores, never a nested public run (it
      // would double-admit the same session and emit a second lifecycle).
      const authStorage = discovery.t(params.agentDir, { skipCredentials: true });
      const modelRegistry = discovery.n(authStorage, params.agentDir);
      const prepared = await auth.prepareSimpleCompletionModel({ cfg: params.config,
        provider: params.provider, modelId: params.modelId, agentDir: params.agentDir,
        profileId: params.authProfileId, useAsyncModelResolution: true,
        allowMissingApiKeyModes: ["aws-sdk"],
        modelResolver: async () => ({ model: structuredClone(params.model), authStorage, modelRegistry }) });
      if (prepared.error || !prepared.model) throw new Error(prepared.error ?? "Native model authentication unavailable.");
      if (!prepared.auth.apiKey && prepared.auth.mode === "aws-sdk") authStorage.setRuntimeApiKey(params.provider, "__aws_sdk_auth__");
      return { ...params, model: auth.applyAuthHeaderOverride(prepared.model, prepared.auth, params.config),
        resolvedApiKey: prepared.auth.apiKey, authProfileId: prepared.auth.profileId ?? params.authProfileId,
        authStorage, modelRegistry, runtimePlan: undefined,
        agentHarnessRuntimeOverride: "openclaw", agentHarnessOverride: undefined, agentHarnessId: "openclaw" };
    },
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

export async function loadInteractionCompatibility({ packageFile } = {}) {
  if (!packageFile) {
    try { packageFile = createRequire(import.meta.url).resolve("openclaw/package.json"); }
    catch { packageFile = path.join(path.dirname(await fs.realpath(process.argv[1])), "package.json"); }
  }
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (pkg.name !== "openclaw" || pkg.version !== targetVersion) throw new Error("Interaction controls require OpenClaw 2026.7.1-2.");
  const dist = path.join(path.dirname(packageFile), "dist");
  const browserClient = "gateway-CWCQz7bR.js";
  const [source, types, dispatch] = await Promise.all([
    fs.readFile(path.join(dist, "control-ui/assets", browserClient), "utf8"),
    fs.readFile(path.join(dist, "hook-types-DQ9eTy2x.d.ts"), "utf8"),
    fs.readFile(path.join(dist, "dispatch-DnzGTpPs.js"), "utf8"),
  ]);
  if (!source.includes("fe as t") || !source.includes("request(e,t)") || !source.includes("onHello") || !source.includes("connect.challenge")
    || !types.includes("PluginHookReplyDispatchContext") || !dispatch.includes("runReplyDispatch")) throw new Error("Pinned browser/dispatch contract changed; no fallback client is allowed.");
  const sdk = await import(pathToFileURL(path.join(dist, "plugin-sdk/gateway-runtime.js")));
  const sessions = await import(pathToFileURL(path.join(dist, "plugin-sdk/session-store-runtime.js")));
  for (const key of ["callGatewayFromCli", "addGatewayClientOptions"]) if (typeof sdk[key] !== "function") throw new Error(`Missing Gateway CLI capability: ${key}`);
  for (const key of ["getSessionEntry", "resolveStorePath"]) if (typeof sessions[key] !== "function") throw new Error(`Missing native session capability: ${key}`);
  return { ...sdk, browserClient, version: targetVersion,
    currentSession(config, agentId, sessionKey) {
      return sessions.getSessionEntry({ storePath: sessions.resolveStorePath(config.session?.store, { agentId }),
        sessionKey, agentId, readConsistency: "latest" });
    } };
}
