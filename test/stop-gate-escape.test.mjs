// The Stop gate may fail closed while retries remain, but the plugin's own
// faults must never trap a session. These tests exercise the escape paths
// through the REAL hook process, because the disclosure channel is part of
// the contract (an in-process assertion cannot see an illegal hook payload).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(PLUGIN_ROOT, "scripts", "runtime-event.mjs");

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stop-escape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** Run the hook exactly as Claude Code does: JSON on stdin, JSON on stdout. */
function runHook(root, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK], { cwd: root }, (error, stdout) => {
      const trimmed = String(stdout ?? "").trim();
      resolve({ exitCode: error?.code ?? 0, output: trimmed ? JSON.parse(trimmed) : null });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function stopInput(root, id) {
  return {
    cwd: root,
    session_id: "session-escape",
    transcript_path: path.join(root, "transcript.jsonl"),
    hook_event_name: "Stop",
    hook_event_id: id,
    last_assistant_message: "Task complete.",
  };
}

/** A project whose Stop gate is armed, with a transcript the runtime cannot read. */
async function brokenProject(t, { stopEnabled = true } = {}) {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".runtime-corrector", "config.yaml"),
    [
      "version: 2",
      "artifacts: []",
      "dynamicGroundTruth:",
      "  enabled: true",
      "stopCorrection:",
      `  enabled: ${stopEnabled}`,
      "",
    ].join("\n"),
  );
  // A directory where a transcript file is expected: reading it throws EISDIR,
  // which is neither ENOENT nor recoverable — the outer-crash path.
  await fs.mkdir(path.join(root, "transcript.jsonl"), { recursive: true });
  return root;
}

test("a persistent runtime crash blocks, then releases with a Stop-consumable disclosure", async (t) => {
  const root = await brokenProject(t);
  const first = await runHook(root, stopInput(root, "escape-1"));
  assert.equal(first.output?.decision, "block", "an unverifiable completion is not laundered");
  assert.match(first.output.reason, /attempt 1\/2/u);
  assert.doesNotMatch(first.output.reason, /stopCorrection\.enabled: false/u,
    "a block must never tell the policed agent how to disarm the gate");

  const second = await runHook(root, stopInput(root, "escape-2"));
  assert.equal(second.output?.decision, "block");

  const released = await runHook(root, stopInput(root, "escape-3"));
  assert.equal(released.output?.decision, undefined, "the ceiling releases the session");
  assert.equal(released.output?.continue, true);
  assert.match(released.output.systemMessage, /STOP_VERIFICATION_UNAVAILABLE/u);
  assert.match(released.output.systemMessage, /completed but unverified/iu);
  assert.match(released.output.systemMessage, /stopCorrection\.enabled: false/u,
    "the remedy belongs on the human-facing release channel");
  assert.equal(released.output.hookSpecificOutput, undefined,
    "the Stop contract has no additionalContext — the disclosure must not ride an ignored field");

  const again = await runHook(root, stopInput(root, "escape-4"));
  assert.equal(again.output?.continue, true, "release is sticky while the fault lasts");
});

test("disabling stopCorrection disarms the gate even when the runtime crashes", async (t) => {
  const root = await brokenProject(t, { stopEnabled: false });
  for (const id of ["disarmed-1", "disarmed-2", "disarmed-3"]) {
    const result = await runHook(root, stopInput(root, id));
    assert.notEqual(result.output?.decision, "block",
      "the documented escape hatch must actually disarm the block");
  }
});

test("observe-only mode stays silent through an outer crash", async (t) => {
  const root = await brokenProject(t);
  await fs.appendFile(path.join(root, ".runtime-corrector", "config.yaml"), "shadowMode: true\n");
  const result = await runHook(root, stopInput(root, "shadow-1"));
  assert.equal(result.output, null, "an observe-only run emits nothing at all");
});

