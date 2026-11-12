#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const DEFAULT_FILE_TIMEOUT_MS = 90_000;

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
  let timeoutMs = DEFAULT_FILE_TIMEOUT_MS;
  const nodeArgs = [], args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--file-timeout-ms") timeoutMs = Number(args[++index]);
    else if (args[index].startsWith("--file-timeout-ms=")) timeoutMs = Number(args[index].split("=")[1]);
    else if (args[index] === "--openclaw-host" || args[index].startsWith("--openclaw-host="))
      process.env.RC_OPENCLAW_HOST_ROOT = await resolveOpenClawTestHost(args[index].includes("=") ? args[index].slice(args[index].indexOf("=") + 1) : args[++index]);
    else nodeArgs.push(args[index]);
  }
  for (const warning of testEnvironmentWarnings()) console.warn(warning);
  const files = readdirSync(path.join(root, "test")).filter(name => name.endsWith(".test.mjs"))
    .sort().map(name => path.join("test", name));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const results = await runTestFiles({ files, cwd: root, timeoutMs, nodeArgs, signal: controller.signal,
      onResult(result) {
        const label = result.timedOut ? `TIMEOUT (${timeoutMs} ms)` : result.passed ? "PASS" : "FAIL";
        console.log(`${label} ${result.file}`);
        if (!result.passed) process.stdout.write(result.output || `${result.error ?? result.exitSignal ?? "Test process failed"}\n`);
      } });
    const totals = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped"]
      .map(name => [name, results.reduce((sum, result) => sum + (result.counts[name] ?? 0), 0)]));
    console.log(JSON.stringify({ files: files.length, completed: results.length,
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
