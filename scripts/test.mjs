#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_FILE_TIMEOUT_MS = 90_000;

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
  let timeoutMs = DEFAULT_FILE_TIMEOUT_MS;
  const nodeArgs = [], args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--file-timeout-ms") timeoutMs = Number(args[++index]);
    else if (args[index].startsWith("--file-timeout-ms=")) timeoutMs = Number(args[index].split("=")[1]);
    else nodeArgs.push(args[index]);
  }
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
