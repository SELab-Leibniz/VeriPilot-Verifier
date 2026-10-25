import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTestFiles } from "../scripts/test.mjs";

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
