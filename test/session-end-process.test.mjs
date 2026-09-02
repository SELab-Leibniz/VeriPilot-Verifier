import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createInternalRunLease,
  internalRunEnvironment,
  releaseInternalRunLease,
} from "../lib/runtime-v2/internal-run.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARD_DEADLINE_MS = 1_200;


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-end-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function declaredSessionEndHook() {
  const declarations = JSON.parse(await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const hooks = declarations.hooks.SessionEnd
    .flatMap((registration) => registration.hooks)
    .filter((hook) => hook.type === "command");
  assert.equal(hooks.length, 1, "SessionEnd must declare exactly one command");
  assert.match(hooks[0].command, /"scripts\/session-end\.mjs"$/u);
  return hooks[0];
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


function cleanProcessEnvironment(overrides = {}) {
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
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}


async function runDeclaredSessionEnd({
  cwd,
  input,
  env = {},
  keepStdinOpen = false,
  rawInput = null,
  declaredPluginRoot = pluginRoot,
}) {
  const command = (await declaredSessionEndHook()).command;
  const invocation = shellInvocation(command);
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: { ...cleanProcessEnvironment(env), CLAUDE_PLUGIN_ROOT: declaredPluginRoot },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, HARD_DEADLINE_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        elapsedMs: performance.now() - startedAt,
      });
    });
    const serialized = rawInput ?? JSON.stringify(input);
    if (keepStdinOpen) child.stdin.write(serialized);
    else child.stdin.end(serialized);
  });
}


async function injectStaleCleanupWork(root) {
  const outputRoot = path.join(root, ".runtime-correction");
  const staleTemporary = path.join(outputRoot, "nested", ".state.json.1234.abcdef12.tmp");
  const expiredLease = path.join(outputRoot, "internal-runs", "expired.json");
  await fs.mkdir(path.dirname(staleTemporary), { recursive: true });
  await fs.mkdir(path.dirname(expiredLease), { recursive: true });
  await fs.writeFile(staleTemporary, "stale atomic write", "utf8");
  await fs.utimes(staleTemporary, new Date(0), new Date(0));
  await fs.writeFile(expiredLease, `${JSON.stringify({
    runId: "expired",
    expiresAt: new Date(0).toISOString(),
  })}\n`, "utf8");
  return { staleTemporary, expiredLease };
}


async function assertFastSuccessfulSilence(result) {
  assert.equal(result.timedOut, false, `SessionEnd exceeded ${HARD_DEADLINE_MS} ms`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.ok(result.elapsedMs < HARD_DEADLINE_MS, `SessionEnd took ${result.elapsedMs.toFixed(1)} ms`);
}


test("declared taskless SessionEnd stays silent and leaves recovery work for SessionStart", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".runtime-corrector", "config.yaml"),
    "version: [broken yaml\n",
    "utf8",
  );
  const stale = await injectStaleCleanupWork(root);

  const result = await runDeclaredSessionEnd({
    cwd: root,
    input: {
      cwd: root,
      session_id: "taskless-session-end",
      hook_event_name: "SessionEnd",
      transcript_path: path.join(root, "missing-transcript.jsonl"),
      reason: "other",
    },
  });

  await assertFastSuccessfulSilence(result);
  await fs.access(stale.staleTemporary);
  await fs.access(stale.expiredLease);
  await assert.rejects(fs.access(path.join(root, ".runtime-correction", "runtime-v2-warnings")));
  await assert.rejects(fs.access(path.join(root, ".runtime-correction", "tasks")));
});


test("declared SessionEnd watchdog releases a process stalled before stdin EOF", async (t) => {
  const root = await workspace(t);
  const declaration = await declaredSessionEndHook();
  const result = await runDeclaredSessionEnd({
    cwd: root,
    keepStdinOpen: true,
    input: {
      cwd: root,
      session_id: "stalled-session-end",
      hook_event_name: "SessionEnd",
      transcript_path: path.join(root, "transcript.jsonl"),
      reason: "other",
    },
  });

  await assertFastSuccessfulSilence(result);
  assert.equal(declaration.timeout, 1, "host declaration must match the sub-1200ms capability budget");
});


