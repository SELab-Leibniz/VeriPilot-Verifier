import os from "node:os";
import path from "node:path";

export const host = "openclaw";
export const targetVersion = "2026.7.1-2";
export const manifestDirectory = ".";
export const manifestFile = "openclaw.plugin.json";
export const pluginRootEnv = "RUNTIME_CORRECTOR_PLUGIN_ROOT";
export const foreignPluginRootEnv = "CLAUDE_PLUGIN_ROOT";
export const defaultSemanticReviewTimeoutMs = 180000;
export const defaultReviewerTimeoutMs = 180000;
export const instructionFileNames = Object.freeze(["AGENTS.md"]);
export const reviewerContextEnvKeys = Object.freeze([]);

export function localSkillRoots({ projectRoot, pluginRoot, homeDirectory = os.homedir() }) {
  return [path.join(projectRoot, "skills"), pluginRoot && path.join(pluginRoot, "skills"),
    path.join(homeDirectory, ".openclaw", "skills")].filter(Boolean);
}

export function resolveDefaultReviewerExecutable() {
  throw new Error("OpenClaw reviews require the native plugin runtime; a Claude-compatible CLI is not used.");
}

export function buildReviewerSessionArguments() { return resolveDefaultReviewerExecutable(); }
export function assertReviewerInvocation() { return resolveDefaultReviewerExecutable(); }
