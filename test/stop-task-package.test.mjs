import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
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
  for (const name of ["commands", "config", "hooks", "knowledge", "lib", "scripts", "skills", "specs", "templates", "docs", "README.md", "README.en.md"]) {
    await fs.cp(path.join(SOURCE, name), path.join(sourceRoot, name), { recursive: true,
      filter: file => !["node_modules", ".runtime-correction"].includes(path.basename(file)) });
  }
  const worker = path.join(sourceRoot, "lib/review-task");
  await write(path.join(sourceRoot, "packaging/runtime-modules.json"),
    await fs.readFile(path.join(SOURCE, "packaging/runtime-modules.json"), "utf8"));
  await fs.cp(path.join(SOURCE, "packaging/vendor"), path.join(sourceRoot, "packaging/vendor"), { recursive: true });
  await write(path.join(sourceRoot, "package.json"), {
    name: "runtime-corrector", version: "1.9.1", type: "module", engines: { node: ">=18" },
    bin: { "runtime-corrector": "./scripts/cli.mjs" }, scripts: { check: "node scripts/cli.mjs" },
  });
  for (const file of ["package.json", "package-lock.json"]) {
    await write(path.join(worker, file), await fs.readFile(path.join(SOURCE, "lib/review-task", file), "utf8"));
  }
  for (const directory of ["commands", "skills"]) await fs.mkdir(path.join(sourceRoot, directory), { recursive: true });
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
  await write(path.join(sourceRoot, "packaging/hosts/openclaw/skills/runtime-corrector/SKILL.md"),
    await fs.readFile(path.join(SOURCE, "packaging/hosts/openclaw/skills/runtime-corrector/SKILL.md"), "utf8"));
  for (const file of ["node_modules/top-sentinel", "lib/review-task/node_modules/worker-sentinel",
    "examples/nested/node_modules/example-sentinel", ".runtime-correction/review-module-lab/experiment-sentinel",
    "examples/nested/.runtime-correction/private-sentinel", "packaging/hosts/openclaw/skills/node_modules/skill-sentinel",
    "experiments/live-kitchen-private/host/openclaw.json", "experiments/review-fixtures/oracle-sentinel",
    "unknown-directory/report.md", "scripts/unknown-tool.mjs", "docs/report.md", "unlisted-root.md",
    "lib/review-task/report.json", "lib/report.md", "lib/unknown-tools/probe.mjs",
    "lib/one-off-diagnostic.mjs", "lib/runtime-v2/one-off-diagnostic.mjs",
    "lib/review-task/one-off-diagnostic.mjs", "lib/openclaw/one-off-diagnostic.mjs",
    "skills/runtime-corrector-init/report.md", "config/report.json", "test/example.test.mjs"]) {
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
    for (const unwanted of ["unknown-directory", "unknown-tools", "unknown-tool.mjs", "one-off-diagnostic.mjs", "report.md", "report.json", "unlisted-root.md", "test", "examples", "packaging", "build-plugin.mjs", "plugin-builder.mjs"]) {
      assert(!names.some(name => name.split("/").includes(unwanted)), `${host}: ${unwanted}`);
    }
    const pkg = await read(path.join(artifact, "package.json"));
    assert.deepEqual(pkg.scripts, { check: "node ./scripts/cli.mjs" });
    assert.deepEqual(names.filter(name => name.startsWith("lib/hosts/") && name.endsWith(".mjs")).sort(),
      [...new Set([`lib/hosts/${host}.mjs`, "lib/hosts/openclaw.mjs"])].sort());
    if (host !== "openclaw") {
      const pkg = await read(path.join(artifact, "package.json"));
      assert.equal(pkg.dependencies, undefined);
      assert.equal(pkg.engines.node, ">=18");
      await assert.rejects(fs.access(path.join(artifact, "package-lock.json")), { code: "ENOENT" });
    }
  }
  await fs.access(path.join(input.worker, "node_modules/worker-sentinel"));
});

test("OpenClaw builds complete tool declarations even when the manifest template omitted them",async t=>{
  const input=await fixture(t);
  const manifestFile=path.join(input.sourceRoot,"packaging/hosts/openclaw/openclaw.plugin.json");
  const template=await read(manifestFile);template.contracts.tools=["runtime_corrector"];
  await write(manifestFile,template);
  const artifact=await buildPlugin({...input,host:"openclaw"});
  const manifest=await read(path.join(artifact,"openclaw.plugin.json"));
  const contracts=await import(pathToFileURL(path.join(artifact,"lib/openclaw/tool-contracts.mjs")));
  assert.deepEqual(manifest.contracts.tools,contracts.OPENCLAW_TOOL_NAMES);
  assert(manifest.contracts.tools.includes("save_baseline_batch"));
  assert(manifest.contracts.tools.includes("finish_baseline"));
  const {registerTaskTools}=await import(pathToFileURL(path.join(artifact,"lib/openclaw/task-tools.mjs")));
  let names;
  registerTaskTools({registerTool(_factory,metadata){names=metadata.names;},on(){}});
  assert(names.every(name=>manifest.contracts.tools.includes(name)));
  assert.deepEqual((await read(manifestFile)).contracts.tools,["runtime_corrector"],"build does not rewrite its source template");
});