test("declared SessionEnd appends one lifecycle event to the indexed task", async (t) => {
  const root = await workspace(t);
  const sessionId = "active-session-end";
  const task = await ensureTask({ projectRoot: root, sessionId });

  const result = await runDeclaredSessionEnd({
    cwd: root,
    input: {
      cwd: root,
      session_id: sessionId,
      hook_event_name: "SessionEnd",
      hook_event_id: "active-session-end-event",
      tool_use_id: "extraneous-tool-identity",
      transcript_path: path.join(root, "transcript.jsonl"),
      reason: "other",
    },
  });

  await assertFastSuccessfulSilence(result);
  const lines = (await fs.readFile(
    path.join(taskDirectory(root, task.taskId), "journal", "events.jsonl"),
    "utf8",
  )).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.deepEqual(
    {
      type: lines[0].type,
      hookEventId: lines[0].hookEventId,
      hookEventName: lines[0].hookEventName,
      toolName: lines[0].toolName,
    },
    {
      type: "HOOK_EVENT",
      hookEventId: "active-session-end-event",
      hookEventName: "SessionEnd",
      toolName: null,
    },
  );
  assert.equal(Object.hasOwn(lines[0], "lifecycleOnly"), false);
});


test("declared SessionEnd rejects stdin above 256 KiB without journaling", async (t) => {
  const root = await workspace(t);
  const sessionId = "oversized-session-end";
  const task = await ensureTask({ projectRoot: root, sessionId });
  const rawInput = JSON.stringify({
    cwd: root,
    session_id: sessionId,
    hook_event_name: "SessionEnd",
    hook_event_id: "oversized-session-end-event",
    transcript_path: path.join(root, "transcript.jsonl"),
    reason: "other",
    padding: "界".repeat(90_000),
  });
  assert.ok(Buffer.byteLength(rawInput, "utf8") > 256 * 1024);

  const result = await runDeclaredSessionEnd({ cwd: root, input: null, rawInput });

  await assertFastSuccessfulSilence(result);
  await assert.rejects(fs.access(
    path.join(taskDirectory(root, task.taskId), "journal", "events.jsonl"),
  ));
});


test("declared Node launch preserves a plugin root containing spaces", async (t) => {
  const root = await workspace(t);
  const spacedRoot = path.join(root, "plugin root with spaces");
  await fs.symlink(pluginRoot, spacedRoot, "dir");
  const result = await runDeclaredSessionEnd({
    cwd: root,
    declaredPluginRoot: spacedRoot,
    input: {
      cwd: root,
      session_id: "spaced-root-session-end",
      hook_event_name: "SessionEnd",
      transcript_path: path.join(root, "transcript.jsonl"),
      reason: "other",
    },
  });
  await assertFastSuccessfulSilence(result);
});


test("declared SessionEnd excludes authenticated internal reviewer traffic", async (t) => {
  const root = await workspace(t);
  const sessionId = "internal-session-end";
  const task = await ensureTask({ projectRoot: root, sessionId });
  const lease = await createInternalRunLease({
    projectRoot: root,
    taskId: task.taskId,
    role: "stop-reviewer",
  });
  t.after(() => releaseInternalRunLease(lease));

  const result = await runDeclaredSessionEnd({
    cwd: root,
    env: internalRunEnvironment(lease, {}),
    input: {
      cwd: root,
      session_id: sessionId,
      hook_event_name: "SessionEnd",
      hook_event_id: "internal-session-end-event",
      transcript_path: path.join(root, "internal-transcript.jsonl"),
      reason: "other",
    },
  });

  await assertFastSuccessfulSilence(result);
  await assert.rejects(fs.access(
    path.join(taskDirectory(root, task.taskId), "journal", "events.jsonl"),
  ));
});


test("dedicated SessionEnd command rejects other hook events without side effects", async (t) => {
  const root = await workspace(t);
  const sessionId = "wrong-event-on-session-end-command";
  const task = await ensureTask({ projectRoot: root, sessionId });

  const result = await runDeclaredSessionEnd({
    cwd: root,
    input: {
      cwd: root,
      session_id: sessionId,
      hook_event_name: "SessionStart",
      transcript_path: path.join(root, "transcript.jsonl"),
      source: "startup",
    },
  });

  await assertFastSuccessfulSilence(result);
  await assert.rejects(fs.access(
    path.join(taskDirectory(root, task.taskId), "journal", "events.jsonl"),
  ));
});
