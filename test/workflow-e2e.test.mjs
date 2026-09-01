import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
const POST_TOOL_USE = path.join(PLUGIN_ROOT, "scripts", "post-tool-use.mjs");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-workflow-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


function workflowConfig({
  enabledStages = ["source-a", "source-b", "target"],
  workflow = true,
  persist = true,
} = {}) {
  return `version: 1
enabledStages:
${enabledStages.map((stage) => `  - ${stage}`).join("\n")}
artifacts:
  - name: source-a
    stage: source-a
    patterns:
      - docs/source-a.md
    rules:
      enabled: true
      file: empty.rules.yaml
  - name: source-b
    stage: source-b
    patterns:
      - docs/source-b.md
    rules:
      enabled: true
      file: empty.rules.yaml
  - name: target
    stage: target
    patterns:
      - docs/target.md
    rules:
      enabled: true
      file: empty.rules.yaml
    review:
      enabled: true
${workflow
    ? `workflow:
  edges:
    - from: source-a
      to: target
      review:
        enabled: true
        criteria: source-a-to-target.reviewer.md
    - from: source-b
      to: target
      review:
        enabled: true
`
    : ""}
output:
  persist: ${persist}
  mode: centralized
  directory: .runtime-correction
`;
}


async function createWorkflowProject(t, options = {}) {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", workflowConfig(options));
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  await writeFile(
    cwd,
    ".runtime-corrector/source-a-to-target.reviewer.md",
    "# Source A alignment\n\nKeep Source A decisions traceable.\n",
  );
  return cwd;
}


function runCli(cwd, ...args) {
  return spawnSync(
    process.execPath,
    [CLI, ...args, "--cwd", cwd],
    { cwd, encoding: "utf8", windowsHide: true },
  );
}


function hookInput(cwd, filePath) {
  return {
    session_id: "e2e-parent-session",
    transcript_path: path.join(cwd, "transcript.jsonl"),
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath },
    tool_response: { success: true },
    tool_use_id: "toolu-workflow-e2e",
  };
}


async function createFakeClaudeShim(cwd) {
  return writeFile(cwd, "fake-claude-preload.cjs", String.raw`
const fs = require("node:fs");
const path = require("node:path");

const prompt = process.argv[1] || "";
if (prompt.includes("runtime-corrector:semantic-review --request ")) {
  const requestMatch = prompt.match(/--request "([^"]+)"/);
  if (!requestMatch) {
    process.stderr.write("missing request path");
    process.exit(2);
  }
  const requestPath = path.resolve(process.cwd(), requestMatch[1]);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_CAPTURE,
    JSON.stringify({ argv: process.argv.slice(1), request }) + "\n",
    "utf8",
  );
  const review = JSON.parse(process.env.FAKE_CLAUDE_REVIEW);
  process.stdout.write(JSON.stringify({
    session_id: "e2e-fork-session",
    structured_output: review,
  }));
  process.exit(0);
}
`);
}


async function runHookWithFakeClaude(cwd, filePath, review) {
  const shimPath = await createFakeClaudeShim(cwd);
  const capturePath = path.join(cwd, "fake-claude-capture.jsonl");
  const nodeOptionsPath = shimPath.replaceAll("\\", "/");
  const completed = spawnSync(
    process.execPath,
    [POST_TOOL_USE],
    {
      cwd,
      input: JSON.stringify(hookInput(cwd, filePath)),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
        NODE_OPTIONS: `--require=${nodeOptionsPath}`,
        FAKE_CLAUDE_CAPTURE: capturePath,
        FAKE_CLAUDE_REVIEW: JSON.stringify(review),
      },
    },
  );
  let captures = [];
  try {
    captures = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { completed, captures };
}


async function findNamedFiles(root, filename) {
  const matches = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === filename) matches.push(candidate);
    }
  }
  await visit(root);
  return matches;
}


