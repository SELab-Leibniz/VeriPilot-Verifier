import os from "node:os";
import path from "node:path";

import { resolveClaudeExecutable } from "../claude-executable.mjs";


export const host = "claude";
export const manifestDirectory = ".claude-plugin";
export const pluginRootEnv = "CLAUDE_PLUGIN_ROOT";
export const foreignPluginRootEnv = "CODEAGENT3_PLUGIN_ROOT";
export const defaultSemanticReviewTimeoutMs = 240000;
export const defaultReviewerTimeoutMs = 240000;
export const instructionFileNames = Object.freeze(["AGENTS.md", "CLAUDE.md"]);
export const reviewerContextEnvKeys = Object.freeze(["CLAUDE_CONFIG_DIR"]);


function assertSessionId(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new Error("Reviewer session ID must be a nonblank string without NUL bytes.");
  }
}


export function localSkillRoots({ projectRoot, pluginRoot, homeDirectory = os.homedir() }) {
  return [
    path.join(projectRoot, ".claude", "skills"),
    pluginRoot ? path.join(pluginRoot, "skills") : null,
    path.join(homeDirectory, ".claude", "skills"),
  ].filter(Boolean);
}


export async function resolveDefaultReviewerExecutable(env = process.env, platform = process.platform) {
  return resolveClaudeExecutable(env, platform);
}


export function buildReviewerSessionArguments({
  sessionId = null,
  fork = false,
  noSessionPersistence = false,
} = {}) {
  const args = [];
  if (sessionId !== null && sessionId !== undefined) {
    assertSessionId(sessionId);
    args.push("--resume", sessionId);
  }
  if (fork) args.push("--fork-session");
  if (noSessionPersistence) args.push("--no-session-persistence");
  return args;
}


export function assertReviewerInvocation(args) {
  if (args.some((value) => value === "--sessions" || value.startsWith("--sessions="))) {
    throw new Error("Claude reviewer arguments cannot contain CodeAgent --sessions.");
  }
}
