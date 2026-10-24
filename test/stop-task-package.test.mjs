import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildPlugin } from "../lib/plugin-builder.mjs";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
};

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "stop-task-package-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert(path.basename(temporary).startsWith("stop-task-package-"));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const sourceRoot = path.join(temporary, "source"), outputRoot = path.join(temporary, "output");
  const worker = path.join(sourceRoot, "lib/review-task");
  await write(path.join(sourceRoot, "package.json"), {
    name: "runtime-corrector", version: "1.9.1", type: "module", engines: { node: ">=18" },
    bin: { "runtime-corrector": "./scripts/cli.mjs" }, scripts: { check: "node scripts/cli.mjs" },
  });
  for (const file of ["package.json", "package-lock.json"]) {
    await write(path.join(worker, file), await fs.readFile(path.join(SOURCE, "lib/review-task", file), "utf8"));
  }
  await write(path.join(worker, "review-task.mjs"), "export const packaged = true;\n");
  for (const directory of ["commands", "skills"]) await fs.mkdir(path.join(sourceRoot, directory));
  await write(path.join(sourceRoot, "hooks/hooks.json"), { hooks: {} });
  await write(path.join(sourceRoot, "docs/openclaw.md"), "# Review package fixture\n");
  for (const host of ["claude", "codeagent", "openclaw"]) {
    await write(path.join(sourceRoot, "lib/hosts", `${host}.mjs`), `export const host = ${JSON.stringify(host)};\n`);
    for (const file of host === "openclaw" ? ["openclaw.plugin.json"] : ["plugin.json", "marketplace.json"]) {
      await write(path.join(sourceRoot, "packaging/hosts", host, file),
        await fs.readFile(path.join(SOURCE, "packaging/hosts", host, file), "utf8"));
    }
  }
  await fs.mkdir(path.join(sourceRoot, "packaging/hosts/openclaw/skills"));
  for (const file of ["node_modules/top-sentinel", "lib/review-task/node_modules/worker-sentinel",
    "examples/nested/node_modules/example-sentinel", ".runtime-correction/review-module-lab/experiment-sentinel",
    "examples/nested/.runtime-correction/private-sentinel", "packaging/hosts/openclaw/skills/node_modules/skill-sentinel",
    "experiments/live-kitchen-private/host/openclaw.json", "experiments/review-fixtures/oracle-sentinel"]) {
    await write(path.join(sourceRoot, file), "Never include this file in a deliverable.\n");
  }
  return { sourceRoot, outputRoot, worker };
}

async function artifactFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    files.push(relative);
    if (entry.isDirectory()) files.push(...await artifactFiles(path.join(directory, entry.name), `${relative}/`));
  }
  return files;
}

test("every artifact excludes nested installations and private experiment outputs", async t => {
  const input = await fixture(t);
  for (const host of ["claude", "codeagent", "openclaw"]) {
    const artifact = await buildPlugin({ ...input, host });
    const names = await artifactFiles(artifact);
    assert(names.includes("lib/review-task/review-task.mjs"));
    assert(!names.some(name => name.split("/").some(part => ["node_modules", ".runtime-correction"].includes(part))));
    assert(!names.some(name => name.includes("sentinel")));
    assert(!names.some(name => name === "experiments" || name.startsWith("experiments/")));
    if (host !== "openclaw") {
      const pkg = await read(path.join(artifact, "package.json"));
      assert.equal(pkg.dependencies, undefined);
      assert.equal(pkg.engines.node, ">=18");
      await assert.rejects(fs.access(path.join(artifact, "package-lock.json")), { code: "ENOENT" });
    }
  }
  await fs.access(path.join(input.worker, "node_modules/worker-sentinel"));
});

test("OpenClaw root package and lock retain exact worker dependencies and all transitive records", async t => {
  const input = await fixture(t);
  const artifact = await buildPlugin({ ...input, host: "openclaw" });
  const pkg = await read(path.join(artifact, "package.json"));
  const lock = await read(path.join(artifact, "package-lock.json"));
  const workerPackage = await read(path.join(input.worker, "package.json"));
  const workerLock = await read(path.join(input.worker, "package-lock.json"));
  const manifest = await read(path.join(artifact, "openclaw.plugin.json"));
  assert.deepEqual(pkg.dependencies, workerPackage.dependencies);
  assert.equal(Object.keys(pkg.dependencies).length, 3);
  assert.equal(pkg.dependencies["@earendil-works/pi-ai"], "1.4.0");
  assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "1.4.0");
  assert.equal(pkg.dependencies.typebox, "1.3.27");
  assert.deepEqual(pkg.overrides, workerPackage.overrides);
  if (workerPackage.overrides?.undici) assert.equal(lock.packages["node_modules/undici"].version, workerPackage.overrides.undici);
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.version, "1.9.1-openclaw.11-session-projects.12");
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  for (const key of ["name", "version", "dependencies", "engines", "bin", "peerDependencies", "peerDependenciesMeta"]) {
    assert.deepEqual(lock.packages[""][key], pkg[key]);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(lock.packages).filter(([name]) => name !== "")),
    Object.fromEntries(Object.entries(workerLock.packages).filter(([name]) => name !== "")));
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.equal(lock.packages[`node_modules/${name}`].version, version);
  assert.equal(pkg.peerDependenciesMeta.openclaw.optional, true);
});

test("a mismatched pinned worker package cannot produce an installable-looking artifact", async t => {
  const input = await fixture(t);
  const lockFile = path.join(input.worker, "package-lock.json");
  const lock = await read(lockFile);
  lock.packages["node_modules/@earendil-works/pi-ai"].version = "0.0.0";
  await write(lockFile, lock);
  await assert.rejects(buildPlugin({ ...input, host: "openclaw" }), /matching npm v3 lockfile/u);
});
