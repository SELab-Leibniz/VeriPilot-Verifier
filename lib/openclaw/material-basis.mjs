import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateJson } from "./controller-store.mjs";
import { withTaskResourceLock } from "../runtime-v2/task-store.mjs";
import { outsideDecision } from "../runtime-v2/decision-scope.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";
import { isSkillSourceFile } from "../runtime-v2/skill-source.mjs";

export const MATERIAL_BASIS_LIMITS = Object.freeze({ roots: 16, files: 100, entries: 1000, bytes: 4 * 1024 * 1024, timeoutMs: 2000 });
const ignored = new Set(["node_modules", ".git", ".runtime-correction", "__pycache__", ".cache"]);
const sensitive = name => /^(?:\.env|\.npmrc|\.pypirc|credentials(?:\.json)?|id_rsa|id_ed25519)$/iu.test(name)
  || /secret|\.(?:pem|key)$/iu.test(name);
const key = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const basisFile = (root, taskId) => path.join(root, ".runtime-correction", "openclaw", "material-basis", `${sha256(taskId)}.json`);
const failureFile = file => file.replace(/\.json$/u, ".unverified.json");
const error = code => Object.assign(new Error(`UNVERIFIED: original material basis is unavailable (${code}); changed sources cannot replace the initial authority. Start an explicit new task after checking the original materials.`), { code });
const validRecord = record => Array.isArray(record.roots) && record.roots.every(root => typeof root === "string")
  && Array.isArray(record.sources) && record.sources.every(source => source && typeof source.path === "string"
    && typeof source.realPath === "string" && ["file", "directory"].includes(source.kind))
  && Array.isArray(record.files) && record.files.every(source => source && typeof source.path === "string"
    && Number.isSafeInteger(source.bytes) && source.bytes >= 0 && typeof source.sha256 === "string"
    && typeof source.contentBase64 === "string");

async function load(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (cause) { if (cause.code === "ENOENT") return null; return { status: "UNVERIFIED", reason: "MATERIAL_BASIS_RECORD_INVALID" }; }
}

async function snapshot(roots, { signal, active, limits, deadlineAt = Infinity }) {
  deadlineAt = Math.min(deadlineAt, Date.now() + limits.timeoutMs);
  const files = new Map(), visited = new Set(), sources = [];
  let bytes = 0, entries = 0;
  const current = () => {
    signal?.throwIfAborted();
    if (active && !active()) throw error("MATERIAL_BASIS_CAPTURE_CANCELLED");
    if (Date.now() >= deadlineAt) throw error("MATERIAL_BASIS_CAPTURE_TIMEOUT");
  };
  async function capture(file) {
    current();
    const real = await fs.realpath(file), identity = key(real);
    if (files.has(identity)) return;
    if (files.size >= limits.files) throw error("MATERIAL_BASIS_SCOPE_LIMIT");
    const handle = await fs.open(real, "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(limits.bytes - bytes)) throw error("MATERIAL_BASIS_SCOPE_LIMIT");
      const digest = createHash("sha256"), buffer = Buffer.alloc(Math.min(65536, limits.bytes - bytes + 1)), chunks = [];
      let size = 0;
      for (;;) {
        current();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limits.bytes - bytes - size + 1), null);
        if (!bytesRead) break;
        size += bytesRead;
        if (bytes + size > limits.bytes) throw error("MATERIAL_BASIS_SCOPE_LIMIT");
        digest.update(buffer.subarray(0, bytesRead));
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const after = await handle.stat({ bigint: true }), named = await fs.stat(real, { bigint: true });
      const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named)) throw error("MATERIAL_BASIS_CHANGED");
      const contents = Buffer.concat(chunks);
      if (contents.includes(0) || !Buffer.from(contents.toString("utf8")).equals(contents)) throw error("MATERIAL_BASIS_SOURCE_UNAVAILABLE");
      files.set(identity, { path: real, bytes: size, sha256: digest.digest("hex"), contentBase64: contents.toString("base64") }); bytes += size;
    } finally { await handle.close(); }
  }
  async function visit(directory) {
    current();
    const identity = key(directory);
    if (visited.has(identity)) return;
    visited.add(identity);
    const stream = await fs.opendir(directory);
    for await (const entry of stream) {
      current();
      if (++entries > limits.entries) throw error("MATERIAL_BASIS_SCOPE_LIMIT");
      if (ignored.has(entry.name) || sensitive(entry.name)) continue;
      const file = path.join(directory, entry.name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw error("MATERIAL_BASIS_LINKED_SOURCE");
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) { if (isSkillSourceFile(entry.name)) await capture(file); }
      else throw error("MATERIAL_BASIS_SOURCE_UNAVAILABLE");
    }
  }
  if (roots.length > limits.roots) throw error("MATERIAL_BASIS_SCOPE_LIMIT");
  for (const requested of roots) {
    current();
    const real = await fs.realpath(requested), stat = await fs.stat(real);
    sources.push({ path: requested, realPath: real, kind: stat.isDirectory() ? "directory" : "file" });
    if (stat.isDirectory()) await visit(real);
    else if (stat.isFile()) await capture(real);
    else throw error("MATERIAL_BASIS_SOURCE_UNAVAILABLE");
  }
  current();
  const captured = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
  return { sources, files: captured, bytes,
    digest: sha256({ sources: sources.map(source => [key(source.path), key(source.realPath), source.kind]),
      files: captured.map(file => [key(file.path), file.bytes, file.sha256]) }) };
}

