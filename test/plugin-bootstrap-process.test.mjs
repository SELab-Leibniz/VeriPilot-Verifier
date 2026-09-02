import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_KEYS = ["CLAUDE_PLUGIN_ROOT", "CODEAGENT3_PLUGIN_ROOT"];


async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}


async function sessionStartCommand() {
  const declaration = JSON.parse(
    await fs.readFile(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  );
  return declaration.hooks.SessionStart[0].hooks[0].command;
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


async function runCommand(command, { cwd, env, input }) {
  const invocation = shellInvocation(command);
  return new Promise((resolve, reject) => {
    const processEnv = { ...process.env };
    for (const key of ROOT_KEYS) delete processEnv[key];
    Object.assign(processEnv, env);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: processEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}


function sessionStartInput(cwd, suffix) {
  return {
    session_id: `bootstrap-${suffix}`,
    transcript_path: path.join(cwd, "transcript.jsonl"),
    cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  };
}


test("the raw declared command runs with only CODEAGENT3_PLUGIN_ROOT", async (t) => {
  const cwd = await temporaryDirectory(t);
  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: { CODEAGENT3_PLUGIN_ROOT: PLUGIN_ROOT },
    input: sessionStartInput(cwd, "codeagent3"),
  });

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "");
  assert.equal(completed.stderr, "");
});


test("the raw declared command accepts canonical-equivalent dual roots", async (t) => {
  const cwd = await temporaryDirectory(t);
  const linkedRoot = path.join(cwd, "plugin root link");
  await fs.symlink(PLUGIN_ROOT, linkedRoot, process.platform === "win32" ? "junction" : "dir");

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CODEAGENT3_PLUGIN_ROOT: linkedRoot,
    },
    input: sessionStartInput(cwd, "equivalent"),
  });

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "");
  assert.equal(completed.stderr, "");
});


test("the raw declared command rejects conflicting dual roots before loading an entry", async (t) => {
  const cwd = await temporaryDirectory(t);
  const otherRoot = await temporaryDirectory(t);

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CODEAGENT3_PLUGIN_ROOT: otherRoot,
    },
    input: sessionStartInput(cwd, "conflict"),
  });

  assert.notEqual(completed.code, 0);
  assert.equal(completed.stdout, "");
  assert.match(completed.stderr, /PLUGIN_ROOT_CONFLICT/u);
  await assert.rejects(fs.access(path.join(cwd, ".runtime-correction")));
});


test("the raw declared command rejects a missing root without stdout", async (t) => {
  const cwd = await temporaryDirectory(t);
  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: {},
    input: sessionStartInput(cwd, "missing"),
  });

  assert.notEqual(completed.code, 0);
  assert.equal(completed.stdout, "");
  assert.match(completed.stderr, /PLUGIN_ROOT_MISSING/u);
});


test("the raw declared command keeps a CodeAgent3 root with spaces and shell characters as data", async (t) => {
  const cwd = await temporaryDirectory(t);
  const linkedRoot = path.join(cwd, "插件 root & (safe)");
  await fs.symlink(PLUGIN_ROOT, linkedRoot, process.platform === "win32" ? "junction" : "dir");

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: { CODEAGENT3_PLUGIN_ROOT: linkedRoot },
    input: sessionStartInput(cwd, "special-path"),
  });

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "");
  assert.equal(completed.stderr, "");
});
