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

async function fingerprint(file) {
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
  let unstable = false;
  async function observe(file) {
    const target = evidencePath(root, file);
    if (!target) return;
    const value = await fingerprint(target);
    if (snapshots.has(target) && snapshots.get(target) !== value) unstable = true;
    else snapshots.set(target, value);
  }
  const digest = (entries) => sha256([...entries].sort(([a], [b]) => a.localeCompare(b)));
  return {
    observe,
    async capture(files) { for (const file of files) await observe(file); },
    async observeTool(name, args) { if (String(name).toLowerCase() === "read") await observe(args?.path ?? args?.file_path); },
    snapshot: () => ({ digest: digest(snapshots), files: [...snapshots.keys()], unstable }),
    async matches() {
      if (unstable) return false;
      const current = new Map();
      for (const file of snapshots.keys()) current.set(file, await fingerprint(file));
      return digest(current) === digest(snapshots);
    },
  };
}
