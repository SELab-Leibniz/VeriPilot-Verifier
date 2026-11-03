import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasLinkedPath, isSameFile } from "../lib/path-utils.mjs";

async function workspace(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-file-identity-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("file identity uses device and inode, including hard links", async t => {
  const root = await workspace(t), file = path.join(root, "Design.md"), other = path.join(root, "other.md");
  await fs.writeFile(file, "same bytes\n"); await fs.writeFile(other, "same bytes\n");
  const alias = path.join(root, "alias.md"); await fs.link(file, alias);
  assert.equal(await isSameFile(file, alias), true);
  assert.equal(await isSameFile(file, other), false);
  assert.equal(await hasLinkedPath(alias), false);
  if (process.platform === "win32") {
    assert.equal(await isSameFile(file, path.join(root, "design.md")), true);
    assert.equal(await hasLinkedPath(path.join(root, "design.md")), false);
  }
});

test("identity fallback respects Windows case and separators without folding POSIX paths", async () => {
  const stat = async () => ({ dev: 0n, ino: 0n });
  assert.equal(await isSameFile("C:\\p\\Design.md", "c:/p/design.md", { platform: "win32", stat }), true);
  assert.equal(await isSameFile("/p/Design.md", "/p/design.md", { platform: "linux", stat }), false);
  await assert.rejects(isSameFile("a", "b", { stat: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/u);
});

test("link detection checks ancestor Junctions and symbolic links separately from file identity", async t => {
  const root = await workspace(t), directory = path.join(root, "real"), linked = path.join(root, "linked");
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, "source.md"), "source\n");
  await fs.symlink(directory, linked, process.platform === "win32" ? "junction" : "dir");
  const file = path.join(directory, "source.md"), alias = path.join(linked, "source.md");
  assert.equal(await isSameFile(file, alias), true);
  assert.equal(await hasLinkedPath(file), false);
  assert.equal(await hasLinkedPath(linked), true);
  assert.equal(await hasLinkedPath(alias), true);
  if (process.platform !== "win32") {
    const fileLink = path.join(root, "source-link.md"); await fs.symlink(file, fileLink);
    assert.equal(await hasLinkedPath(fileLink), true);
  }
  await assert.rejects(hasLinkedPath(path.join(root, "missing.md")), { code: "ENOENT" });
});
