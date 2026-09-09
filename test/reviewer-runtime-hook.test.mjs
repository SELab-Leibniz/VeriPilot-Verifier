import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LITERAL_PREFIX = 'literal 空 格 "quotes" \\windows\\path $HOME ; &';
const AMBIENT_TOKEN = "hook-test-ambient-token";
const TARGET_TOKEN = "hook-test-target-token";


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
const path = require("node:path");
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
const frozen = {};
for (const [key, file] of Object.entries({
  transcript: request?.transcript?.path,
  groundTruth: request?.groundTruthPath,
  skill: request?.skillGroundTruthPath,
})) {
  if (file) frozen[key] = JSON.parse(fs.readFileSync(file, "utf8"));
}
const runId = process.env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID ?? null;
const runtimeRoot = process.env.RUNTIME_CORRECTOR_INTERNAL_PROJECT_ROOT;
const lease = runId ? JSON.parse(fs.readFileSync(path.join(runtimeRoot, ".runtime-correction", "internal-runs", runId + ".json"), "utf8")) : null;
let previousCalls = [];
try { previousCalls = fs.readFileSync(process.env.HOOK_REVIEWER_CAPTURE, "utf8").trim().split("\n").map(JSON.parse); } catch {}
const priorGroundTruth = previousCalls.reverse().find((call) => call.role === "ground-truth-extractor");
fs.appendFileSync(process.env.HOOK_REVIEWER_CAPTURE, JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  role: process.env.RUNTIME_CORRECTOR_INTERNAL_ROLE ?? null,
  runtimeProjectRoot: process.env.RUNTIME_CORRECTOR_INTERNAL_PROJECT_ROOT ?? null,
  runId,
  lease,
  provider: process.env.ANTHROPIC_BASE_URL ?? null,
  token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  ambientApiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
  requestPath,
  request,
  semanticRequest,
  frozen,
  originDirectoryExists: priorGroundTruth?.requestPath
    ? fs.existsSync(path.dirname(priorGroundTruth.requestPath))
    : null,
}) + "\n");
const result = schema.properties.operations
  ? { summary: "No new claims.", taskClassification: "CONTINUATION", operations: [], ...(request?.skill ? {
    skillGroundTruth: { constraints: [{ constraintId: "read-task", kind: "STEP", modality: "MUST", statement: "Read the task before reviewing." }], taskOverlays: [] },
  } : {}) }
  : schema.properties.completionStatus
    ? { summary: "Skill completed.", completionStatus: "COMPLETED", findings: [] }
    : { summary: "Hook fixture review.", findings: [], edits: [], metricObjectJudgements: [] };
