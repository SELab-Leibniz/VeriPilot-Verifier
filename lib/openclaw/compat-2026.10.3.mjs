import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pending;
// Public SDK exports only; no bundled chunk names or host patches.
export function loadNativeCompatibility() {
  return pending ??= (async () => {
    let packageFile;
    try { packageFile = createRequire(import.meta.url).resolve("openclaw/package.json"); }
    catch { packageFile = path.join(path.dirname(await fs.realpath(process.argv[1])), "package.json"); }
    const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
    if (pkg.name !== "openclaw" || pkg.version !== "2026.10.3") throw new Error("Native project adapter requires OpenClaw 2026.10.3.");
    const sdk = name => import(pathToFileURL(path.join(path.dirname(packageFile), "dist/plugin-sdk", `${name}.js`)));
    const [sessions, diagnostics, agent] = await Promise.all([sdk("session-store-runtime"), sdk("diagnostic-runtime"), sdk("agent-harness-runtime")]);
    if (typeof sessions.loadTranscriptEventsSync !== "function" || typeof diagnostics.onInternalDiagnosticEvent !== "function"
      || typeof diagnostics.emitTrustedDiagnosticEvent !== "function" || typeof agent.emitAgentEvent !== "function") {
      throw new Error("OpenClaw 2026.10.3 public native contract unavailable.");
    }
    return { loadTranscriptEvents: sessions.loadTranscriptEventsSync,
      formatSessionMarker: sessions.formatSqliteSessionFileMarker, deleteSessionEntry: sessions.deleteSessionEntry,
      onRunActivity: diagnostics.onInternalDiagnosticEvent, onAgentEvent: agent.onAgentEvent,
      emitAgentEvent: agent.emitAgentEvent,
      reportProgress: (parent, reason) => diagnostics.emitTrustedDiagnosticEvent({ type: "run.progress", reason, ...parent }),
    };
  })();
}

// Only private RC reviewer UUIDs may enter this transport. Newer hosts own
// their transcripts in SQLite and reject the old private JSONL filename.
// Keep the role's identity across repairs; do not create a business harness.
export function createNativeReviewerRunner(api, load = loadNativeCompatibility) {
  const owned = new Map();
  const run = async params => {
    const { agentId, sessionId, sessionKey } = params;
    if (sessionKey !== `agent:${agentId}:runtime-corrector:${sessionId}`) throw new Error("NATIVE_REVIEWER_IDENTITY_REQUIRED");
    params.abortSignal?.throwIfAborted();
    const sessions = api.runtime.agent.session, sdk = await load();
    if (typeof sessions?.upsertSessionEntry !== "function" || typeof sdk.formatSessionMarker !== "function") throw new Error("NATIVE_REVIEWER_SESSION_API_UNAVAILABLE");
    const storePath = sessions.resolveStorePath(params.config?.session?.store, { agentId });
    const identity = { agentId, sessionId, sessionKey, storePath };
    const entry = await sessions.getSessionEntry({ ...identity, readConsistency: "latest" });
    if (entry && (entry.sessionId !== sessionId || !owned.has(sessionKey))) throw new Error("NATIVE_REVIEWER_SESSION_CONFLICT");
    const marker = sdk.formatSessionMarker(identity);
    if (!entry) {
      await sessions.upsertSessionEntry({ ...identity, entry: { sessionId, createdAt: Date.now(), updatedAt: Date.now(),
        sessionFile: marker, spawnedCwd: params.cwd ?? params.workspaceDir } });
      owned.set(sessionKey, identity);
    }
    params.abortSignal?.throwIfAborted();
    const live = await sessions.getSessionEntry({ ...identity, readConsistency: "latest" });
    if (live?.sessionId !== sessionId) throw new Error("NATIVE_REVIEWER_SESSION_REPLACED");
    return api.runtime.agent.runEmbeddedAgent({ ...params, sessionFile: marker, sessionTarget: identity });
  };
  run.close = async (sessionKey, sessionId) => {
    const identity = owned.get(sessionKey);
    if (!identity || identity.sessionId !== sessionId) return;
    const sdk = await load();
    await sdk.deleteSessionEntry({ ...identity, expectedSessionId: sessionId, archiveTranscript: false });
    owned.delete(sessionKey);
  };
  return run;
}
