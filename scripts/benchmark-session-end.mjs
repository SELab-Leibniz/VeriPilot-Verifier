#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { ensureTask } from "../lib/runtime-v2/task-store.mjs";


const SAMPLE_COUNT = 20;
const WARMUP_COUNT = 3;
const TASKLESS_P95_LIMIT_MS = 150;
const ACTIVE_TASK_P95_LIMIT_MS = 300;
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookDeclarations = JSON.parse(
  await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
);
const sessionEndCommand = hookDeclarations.hooks.SessionEnd[0].hooks[0].command;


function cleanEnvironment() {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CODEAGENT3_PLUGIN_ROOT;
  env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  for (const key of [
    "RUNTIME_CORRECTOR_TASK_ID",
    "RUNTIME_CORRECTOR_SEMANTIC_REVIEW_ACTIVE",
    "RUNTIME_CORRECTOR_INTERNAL_RUN_ID",
    "RUNTIME_CORRECTOR_INTERNAL_ROLE",
    "RUNTIME_CORRECTOR_INTERNAL_DEPTH",
    "RUNTIME_CORRECTOR_INTERNAL_TOKEN",
    "RUNTIME_CORRECTOR_INTERNAL_PROJECT_ROOT",
  ]) delete env[key];
  return env;
}


function shellInvocation(command) {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return { executable: "/bin/sh", args: ["-c", command] };
}


function runSessionEnd(cwd, input) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const invocation = shellInvocation(sessionEndCommand);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: cleanEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal || stdout || stderr) {
        reject(new Error(`SessionEnd benchmark process failed: ${JSON.stringify({ code, signal, stdout, stderr })}`));
        return;
      }
      resolve(performance.now() - startedAt);
    });
    child.stdin.end(JSON.stringify(input));
  });
}


function percentile95(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}


async function sample(label, cwd, inputFactory, limitMs) {
  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    await runSessionEnd(cwd, inputFactory(`warmup-${index}`));
  }
  const durationsMs = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    durationsMs.push(await runSessionEnd(cwd, inputFactory(`sample-${index}`)));
  }
  const p95Ms = percentile95(durationsMs);
  if (p95Ms > limitMs) {
    throw new Error(`${label} SessionEnd p95 ${p95Ms.toFixed(2)}ms exceeds ${limitMs}ms`);
  }
  return {
    samples: SAMPLE_COUNT,
    p95Ms: Number(p95Ms.toFixed(2)),
    limitMs,
  };
}


const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-end-benchmark-"));
try {
  const transcriptPath = path.join(root, "transcript.jsonl");
  await fs.writeFile(transcriptPath, "", "utf8");
  const taskless = await sample("taskless", root, (suffix) => ({
    cwd: root,
    session_id: `taskless-${suffix}`,
    hook_event_name: "SessionEnd",
    hook_event_id: `taskless-${suffix}`,
    transcript_path: transcriptPath,
    reason: "other",
  }), TASKLESS_P95_LIMIT_MS);

  const activeSessionId = "active-benchmark-session";
  await ensureTask({ projectRoot: root, sessionId: activeSessionId });
  const activeTask = await sample("active-task", root, (suffix) => ({
    cwd: root,
    session_id: activeSessionId,
    hook_event_name: "SessionEnd",
    hook_event_id: `active-${suffix}`,
    transcript_path: transcriptPath,
    reason: "other",
  }), ACTIVE_TASK_P95_LIMIT_MS);

  process.stdout.write(`${JSON.stringify({ taskless, activeTask })}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
