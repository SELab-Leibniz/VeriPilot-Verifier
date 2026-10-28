import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as activeHost from "../active-host.mjs";
import { isPathInside } from "../path-utils.mjs";
import { sha256 } from "./utils.mjs";


const TEXT_EXTENSIONS = new Set([
  ".c", ".cjs", ".cpp", ".css", ".html", ".js", ".json", ".jsx",
  ".md", ".mjs", ".ps1", ".py", ".sh", ".toml", ".ts", ".tsx",
  ".txt", ".yaml", ".yml",
]);
const SENSITIVE_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", "credentials", "credentials.json",
  "id_rsa", "id_ed25519", "secrets.json",
]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".runtime-correction", "__pycache__", ".cache"]);
const scanCache = new Map();


function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i");
}


export function selectedSkill(skillId, selection) {
  if (!selection) return false;
  if ((selection.exclude ?? []).some((pattern) => globToRegExp(pattern).test(skillId))) return false;
  if (selection.mode === "all") return true;
  return (selection.include ?? []).some((pattern) => globToRegExp(pattern).test(skillId));
}


export function skillIdFromInput(input) {
  const raw = input?.tool_input?.skill
    ?? input?.tool_input?.name
    ?? input?.tool_input?.command
    ?? input?.tool_input?.skill_name;
  if (typeof raw !== "string") return null;
  return raw.trim().replace(/^\//, "") || null;
}


async function isDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}


export async function resolveSkillDirectory({
  skillId,
  projectRoot,
  pluginRoot,
  configuredRoots = [],
  hostAdapter = activeHost,
}) {
  if (!skillId) return null;
  const shortId = skillId.split(":").at(-1);
  const roots = [
    ...configuredRoots,
    ...hostAdapter.localSkillRoots({ projectRoot, pluginRoot, homeDirectory: os.homedir() }),
  ].filter(Boolean).map((root) => path.resolve(root));
  for (const root of roots) {
    for (const name of [skillId, shortId]) {
      const candidate = path.resolve(root, name);
      if (!isPathInside(root, candidate)) continue;
      if (await isDirectory(candidate)) return candidate;
    }
  }
  return null;
}


function sensitive(fileName) {
  const lower = fileName.toLowerCase();
  return SENSITIVE_NAMES.has(lower)
    || lower.includes("secret")
    || lower.endsWith(".pem")
    || lower.endsWith(".key");
}


export async function scanSkillDirectory(directory, { maxFiles = 200, maxBytes = 2 * 1024 * 1024, cache = true } = {}) {
  if (![maxFiles, maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid Skill scan budget.");
  const root = await fs.realpath(directory);
  const cacheKey = JSON.stringify([root, maxFiles, maxBytes]);
  const previous = cache ? scanCache.get(cacheKey) : null;
  const next = new Map();
  const files = [];
  const stats = { directories: 0, filesRead: 0, cacheHits: 0, bytesRead: 0 };
  let totalBytes = 0, truncated = false;
  async function visit(current) {
    stats.directories++;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => Number(right.name === "SKILL.md") - Number(left.name === "SKILL.md") || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (sensitive(entry.name) || IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
      if (files.length >= maxFiles) { truncated = true; return; }
      const candidate = path.join(current, entry.name);
      const resolved = await fs.realpath(candidate);
      if (!isPathInside(root, resolved)) continue;
      if (entry.isDirectory()) {
        await visit(resolved);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && entry.name !== "SKILL.md") continue;
      const before = await fs.stat(resolved, { bigint: true });
      if (before.size > BigInt(maxBytes - totalBytes)) { truncated = true; continue; }
      const stamp = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":");
      const cached = previous?.get(resolved);
      const contents = cached?.stamp === stamp ? cached.contents : await fs.readFile(resolved);
      if (cached?.stamp === stamp) stats.cacheHits++;
      else { stats.filesRead++; stats.bytesRead += contents.length; }
      const after = await fs.stat(resolved, { bigint: true });
      if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":") !== stamp)
        throw Object.assign(new Error("Skill source changed during scan."), { code: "SKILL_SOURCE_STALE" });
      if (contents.includes(0)) continue;
      if (totalBytes + contents.length > maxBytes) { truncated = true; continue; }
      next.set(resolved, { stamp, contents });
      totalBytes += contents.length;
      files.push({
        path: path.relative(root, resolved).replaceAll("\\", "/"),
        bytes: contents.length,
        sha256: sha256(contents),
        content: contents.toString("utf8"),
      });
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (cache) {
    scanCache.delete(cacheKey); scanCache.set(cacheKey, next);
    while (scanCache.size > 16) scanCache.delete(scanCache.keys().next().value);
  }
  return {
    root,
    files,
    totalBytes,
    digest: sha256(files.map(({ path: filePath, bytes, sha256: digest }) => ({
      path: filePath,
      bytes,
      sha256: digest,
    }))),
    truncated,
    stats,
  };
}
