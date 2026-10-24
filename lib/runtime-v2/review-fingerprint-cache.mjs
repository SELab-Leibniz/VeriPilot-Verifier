import { promises as fs } from "node:fs";
import { sha256 } from "./utils.mjs";

// One collection owns this cache. Metadata is only an intermediate change
// detector; publication always forces a fresh content hash. In particular,
// size + mtime alone is insufficient when an editor restores a timestamp.
const identity = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size,
  stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].map(String).join(":");

export function createReviewFingerprintCache({ assertActive = () => {}, signal } = {}) {
  const files = new Map();
  return async function fingerprint(file, { force = false } = {}) {
    assertActive();
    try {
      const before = await fs.lstat(file, { bigint: true });
      assertActive();
      if (before.isSymbolicLink()) return "symbolic-link";
      if (before.isDirectory()) {
        const names = await fs.readdir(file);
        assertActive();
        return sha256(names.sort());
      }
      if (!before.isFile()) return "special-file";
      const key = identity(before), previous = files.get(file);
      if (!force && previous?.identity === key) return previous.hash;
      const bytes = await fs.readFile(file, signal ? { signal } : undefined);
      assertActive();
      const after = await fs.lstat(file, { bigint: true });
      if (identity(after) !== key) throw Object.assign(new Error("Review input changed while hashing."), { code: "REVIEW_COLLECTION_STALE" });
      const hash = sha256(bytes);
      files.set(file, { identity: key, hash });
      return hash;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing";
      throw error;
    }
  };
}
