import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const host = "openclaw";
export const targetVersion = "2026.7.1-2";
export const manifestDirectory = ".";
export const manifestFile = "openclaw.plugin.json";
export const pluginRootEnv = "RUNTIME_CORRECTOR_PLUGIN_ROOT";
export const foreignPluginRootEnv = "CLAUDE_PLUGIN_ROOT";
export { DEFAULT_REVIEW_TIMEOUT_MS as defaultSemanticReviewTimeoutMs,
  DEFAULT_REVIEW_TIMEOUT_MS as defaultReviewerTimeoutMs } from "../review-timeout.mjs";
export const instructionFileNames = Object.freeze(["AGENTS.md"]);
export const reviewerContextEnvKeys = Object.freeze([]);

function installedPackageRoot() {
  let directory = process.argv[1] && path.dirname(path.resolve(process.argv[1]));
  for (let depth = 0; directory && depth < 4; depth++) {
    try { if (JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name === "openclaw") return directory; } catch {}
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  try { return path.dirname(createRequire(import.meta.url).resolve("openclaw/package.json")); } catch {}
  return null;
}

export function localSkillRoots({ projectRoot, pluginRoot, homeDirectory = os.homedir(), config = {}, hostRoot = installedPackageRoot() }) {
  const resolve = value => path.resolve(value === "~" ? homeDirectory : value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(homeDirectory, value.slice(2)) : value);
  return [...new Set([projectRoot && path.join(projectRoot, "skills"), projectRoot && path.join(projectRoot, ".agents", "skills"),
    path.join(homeDirectory, ".agents", "skills"), path.join(homeDirectory, ".openclaw", "skills"),
    hostRoot && path.join(hostRoot, "skills"), ...(config.skills?.load?.extraDirs ?? []).filter(value => typeof value === "string" && value.trim()).map(value => resolve(value.trim())),
    path.join(homeDirectory, ".openclaw", "plugin-skills"), pluginRoot && path.join(pluginRoot, "skills")].filter(Boolean))];
}

export function resolveDefaultReviewerExecutable() {
  throw new Error("OpenClaw reviews require the native plugin runtime; a Claude-compatible CLI is not used.");
}

export function buildReviewerSessionArguments() { return resolveDefaultReviewerExecutable(); }
export function assertReviewerInvocation() { return resolveDefaultReviewerExecutable(); }
