import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRoleReviewer } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";


const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-deadline-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


function reviewer(timeoutMs) {
  return {
    effort: "low",
    timeoutMs,
    maxBudgetUsd: null,
    session: "detached",
    provider: null,
  };
}


async function waitForProcessExit(pid, timeoutMs = 1_000) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}


test("structured-output retries share one absolute reviewer deadline", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "deadline-session" });
  const counterPath = path.join(root, "attempt.txt");
  const preloadPath = path.join(root, "fake-claude-preload.cjs");
  await fs.writeFile(preloadPath, String.raw`
const fs = require("node:fs");
const counterPath = process.env.FAKE_REVIEWER_COUNTER;
let attempt = 0;
try { attempt = Number(fs.readFileSync(counterPath, "utf8")); } catch {}
attempt += 1;
fs.writeFileSync(counterPath, String(attempt));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt === 1 ? 30 : 600);
process.stdout.write(JSON.stringify(attempt === 1
  ? { session_id: "fake-review-session", result: "not-json" }
  : { session_id: "fake-review-session", structured_output: { ok: true } }));
process.exit(0);
`, "utf8");
  const startedAt = Date.now();
  await assert.rejects(startRoleReviewer({
    projectRoot: root,
    sessionCwd: root,
    taskId: task.taskId,
    parentSessionId: "deadline-session",
    role: "stop-reviewer",
    reviewer: reviewer(1_000),
    schema: RESULT_SCHEMA,
    request: { test: true },
    deadlineAt: startedAt + 350,
    env: {
      ...process.env,
      RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
      NODE_OPTIONS: `--require=${preloadPath}`,
      FAKE_REVIEWER_COUNTER: counterPath,
    },
  }), /deadline|timed out/iu);
  assert.ok(Date.now() - startedAt < 550, "a retry must not receive a fresh 1000ms timeout");
  assert.equal(await fs.readFile(counterPath, "utf8"), "2");
});


test("structured-result repair shares the original absolute reviewer deadline", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "repair-deadline-session" });
  const counterPath = path.join(root, "repair-attempt.txt");
  const preloadPath = path.join(root, "fake-repair-preload.cjs");
  await fs.writeFile(preloadPath, String.raw`
const fs = require("node:fs");
const counterPath = process.env.FAKE_REVIEWER_COUNTER;
let attempt = 0;
try { attempt = Number(fs.readFileSync(counterPath, "utf8")); } catch {}
attempt += 1;
fs.writeFileSync(counterPath, String(attempt));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt === 1 ? 30 : 600);
process.stdout.write(JSON.stringify({
  session_id: "fake-repair-session",
  structured_output: attempt === 1 ? { ok: "not-a-boolean" } : { ok: true },
}));
process.exit(0);
`, "utf8");
  const startedAt = Date.now();
  await assert.rejects(startRoleReviewer({
    projectRoot: root,
    sessionCwd: root,
    taskId: task.taskId,
    parentSessionId: "repair-deadline-session",
    role: "stop-reviewer",
    reviewer: reviewer(1_000),
    schema: RESULT_SCHEMA,
    request: { test: true },
    deadlineAt: startedAt + 350,
    env: {
      ...process.env,
      RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
      NODE_OPTIONS: `--require=${preloadPath}`,
      FAKE_REVIEWER_COUNTER: counterPath,
    },
  }), /deadline|timed out/iu);
  assert.ok(Date.now() - startedAt < 550, "a repair pass must not receive a fresh 1000ms timeout");
  assert.equal(await fs.readFile(counterPath, "utf8"), "2");
});


test("POSIX reviewer timeout terminates the spawned process group", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "process-group-session" });
  const grandchildPath = path.join(root, "grandchild.mjs");
  const pidPath = path.join(root, "grandchild.pid");
  const preloadPath = path.join(root, "spawn-grandchild.cjs");
  await fs.writeFile(grandchildPath, "setInterval(() => {}, 1000);\n", "utf8");
  await fs.writeFile(preloadPath, String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.env.FAKE_GRANDCHILD], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_GRANDCHILD_PID, String(child.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
`, "utf8");
  let grandchildPid = null;
  t.after(() => {
    if (grandchildPid) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
    }
  });

  await assert.rejects(startRoleReviewer({
    projectRoot: root,
    sessionCwd: root,
    taskId: task.taskId,
    parentSessionId: "process-group-session",
    role: "stop-reviewer",
    reviewer: reviewer(100),
    schema: RESULT_SCHEMA,
    request: { test: true },
    env: {
      ...process.env,
      RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
      NODE_OPTIONS: `--require=${preloadPath}`,
      FAKE_GRANDCHILD: grandchildPath,
      FAKE_GRANDCHILD_PID: pidPath,
    },
  }), /timed out/iu);
  grandchildPid = Number(await fs.readFile(pidPath, "utf8"));
  assert.equal(await waitForProcessExit(grandchildPid), true, "the process-group grandchild must exit");
  grandchildPid = null;
});