test("CLI check covers no-workflow compatibility and ready fan-in review plans", async (t) => {
  const legacy = await createWorkflowProject(t, { workflow: false, persist: false });
  await writeFile(legacy, "docs/target.md", "Scope: beta\n");
  const legacyCheck = runCli(
    legacy,
    "check",
    "docs/target.md",
    "--format",
    "json",
  );
  assert.equal(legacyCheck.status, 0, legacyCheck.stderr);
  const legacyResult = JSON.parse(legacyCheck.stdout);
  assert.equal(Object.hasOwn(legacyResult.metadata, "workflow"), false);
  assert.equal(Object.hasOwn(legacyResult.agentReview ?? {}, "edges"), false);

  const workflow = await createWorkflowProject(t, { persist: false });
  await writeFile(workflow, "docs/source-a.md", "Scope: alpha\n");
  await writeFile(workflow, "docs/source-b.md", "Constraint: stable\n");
  await writeFile(workflow, "docs/target.md", "Scope: beta\n");
  const workflowCheck = runCli(
    workflow,
    "check",
    "docs/target.md",
    "--format",
    "json",
  );
  assert.equal(workflowCheck.status, 0, workflowCheck.stderr);
  const workflowResult = JSON.parse(workflowCheck.stdout);
  assert.equal(workflowResult.status, "passed");
  assert.deepEqual(workflowResult.metadata.artifactFiles, [
    "docs/target.md",
    "docs/source-a.md",
    "docs/source-b.md",
  ]);
  assert.deepEqual(
    workflowResult.agentReview.edges.map((edge) => [edge.from, edge.status]),
    [["source-a", "ready"], ["source-b", "ready"]],
  );
});


