import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parseTestArguments, runTestFiles, selectTestFileShard } from "../scripts/test.mjs";

const execute = promisify(execFile);

test("file watchdog kills an indefinitely waiting process and its child, then runs the next file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-test-watchdog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const heartbeat = path.join(root, "heartbeat.txt");
  const grandchild = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`;
  await fs.writeFile(path.join(root, "hung.mjs"), `import test from 'node:test';import{spawn}from'node:child_process';
    test('unbounded backend',async()=>{spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});await new Promise(()=>{});});`);
  await fs.writeFile(path.join(root, "next.mjs"), "import test from 'node:test';test('next file still executes',()=>{});\n");
  const results = await runTestFiles({ files: ["hung.mjs", "next.mjs"], cwd: root, concurrency: 1, timeoutMs: 2500 });
  assert.equal(results.length, 2);
  assert.equal(results[0].timedOut, true);
  assert.equal(results[0].passed, false);
  assert.equal(results[1].passed, true, results[1].output);
  const size = (await fs.stat(heartbeat)).size;
  assert(size > 0, "the grandchild actually ran before the watchdog fired");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await fs.stat(heartbeat)).size, size, "no descendant keeps writing after timeout");
});

test("ordinary assertion failures remain failures and invalid watchdog values are rejected", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-test-result-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "fail.mjs"), "import test from 'node:test';import assert from 'node:assert/strict';test('essential assertion',()=>assert.equal(1,2));\n");
  const [result] = await runTestFiles({ files: ["fail.mjs"], cwd: root });
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.counts.fail, 1);
  for (const timeoutMs of [0, -1, NaN, Infinity])
    await assert.rejects(runTestFiles({ files: [], cwd: root, timeoutMs }), /positive integers/u);
});

test("sorted shards form a disjoint complete inventory with the same cross-platform digest", () => {
  const files = Array.from({ length: 17 }, (_value, index) => `test/example-${String(index).padStart(2, "0")}.test.mjs`);
  const full = selectTestFileShard(files);
  assert.deepEqual(full.files, files);
  for (const count of [1, 2, 3, 4, 7, files.length]) {
    const shards = Array.from({ length: count }, (_value, index) =>
      selectTestFileShard([...files].reverse(), `${index + 1}/${count}`));
    const union = shards.flatMap(shard => shard.files);
    assert.equal(new Set(union).size, files.length, "no file belongs to two shards");
    assert.deepEqual(union.sort(), files, "every original file belongs to one shard");
    for (const shard of shards) {
      assert.equal(shard.fullTestFileCount, files.length);
      assert.equal(shard.fullFileListSha256, full.fullFileListSha256);
      assert.equal(shard.selectedFileListSha256, createHash("sha256").update(JSON.stringify(shard.files)).digest("hex"));
    }
  }
  assert.deepEqual(selectTestFileShard(files.map(file => file.replaceAll("/", "\\")), "2/3"),
    selectTestFileShard(files, "2/3"));
  assert.throws(() => selectTestFileShard([files[0], files[0].replaceAll("/", "\\")]), /duplicates/u);
});

test("parent scheduling options retain defaults and leave child Node options separate", () => {
  const defaults = parseTestArguments([]);
  assert.equal(defaults.timeoutMs, 180000); assert.equal(defaults.concurrency, 4); assert.equal(defaults.shard, "1/1");
  assert.deepEqual(parseTestArguments(["--file-concurrency", "2", "--file-shard=2/3", "--file-timeout-ms=180000",
    "--openclaw-host", "host-root", "--test-concurrency=1"]),
  { timeoutMs: 180000, concurrency: 2, shard: "2/3", openclawHost: "host-root", nodeArgs: ["--test-concurrency=1"] });
  for (const argument of ["0", "-1", "1.5", "NaN", "Infinity"])
    assert.throws(() => parseTestArguments(["--file-concurrency", argument]), /positive integers/u);
  for (const name of ["--file-concurrency", "--file-shard", "--file-timeout-ms", "--openclaw-host"])
    assert.throws(() => parseTestArguments([name]), /Missing value/u);
});

async function cliFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-test-shards-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts")); await fs.mkdir(path.join(root, "test"));
  await fs.copyFile(new URL("../scripts/test.mjs", import.meta.url), path.join(root, "scripts/test.mjs"));
  const files = ["a", "b", "c", "d", "e", "f"].map(name => `test/${name}.test.mjs`);
  const failure = files[4];
  for (const file of files) await fs.writeFile(path.join(root, file),
    `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('actual ${file}',()=>{fs.appendFileSync(${JSON.stringify(path.join(root, path.basename(file) + ".ran"))},'x');
assert.equal(${file === failure ? "1,2" : "1,1"});});\n`);
  const run = async args => {
    let stdout, stderr, code;
    try { ({ stdout, stderr } = await execute(process.execPath, [path.join(root, "scripts/test.mjs"), ...args], { cwd: root })); code = 0; }
    catch (error) { ({ stdout, stderr, code } = error); }
    return { code, stdout, stderr,
      records: stdout.split(/\r?\n/u).filter(line => line.startsWith("{")).map(line => JSON.parse(line)) };
  };
  return { root, files, failure, run };
}

test("actual CLI shards execute every file once and keep a genuine assertion failure in its assigned shard", async t => {
  const f = await cliFixture(t);
  for (const shardCount of [2, 3, 4]) {
    const plans = [];
    for (let index = 1; index <= shardCount; index++) {
      const result = await f.run(["--file-shard", `${index}/${shardCount}`, "--file-concurrency=2", "--file-timeout-ms=180000"]);
      const [plan, summary] = result.records;
      assert.equal(plan.event, "TEST_FILE_PLAN"); assert.equal(plan.fullTestFileCount, f.files.length);
      assert.equal(plan.shardIndex, index); assert.equal(plan.shardCount, shardCount);
      assert.equal(plan.fileConcurrency, 2); assert.equal(plan.fileTimeoutMs, 180000);
      assert.equal(summary.completed, plan.selectedFiles.length); assert.equal(summary.files, plan.selectedFiles.length);
      assert.deepEqual(summary.timedOutFiles, []);
      const assignedFailure = plan.selectedFiles.includes(f.failure);
      assert.equal(result.code, assignedFailure ? 1 : 0, result.stdout + result.stderr);
      assert.deepEqual(summary.failedFiles, assignedFailure ? [f.failure] : []);
      assert.equal(summary.totals.fail, assignedFailure ? 1 : 0);
      assert.equal(summary.fullFileListSha256, plan.fullFileListSha256);
      plans.push(plan);
    }
    assert.equal(new Set(plans.map(plan => plan.fullFileListSha256)).size, 1);
    const union = plans.flatMap(plan => plan.selectedFiles);
    assert.equal(new Set(union).size, f.files.length); assert.deepEqual(union.sort(), f.files);
    for (const file of f.files) {
      const marker = path.join(f.root, path.basename(file) + ".ran");
      assert.equal(await fs.readFile(marker, "utf8"), "x", "no selected test is skipped or executed twice");
      await fs.unlink(marker);
    }
  }
});

test("actual CLI refuses invalid or empty shards before executing any test file", async t => {
  const f = await cliFixture(t);
  for (const shard of ["0/2", "3/2", "1/0", "1", "1/2/3", "1/7", "1/9007199254740992"]) {
    const result = await f.run([`--file-shard=${shard}`]);
    assert.equal(result.code, 1); assert.match(result.stderr, /--file-shard/u);
    assert.deepEqual(result.records, []);
  }
  assert.deepEqual((await fs.readdir(f.root)).filter(file => file.endsWith(".ran")), []);
});

test("the parent CLI file-concurrency limit holds blocked file workers before admitting another file", async t => {
  const f = await cliFixture(t), release = path.join(f.root, "release-workers");
  for (const file of f.files) await fs.writeFile(path.join(f.root, file),
    `import test from 'node:test';import fs from 'node:fs';
