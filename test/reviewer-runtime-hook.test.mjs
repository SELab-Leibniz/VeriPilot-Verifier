import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LITERAL_PREFIX = 'literal 空 格 "quotes" \\windows\\path $HOME ; &';


async function write(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}


async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer hook 空 格-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = await write(root, "fake agent/entry.cjs", String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[2];
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
const requestPath = prompt.match(/--request "([^"]+)"/)?.[1]
  ?? prompt.match(/Read the request at (.+)\.\n/)?.[1]
  ?? prompt.match(/Read (.+?) and (?:perform|assess)/)?.[1];
const request = requestPath ? JSON.parse(fs.readFileSync(requestPath, "utf8")) : null;
const semanticRequest = request?.semanticReviewRequestPath
  ? JSON.parse(fs.readFileSync(request.semanticReviewRequestPath, "utf8"))
  : null;
fs.appendFileSync(process.env.HOOK_REVIEWER_CAPTURE, JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  role: process.env.RUNTIME_CORRECTOR_INTERNAL_ROLE ?? null,
  runtimeProjectRoot: process.env.RUNTIME_CORRECTOR_INTERNAL_PROJECT_ROOT ?? null,
  requestPath,
  request,
  semanticRequest,
}) + "\n");
const result = schema.properties.operations
  ? { summary: "No new claims.", taskClassification: "CONTINUATION", operations: [] }
  : { summary: "Hook fixture review.", findings: [], edits: [], metricObjectJudgements: [] };