export async function readMaterialBasis(projectRoot, taskId) {
  const file = basisFile(projectRoot, taskId), saved = await load(file);
  const failed = await load(failureFile(file));
  if (!saved && !failed) return null;
  const record = { ...saved, ...failed };
  return record ? { status: record.status, reason: record.reason, recordedAt: record.recordedAt,
    capturedAt: record.capturedAt, digest: record.digest, files: record.files?.length ?? 0 } : null;
}

export async function invalidateMaterialBasis({ projectRoot, taskId, reason, onlyUncaptured = false }) {
  const file = basisFile(projectRoot, taskId);
  if (onlyUncaptured && (await load(file))?.status === "CAPTURED") return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // A late capture cannot erase an earlier hook's inability to protect the
  // initial originals. This monotonic marker is independent of staged writes.
  try { await fs.writeFile(failureFile(file), JSON.stringify({ status: "UNVERIFIED", reason, recordedAt: Date.now() }) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (cause) { if (cause.code !== "EEXIST") throw cause; }
}

export async function prepareMaterialBasis({ projectRoot, taskId, roots = [], mode = "capture", signal, active,
  deadlineAt, limits: overrides = {} }) {
  const limits = { ...MATERIAL_BASIS_LIMITS, ...overrides };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid material capture bounds.");
  const requested = [...new Map(roots.map(root => [key(root), path.resolve(root)]))]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
  const file = basisFile(projectRoot, taskId);
  if (!requested.length && !await load(file) && !await load(failureFile(file))) return null;
  const locked = run => outsideDecision(() => withTaskResourceLock({ projectRoot, taskId, resource: "material-basis",
    reclaimDeadOwner: true, timeoutMs: limits.timeoutMs }, run));
  const fail = async (record, reason) => {
    await invalidateMaterialBasis({ projectRoot, taskId, reason });
    const failed = { ...record, schemaVersion: 1, taskId, status: "UNVERIFIED", reason, recordedAt: Date.now() };
    await privateJson(file, failed); return failed;
  };
  async function check() {
    return locked(async () => {
      const record = await load(file);
      if (await load(failureFile(file)) || record?.status !== "CAPTURED" || record.taskId !== taskId) return false;
      if (!validRecord(record)) { await fail(record, "MATERIAL_BASIS_RECORD_INVALID"); return false; }
      if (sha256(record.roots.map(key)) !== sha256(requested.map(key))) { await fail(record, "MATERIAL_BASIS_SCOPE_CHANGED"); return false; }
      try {
        const current = await snapshot(requested, { limits });
        if (current.digest === record.digest) return true;
        await fail(record, "MATERIAL_BASIS_CHANGED");
      } catch (cause) { await fail(record, typeof cause.code === "string" && cause.code.startsWith("MATERIAL_BASIS_") ? cause.code : "MATERIAL_BASIS_SOURCE_UNAVAILABLE"); }
      return false;
    });
  }
  let record = await locked(async () => {
    const previous = await load(file);
    const failed = await load(failureFile(file));
    if (failed) return { ...previous, ...failed };
    if (previous) {
      if (previous.status === "CAPTURING") return fail(previous, "MATERIAL_BASIS_CAPTURE_INTERRUPTED");
      return previous;
    }
    if (!requested.length || mode === "optional") return null;
    const reserved = { schemaVersion: 1, taskId, roots: requested, status: "CAPTURING", recordedAt: Date.now() };
    await privateJson(file, reserved);
    if (mode !== "capture") return fail(reserved, "MATERIAL_BASIS_NOT_CAPTURED");
    try {
      const captured = await snapshot(requested, { signal, active, limits, deadlineAt });
      const failed = await load(failureFile(file));
      if (failed) return { ...reserved, ...failed };
      const complete = { ...reserved, ...captured, status: "CAPTURED", capturedAt: Date.now() };
      await privateJson(file, complete); return complete;
    } catch (cause) { return fail(reserved, typeof cause.code === "string" && cause.code.startsWith("MATERIAL_BASIS_") ? cause.code : "MATERIAL_BASIS_SOURCE_UNAVAILABLE"); }
  });
  if (!record) return null;
  if (record.status !== "CAPTURED") throw error(record.reason ?? "MATERIAL_BASIS_UNVERIFIED");
  if (record.taskId !== taskId || !validRecord(record)) {
    await invalidateMaterialBasis({ projectRoot, taskId, reason: "MATERIAL_BASIS_RECORD_INVALID" });
    throw error("MATERIAL_BASIS_RECORD_INVALID");
  }
  if (!await check()) { record = await load(failureFile(file)) ?? await load(file); throw error(record?.reason ?? "MATERIAL_BASIS_UNVERIFIED"); }
  const originalFiles = new Map(record.files.map(source => [key(source.path), source]));
  const originalFor = file => {
    file = path.resolve(projectRoot, file);
    let source = originalFiles.get(key(file)), protectedSource = false;
    for (const root of record.sources) {
      for (const alias of [root.path, root.realPath]) {
        const relative = path.relative(alias, path.resolve(file));
        const included = !relative.split(path.sep).some(part => ignored.has(part) || sensitive(part)) && isSkillSourceFile(path.basename(file));
        if (relative === "" || root.kind === "directory" && included && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          protectedSource = true;
          source ??= originalFiles.get(key(root.kind === "file" ? root.realPath : path.resolve(root.realPath, relative)));
        }
      }
    }
    return { source, protectedSource };
  };
  const readOriginalMaterial = async file => {
    const { source, protectedSource } = originalFor(file);
    if (!protectedSource && !source) return null;
    if (!source?.contentBase64) {
      if (source?.bytes === 0 && source.contentBase64 === "") return Buffer.alloc(0);
      await invalidateMaterialBasis({ projectRoot, taskId, reason: "MATERIAL_BASIS_RECORD_INVALID" }); throw error("MATERIAL_BASIS_RECORD_INVALID");
    }
    const bytes = Buffer.from(source.contentBase64, "base64");
    if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) {
      await invalidateMaterialBasis({ projectRoot, taskId, reason: "MATERIAL_BASIS_RECORD_INVALID" }); throw error("MATERIAL_BASIS_RECORD_INVALID");
    }
    return bytes;
  };
  const frozenManifest = async (requestedRoots, options = {}) => {
    if (sha256(requestedRoots.map(key).sort()) !== sha256(record.roots.map(key).sort())) {
      await invalidateMaterialBasis({ projectRoot, taskId, reason: "MATERIAL_BASIS_SCOPE_CHANGED" }); throw error("MATERIAL_BASIS_SCOPE_CHANGED");
    }
    const capturedEntries = [];
    for (const root of record.sources) for (const source of record.files) {
      const relative = path.relative(root.realPath, source.path);
      if (root.kind === "file" ? relative !== "" : !relative || relative === ".." || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative) || !isSkillSourceFile(path.basename(source.path))) continue;
      const contents = await readOriginalMaterial(source.path);
      if (contents.includes(0) && root.kind === "directory") continue;
      capturedEntries.push({ root: root.kind === "file" ? path.dirname(root.path) : root.realPath,
        path: root.kind === "file" ? path.basename(root.path) : relative.replaceAll("\\", "/"),
        bytes: source.bytes, sha256: source.sha256, text: contents.toString("utf8") });
    }
    const { materialManifest } = await import("../runtime-v2/onboarding.mjs");
    return materialManifest(requestedRoots, { ...options, capturedEntries });
  };
  return { taskId, current: check, readOriginalMaterial, materialManifest: frozenManifest,
    async validateCitations(citations = []) {
      for (const citation of citations) {
        if (typeof citation.path !== "string") continue;
        const { source, protectedSource } = originalFor(path.resolve(projectRoot, citation.path));
        if ((source || protectedSource) && (!source || (citation.contentHash ?? citation.sha256) !== source.sha256)) {
          await invalidateMaterialBasis({ projectRoot, taskId, reason: "MATERIAL_BASIS_RECEIPT_CHANGED" }); throw error("MATERIAL_BASIS_RECEIPT_CHANGED");
        }
      }
    }, async assert() {
    if (!await check()) { const current = await load(failureFile(file)) ?? await load(file); throw error(current?.reason ?? "MATERIAL_BASIS_UNVERIFIED"); }
  } };
}
