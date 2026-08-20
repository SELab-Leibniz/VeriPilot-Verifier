import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";


export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}


export function sha256(value) {
  const contents = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? value
      : JSON.stringify(canonicalize(value));
  return createHash("sha256").update(contents).digest("hex");
}


export function safeId(value, fallback = "item") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}


export function uniqueId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  return `${safeId(prefix)}-${stamp}-${randomBytes(4).toString("hex")}`;
}


export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}


export async function atomicWrite(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  await fs.writeFile(temporary, contents);
  const retryable = new Set(["EACCES", "EBUSY", "EPERM"]);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, filePath);
        return;
      } catch (error) {
        if (!retryable.has(error.code) || attempt >= 7) throw error;
        const delayMs = Math.min(10 * (2 ** attempt), 250);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}


export async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}


export async function cleanupStaleAtomicWrites(root, { staleMs = 30_000 } = {}) {
  const removed = [];
  const pattern = /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/i;
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      try {
        const stat = await fs.stat(candidate);
        if (Date.now() - stat.mtimeMs < staleMs) continue;
        await fs.rm(candidate, { force: true });
        removed.push(candidate);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  await visit(root);
  return removed;
}


export async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}


export function relativeDisplay(root, filePath) {
  const relative = path.relative(root, filePath).replaceAll("\\", "/");
  return relative.startsWith("..") ? filePath.replaceAll("\\", "/") : relative;
}
