import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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


export async function resolveSkillDirectory({ skillId, projectRoot, pluginRoot, configuredRoots = [] }) {
  if (!skillId) return null;
  const shortId = skillId.split(":").at(-1);
  const roots = [
    ...configuredRoots,
    path.join(projectRoot, ".claude", "skills"),
    pluginRoot ? path.join(pluginRoot, "skills") : null,
    path.join(os.homedir(), ".claude", "skills"),
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


export async function scanSkillDirectory(directory, { maxFiles = 200, maxBytes = 2 * 1024 * 1024 } = {}) {
  const root = await fs.realpath(directory);
  const files = [];
  let totalBytes = 0;
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles || totalBytes >= maxBytes) return;
      if (sensitive(entry.name) || entry.name === "node_modules" || entry.name === ".git") continue;
      const candidate = path.join(current, entry.name);
      const resolved = await fs.realpath(candidate);
      if (!isPathInside(root, resolved)) continue;
      if (entry.isDirectory()) {
        await visit(resolved);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && entry.name !== "SKILL.md") continue;
      const contents = await fs.readFile(resolved);
      if (contents.includes(0)) continue;
      if (totalBytes + contents.length > maxBytes) continue;
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
  return {
    root,
    files,
    totalBytes,
    digest: sha256(files.map(({ path: filePath, bytes, sha256: digest }) => ({
      path: filePath,
      bytes,
      sha256: digest,
    }))),
    truncated: files.length >= maxFiles || totalBytes >= maxBytes,
  };
}