test("PostToolUse runs one successful fan-in fork and persists a target-only patch", async (t) => {
  const cwd = await createWorkflowProject(t);
  await writeFile(cwd, "docs/source-a.md", "Scope: alpha\n");
  await writeFile(cwd, "docs/source-b.md", "Constraint: stable\n");
  const targetPath = await writeFile(cwd, "docs/target.md", "Scope: beta\n");
  const review = {
    summary: "Target scope must align with Source A.",
    findings: [{
      ruleId: "AGENT-EDGE-SOURCE-A-TO-TARGET-SCOPE",
      severity: "error",
      path: "docs/target.md",
      line: 1,
      message: "Target scope contradicts Source A.",
      evidence: ["docs/source-a.md: Scope: alpha"],
    }],
    edits: [{
      target: "docs/target.md",
      operations: [{
        type: "replace-line",
        line: 1,
        expect: "Scope: beta",
        replacement: "Scope: alpha",
      }],
    }],
  };

  const { completed, captures } = await runHookWithFakeClaude(cwd, targetPath, review);

  assert.equal(completed.status, 0, completed.stderr);
  const hook = JSON.parse(completed.stdout);
  assert.equal(hook.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(hook.hookSpecificOutput.additionalContext, /隔离语义审阅已完成/);
  assert.equal(captures.length, 1);
  assert.ok(captures[0].argv.includes("--fork-session"));
  assert.deepEqual(
    captures[0].argv.slice(
      captures[0].argv.indexOf("--tools"),
      captures[0].argv.indexOf("--tools") + 4,
    ),
    ["--tools", "Read,Grep", "--allowedTools", "Read,Grep"],
  );
  assert.deepEqual(captures[0].request.workflow.editableArtifactFiles, ["docs/target.md"]);
  assert.deepEqual(
    captures[0].request.workflow.incomingEdges.map((edge) => ({
      from: edge.from,
      status: edge.status,
      sourceFiles: edge.sourceFiles,
      reviewer: edge.reviewer?.path ?? null,
    })),
    [
      {
        from: "source-a",
        status: "ready",
        sourceFiles: ["docs/source-a.md"],
        reviewer: ".runtime-corrector/source-a-to-target.reviewer.md",
      },
      {
        from: "source-b",
        status: "ready",
        sourceFiles: ["docs/source-b.md"],
        reviewer: null,
      },
    ],
  );
  const latestRoot = path.join(cwd, ".runtime-correction", "latest");
  const patches = await findNamedFiles(latestRoot, "patch.diff");
  const diagnostics = await findNamedFiles(latestRoot, "diagnostic.md");
  assert.equal(patches.length, 1);
  assert.equal(diagnostics.length, 1);
  const patch = await fs.readFile(patches[0], "utf8");
  assert.match(patch, /^--- a\/docs\/target\.md$/m);
  assert.match(patch, /^\+Scope: alpha$/m);
  assert.doesNotMatch(patch, /source-a\.md|source-b\.md/);
  assert.match(
    await fs.readFile(diagnostics[0], "utf8"),
    /AGENT-EDGE-SOURCE-A-TO-TARGET-SCOPE/,
  );
  assert.equal(await fs.readFile(targetPath, "utf8"), "Scope: beta\n");
});


test("PostToolUse semantic request excludes other correlated workflow instances", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: source
    pathTemplates:
      - "docs/{date}-source-{changeName}.md"
    rules:
      enabled: true
      file: empty.rules.yaml
    review:
      enabled: false
  - name: target
    pathTemplates:
      - "docs/{date}-target-{changeName}.md"
    relatedRoot: project
    relatedPatterns:
      - workflow.yaml
      - docs/*-source-*.md
    rules:
      enabled: true
      file: empty.rules.yaml
    review:
      enabled: true
workflow:
  correlation:
    keys: [changeName]
  edges:
    - from: source
      to: target
      review:
        enabled: true
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`);
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  await writeFile(cwd, "workflow.yaml", "kind: correlated\n");
  await writeFile(cwd, "docs/2026-07-27-source-alpha.md", "Scope: alpha\n");
  await writeFile(cwd, "docs/2026-07-27-source-beta.md", "Scope: beta\n");
  const targetPath = await writeFile(
    cwd,
    "docs/2026-07-28-target-alpha.md",
    "Scope: alpha\n",
  );

  const { completed, captures } = await runHookWithFakeClaude(cwd, targetPath, {
    summary: "The correlated instance is aligned.",
    findings: [],
    edits: [],
  });

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(captures.length, 1);
  const request = captures[0].request;
  assert.deepEqual(request.workflow.instance, { changeName: "alpha" });
  assert.deepEqual(request.workflow.incomingEdges[0].sourceFiles, [
    "docs/2026-07-27-source-alpha.md",
  ]);
  assert.deepEqual(request.workflow.editableArtifactFiles, [
    "docs/2026-07-28-target-alpha.md",
  ]);
  assert.ok(request.artifactFiles.includes("workflow.yaml"));
  assert.ok(request.artifactFiles.every((file) => !file.includes("-beta.md")));
});


test("PostToolUse keeps a missing source pending while reviewing available evidence", async (t) => {
  const cwd = await createWorkflowProject(t);
  await writeFile(cwd, "docs/source-a.md", "Scope: alpha\n");
  const targetPath = await writeFile(cwd, "docs/target.md", "Scope: alpha\n");

  const { completed, captures } = await runHookWithFakeClaude(cwd, targetPath, {
    summary: "Available evidence is aligned.",
    findings: [],
    edits: [],
  });

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(captures.length, 1);
  assert.deepEqual(
    captures[0].request.workflow.incomingEdges.map((edge) => [edge.from, edge.status]),
    [["source-a", "ready"], ["source-b", "pending"]],
  );
  const diagnostics = await findNamedFiles(
    path.join(cwd, ".runtime-correction", "latest"),
    "diagnostic.md",
  );
  const diagnostic = await fs.readFile(diagnostics[0], "utf8");
  assert.match(diagnostic, /Status: `pending`/);
  assert.match(diagnostic, /WORKFLOW-EDGE-SOURCE-MISSING/);
  const patches = await findNamedFiles(
    path.join(cwd, ".runtime-correction", "latest"),
    "patch.diff",
  );
  assert.equal(await fs.readFile(patches[0], "utf8"), "");
});


test("PostToolUse rejects an upstream semantic edit and persists no patch", async (t) => {
  const cwd = await createWorkflowProject(t);
  const sourcePath = await writeFile(cwd, "docs/source-a.md", "Scope: alpha\n");
  await writeFile(cwd, "docs/source-b.md", "Constraint: stable\n");
  const targetPath = await writeFile(cwd, "docs/target.md", "Scope: beta\n");

  const { completed, captures } = await runHookWithFakeClaude(cwd, targetPath, {
    summary: "Invalid proposal attempts to rewrite Source A.",
    findings: [{
      ruleId: "AGENT-EDGE-SOURCE-A-TO-TARGET-SCOPE",
      severity: "error",
      path: "docs/target.md",
      line: 1,
      message: "Target scope contradicts Source A.",
      evidence: ["docs/source-a.md: Scope: alpha"],
    }],
    edits: [{
      target: "docs/source-a.md",
      operations: [{
        type: "replace-line",
        line: 1,
        expect: "Scope: alpha",
        replacement: "Scope: beta",
      }],
    }],
  });

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(captures.length, 1);
  const hook = JSON.parse(completed.stdout);
  assert.match(hook.hookSpecificOutput.additionalContext, /隔离语义审阅失败/);
  const diagnostics = await findNamedFiles(
    path.join(cwd, ".runtime-correction", "latest"),
    "diagnostic.md",
  );
  const diagnostic = await fs.readFile(diagnostics[0], "utf8");
  assert.match(diagnostic, /AGENT-SEMANTIC-REVIEW-FAILED/);
  assert.match(diagnostic, /edit\.target 不在本轮可编辑产物列表中/);
  const patches = await findNamedFiles(
    path.join(cwd, ".runtime-correction", "latest"),
    "patch.diff",
  );
  assert.equal(await fs.readFile(patches[0], "utf8"), "");
  assert.equal(await fs.readFile(sourcePath, "utf8"), "Scope: alpha\n");
  assert.equal(await fs.readFile(targetPath, "utf8"), "Scope: beta\n");
});


test("disabled targets stay unmatched and cyclic workflow configs fail at the CLI boundary", async (t) => {
  const disabledSources = await createWorkflowProject(t, {
    enabledStages: ["target"],
    persist: false,
  });
  await writeFile(disabledSources, "docs/source-a.md", "Scope: alpha\n");
  await writeFile(disabledSources, "docs/source-b.md", "Constraint: stable\n");
  await writeFile(disabledSources, "docs/target.md", "Scope: alpha\n");
  const sourceRead = runCli(
    disabledSources,
    "check",
    "docs/target.md",
    "--format",
    "json",
  );
  assert.equal(sourceRead.status, 0, sourceRead.stderr);
  assert.deepEqual(
    JSON.parse(sourceRead.stdout).metadata.workflow.incomingEdges.map(
      (edge) => [edge.from, edge.status],
    ),
    [["source-a", "ready"], ["source-b", "ready"]],
  );

  const disabled = await createWorkflowProject(t, {
    enabledStages: ["source-a", "source-b"],
  });
  const targetPath = await writeFile(disabled, "docs/target.md", "Scope: beta\n");
  const shimPath = await createFakeClaudeShim(disabled);
  const capturePath = path.join(disabled, "should-not-exist.jsonl");
  const hook = spawnSync(
    process.execPath,
    [POST_TOOL_USE],
    {
      cwd: disabled,
      input: JSON.stringify(hookInput(disabled, targetPath)),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
        NODE_OPTIONS: `--require=${shimPath.replaceAll("\\", "/")}`,
        FAKE_CLAUDE_CAPTURE: capturePath,
        FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: "unused", findings: [], edits: [] }),
      },
    },
  );
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "");
  await assert.rejects(fs.access(capturePath), { code: "ENOENT" });

  const cyclic = await workspace(t);
  await writeFile(cyclic, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: first
    stage: first
    patterns:
      - first.md
  - name: second
    stage: second
    patterns:
      - second.md
workflow:
  edges:
    - from: first
      to: second
      review:
        enabled: true
    - from: second
      to: first
      review:
        enabled: true
`);
  await writeFile(cyclic, "first.md", "# First\n");
  const cycleCheck = runCli(cyclic, "check", "first.md", "--format", "json");
  assert.equal(cycleCheck.status, 2);
  assert.match(cycleCheck.stderr, /必须是有向无环图/);
  assert.equal(cycleCheck.stdout, "");
});


test("PostToolUse without a session fails visibly without attempting a fork", async (t) => {
  const cwd = await createWorkflowProject(t);
  await writeFile(cwd, "docs/source-a.md", "Scope: alpha\n");
  await writeFile(cwd, "docs/source-b.md", "Constraint: stable\n");
  const targetPath = await writeFile(cwd, "docs/target.md", "Scope: alpha\n");
  const shimPath = await createFakeClaudeShim(cwd);
  const capturePath = path.join(cwd, "should-not-fork.jsonl");
  const input = hookInput(cwd, targetPath);
  input.session_id = "";

  const completed = spawnSync(
    process.execPath,
    [POST_TOOL_USE],
    {
      cwd,
      input: JSON.stringify(input),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
        NODE_OPTIONS: `--require=${shimPath.replaceAll("\\", "/")}`,
        FAKE_CLAUDE_CAPTURE: capturePath,
        FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: "unused", findings: [], edits: [] }),
      },
    },
  );

  assert.equal(completed.status, 0, completed.stderr);
  const hook = JSON.parse(completed.stdout);
  assert.match(hook.hookSpecificOutput.additionalContext, /隔离语义审阅失败/);
  assert.match(hook.hookSpecificOutput.additionalContext, /没有 session_id/);
  await assert.rejects(fs.access(capturePath), { code: "ENOENT" });
  const diagnostics = await findNamedFiles(
    path.join(cwd, ".runtime-correction", "latest"),
    "diagnostic.md",
  );
  assert.match(
    await fs.readFile(diagnostics[0], "utf8"),
    /AGENT-SEMANTIC-REVIEW-FAILED/,
  );
});


test("PostToolUse skips the fork when node and edge reviews are explicitly disabled", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: target
    stage: target
    patterns:
      - docs/target.md
    rules:
      enabled: false
      file: missing.rules.yaml
    review:
      enabled: false
      criteria: missing.reviewer.md
output:
  persist: false
`);
  const targetPath = await writeFile(cwd, "docs/target.md", "# Target\n");
  const { completed, captures } = await runHookWithFakeClaude(
    cwd,
    targetPath,
    { summary: "unused", findings: [], edits: [] },
  );

  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(captures, []);
  const hook = JSON.parse(completed.stdout);
  assert.match(hook.hookSpecificOutput.additionalContext, /纠偏诊断：passed/);
  assert.doesNotMatch(hook.hookSpecificOutput.additionalContext, /隔离语义审阅/);
});


test("policy and ignored Markdown cannot satisfy a broad workflow source pattern", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: target
    stage: target
    patterns:
      - docs/target.md
    rules:
      enabled: true
      file: empty.rules.yaml
  - name: source
    stage: source
    patterns:
      - "**/*.md"
    rules:
      enabled: true
      file: empty.rules.yaml
ignorePatterns:
  - ignored/**
workflow:
  edges:
    - from: source
      to: target
      review:
        enabled: true
        criteria: source-to-target.reviewer.md
output:
  persist: false
`);
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  await writeFile(
    cwd,
    ".runtime-corrector/source-to-target.reviewer.md",
    "# Edge reviewer\n\nKeep the target aligned.\n",
  );
  await writeFile(cwd, "ignored/not-a-source.md", "# Ignored\n");
  await writeFile(cwd, "docs/target.md", "Scope: target\n");

  const check = runCli(cwd, "check", "docs/target.md", "--format", "json");

  assert.equal(check.status, 0, check.stderr);
  const result = JSON.parse(check.stdout);
  assert.equal(result.status, "pending");
  assert.deepEqual(result.metadata.workflow.incomingEdges[0].sourceFiles, []);
  assert.equal(result.diagnostics[0].ruleId, "WORKFLOW-EDGE-SOURCE-MISSING");
});