process.stdout.write(JSON.stringify({ session_id: runId ?? "hook-reviewer-session", structured_output: result }));
`);
  const transcriptEntries = [
    { type: "user", uuid: "hook-user", message: { content: "Review the completed artifact against the task requirements." } },
    { type: "assistant", uuid: "hook-assistant", message: { id: "hook-assistant-message", content: [{ type: "text", text: "Artifact prepared for review." }] } },
  ];
  const transcriptText = `${transcriptEntries.map((item) => JSON.stringify(item)).join("\n")}\n`;
  return {
    root,
    artifactRoot: path.join(root, "nested artifact"),
    entry,
    capture: path.join(root, "reviewer-capture.jsonl"),
    transcript: await write(root, "transcript.jsonl", transcriptText),
    transcriptEntries,
    sourceDigest: createHash("sha256").update(transcriptText).digest("hex"),
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


async function runPostToolUse(f, targetPath, eventId, { hookEventName = "PostToolUse", toolName = "Write", toolInput = { file_path: targetPath } } = {}) {
  const hooks = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, "hooks/hooks.json"), "utf8"));
  const command = hooks.hooks[hookEventName][0].hooks[0].command;
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
    ANTHROPIC_BASE_URL: "https://hook-ambient.invalid",
    ANTHROPIC_AUTH_TOKEN: AMBIENT_TOKEN,
    ANTHROPIC_API_KEY: "hook-test-parent-api-key",
    HOOK_TARGET_PROVIDER_KEY: TARGET_TOKEN,
  });
  const input = {
    session_id: "hook-runtime-parent",
    transcript_path: f.transcript,
    cwd: f.root,
    hook_event_name: hookEventName,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { success: true },
    tool_use_id: eventId,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: f.root,
      env,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
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
  const requestData = JSON.stringify({ request: invocation.request, semantic: invocation.semanticRequest, frozen: invocation.frozen });
  for (const secret of [AMBIENT_TOKEN, TARGET_TOKEN, "hook-test-parent-api-key"]) {
    assert.ok(!requestData.includes(secret), "reviewer requests must not serialize credentials");
  }
}


async function assertTargetEvidence(f, call) {
  const requestDirectory = path.dirname(call.requestPath);
  assert.deepEqual(call.frozen.transcript.entries, f.transcriptEntries);
  assert.equal(call.request.transcript.digest, f.sourceDigest);
  assert.equal(call.request.transcript.cursor, "hook-assistant");
  assert.equal(call.semanticRequest.runtimeV2.transcriptDigest, f.sourceDigest);
  assert.equal(call.semanticRequest.runtimeV2.transcriptCursor, "hook-assistant");
  assert.deepEqual(call.semanticRequest.runtimeV2.transcript, call.request.transcript);
  assert.equal(call.semanticRequest.runtimeV2.groundTruthPath, call.request.groundTruthPath);
  for (const file of [call.request.transcript.path, call.request.groundTruthPath, call.request.semanticReviewRequestPath]) {
    assert.equal(
      path.normalize(path.dirname(file)),
      path.normalize(requestDirectory),
      "evidence belongs to the target request directory",
    );
    await assert.rejects(fs.access(file), { code: "ENOENT" });
  }
  assert.equal(call.frozen.groundTruth.taskId, call.semanticRequest.runtimeV2.taskId);
  assert.equal(call.frozen.groundTruth.version, call.semanticRequest.runtimeV2.groundTruthVersion);
  const serialized = JSON.stringify({ request: call.request, semantic: call.semanticRequest, frozen: call.frozen });
  for (const secret of [AMBIENT_TOKEN, TARGET_TOKEN, "hook-test-parent-api-key"]) {
    assert.ok(!serialized.includes(secret), "request evidence must not contain credentials");
  }
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


test("declared v2 PostToolUse hands off to the configured artifact provider with a new lease and frozen owner evidence", async (t) => {
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
    "  groundTruthExtractor:",
    "    model: ambient-model",
    "  artifactReviewer:",
    "    session: independent",
    "    provider:",
    "      baseUrl: https://hook-reviewer.invalid",
    "      apiKeyEnv: HOOK_TARGET_PROVIDER_KEY",
    "      model: target-provider-model",
    "",
  ].join("\n"));
  const target = await artifactPolicy(f, "wrong-artifact-owner", { reviewEnabled: false });
  const first = await runPostToolUse(f, target, "toolu-v2-reviewer-runtime-first");
  assert.equal(first.code, 0, first.stderr);
  const firstCalls = await captures(f);
  assert.equal(firstCalls.length, 2, `expected Ground Truth plus artifact review; stdout=${first.stdout}; stderr=${first.stderr}`);
  for (const call of firstCalls) await assertInvocation(f, call, "runtime-owner");
  const [origin, targetReview] = firstCalls;
  assert.equal(origin.role, "ground-truth-extractor");
  assert.equal(origin.provider, "https://hook-ambient.invalid");
  assert.equal(origin.token, AMBIENT_TOKEN);
  assert.ok(origin.argv.includes("--fork-session"));
  assert.equal(targetReview.role, "artifact-reviewer");
  assert.notEqual(targetReview.runId, origin.runId, "cross-role review owns a new internal run");
  assert.notEqual(path.dirname(targetReview.requestPath), path.dirname(origin.requestPath));
  assert.equal(targetReview.lease.role, "artifact-reviewer");
  assert.equal(targetReview.provider, "https://hook-reviewer.invalid");
  assert.equal(targetReview.token, TARGET_TOKEN);
  assert.equal(targetReview.ambientApiKeyPresent, false);
  assert.equal(targetReview.argv[targetReview.argv.indexOf("--model") + 1], "target-provider-model");
  assert.ok(!targetReview.argv.includes("--resume"));
  assert.ok(!targetReview.argv.includes("--fork-session"));
  assert.equal(targetReview.originDirectoryExists, false);
  await assertTargetEvidence(f, targetReview);

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
  assert.notEqual(fresh.runId, targetReview.runId);
  assert.equal(fresh.provider, "https://hook-reviewer.invalid");
  assert.equal(fresh.token, TARGET_TOKEN);
  assert.ok(!fresh.argv.includes("--resume"));
  assert.equal(await fs.realpath(fresh.runtimeProjectRoot), await fs.realpath(f.root));
  assert.equal(fresh.request.schemaVersion, "runtime-corrector.artifact-role-request.v2");
  assert.equal(fresh.semanticRequest.triggerFile, "docs/result.md");
  const tasks = await fs.readdir(path.join(f.root, ".runtime-correction/tasks"));
  assert.equal(tasks.length, 1, "one task under the runtime owner");
  assert.equal(fresh.semanticRequest.runtimeV2.taskId, tasks[0]);
  await assertTargetEvidence(f, fresh);
  const journal = await fs.readFile(path.join(f.root, ".runtime-correction/tasks", tasks[0], "journal/events.jsonl"), "utf8");
  const envelopes = journal.trim().split(/\r?\n/u).map(JSON.parse).filter((event) => event.type === "REVIEWER_ENVELOPE");
  assert.deepEqual(envelopes.map((event) => event.role), ["ground-truth-extractor", "artifact-reviewer", "artifact-reviewer"]);
  assert.ok(!journal.includes(TARGET_TOKEN));
  assert.ok(!journal.includes(AMBIENT_TOKEN));
  await assert.rejects(fs.access(path.join(f.artifactRoot, ".runtime-correction/tasks")), { code: "ENOENT" });
  assert.match(JSON.parse(second.stdout).hookSpecificOutput.additionalContext, /隔离语义审阅已完成/u);
});


test("declared Skill hooks hand off refreshed Ground Truth to a new configured Skill reviewer", async (t) => {
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
    "  enabled: true",
    "  selection:",
    "    mode: include",
    "    include:",
    "      - runtime-corrector-control",
    "  completionCheckIntervalTurns: 1",
    "  maxWatchTurns: 2",
    "  maxFeedbacksPerSkill: 1",
    "stopCorrection:",
    "  enabled: false",
    "reviewers:",
    "  defaults:",
    "    timeoutMs: 2000",
    "  skillReviewer:",
    "    session: independent",
    "    provider:",
    "      baseUrl: https://hook-reviewer.invalid",
    "      apiKeyEnv: HOOK_TARGET_PROVIDER_KEY",
    "      model: target-provider-model",
    "",
  ].join("\n"));
  const start = await runPostToolUse(f, f.transcript, "toolu-start-skill", {
    hookEventName: "PreToolUse",
    toolName: "Skill",
    toolInput: { skill: "runtime-corrector-control" },
  });
  assert.equal(start.code, 0, start.stderr);
  assert.equal((await captures(f)).length, 1, `Skill start extracts Ground Truth once: ${start.stdout}`);
  const nextEntries = [...f.transcriptEntries, {
    type: "user", uuid: "hook-skill-follow-up", message: { content: "The Skill has completed; assess its required steps." },
  }];
  const nextTranscript = `${nextEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await fs.writeFile(f.transcript, nextTranscript, "utf8");
  const completed = await runPostToolUse(f, f.transcript, "toolu-assess-skill", { toolName: "Read" });
  assert.equal(completed.code, 0, completed.stderr);
  const calls = await captures(f);
  assert.equal(calls.length, 3, `one initial GT, one refreshed GT, one Skill review; stdout=${completed.stdout}; stderr=${completed.stderr}`);
  const [initial, origin, target] = calls;
  assert.deepEqual(calls.map((call) => call.role), ["ground-truth-extractor", "ground-truth-extractor", "skill-reviewer"]);
  for (const call of calls) await assertInvocation(f, call, "runtime-owner");
  assert.notEqual(target.runId, origin.runId);
  assert.notEqual(target.runId, initial.runId);
  assert.equal(target.lease.role, "skill-reviewer");
  assert.equal(target.provider, "https://hook-reviewer.invalid");
  assert.equal(target.token, TARGET_TOKEN);
  assert.equal(target.ambientApiKeyPresent, false);
  assert.ok(!target.argv.includes("--resume"));
  assert.equal(target.originDirectoryExists, false);
  assert.equal(target.request.schemaVersion, "runtime-corrector.skill-review-request.v2");
  assert.deepEqual(target.frozen.transcript.entries, nextEntries);
  assert.equal(target.request.transcript.digest, createHash("sha256").update(nextTranscript).digest("hex"));
  assert.equal(target.request.transcript.cursor, "hook-skill-follow-up");
  assert.equal(target.frozen.skill.constraints[0].statement, "Read the task before reviewing.");
  for (const evidencePath of [target.request.transcript.path, target.request.groundTruthPath, target.request.skillGroundTruthPath]) {
    assert.equal(
      path.normalize(path.dirname(evidencePath)),
      path.normalize(path.dirname(target.requestPath)),
    );
    await assert.rejects(fs.access(evidencePath), { code: "ENOENT" });
  }
  const serialized = JSON.stringify({ request: target.request, frozen: target.frozen });
  assert.ok(!serialized.includes(TARGET_TOKEN));
  assert.ok(!serialized.includes(AMBIENT_TOKEN));
  const task = JSON.parse(await fs.readFile(path.join(f.root, ".runtime-correction/tasks", target.lease.taskId, "task.json"), "utf8"));
  assert.deepEqual(Object.values(task.watchers).map((watcher) => watcher.status), ["PASS"]);
});