process.stdout.write(JSON.stringify({ session_id: "hook-reviewer-session", structured_output: result }));
`);
  return {
    root,
    artifactRoot: path.join(root, "nested artifact"),
    entry,
    capture: path.join(root, "reviewer-capture.jsonl"),
    transcript: await write(root, "transcript.jsonl", ""),
  };
}


function launcherYaml(entry, marker) {
  return [
    "reviewerRuntime:",
    `  executable: ${JSON.stringify(process.execPath)}`,
    "  argsPrefix:",
    `    - ${JSON.stringify(entry)}`,
    `    - ${JSON.stringify(marker)}`,
    `    - ${JSON.stringify(LITERAL_PREFIX)}`,
  ].join("\n");
}


async function artifactPolicy(f, marker, { reviewEnabled = true } = {}) {
  await write(f.artifactRoot, ".runtime-corrector/config.yaml", [
    "version: 1",
    launcherYaml(f.entry, marker),
    "enabledStages:",
    "  - result",
    "artifacts:",
    "  - name: result",
    "    stage: result",
    "    patterns:",
    "      - docs/result.md",
    "    rules:",
    "      enabled: true",
    "      file: empty.rules.yaml",
    "    review:",
    `      enabled: ${reviewEnabled}`,
    "output:",
    "  persist: true",
    "  mode: centralized",
    "  directory: .runtime-correction",
    "",
  ].join("\n"));
  await write(f.artifactRoot, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  return write(f.artifactRoot, "docs/result.md", "# Result\n\nReady for review.\n");
}


async function runPostToolUse(f, targetPath, eventId) {
  const hooks = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, "hooks/hooks.json"), "utf8"));
  const command = hooks.hooks.PostToolUse[0].hooks[0].command;
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RUNTIME_CORRECTOR_") || key === "NODE_OPTIONS" || key === "CLAUDE_PLUGIN_ROOT") {
      delete env[key];
    }
  }
  Object.assign(env, {
    CODEAGENT3_PLUGIN_ROOT: PLUGIN_ROOT,
    // A dropped YAML launcher must fail locally, never launch the real CLI.
    RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: path.join(f.root, "unselected-legacy-agent"),
    CLAUDE_CODE_EXECUTABLE: path.join(f.root, "unselected-legacy-agent"),
    HOOK_REVIEWER_CAPTURE: f.capture,
  });
  const input = {
    session_id: "hook-runtime-parent",
    transcript_path: f.transcript,
    cwd: f.root,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: targetPath },
    tool_response: { success: true },
    tool_use_id: eventId,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: f.root,
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
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}


async function captures(f) {
  const contents = await fs.readFile(f.capture, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return contents.trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}


async function assertInvocation(f, invocation, marker) {
  assert.deepEqual(invocation.argv.slice(0, 2), [marker, LITERAL_PREFIX]);
  assert.equal(invocation.argv.filter((arg) => arg === marker).length, 1);
  assert.equal(invocation.argv.filter((arg) => arg === LITERAL_PREFIX).length, 1);
  assert.equal(await fs.realpath(invocation.cwd), await fs.realpath(f.root));
  assert.equal(invocation.argv[invocation.argv.indexOf("--plugin-dir") + 1], await fs.realpath(PLUGIN_ROOT));
  assert.equal(invocation.argv[invocation.argv.indexOf("--tools") + 1], "Read,Grep");
}


test("declared v1 PostToolUse uses nested artifact YAML launcher and retains the parent session cwd", async (t) => {
  const f = await fixture(t);
  await artifactPolicy({ ...f, artifactRoot: f.root }, "wrong-runtime-owner");
  const target = await artifactPolicy(f, "artifact-owner");
  const completed = await runPostToolUse(f, target, "toolu-v1-reviewer-runtime");
  assert.equal(completed.code, 0, completed.stderr);
  const calls = await captures(f);
  assert.equal(calls.length, 1, `expected configured local reviewer; stdout=${completed.stdout}; stderr=${completed.stderr}`);
  await assertInvocation(f, calls[0], "artifact-owner");
  assert.ok(calls[0].argv.includes("--fork-session"));
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--resume") + 1], "hook-runtime-parent");
  assert.equal(calls[0].request.triggerFile, "docs/result.md");
  assert.match(JSON.parse(completed.stdout).hookSpecificOutput.additionalContext, /隔离语义审阅已完成/u);
});


test("declared v2 PostToolUse keeps runtime-owner YAML and task storage for a fresh nested artifact reviewer", async (t) => {
  const f = await fixture(t);
  await write(f.root, ".runtime-corrector/config.yaml", [
    "version: 2",
    "artifacts: []",
    launcherYaml(f.entry, "runtime-owner"),
    "dynamicGroundTruth:",
    "  enabled: true",
    "  materialRoots: []",
    "  panel:",
    "    size: 0",
    "skillCorrection:",
    "  enabled: false",
    "artifactCorrection:",
    "  groundTruthReviewEnabled: true",
    "  stageMetricsEnabled: false",
    "stopCorrection:",
    "  enabled: false",
    "reviewers:",
    "  defaults:",
    "    timeoutMs: 2000",
    "",
  ].join("\n"));
  const target = await artifactPolicy(f, "wrong-artifact-owner", { reviewEnabled: false });
  const first = await runPostToolUse(f, target, "toolu-v2-reviewer-runtime-first");
  assert.equal(first.code, 0, first.stderr);
  const firstCalls = await captures(f);
  assert.equal(firstCalls.length, 2, `expected Ground Truth plus artifact review; stdout=${first.stdout}; stderr=${first.stderr}`);
  for (const call of firstCalls) await assertInvocation(f, call, "runtime-owner");

  // Unchanged user/material evidence needs no Ground Truth subprocess, so the
  // second event exercises the artifact reviewer factory without a GT handle.
  const second = await runPostToolUse(f, target, "toolu-v2-reviewer-runtime-second");
  assert.equal(second.code, 0, second.stderr);
  const allCalls = await captures(f);
  const freshCalls = allCalls.slice(firstCalls.length);
  assert.equal(freshCalls.length, 1, `expected one fresh artifact reviewer; stdout=${second.stdout}; stderr=${second.stderr}`);
  const fresh = freshCalls[0];
  await assertInvocation(f, fresh, "runtime-owner");
  assert.equal(fresh.role, "artifact-reviewer");
  assert.equal(await fs.realpath(fresh.runtimeProjectRoot), await fs.realpath(f.root));
  assert.equal(fresh.request.schemaVersion, "runtime-corrector.artifact-role-request.v2");
  assert.equal(fresh.semanticRequest.triggerFile, "docs/result.md");
  const tasks = await fs.readdir(path.join(f.root, ".runtime-correction/tasks"));
  assert.equal(tasks.length, 1, "one task under the runtime owner");
  assert.equal(fresh.semanticRequest.runtimeV2.taskId, tasks[0]);
  await assert.rejects(fs.access(path.join(f.artifactRoot, ".runtime-correction/tasks")), { code: "ENOENT" });
  assert.match(JSON.parse(second.stdout).hookSpecificOutput.additionalContext, /隔离语义审阅已完成/u);
});
