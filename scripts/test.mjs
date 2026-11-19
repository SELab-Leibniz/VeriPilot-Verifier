#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

// Native lifecycle suites include real deadline windows exceeding 90 seconds.
export const DEFAULT_FILE_TIMEOUT_MS = 180_000;

export function parseTestArguments(args) {
  let timeoutMs = DEFAULT_FILE_TIMEOUT_MS, concurrency = 4, shard = "1/1", openclawHost;
  const nodeArgs = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index], equal = argument.indexOf("="), name = equal < 0 ? argument : argument.slice(0, equal);
    if (["--file-timeout-ms", "--file-concurrency", "--file-shard", "--openclaw-host"].includes(name)) {
      const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
      if (name === "--file-timeout-ms") timeoutMs = Number(value);
      else if (name === "--file-concurrency") concurrency = Number(value);
      else if (name === "--file-shard") shard = value;
      else openclawHost = value;
    } else nodeArgs.push(argument);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(concurrency) || concurrency <= 0)
    throw new Error("Test timeout and concurrency must be positive integers.");
  return { timeoutMs, concurrency, shard, openclawHost, nodeArgs };
}

// Normalize before sorting so Windows and POSIX jobs publish the same inventory.
// A file's sorted index belongs to exactly one shard; sharding never selects cases.
export function selectTestFileShard(files, shard = "1/1") {
  if (typeof shard !== "string" || !/^[1-9]\d*\/[1-9]\d*$/u.test(shard))
    throw new Error("--file-shard must be an index/count such as 1/2.");
  const [shardIndex, shardCount] = shard.split("/").map(Number);
  if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount) || shardIndex > shardCount)
    throw new Error("--file-shard requires 1 <= index <= count.");
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== "string" || !file))
    throw new Error("Test file inventory must be nonempty.");
  const sorted = files.map(file => file.replaceAll("\\", "/")).sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("Test file inventory contains duplicates.");
  if (shardCount > sorted.length) throw new Error("--file-shard count exceeds the test file count.");
  const selected = sorted.filter((_file, index) => index % shardCount === shardIndex - 1);
  const digest = values => createHash("sha256").update(JSON.stringify(values)).digest("hex");
  return { files: selected, fullTestFileCount: sorted.length, shardIndex, shardCount,
    fullFileListSha256: digest(sorted), selectedFileListSha256: digest(selected) };
}

export function testDependencyWarnings(root) {
  try {
    createRequire(path.join(root, "lib", "review-task", "package.json")).resolve("typebox");
    return [];
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    return ["Review-task test dependency typebox is missing. Run: npm ci --prefix lib/review-task --ignore-scripts. Dependent tests will still run and report failures."];
  }
}

// Without RC_OPENCLAW_HOST_ROOT the OpenClaw public tool validator falls back to
// package.json beside process.argv[1], which under node --test is test/. Without
// a locale variable the product derives its zh default, while hook-process tests
// assert en messages.
export function testEnvironmentWarnings(env = process.env) {
  return [
    ...env.RC_OPENCLAW_HOST_ROOT ? [] : ["RC_OPENCLAW_HOST_ROOT is unset; tests that load the OpenClaw public tool validator fail with ENOENT realpath 'test/package.json'. Pass --openclaw-host=<OpenClaw package directory>."],
    ...env.LC_ALL || env.LC_MESSAGES || env.LANG ? [] : ["LC_ALL, LC_MESSAGES and LANG are unset; the product feedback locale defaults to zh and hook-process tests that assert English messages fail. Set LANG=en_US.UTF-8 to match the recorded baseline."],
  ];
}

export async function resolveOpenClawTestHost(directory) {
  const { targetVersion } = await import("../lib/hosts/openclaw.mjs");
  const root = realpathSync(path.resolve(directory));
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== "openclaw" || manifest.version !== targetVersion)
    throw new Error(`--openclaw-host must be the OpenClaw ${targetVersion} package directory.`);
  return root;
}

function terminateTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

function runFile(file, { cwd, timeoutMs, nodeArgs, signal }) {
  return new Promise(resolve => {
    let output = "", timedOut = false, cancelled = false, error;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...nodeArgs, file],
      { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => { cancelled = true; terminateTree(child); };
    const timer = setTimeout(() => { timedOut = true; terminateTree(child); }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", cause => { error = cause.message; });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      const counts = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)\r?$/gmu)]
        .map(([, name, value]) => [name, Number(value)]));
      resolve({ file, code, exitSignal, timedOut, cancelled, error, output, counts,
        passed: code === 0 && !timedOut && !cancelled && !error });
    });
  });
}

export async function runTestFiles({ files, cwd, timeoutMs = DEFAULT_FILE_TIMEOUT_MS,
  concurrency = 4, nodeArgs = [], signal, onResult = () => {} }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(concurrency) || concurrency <= 0)
    throw new Error("Test timeout and concurrency must be positive integers.");
  const results = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length && !signal?.aborted) {
      const index = next++;
      results[index] = await runFile(files[index], { cwd, timeoutMs, nodeArgs, signal });
      await onResult(results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results.filter(Boolean);
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const warning of testDependencyWarnings(root)) console.warn(warning);
  // Runtime scopes use physical filesystem identities. Keep implicit fixture
  // roots canonical too; explicit symlink tests still exercise alias handling.
  const temporaryRoot = realpathSync(tmpdir());
  if (process.platform === "win32") process.env.TEMP = process.env.TMP = temporaryRoot;
  else process.env.TMPDIR = temporaryRoot;
  const { timeoutMs, concurrency, shard, openclawHost, nodeArgs } = parseTestArguments(process.argv.slice(2));
  if (openclawHost) process.env.RC_OPENCLAW_HOST_ROOT = await resolveOpenClawTestHost(openclawHost);
  for (const warning of testEnvironmentWarnings()) console.warn(warning);
  const { files, ...selection } = selectTestFileShard(readdirSync(path.join(root, "test"))
    .filter(name => name.endsWith(".test.mjs")).map(name => `test/${name}`), shard);
  const plan = { ...selection, partition: "sorted-file-index-modulo-v1", fileConcurrency: concurrency, fileTimeoutMs: timeoutMs };
  console.log(JSON.stringify({ event: "TEST_FILE_PLAN", ...plan, selectedFiles: files }));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const results = await runTestFiles({ files, cwd: root, timeoutMs, concurrency, nodeArgs, signal: controller.signal,
      onResult(result) {
        const label = result.timedOut ? `TIMEOUT (${timeoutMs} ms)` : result.passed ? "PASS" : "FAIL";
        console.log(`${label} ${result.file}`);
        if (!result.passed) process.stdout.write(result.output || `${result.error ?? result.exitSignal ?? "Test process failed"}\n`);
      } });
    const totals = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped"]
      .map(name => [name, results.reduce((sum, result) => sum + (result.counts[name] ?? 0), 0)]));
    console.log(JSON.stringify({ ...plan, files: files.length, completed: results.length,
      failedFiles: results.filter(result => !result.passed).map(result => result.file),
      timedOutFiles: results.filter(result => result.timedOut).map(result => result.file), totals }));
    process.exitCode = controller.signal.aborted ? 130 : results.every(result => result.passed) ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