test("OpenClaw ships a private locked TypeBox without an external install dependency", async t => {
  const input = await fixture(t);
  const artifact = await buildPlugin({ ...input, host: "openclaw" });
  const pkg = await read(path.join(artifact, "package.json"));
  const lock = await read(path.join(artifact, "package-lock.json"));
  const workerPackage = await read(path.join(input.worker, "package.json"));
  const workerLock = await read(path.join(input.worker, "package-lock.json"));
  const manifest = await read(path.join(artifact, "openclaw.plugin.json"));
  assert.equal(pkg.dependencies, undefined);
  assert.doesNotMatch(JSON.stringify(lock), /@earendil-works\/pi-/u);
  assert.equal(workerPackage.dependencies.typebox, "1.3.27");
  assert.deepEqual(pkg.runtimeCorrector.bundledDependencies.typebox, {
    version: "1.3.27", integrity: workerLock.packages["node_modules/typebox"].integrity,
    path: "vendor/typebox", license: "MIT",
  });
  assert.equal((await read(path.join(artifact, "vendor/typebox/package.json"))).version, "1.3.27");
  await fs.access(path.join(artifact, "vendor/typebox/license"));
  assert.match(await fs.readFile(path.join(artifact, "lib/review-task/review-task.mjs"), "utf8"),
    /from '\.\.\/\.\.\/vendor\/typebox\/build\/index\.mjs'/u);
  assert.deepEqual(pkg.overrides, workerPackage.overrides);
  if (workerPackage.overrides?.undici) assert.equal(lock.packages["node_modules/undici"].version, workerPackage.overrides.undici);
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.version, "1.9.1-openclaw.11-session-projects.15");
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  for (const key of ["name", "version", "dependencies", "engines", "bin", "peerDependencies", "peerDependenciesMeta"]) {
    assert.deepEqual(lock.packages[""][key], pkg[key]);
  }
  assert.deepEqual(Object.keys(lock.packages), [""]);
  assert.deepEqual(await read(path.join(artifact, "lib/review-task/package-lock.json")), workerLock);
  assert.equal(pkg.peerDependenciesMeta.openclaw.optional, true);
});

test("a copied artifact imports its real review engine without node_modules or ambient TypeBox", async t => {
  const input = await fixture(t);
  const artifact = await buildPlugin({ ...input, host: "openclaw" });
  const installed = path.join(input.outputRoot, "copied-install");
  await fs.cp(artifact, installed, { recursive: true });
  const ambient = path.join(input.outputRoot, "node_modules/typebox");
  await write(path.join(ambient, "package.json"), { name: "typebox", version: "0.0.0", type: "module", exports: "./index.mjs" });
  await write(path.join(ambient, "index.mjs"), "throw new Error('AMBIENT_TYPEBOX_MUST_NOT_LOAD');\n");
  const url = pathToFileURL(path.join(installed, "lib/review-task/review-task.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const worker = await import(${JSON.stringify(url)}); if (typeof worker.runReviewTask !== 'function') process.exit(1); console.log('PRIVATE_REVIEW_IMPORT_OK');`],
    { cwd: installed, env: { ...process.env, NODE_PATH: path.dirname(ambient) }, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PRIVATE_REVIEW_IMPORT_OK/u);
  await assert.rejects(fs.access(path.join(installed, "node_modules")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(ambient, "index.mjs"), "utf8"), "throw new Error('AMBIENT_TYPEBOX_MUST_NOT_LOAD');\n");
});

test("a changed dependency archive fails the build before it can be installed", async t => {
  const input = await fixture(t);
  const archive = path.join(input.sourceRoot, "packaging/vendor/typebox-1.3.27.tgz");
  const bytes = await fs.readFile(archive);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(archive, bytes);
  await assert.rejects(buildPlugin({ ...input, host: "openclaw" }), /archive integrity/u);
});

test("a mismatched pinned worker package cannot produce an installable-looking artifact", async t => {
  const input = await fixture(t);
  const lockFile = path.join(input.worker, "package-lock.json");
  const lock = await read(lockFile);
  lock.packages["node_modules/typebox"].version = "0.0.0";
  await write(lockFile, lock);
  await assert.rejects(buildPlugin({ ...input, host: "openclaw" }), /matching npm v3 lockfile/u);
});

test('a transitive Pi package cannot be reintroduced through an otherwise matching lockfile', async t => {
  const input = await fixture(t), lockFile = path.join(input.worker, 'package-lock.json');
  const lock = await read(lockFile);
  lock.packages['node_modules/hidden/node_modules/@earendil-works/pi-ai'] = { version: '1.4.0' };
  await write(lockFile, lock);
  await assert.rejects(buildPlugin({ ...input, host: 'openclaw' }), /must not contain Pi/);
});
