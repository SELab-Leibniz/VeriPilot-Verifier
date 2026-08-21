import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../lib/runtime-corrector.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runHookScript(script, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, "scripts", script)], {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function shadowProject(t, configLines) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-failopen-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(root, ".runtime-corrector", "config.yaml"), configLines.join("\n"), "utf8");
  return root;
}

// THE launch-critical property: whatever goes wrong inside the corrector —
// missing transcripts, broken config, crashed reviewers — a SHADOW (or
// arm-unknown) hook invocation writes NOTHING to stdout. Fail-open warnings
// are model-visible text like any other; round 1 was voided by exactly this
// class of leak.

test("runtime-event emits nothing under a shadow config even when processing fails", async (t) => {
  const root = await shadowProject(t, [
    "shadowMode: true",
    "version: 2",
    "artifacts:",
    "  - name: requirements",
    "    stage: requirements",
    "    format: markdown",
    "    patterns:",
    "      - spec/requirements.md",
    "dynamicGroundTruth:",
    "  enabled: true",
    "stopCorrection:",
    "  enabled: true",
    "",
  ]);
  // A Stop event with a nonexistent transcript forces the internal machinery
  // down its failure paths.
  const { stdout } = await runHookScript("runtime-event.mjs", {
    cwd: root,
    input: {
      cwd: root,
      session_id: "shadow-smoke",
      hook_event_name: "Stop",
      hook_event_id: "stop-smoke",
      transcript_path: path.join(root, "does-not-exist.jsonl"),
      last_assistant_message: "done",
    },
  });
  assert.equal(stdout.trim(), "", "shadow arm must write NOTHING to stdout on failure");
});

test("runtime-event emits nothing when the arm cannot be determined (config load failure)", async (t) => {
  const root = await shadowProject(t, ["version: [broken yaml", ""]);
  const { stdout } = await runHookScript("runtime-event.mjs", {
    cwd: root,
    input: {
      cwd: root,
      session_id: "unknown-arm",
      hook_event_name: "Stop",
      hook_event_id: "stop-unknown",
      transcript_path: path.join(root, "missing.jsonl"),
      last_assistant_message: "done",
    },
  });
  assert.equal(stdout.trim(), "", "an undetermined arm must stay silent — silence cannot contaminate a control");
});

test("runtime-event fails closed when an active Stop crashes after config load", async (t) => {
  const root = await shadowProject(t, [
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  panel:",
    "    size: 0",
    "stopCorrection:",
    "  enabled: true",
    "",
  ]);
  const plan = await loadConfig({ cwd: root, pluginRoot });
  assert.equal(plan.runtimeV2.shadowMode, false);
  assert.equal(plan.runtimeV2.stopCorrection.enabled, true);
  const { code, stdout, stderr } = await runHookScript("runtime-event.mjs", {
    cwd: root,
    input: {
      cwd: root,
      session_id: "active-stop-crash",
      hook_event_name: "Stop",
      hook_event_id: "stop-active-crash",
      // Reading a directory as a transcript fails after the active config and
      // arm have been loaded, exercising the lifecycle hook's outer catch.
      transcript_path: root,
      last_assistant_message: "Everything is complete and fully verified.",
    },
  });

  assert.equal(code, 0);
  assert.ok(stdout.trim(), `active Stop emitted no fail-closed output; stderr: ${stderr}`);
  const output = JSON.parse(stdout.trim());
  assert.equal(output.decision, "block");
  assert.match(output.reason, /Final Stop review is UNVERIFIED/u);
});


test("post-tool-use emits nothing under a shadow config even when processing fails", async (t) => {
  const root = await shadowProject(t, [
    "shadowMode: true",
    "version: 2",
    "artifacts:",
    "  - name: requirements",
    "    stage: requirements",
    "    format: markdown",
    "    patterns:",
    "      - spec/requirements.md",
    "",
  ]);
  await fs.mkdir(path.join(root, "spec"), { recursive: true });
  await fs.writeFile(path.join(root, "spec", "requirements.md"), "# spec\n", "utf8");
  const { stdout } = await runHookScript("post-tool-use.mjs", {
    cwd: root,
    input: {
      cwd: root,
      session_id: "shadow-smoke-ptu",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "spec", "requirements.md") },
      transcript_path: path.join(root, "missing.jsonl"),
    },
  });
  // Either fully silent, or a hookOutput whose additionalContext is EMPTY —
  // no corrector text may reach a shadow developer.
  if (stdout.trim()) {
    const parsed = JSON.parse(stdout.trim());
    const context = parsed?.hookSpecificOutput?.additionalContext ?? "";
    assert.equal(context, "", `shadow arm leaked context: ${context.slice(0, 120)}`);
  }
});
