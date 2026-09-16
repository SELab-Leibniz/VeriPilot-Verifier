import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "../runtime-v2/utils.mjs";

export function evidencePath(root, file) {
  if (typeof file !== "string" || !file || file.includes("\0")) return null;
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || relative.split(path.sep).includes(".runtime-correction")) return null;
  return absolute;
}

export async function fingerprint(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return sha256(await fs.readFile(file));
    if (stat.isDirectory()) return sha256((await fs.readdir(file)).sort());
    return "special-file";
  } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

// Each assessment owns its observed evidence. An unrelated conversation may
// edit another artifact in the same project without invalidating this one.
export function createEvidenceLedger(root) {
  const snapshots = new Map();
  const reads = [];
  const pendingReads = new Map();
  const pendingFiles = new Set();
  const changedPaths = new Set();
  let unstable = false;
  async function observe(file) {
    const target = evidencePath(root, file);
    if (!target) return;
    const value = await fingerprint(target);
    if (snapshots.has(target) && snapshots.get(target) !== value) { unstable = true; changedPaths.add(target); }
    else snapshots.set(target, value);
  }
  const digest = (entries) => sha256([...entries].sort(([a], [b]) => a.localeCompare(b)));
  return {
    observe,
    async capture(files) { for (const file of files) await observe(file); },
    async observeTool(name, args) {
      if (String(name).toLowerCase() === "read") {
        const file = evidencePath(root, args?.path ?? args?.file_path);
        if (file) {
          const before = await fingerprint(file);
          pendingReads.set(file, before);
          if (await fs.stat(file).then(stat => stat.isFile()).catch(() => false)) { pendingFiles.add(file); await observe(file); }
          else pendingFiles.delete(file);
        }
      }
      if (name === "read:result" && String(args.toolName).toLowerCase() === "read") {
        const file = evidencePath(root, args.args?.path ?? args.args?.file_path);
        if (file) {
          const before = pendingReads.get(file), after = await fingerprint(file);
          const failed = args.isError === true || args.result?.isError === true || before === "missing" || !pendingFiles.has(file);
          // A failed exploratory read is an audited reviewer observation, not
          // a required artifact. Required missing files remain in capture().
          if (before && before !== "missing" && before !== after) { unstable = true; changedPaths.add(file); }
          if (!failed) {
            if (snapshots.has(file) && snapshots.get(file) !== after) { unstable = true; changedPaths.add(file); }
            else snapshots.set(file, after);
          }
          reads.push({ file, toolCallId: args.toolCallId, resultDigest: sha256(args.result),
            input: { offset: args.args?.offset ?? null, limit: args.args?.limit ?? null }, isError: failed });
        }
      }
    },
    snapshot: () => ({ digest: digest(snapshots), files: [...snapshots.keys()], fingerprints: Object.fromEntries(snapshots), unstable,
      reads: [...reads], changedPaths: [...changedPaths], missing: [...snapshots].filter(([, value]) => value === "missing").map(([file]) => file) }),
    async matches() {
      if (unstable || [...snapshots.values()].includes("missing")) return false;
      const current = new Map();
      for (const file of snapshots.keys()) {
        const value = await fingerprint(file); current.set(file, value);
        if (value !== snapshots.get(file)) changedPaths.add(file);
      }
      return digest(current) === digest(snapshots);
    },
  };
}

export async function matchesEvidence(evidence) {
  if (!evidence?.fingerprints || evidence.unstable || evidence.missing?.length || !evidence.files?.length) return false;
  for (const [file, hash] of Object.entries(evidence.fingerprints)) if (hash === "missing" || await fingerprint(file) !== hash) return false;
  return true;
}
