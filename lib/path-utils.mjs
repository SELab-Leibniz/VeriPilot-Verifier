import path from "node:path";
import { promises as fs } from "node:fs";


export function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}


export function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}


export async function isSameFile(left, right, { platform = process.platform, stat = fs.stat } = {}) {
  try {
    const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
    if (a.ino !== 0n && b.ino !== 0n && a.ino !== undefined && b.ino !== undefined)
      return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ENOSYS", "ENOTSUP", "EINVAL"].includes(error.code)) throw error;
  }
  const normalize = value => {
    const absolute = (platform === "win32" ? path.win32 : path).resolve(value);
    return platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}


export async function hasLinkedPath(file) {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let current = root;
  // realpath string differences also include Windows casing. Only lstat can
  // distinguish those aliases from a link or Junction in any ancestor.
  for (const part of ["", ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}
