import { promises as fs } from "node:fs";
import path from "node:path";


export const host = "codeagent";
export const manifestDirectory = ".cac-plugin";
export const pluginRootEnv = "CODEAGENT3_PLUGIN_ROOT";
export const foreignPluginRootEnv = "CLAUDE_PLUGIN_ROOT";
export const defaultSemanticReviewTimeoutMs = 900000;
export const defaultReviewerTimeoutMs = 900000;
export const instructionFileNames = Object.freeze(["AGENTS.md"]);
export const reviewerContextEnvKeys = Object.freeze([]);


function assertSessionId(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new Error("Reviewer session ID must be a nonblank string without NUL bytes.");
  }
}


async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next native installation location.
    }
  }
  return null;
}


export function localSkillRoots({ pluginRoot }) {
  return pluginRoot ? [path.join(pluginRoot, "skills")] : [];
}


export async function resolveDefaultReviewerExecutable(env = process.env, platform = process.platform) {
  if (env.RUNTIME_CORRECTOR_CODEAGENT_EXECUTABLE) {
    return env.RUNTIME_CORRECTOR_CODEAGENT_EXECUTABLE;
  }
  if (platform === "win32") {
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
    return await firstExecutable([
      path.join(programFiles, "CodeAgentCLI", "bin", "codeagentcli.exe"),
    ]) ?? "codeagentcli.exe";
  }
  return "codeagentcli";
}


export function buildReviewerSessionArguments({
  sessionId = null,
  fork = false,
  noSessionPersistence = false,
} = {}) {
  const args = [];
  if (sessionId !== null && sessionId !== undefined) {
    assertSessionId(sessionId);
    args.push("--sessions", sessionId);
  }
  if (fork) args.push("--fork-session");
  if (noSessionPersistence) args.push("--no-session-persistence");
  return args;
}


function forbidden(value) {
  return value === "--session-id" || value.startsWith("--session-id=")
    || value === "--resume" || value.startsWith("--resume=")
    || value === "--continue" || value.startsWith("--continue=");
}


export function assertReviewerInvocation(args) {
  if (args.some(forbidden)) {
    throw new Error("CodeAgent reviewer arguments cannot contain --session-id, --resume, or --continue.");
  }
}
