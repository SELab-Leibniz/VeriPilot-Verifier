import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-root-propagation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(root, ".runtime-corrector", "config.yaml"), [
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  panel:",
    "    size: 0",
    "skillCorrection:",
    "  enabled: true",
    "  selection:",
    "    mode: include",
    "    include:",
    "      - runtime-corrector-control",
    "  completionCheckIntervalTurns: 10",
    "  maxWatchTurns: 30",
    "  maxFeedbacksPerSkill: 1",
    "stopCorrection:",
    "  enabled: false",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(root, "transcript.jsonl"), "", "utf8");
  return root;
}


async function preToolUseCommand() {
  const declaration = JSON.parse(
    await fs.readFile(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  );
  return declaration.hooks.PreToolUse[0].hooks[0].command;
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


async function runCodeAgent3Only(command, cwd, input) {
  const invocation = shellInvocation(command);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CODEAGENT3_PLUGIN_ROOT: PLUGIN_ROOT };
    delete env.CLAUDE_PLUGIN_ROOT;
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}


async function onlyTaskState(root) {
  const tasksRoot = path.join(root, ".runtime-correction", "tasks");
  let taskEntries;
  try {
    taskEntries = await fs.readdir(tasksRoot, { withFileTypes: true });
  } catch (error) {
    const warningRoot = path.join(root, ".runtime-correction", "runtime-v2-warnings");
    const warnings = [];
    for (const name of await fs.readdir(warningRoot).catch(() => [])) {
      warnings.push(await fs.readFile(path.join(warningRoot, name), "utf8"));
    }
    assert.fail(`runtime task was not created: ${error.message}; warnings=${warnings.join(" | ")}`);
  }
  const tasks = taskEntries.filter((entry) => entry.isDirectory());
  assert.equal(tasks.length, 1, "one runtime task");
  return JSON.parse(await fs.readFile(
    path.join(tasksRoot, tasks[0].name, "task.json"),
    "utf8",
  ));
}


test("CodeAgent3-only PreToolUse discovers a plugin-bundled Skill through the canonical root", async (t) => {
  const root = await workspace(t);
  const completed = await runCodeAgent3Only(await preToolUseCommand(), root, {
    session_id: "codeagent3-plugin-skill",
    transcript_path: path.join(root, "transcript.jsonl"),
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: "Skill",
    tool_input: { skill: "runtime-corrector-control" },
    tool_use_id: "toolu-codeagent3-plugin-skill",
  });

  assert.equal(completed.code, 0, completed.stderr);
  const state = await onlyTaskState(root);
  const watchers = Object.values(state.watchers);
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].skillId, "runtime-corrector-control");
  assert.equal(watchers[0].status, "ACTIVE");
});
