import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test, { before, after } from "node:test";
import { buildMAPackage } from "../lib/ma-package-builder.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
let output, result;
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "rc-ma-package-"));
  result = await buildMAPackage({ sourceRoot, outputRoot: path.join(output, "build output 中文") });
});
after(() => fs.rm(output, { recursive: true, force: true }));

test("MA release is a flat tar.gz with complete ESM payload and named CJS lifecycle exports", async () => {
  const root = path.join(output, "unpacked"); await fs.mkdir(root);
  execFileSync("tar", ["-xzf", result.archive, "-C", root], { windowsHide: true });
  assert.deepEqual((await fs.readdir(root)).sort(), ["README.md", "index.js", "installer.mjs", "package.json", "payload"]);
  const wrapper = require(path.join(root, "index.js"));
  assert.equal(typeof wrapper.activate, "function"); assert.equal(typeof wrapper.deactivate, "function");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json")));
  assert.equal(pkg.name, "runtime-corrector-ma"); assert.equal(pkg.type, "commonjs"); assert.equal(pkg.main, "index.js");
  const payload = path.join(root, "payload/runtime-corrector");
  const native = JSON.parse(await fs.readFile(path.join(payload, "package.json")));
  const manifest = JSON.parse(await fs.readFile(path.join(payload, "openclaw.plugin.json")));
  assert.equal(native.type, "module"); assert.equal(manifest.id, "runtime-corrector");
  assert.equal(manifest.main, native.openclaw.extensions[0]); assert.equal(manifest.main, "./ma-entry.mjs");
  assert.equal(manifest.version, native.version);
  assert.equal(native.dependencies, undefined);
  for (const file of [".runtime-corrector-default/config.yaml", "config/openclaw-tool-contracts.json", "skills/runtime-corrector/SKILL.md",
    "lib/openclaw/entry.mjs", "lib/openclaw/ui/index.html", "lib/runtime-v2/production-stop.mjs"]) await fs.access(path.join(payload, file));
  for (const name of ["node_modules", ".git", "test", "experiments"]) await assert.rejects(fs.access(path.join(payload, name)));
});

test("release filename, registry ID, version and SHA-256 describe the actual upload archive", async () => {
  const records = JSON.parse(await fs.readFile(result.registry)).plugins;
  assert.deepEqual(Object.keys(records), ["runtime-corrector"]);
  const record = records["runtime-corrector"];
  assert.equal(path.basename(result.archive), `runtime-corrector-ma-${record.version}.tgz`);
  assert.equal(new URL(record.downloadUrl).pathname.endsWith(path.basename(result.archive)), true);
  assert.equal(record.sha256, createHash("sha256").update(await fs.readFile(result.archive)).digest("hex"));
  assert.equal(record.sha256, result.sha256); assert.equal(record.mode, "client"); assert.equal(record.restart, "gateway");
  assert.equal(record.pluginType, "user"); assert.equal(record.installPath, "~/.matrixassistant/plugins");
  assert.match(await fs.readFile(`${result.archive}.sha256`, "utf8"), new RegExp(`^${record.sha256}  runtime-corrector-ma-`));
});

test("MA version overrides do not change the inner OpenClaw release or leave temporary build directories", async () => {
  const next = await buildMAPackage({ sourceRoot, outputRoot: path.join(output, "next"), version: "2.3.4" });
  assert.equal(path.basename(next.archive), "runtime-corrector-ma-2.3.4.tgz");
  assert.equal(JSON.parse(await fs.readFile(path.join(next.directory, "package.json"))).version, "2.3.4");
  assert.equal(JSON.parse(await fs.readFile(path.join(next.directory, "payload/runtime-corrector/package.json"))).version,
    "1.9.1-openclaw.11-session-projects.15");
  assert.equal((await fs.readdir(path.dirname(next.directory))).some(name => name.startsWith(".ma-build-")), false);
});

test("ambiguous MA directory versions and source-containing output roots fail before writing", async () => {
  for (const version of ["1.9.1-openclaw.11", "../outside", "01.2.3", "1.2", "1.2.3+build"]) {
    await assert.rejects(buildMAPackage({ sourceRoot, outputRoot: path.join(output, "invalid"), version }), /simple x.y.z/u);
  }
  await assert.rejects(fs.access(path.join(output, "invalid")));
  await assert.rejects(buildMAPackage({ sourceRoot, outputRoot: sourceRoot }), /source checkout/u);
});
