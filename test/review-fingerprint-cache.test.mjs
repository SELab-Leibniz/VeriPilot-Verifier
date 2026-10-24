import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReviewFingerprintCache } from "../lib/runtime-v2/review-fingerprint-cache.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/fingerprint-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.txt"); await fs.writeFile(file, "original");
  return { root, file };
}

test("repeated collection checks reuse content hashes but force a fresh publication hash", async t => {
  const f = await fixture(t), originalRead = fs.readFile; let reads = 0;
  fs.readFile = async (file, ...args) => { if (file === f.file) reads++; return originalRead(file, ...args); };
  t.after(() => { fs.readFile = originalRead; });
  const fingerprint = createReviewFingerprintCache();
  for (let index = 0; index < 16; index++) assert.equal(await fingerprint(f.file), sha256("original"));
  assert.equal(reads, 1);
  assert.equal(await fingerprint(f.file, { force: true }), sha256("original"));
  assert.equal(reads, 2);
});

test("changes, missing inputs and new directory entries are not hidden by cached hashes", async t => {
  const f = await fixture(t), fingerprint = createReviewFingerprintCache();
  const original = await fingerprint(f.file), directory = await fingerprint(f.root), times = await fs.stat(f.file);
  await fs.writeFile(f.file, "modified");
  await fs.utimes(f.file, times.atime, times.mtime);
  assert.notEqual(await fingerprint(f.file, { force: true }), original);
  await fs.writeFile(path.join(f.root, "new.txt"), "new");
  assert.notEqual(await fingerprint(f.root), directory);
  await fs.unlink(f.file);
  assert.equal(await fingerprint(f.file), "missing");
});

test("cached checks still honor cancellation and deadlines", async t => {
  const f = await fixture(t); let closed = false;
  const fingerprint = createReviewFingerprintCache({ assertActive: () => { if (closed) throw new Error("cancelled"); } });
  await fingerprint(f.file); closed = true;
  await assert.rejects(fingerprint(f.file), /cancelled/);
});