test('blocked file worker',async()=>{fs.writeFileSync(${JSON.stringify(path.join(f.root, path.basename(file) + ".entered"))},'entered');
while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,10));});\n`);
  const running = execute(process.execPath, [path.join(f.root, "scripts/test.mjs"), "--file-concurrency=2"],
    { cwd: f.root, timeout: 10000 });
  // Observe the real children while both slots are occupied; a metadata-only
  // implementation or forwarding the flag to child Node cannot satisfy this.
  const entered = async () => (await fs.readdir(f.root)).filter(file => file.endsWith(".entered")).length;
  try {
    const deadline = Date.now() + 5000;
    while (await entered() < 2) {
      assert(Date.now() < deadline, "two file workers must actually start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await entered(), 2, "a third file waits for an occupied parent slot");
  } finally {
    await fs.writeFile(release, "release");
    await running;
  }
  assert.equal(await entered(), f.files.length, "all remaining files run after a slot is released");
});


test("push filtering skips only the two exact reports and keeps mixed changes in CI", async () => {
  const workflow = (await fs.readFile(new URL("../.github/workflows/plugin-compatibility.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const on = /^on:\n([\s\S]*?)(?=^[^ \t\r\n])/mu.exec(workflow)?.[1];
  assert(on, "The workflow must expose its event configuration.");
  assert.deepEqual([...on.matchAll(/^  ([a-z_]+):/gmu)].map(match => match[1]).sort(), ["pull_request", "push"]);
  assert.equal(on.slice(0, on.indexOf("  push:")).trim(), "pull_request:", "Pull-request checks retain their existing unfiltered trigger.");
  const push = /^  push:\n(?: {4}.*(?:\n|$))+/mu.exec(on)?.[0];
  assert(push, "Push configuration is required.");
  const { parseSimpleYaml } = await import("../lib/simple-yaml.mjs");
  const configuration = parseSimpleYaml(push.replace(/^ {2}/gmu, "")).push;
  assert.deepEqual(Object.keys(configuration), ["paths-ignore"], "Branch and tag triggers retain their existing scope.");
  const reports = [".runtime-correction/runtime-corrector-progress.html", "dist/runtime-corrector-openclaw-1.10.0.validation.json"];
  assert.deepEqual(configuration["paths-ignore"], reports, "No wildcard, directory-wide or extra file exclusions.");
  // GitHub's documented paths-ignore rule runs if any changed path is outside
  // the exclusions; all patterns above are literal file names.
  const triggersPush = changed => changed.some(file => !configuration["paths-ignore"].includes(file));
  for (const changed of [[reports[0]], [reports[1]], reports]) assert.equal(triggersPush(changed), false);
  for (const file of ["lib/runtime-v2/stop-workspace-review.mjs", "test/test-runner.test.mjs", "scripts/test.mjs",
    ".github/workflows/plugin-compatibility.yml", "packaging/runtime-modules.json", "packaging/hosts/openclaw/README.md",
    "dist/runtime-corrector-openclaw-1.10.0.tgz", "README.md", ".runtime-correction/runtime-corrector-progress.json",
    "dist/runtime-corrector-openclaw-1.10.1.validation.json", reports[0] + ".bak"]) {
    assert.equal(triggersPush([file]), true, file);
    assert.equal(triggersPush([...reports, file]), true, "Mixed report/code changes must run: " + file);
  }
});