test("the fail-closed Stop messages follow the project locale in both directions", async (t) => {
  for (const [locale, blockedPattern, releasedPattern] of [
    ["zh", /最终验收未能完成/u, /最终验收连续/u],
    ["en", /Final Stop review is UNVERIFIED/u, /could not run after/u],
  ]) {
    const root = await brokenProject(t);
    await fs.appendFile(path.join(root, ".runtime-corrector", "config.yaml"), `locale: ${locale}\n`);
    const blocked = await runHook(root, stopInput(root, `locale-${locale}-1`));
    assert.match(blocked.output.reason, blockedPattern, `${locale} block text`);
    assert.doesNotMatch(blocked.output.reason, /stopCorrection\.enabled: false/u,
      "the disarm remedy never appears in agent-facing block text");

    await runHook(root, stopInput(root, `locale-${locale}-2`));
    const released = await runHook(root, stopInput(root, `locale-${locale}-3`));
    assert.match(released.output.systemMessage, releasedPattern, `${locale} release text`);
    assert.match(released.output.systemMessage, /STOP_VERIFICATION_UNAVAILABLE/u,
      "the machine-readable marker stays locale-independent");
    assert.match(released.output.systemMessage, /stopCorrection\.enabled: false/u,
      "the remedy is still discoverable to the human in every locale");
  }
});

test("an agent cannot disarm the Stop gate by editing the config mid-task", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  const configPath = path.join(root, ".runtime-corrector", "config.yaml");
  const config = (stopEnabled) => [
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  panel:",
    "    size: 0",
    "stopCorrection:",
    `  enabled: ${stopEnabled}`,
    "",
  ].join("\n");
  await fs.writeFile(configPath, config(true));
  // A transcript with ordinary development turns — no user ever asks to
  // disable the corrector.
  await fs.writeFile(path.join(root, "transcript.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u1", message: { id: "um1", content: "Build the app." } }),
    JSON.stringify({ type: "assistant", uuid: "a1", message: { id: "am1", content: "Working." } }),
  ].join("\n"));

  const armed = await runHook(root, stopInput(root, "disarm-1"));
  assert.equal(armed.output?.decision, "block", "the gate is armed while the reviewer is unavailable");

  // The agent now edits the plugin's own config to switch the gate off.
  await fs.writeFile(configPath, config(false));
  const afterEdit = await runHook(root, stopInput(root, "disarm-2"));
  assert.equal(afterEdit.output?.decision, "block",
    "a mid-task disarm the user never asked for must not take effect");

  const tasksRoot = path.join(root, ".runtime-correction", "tasks");
  const [taskId] = await fs.readdir(tasksRoot);
  const journal = await fs.readFile(path.join(tasksRoot, taskId, "journal", "events.jsonl"), "utf8");
  assert.match(journal, /STOP_GATE_DISARM_IGNORED/u, "the attempt is recorded, not silently dropped");
});

test("a user who asks for the gate off gets it off", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  const configPath = path.join(root, ".runtime-corrector", "config.yaml");
  const config = (stopEnabled) => [
    "version: 2", "artifacts: []", "dynamicGroundTruth:", "  enabled: true",
    "  panel:", "    size: 0", "stopCorrection:", `  enabled: ${stopEnabled}`, "",
  ].join("\n");
  await fs.writeFile(configPath, config(true));
  await fs.writeFile(path.join(root, "transcript.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u1", message: { id: "um1", content: "Build the app." } }),
  ].join("\n"));
  assert.equal((await runHook(root, stopInput(root, "user-off-1"))).output?.decision, "block");

  // The user asks, then the config changes.
  await fs.writeFile(path.join(root, "transcript.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u1", message: { id: "um1", content: "Build the app." } }),
    JSON.stringify({ type: "user", uuid: "u2", message: { id: "um2", content: "Please disable stopCorrection for now." } }),
  ].join("\n"));
  await fs.writeFile(configPath, config(false));
  const afterUser = await runHook(root, stopInput(root, "user-off-2"));
  assert.notEqual(afterUser.output?.decision, "block", "the user's own instruction is honoured");
});
