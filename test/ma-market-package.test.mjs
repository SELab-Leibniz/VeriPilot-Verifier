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

test("MA release is a discoverable OpenClaw extension with named CJS lifecycle exports", async () => {
  const root = path.join(output, "unpacked"); await fs.mkdir(root);
  execFileSync("tar", ["-xzf", result.archive, "-C", root], { windowsHide: true });
  await assert.rejects(fs.access(path.join(root, "payload")));
  const wrapper = require(path.join(root, "index.js"));
  assert.equal(typeof wrapper.activate, "function"); assert.equal(typeof wrapper.deactivate, "function");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json")));
  assert.equal(pkg.name, "runtime-corrector-ma"); assert.equal(pkg.type, "commonjs"); assert.equal(pkg.main, "index.js");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "openclaw.plugin.json")));
  assert.equal(manifest.id, "runtime-corrector");
  assert.deepEqual(pkg.openclaw.extensions, ["./ma-entry.mjs"]);
  assert.equal(manifest.main, pkg.openclaw.extensions[0]);
  assert.equal(manifest.version, pkg.version);
  assert.equal(pkg.dependencies, undefined);
  for (const file of [".runtime-corrector-default/config.yaml", "config/openclaw-tool-contracts.json", "skills/runtime-corrector/SKILL.md",
    "lib/openclaw/entry.mjs", "lib/openclaw/ui/index.html", "lib/runtime-v2/production-stop.mjs",
    "scripts/rc-status.mjs", "scripts/rc-refresh.mjs", "scripts/rc-terminate.mjs", "docs/session-runtime-status.md",
    "lib/openclaw/session-runtime-client.mjs", "lib/openclaw/session-runtime-status.mjs",
    "lib/openclaw/session-runtime-controls.mjs", "lib/openclaw/session-runtime-cli.mjs"]) await fs.access(path.join(root, file));
  const project = path.join(output, "standalone-status-project"); await fs.mkdir(project);
  const queried = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/rc-status.mjs"),
    "--project-root", project, "--session-key", "agent:main:packaged-status", "--session-id", "packaged-status"],
  { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, NODE_PATH: "" } }));
  assert.equal(queried.ok, true); assert.equal(queried.result.status, "NOT_REGISTERED");
  assert.deepEqual(await fs.readdir(project), [], "a packaged query must not initialize a project");
  for (const name of ["node_modules", ".git", "test", "experiments"]) await assert.rejects(fs.access(path.join(root, name)));
});

test("release filename, registry ID, version and SHA-256 describe the actual upload archive", async () => {
  const records = JSON.parse(await fs.readFile(result.registry)).plugins;
  assert.deepEqual(Object.keys(records), ["runtime-corrector"]);
  const record = records["runtime-corrector"];
  assert.equal(path.basename(result.archive), `runtime-corrector-ma-${record.version}.tgz`);
  assert.equal(new URL(record.downloadUrl).pathname.endsWith(path.basename(result.archive)), true);
  assert.equal(record.sha256, createHash("sha256").update(await fs.readFile(result.archive)).digest("hex"));
  assert.equal(record.sha256, result.sha256); assert.equal(record.mode, "client"); assert.equal(record.restart, "gateway");
  assert.equal(record.pluginType, "user"); assert.equal(record.installPath, "~/.openclaw/extensions");
  assert.match(await fs.readFile(`${result.archive}.sha256`, "utf8"), new RegExp(`^${record.sha256}  runtime-corrector-ma-`));
});

test("MA version overrides do not change the OpenClaw manifest version or leave temporary build directories", async () => {
  const next = await buildMAPackage({ sourceRoot, outputRoot: path.join(output, "next"), version: "2.3.4" });
  assert.equal(path.basename(next.archive), "runtime-corrector-ma-2.3.4.tgz");
  assert.equal(JSON.parse(await fs.readFile(path.join(next.directory, "package.json"))).version, "2.3.4");
  assert.equal(JSON.parse(await fs.readFile(path.join(next.directory, "openclaw.plugin.json"))).version,
    JSON.parse(await fs.readFile(path.join(sourceRoot, "packaging/hosts/openclaw/openclaw.plugin.json"))).version);
  assert.equal((await fs.readdir(path.dirname(next.directory))).some(name => name.startsWith(".ma-build-")), false);
});

test("ambiguous MA directory versions and source-containing output roots fail before writing", async () => {
  for (const version of ["1.9.1-openclaw.11", "../outside", "01.2.3", "1.2", "1.2.3+build"]) {
    await assert.rejects(buildMAPackage({ sourceRoot, outputRoot: path.join(output, "invalid"), version }), /simple x.y.z/u);
  }
  await assert.rejects(fs.access(path.join(output, "invalid")));
  await assert.rejects(buildMAPackage({ sourceRoot, outputRoot: sourceRoot }), /source checkout/u);
});
