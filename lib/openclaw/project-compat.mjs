import path from "node:path";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const permissionSdks = new Map();
export async function projectPermission(api, identity) {
  const version = api.runtime?.version;
  if (!["2026.7.1-2", "2026.10.3"].includes(version)) throw new Error("HOST_PROJECT_BINDING_PERMISSION_UNAVAILABLE");
  let resolver = api.runtime.sandbox?.resolveSandboxRuntimeStatus;
  if (!resolver) {
    if (!permissionSdks.has(version)) permissionSdks.set(version, (async () => {
      let file;
      try { file = createRequire(import.meta.url).resolve("openclaw/package.json"); }
      catch { file = path.join(path.dirname(await fs.realpath(process.argv[1])), "package.json"); }
      const pkg = JSON.parse(await fs.readFile(file, "utf8"));
      if (pkg.name !== "openclaw" || pkg.version !== version) throw new Error("HOST_PERMISSION_CONTRACT_VERSION_CONFLICT");
      return import(pathToFileURL(path.join(path.dirname(file), "dist/plugin-sdk/sandbox.js")));
    })());
    resolver = (await permissionSdks.get(version)).resolveSandboxRuntimeStatus;
  }
  if (typeof resolver !== "function") throw new Error("HOST_PROJECT_BINDING_PERMISSION_UNAVAILABLE");
  const cfg = api.runtime.config?.current?.() ?? api.config ?? {};
  return resolver({ cfg, sessionKey: identity.sessionKey });
}

// MatrixAssistant backports per-session spawnedCwd to 2026.7.1-2. Detect it
// only on the latest, identity-checked session entry, never on hook input.
// This selects directory handling, not the reviewer or lifecycle adapter.
export function projectCapability(api, entry) {
  const version = api.runtime?.version;
  if (version === "2026.7.1-2") return {
    mode: entry?.spawnedCwd != null && entry.spawnedCwd !== "" ? "native" : "legacy", version,
  };
  if (version === "2026.10.3") return { mode: "native", version };
  return { mode: "unavailable", version, reason: "HOST_PROJECT_CAPABILITY_UNVERIFIED" };
}

export function sessionIdentity(event = {}, ctx = {}) {
  const sessionId = ctx.sessionId ?? event.sessionId;
  const sessionKey = ctx.sessionKey ?? event.sessionKey;
  const agentId = ctx.agentId ?? "main";
  if (!sessionId || !sessionKey || typeof sessionId !== "string" || typeof sessionKey !== "string") {
    throw new Error("HOST_SESSION_IDENTITY_REQUIRED");
  }
  if (event.sessionId && event.sessionId !== sessionId || event.sessionKey && event.sessionKey !== sessionKey) {
    throw new Error("HOST_SESSION_IDENTITY_CONFLICT");
  }
  return { agentId, sessionId, sessionKey };
}

export async function currentSession(api, identity) {
  const sessions = api.runtime?.agent?.session;
  if (typeof sessions?.getSessionEntry !== "function" || typeof sessions.resolveStorePath !== "function") {
    throw new Error("HOST_PUBLIC_SESSION_READER_UNAVAILABLE");
  }
  const config = api.runtime.config?.current?.() ?? api.config ?? {};
  const storePath = sessions.resolveStorePath(config.session?.store, { agentId: identity.agentId });
  const entry = await sessions.getSessionEntry({ ...identity, storePath, readConsistency: "latest" });
  if (!entry || entry.sessionId !== identity.sessionId) throw new Error("HOST_SESSION_REPLACED_OR_MISSING");
  return { entry, storePath };
}

// v2026.10.3: sessions.create persists spawnedCwd (including the prepared
// worktree). Run ingress uses spawnedWorkspaceDir only for spawnedBy sessions,
// otherwise spawnedCwd. worktree.repoRoot is never an execution directory.
export function nativeProjectDirectory(entry, version = "2026.10.3") {
  if (entry.execNode || entry.execCwd || entry.repositoryWorkspaceId || entry.pendingWorktree || entry.pendingProjectGitUrl) {
    throw new Error("HOST_PROJECT_NOT_LOCAL_OR_READY");
  }
  const directory = version !== "2026.7.1-2" && entry.spawnedBy && entry.spawnedWorkspaceDir ? entry.spawnedWorkspaceDir : entry.spawnedCwd;
  if (typeof directory !== "string" || !directory || directory.includes("\0") || !path.isAbsolute(directory)) {
    throw new Error("HOST_EFFECTIVE_PROJECT_UNAVAILABLE");
  }
  return path.resolve(directory);
}
