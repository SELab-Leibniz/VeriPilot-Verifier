import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateCandidateDiffs } from "../lib/candidate-diff.mjs";
import {
  finalizeArtifactCheck,
  handleHook,
  transcriptHasPublicCommandContext,
} from "../lib/runtime-corrector.mjs";
import {
  buildSemanticReviewArguments,
  parseClaudeReview,
  runSemanticReview,
} from "../lib/semantic-review.mjs";
import { normalizeSlashes } from "../lib/path-utils.mjs";
import { loadSimpleProjectConfig } from "../lib/simple-mode.mjs";
import { parseSimpleYaml } from "../lib/simple-yaml.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-test-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}


async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


function hookInput(cwd, filePath, toolName = "Write", transcriptPath = null) {
  return {
    session_id: "08cd90cb-e5df-4302-8e0e-ef217eff090a",
    transcript_path: transcriptPath ?? path.join(cwd, "transcript.jsonl"),
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_response: { success: true },
    tool_use_id: "toolu-runtime-corrector-test",
  };
}


const LEGACY_IR_ARTIFACTS = [{
  stage: "ir",
  type: "ir",
  format: "markdown",
  patterns: ["**/ir.md", "**/*.ir.md", "**/ir/*.md"],
  relatedPatterns: [],
  knowledge: ["ir/default"],
}];


function legacyIrOptions(overrides = {}) {
  const overrideConfig = overrides.config ?? {};
  return {
    pluginRoot: PLUGIN_ROOT,
    ...overrides,
    config: {
      ...overrideConfig,
      artifacts: overrideConfig.artifacts ?? LEGACY_IR_ARTIFACTS,
    },
  };
}


test("PostToolUse defers persistence until one isolated semantic review returns diagnostics and a diff", async (t) => {
  const cwd = await workspace(t);
  const placeholder = "- 待补充：性能指标与发布日期。";
  const original = `${VALID_IR.trimEnd()}\n\n${placeholder}\n`;
  const filePath = await writeFile(cwd, "ir.md", original);
  const input = hookInput(cwd, filePath);
  const prepared = await handleHook(input, legacyIrOptions({
    deferPersistence: true,
    config: {
      output: {
        persist: true,
        mode: "centralized",
      },
    },
  }));
  assert.equal(prepared.feedback, undefined);
  assert.equal(prepared.result.outputFiles, undefined);
  assert.equal(prepared.reviewContext.semanticReviewTimeoutMs, 240000);
  await assert.rejects(fs.access(path.join(cwd, ".runtime-correction", "runs")));
  let invocation;
  const line = original.split(/\r?\n/).findIndex((value) => value === placeholder) + 1;
  const review = await runSemanticReview({
    input,
    prepared,
    pluginRoot: PLUGIN_ROOT,
    invokeFork: async (parameters) => {
      invocation = parameters;
      return {
        sessionId: "2e7afb36-149b-43a7-8f12-e8ce9fc50bbc",
        review: {
          summary: "发现一个未解释的占位符，并生成最小删除候选。",
          findings: [{
            ruleId: "AGENT-IR-PLACEHOLDER",
            severity: "error",
            path: "ir.md",
            line,
            message: "IR 保留了未解释的占位内容。",
            evidence: [placeholder],
            suggestion: "删除占位行，或补充有事实依据的未知原因与决策条件。",
          }],
          edits: [{
            target: "ir.md",
            operations: [{ type: "remove-line", line, expect: placeholder }],
          }],
        },
      };
    },
  });
  assert.equal(review.status, "completed");
  assert.equal(review.diffs.length, 1);
  assert.equal(invocation.sessionId, input.session_id);
  assert.equal(invocation.cwd, cwd);
  assert.equal(invocation.pluginRoot, PLUGIN_ROOT);
  assert.equal(invocation.timeoutMs, 240000);
  assert.match(invocation.prompt, /^\/runtime-corrector:semantic-review /);
  const outcome = await finalizeArtifactCheck(prepared, review);
  const roundDiff = outcome.result.roundOutputFiles.find((file) => file.endsWith("/patch.diff"));
  const roundDiagnostic = outcome.result.roundOutputFiles.find((file) => file.endsWith("/diagnostic.md"));
  assert.match(await fs.readFile(path.join(cwd, roundDiff), "utf8"), /^-- 待补充：性能指标与发布日期。$/m);
  assert.match(await fs.readFile(path.join(cwd, roundDiagnostic), "utf8"), /AGENT-IR-PLACEHOLDER/);
  assert.match(outcome.feedback, /隔离语义审阅已完成/);
  assert.match(outcome.feedback, /已释放/);
  assert.doesNotMatch(outcome.feedback, /完整 ir 规范地图/);
  assert.doesNotMatch(outcome.feedback, /Agent 审阅标准/);
  assert.equal(outcome.result.agentReview.status, "completed");
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});


test("semantic review forks from the hook cwd when policy discovery selects a nested project root", async (t) => {
  const sessionCwd = await workspace(t);
  const projectRoot = path.join(sessionCwd, "VeriPilotWorkspace", "delivery-run");
  await fs.mkdir(projectRoot, { recursive: true });
  const input = {
    session_id: "parent-session",
    cwd: sessionCwd,
  };
  let invocation;
  let request;
  const review = await runSemanticReview({
    input,
    prepared: {
      projectRoot,
      result: {
        status: "passed",
        diagnostics: [],
        metadata: {
          roundId: "20260728T145048Z-e8bfd005",
          stage: "prd-deliverables-gate",
          artifactType: "gate-b",
          triggerFile: ".milestone-delivery/gates/gate-b/request.md",
          artifactFiles: ["delivery/planning-projection/SR.md"],
          bundleComplete: true,
        },
      },
      reviewContext: {
        nodeReviewEnabled: true,
        reviewer: null,
        specification: null,
        workflow: null,
      },
    },
    pluginRoot: PLUGIN_ROOT,
    invokeFork: async (parameters) => {
      invocation = parameters;
      const requestMatch = parameters.prompt.match(/--request "([^"]+)"/);
      request = JSON.parse(await fs.readFile(requestMatch[1], "utf8"));
      return {
        sessionId: "fork-session",
        review: {
          summary: "reviewed",
          findings: [],
          edits: [],
        },
      };
    },
  });

  assert.equal(review.status, "completed");
  assert.equal(invocation.cwd, sessionCwd);
  assert.equal(request.projectRoot, normalizeSlashes(projectRoot));
  // Absolute path on any platform: optional Windows drive letter, then a slash.
  assert.match(invocation.prompt, /--request "(?:[A-Za-z]:)?\//);
});


test("semantic fork keeps its prompt first and exposes only read tools", () => {
  const prompt = "/runtime-corrector:semantic-review --request \".runtime-correction/request.json\"";
  const args = buildSemanticReviewArguments({
    sessionId: "08cd90cb-e5df-4302-8e0e-ef217eff090a",
    pluginRoot: PLUGIN_ROOT,
    prompt,
  });
  assert.equal(args[0], prompt);
  assert.ok(args.indexOf("--fork-session") > 0);
  assert.ok(args.indexOf("--no-session-persistence") > 0);
  assert.ok(args.includes("--json-schema"));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), [
    "--tools",
    "Read,Grep",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2), [
    "--allowedTools",
    "Read,Grep",
  ]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(
    args.slice(args.indexOf("--disallowedTools"), args.indexOf("--disallowedTools") + 2),
    ["--disallowedTools", "mcp__*"],
  );
});


test("project config passes a bounded semantic review timeout to the isolated fork", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: reviewed-document
    patterns:
      - reviewed.md
    review:
      enabled: true
limits:
  semanticReviewTimeoutMs: 1200000
`);
  const filePath = await writeFile(cwd, "reviewed.md", "# Reviewed document\n");
  const input = hookInput(cwd, filePath);
  const prepared = await handleHook(input, {
    pluginRoot: PLUGIN_ROOT,
    deferPersistence: true,
  });
  assert.equal(prepared.reviewContext.semanticReviewTimeoutMs, 1200000);

  let invocation;
  const review = await runSemanticReview({
    input,
    prepared,
    pluginRoot: PLUGIN_ROOT,
    invokeFork: async (parameters) => {
      invocation = parameters;
      return {
        sessionId: "bounded-timeout-fork",
        review: {
          summary: "reviewed",
          findings: [],
          edits: [],
        },
      };
    },
  });
  assert.equal(review.status, "completed");
  assert.equal(invocation.timeoutMs, 1200000);

  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: reviewed-document
    patterns:
      - reviewed.md
    review:
      enabled: true
limits:
  semanticReviewTimeoutMs: 1200001
`);
  await assert.rejects(
    loadSimpleProjectConfig(cwd),
    /semanticReviewTimeoutMs 必须是 1000 到 1200000 之间的整数/,
  );
});


test("semantic fork parses Claude Code structured_output", () => {
  const parsed = parseClaudeReview(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "fork-session",
    result: "human-readable fallback",
    structured_output: {
      summary: "reviewed",
      findings: [],
      edits: [],
    },
  }));
  assert.equal(parsed.sessionId, "fork-session");
  assert.deepEqual(parsed.review, {
    summary: "reviewed",
    findings: [],
    edits: [],
  });
});


test("incomplete bundles run semantic review against the available snapshot", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "A.md", "# A\n");
  let invoked = false;
  const review = await runSemanticReview({
    input: { session_id: "parent-session" },
    prepared: {
      projectRoot: cwd,
      result: {
        status: "pending",
        diagnostics: [],
        metadata: {
          roundId: "20260723T101112Z-a1b2c3d4",
          stage: "two-file",
          artifactType: "two-file-bundle",
          triggerFile: "A.md",
          artifactFiles: ["A.md"],
          bundleComplete: false,
        },
      },
      reviewContext: { reviewer: null, specification: null },
    },
    invokeFork: async ({ prompt }) => {
      invoked = true;
      const requestPath = prompt.match(/--request "([^"]+)"/)?.[1];
      const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
      assert.equal(request.bundleComplete, false);
      assert.deepEqual(request.artifactFiles, ["A.md"]);
      return {
        sessionId: "snapshot-review",
        review: { summary: "reviewed available snapshot", findings: [], edits: [] },
      };
    },
  });
  assert.equal(invoked, true);
  assert.equal(review.status, "completed");
  assert.equal(review.forkSessionId, "snapshot-review");
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.diffs, []);
});


test("every write to a two-file bundle reviews the current snapshot and persists one paired result", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1

enabledStages:
  - two-file

artifacts:
  - name: two-file-bundle
    stage: two-file
    type: two-file-bundle
    format: markdown
    patterns:
      - A.md
      - B.md
    relatedPatterns:
      - A.md
      - B.md
    relatedRoot: project
    rules:
      enabled: true
      file: two-file.rules.yaml
    review:
      enabled: true
      criteria: two-file.reviewer.md

output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`);
  await writeFile(cwd, ".runtime-corrector/two-file.rules.yaml", `version: 1

rules:
  - id: TWO-FILE-REQUIRED
    type: require-artifacts
    artifacts:
      - A.md
      - B.md
    pendingUntilComplete: true
    severity: error
`);
  await writeFile(
    cwd,
    ".runtime-corrector/two-file.reviewer.md",
    "# Two-file reviewer\n\nReview every available file; defer only checks that require a missing member.\n",
  );

  const snapshots = [];
  let reviewCount = 0;
  async function runWrite(filePath) {
    const input = hookInput(cwd, filePath, reviewCount === 0 ? "Write" : "Edit");
    const prepared = await handleHook(input, {
      pluginRoot: PLUGIN_ROOT,
      deferPersistence: true,
    });
    const review = await runSemanticReview({
      input,
      prepared,
      pluginRoot: PLUGIN_ROOT,
      invokeFork: async ({ prompt }) => {
        const requestPath = prompt.match(/--request "([^"]+)"/)?.[1];
        const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
        snapshots.push({
          bundleComplete: request.bundleComplete,
          artifactFiles: [...request.artifactFiles].sort(),
        });
        const first = reviewCount === 0;
        reviewCount += 1;
        return {
          sessionId: `snapshot-${reviewCount}`,
          review: first
            ? {
              summary: "A contains an unresolved semantic placeholder.",
              findings: [{
                ruleId: "AGENT-A-PLACEHOLDER",
                severity: "error",
                path: "A.md",
                line: 1,
                message: "A is not semantically ready.",
                evidence: ["A: TBD"],
                suggestion: "Use the known value from the current session.",
              }],
              edits: [{
                target: "A.md",
                operations: [{
                  type: "replace-line",
                  line: 1,
                  expect: "A: TBD",
                  replacement: "A: ready",
                }],
              }],
            }
            : { summary: "Available snapshot is semantically valid.", findings: [], edits: [] },
        };
      },
    });
    return finalizeArtifactCheck(prepared, review);
  }

  const aPath = await writeFile(cwd, "A.md", "A: TBD\n");
  const first = await runWrite(aPath);
  assert.equal(first.result.metadata.bundleComplete, false);
  assert.equal(first.result.agentReview.status, "completed");
  assert.equal(first.result.status, "failed");
  assert.ok(first.result.diagnostics.some((item) => item.ruleId === "AGENT-A-PLACEHOLDER"));
  const firstPatch = first.result.roundOutputFiles.find((item) => item.endsWith("/patch.diff"));
  assert.match(await fs.readFile(path.join(cwd, firstPatch), "utf8"), /^\+A: ready$/m);

  await fs.writeFile(aPath, "A: ready\n", "utf8");
  const second = await runWrite(aPath);
  assert.equal(second.result.metadata.bundleComplete, false);
  assert.equal(second.result.status, "pending");
  assert.equal(second.result.agentReview.status, "completed");
  const secondPatch = second.result.roundOutputFiles.find((item) => item.endsWith("/patch.diff"));
  assert.equal((await fs.stat(path.join(cwd, secondPatch))).size, 0);

  const bPath = await writeFile(cwd, "B.md", "B: ready\n");
  const third = await runWrite(bPath);
  assert.equal(third.result.metadata.bundleComplete, true);
  assert.equal(third.result.status, "passed");
  assert.equal(third.result.agentReview.status, "completed");

  await fs.writeFile(aPath, "A: ready, revised\n", "utf8");
  const fourth = await runWrite(aPath);
  assert.equal(fourth.result.metadata.bundleComplete, true);
  assert.equal(fourth.result.status, "passed");
  assert.deepEqual(snapshots, [
    { bundleComplete: false, artifactFiles: ["A.md"] },
    { bundleComplete: false, artifactFiles: ["A.md"] },
    { bundleComplete: true, artifactFiles: ["A.md", "B.md"] },
    { bundleComplete: true, artifactFiles: ["A.md", "B.md"] },
  ]);
});


test("missing session context becomes a persisted semantic-review failure", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(
    cwd,
    "ir.md",
    `${VALID_IR.trimEnd()}\n\n- TBD：存储选型。\n`,
  );
  const input = hookInput(cwd, filePath);
  delete input.session_id;
  const prepared = await handleHook(input, legacyIrOptions({
    deferPersistence: true,
    config: {
      output: {
        persist: true,
        mode: "centralized",
      },
    },
  }));
  const review = await runSemanticReview({ input, prepared, pluginRoot: PLUGIN_ROOT });
  assert.equal(review.status, "failed");
  const outcome = await finalizeArtifactCheck(prepared, review);
  assert.equal(outcome.result.agentReview.status, "failed");
  assert.ok(outcome.result.diagnostics.some(
    (item) => item.ruleId === "AGENT-SEMANTIC-REVIEW-FAILED",
  ));
  assert.match(outcome.feedback, /没有 session_id/);
});


test("candidate diff generation supports more than one target in a complete bundle", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "PilotPlan.md", "before plan\n");
  await writeFile(cwd, "relations.json", "before relations\n");
  const diffs = await generateCandidateDiffs({
    cwd,
    artifactFiles: ["PilotPlan.md", "relations.json"],
    edits: [
      {
        target: "PilotPlan.md",
        operations: [{ type: "replace-line", line: 1, expect: "before plan", replacement: "after plan" }],
      },
      {
        target: "relations.json",
        operations: [{ type: "replace-line", line: 1, expect: "before relations", replacement: "after relations" }],
      },
    ],
  });
  assert.deepEqual(diffs.map((item) => item.path), ["PilotPlan.md", "relations.json"]);
  const patch = `${diffs.map((item) => item.unifiedDiff).join("\n\n")}\n`;
  const patchPath = await writeFile(cwd, "bundle.diff", patch);
  execFileSync("git", ["apply", "--check", patchPath], { cwd, encoding: "utf8" });
  assert.equal(await fs.readFile(path.join(cwd, "PilotPlan.md"), "utf8"), "before plan\n");
  assert.equal(await fs.readFile(path.join(cwd, "relations.json"), "utf8"), "before relations\n");
});


test("candidate diff preserves the marker for a trailing blank context line", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "PilotPlan.md", `# Pilot Plan

Recommended: coarse
Selected: coarse
Milestone count: 3
Confirmation: auto
Reason: evidence-grounded

## M1
Goal: first
`);
  const diffs = await generateCandidateDiffs({
    cwd,
    artifactFiles: ["PilotPlan.md"],
    edits: [{
      target: "PilotPlan.md",
      operations: [{
        type: "replace-line",
        line: 5,
        expect: "Milestone count: 3",
        replacement: "Milestone count: 2",
      }],
    }],
  });
  assert.equal(diffs.length, 1);
  assert.ok(
    diffs[0].unifiedDiff.endsWith("\n "),
    "the final blank context line must retain its single-space unified-diff marker",
  );
  const patchPath = await writeFile(cwd, "candidate.diff", `${diffs[0].unifiedDiff}\n`);
  execFileSync("git", ["apply", "--check", patchPath], { cwd, encoding: "utf8" });
});


test("the final patch gate rejects malformed diffs before persistence", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR);
  const prepared = await handleHook(hookInput(cwd, filePath), legacyIrOptions({
    deferPersistence: true,
    config: { output: { persist: true, mode: "centralized" } },
  }));
  prepared.result.diffs = [{
    path: "ir.md",
    unifiedDiff: [
      "diff --git a/ir.md b/ir.md",
      "--- a/ir.md",
      "+++ b/ir.md",
      "@@ -1 +1 @@",
      "-not the current first line",
      "+replacement",
    ].join("\n"),
  }];

  const outcome = await finalizeArtifactCheck(prepared);
  const roundDiff = outcome.result.roundOutputFiles.find((file) => file.endsWith("/patch.diff"));
  const roundDiagnostic = outcome.result.roundOutputFiles.find(
    (file) => file.endsWith("/diagnostic.md"),
  );

  assert.equal(outcome.result.status, "failed");
  assert.deepEqual(outcome.result.diffs, []);
  assert.equal(outcome.result.metadata.patchValidation.status, "failed");
  assert.ok(outcome.result.diagnostics.some(
    (item) => item.ruleId === "RUNTIME-PATCH-VALIDATION-FAILED",
  ));
  assert.equal((await fs.stat(path.join(cwd, roundDiff))).size, 0);
  assert.match(
    await fs.readFile(path.join(cwd, roundDiagnostic), "utf8"),
    /RUNTIME-PATCH-VALIDATION-FAILED/,
  );
});


test("a rejected semantic edit still preserves X1 findings in the diagnostic", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR);
  const input = hookInput(cwd, filePath);
  const prepared = await handleHook(input, legacyIrOptions({
    deferPersistence: true,
    config: { output: { persist: true, mode: "centralized" } },
  }));
  const review = await runSemanticReview({
    input,
    prepared,
    pluginRoot: PLUGIN_ROOT,
    invokeFork: async () => ({
      sessionId: "rejected-edit",
      review: {
        summary: "finding survives patch rejection",
        findings: [{
          ruleId: "AGENT-EDIT-REJECTED",
          severity: "error",
          path: "ir.md",
          line: 1,
          message: "The proposed edit could not be validated.",
          evidence: ["# Feature IR"],
        }],
        edits: [{
          target: "ir.md",
          operations: [{
            type: "replace-line",
            line: 1,
            expect: "stale source text",
            replacement: "# Updated",
          }],
        }],
      },
    }),
  });
  assert.equal(review.status, "failed");
  assert.equal(review.findings[0].ruleId, "AGENT-EDIT-REJECTED");
  const outcome = await finalizeArtifactCheck(prepared, review);
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "AGENT-EDIT-REJECTED"));
  assert.ok(outcome.result.diagnostics.some(
    (item) => item.ruleId === "AGENT-SEMANTIC-REVIEW-FAILED",
  ));
});


test("plugin registers the compatible v2 lifecycle hooks without PostToolBatch", async () => {
  const hooks = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  for (const eventName of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "PreCompact",
    "SessionEnd",
  ]) {
    assert.ok(hooks.hooks[eventName], eventName);
  }
  assert.equal(
    hooks.hooks.PreToolUse[0].matcher,
    "Skill|Bash|PowerShell|Write|Edit|NotebookEdit|Monitor",
  );
  assert.equal(hooks.hooks.PostToolBatch, undefined);
  assert.ok(hooks.hooks.PostToolUse);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, undefined);
  assert.equal(
    hooks.hooks.PostToolUse[0].hooks[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.mjs"',
  );
  assert.equal(Object.hasOwn(hooks.hooks.PostToolUse[0].hooks[0], "args"), false);
  // SessionStart is lifecycle-only; the first correction-relevant tool owns
  // the long onboarding budget instead.
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].timeout, 30);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].timeout, 1800);
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].timeout, 1800);
  assert.equal(hooks.hooks.PostToolUse[0].hooks[0].timeout, 1800);
  const packageManifest = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  const pluginManifest = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(packageManifest.version, "1.9.1");
  assert.equal(pluginManifest.version, "1.9.1");
  assert.equal(marketplace.metadata.version, "1.9.1");
  assert.equal(marketplace.plugins[0].version, "1.9.1");
  await assert.rejects(fs.access(path.join(PLUGIN_ROOT, "scripts", "user-prompt-submit.mjs")));
});


test("public command context detection follows the active post-compaction transcript", async (t) => {
  const cwd = await workspace(t);
  const transcriptPath = path.join(cwd, "transcript.jsonl");
  const marker = "[runtime-corrector:public-commands]";

  await fs.writeFile(transcriptPath, [
    JSON.stringify({ type: "user", message: { role: "user", content: marker } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "继续" } }),
  ].join("\n"), "utf8");
  assert.equal(await transcriptHasPublicCommandContext(transcriptPath), true);

  await fs.appendFile(transcriptPath, [
    "",
    JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "摘要没有保留插件命令。" },
    }),
  ].join("\n"), "utf8");
  assert.equal(await transcriptHasPublicCommandContext(transcriptPath), false);

  await fs.appendFile(transcriptPath, [
    "",
    JSON.stringify({
      type: "user",
      message: { role: "user", content: `违规反馈\n${marker}` },
    }),
  ].join("\n"), "utf8");
  assert.equal(await transcriptHasPublicCommandContext(transcriptPath), true);

  await fs.appendFile(transcriptPath, [
    "",
    JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: {
        role: "user",
        content: "可按需使用 /runtime-corrector:spec <stage> 和 /runtime-corrector:help。",
      },
    }),
  ].join("\n"), "utf8");
  assert.equal(await transcriptHasPublicCommandContext(transcriptPath), true);
});


const VALID_IR = `# HarmonyOS TodoList 需求

## 核心功能

用户场景：个人用户在手机上快速维护当天待办。

- 输入非空文本后新增待办，列表立即显示新项目。
- 点击删除按钮后移除对应待办；删除失败时保留原项目并提示原因。
- 使用 ArkData 持久化。数据结构包含唯一 id、非空 title 和 createdAt 字段；删除时同步清理记录。

## 完成定义

- [ ] 输入“购买牛奶”并确认后，列表出现且重启应用后仍保留该待办
- [ ] 删除任意待办后，列表和本地存储均不再包含该记录
- [ ] 空白输入不会创建记录，并显示明确提示

## 应用概述

目标用户是需要记录日常事项的个人用户。本期范围包括新增、展示、保存和删除待办；暂不支持账号、协作、提醒和云同步。

## 运行约束

目标为 HarmonyOS API 12 及以上手机，使用 ArkTS 与 ArkUI 实现。
`;


test("ignores writes whose file name does not match an artifact rule", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "README.md", "# Readme\n");
  const outcome = await handleHook(hookInput(cwd, filePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.matched, false);
  assert.equal(outcome.reason, "unmatched-artifact");
});


test("silently ignores writes outside the active project when no policy owns them", async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  const filePath = await writeFile(outside, "memory.md", "# Claude memory\n");
  const outcome = await handleHook(hookInput(cwd, filePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.matched, false);
  assert.equal(outcome.reason, "outside-project");
});


test("diagnoses missing sections and returns a non-applied unified diff", async (t) => {
  const cwd = await workspace(t);
  const original = "# Feature IR\n\n## 目标\n\n描述目标。\n";
  const filePath = await writeFile(cwd, "docs/feature.ir.md", original);
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions());

  assert.equal(outcome.matched, true);
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.metadata.configSource, "provided");
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "IR-CORE-FUNCTIONS"));
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "IR-CORE-ACCEPTANCE"));
  assert.equal(outcome.result.diffs.length, 1);
  assert.match(outcome.result.diffs[0].unifiedDiff, /\+## 功能需求/);
  assert.equal(outcome.result.diffs[0].format, "git-unified-diff");
  assert.equal(outcome.result.diffs[0].applyMode, "git-apply");
  assert.match(outcome.result.diffs[0].baseHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(outcome.feedback, /请主 Agent/);
  assert.match(outcome.feedback, /不会自动应用候选 Git Patch/);
  assert.match(outcome.feedback, /\/runtime-corrector:help/);
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});


test("generates git-apply patches for newline, empty, and spaced-path files", async (t) => {
  const cwd = await workspace(t);
  execFileSync("git", ["init", "-q"], { cwd, encoding: "utf8" });
  const cases = [
    { name: "with-final-newline", content: "# Feature\n\nExisting content.\n" },
    { name: "without-final-newline", content: "# Feature\n\nExisting content." },
    { name: "path with spaces", content: "# Feature\n\nExisting content.\n" },
    { name: "empty", content: "" },
  ];

  for (const [index, example] of cases.entries()) {
    const relativePath = `docs/${example.name}.ir.md`;
    const filePath = await writeFile(cwd, relativePath, example.content);
    const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions());
    const patch = outcome.result.diffs[0];
    const patchPath = await writeFile(cwd, `patch-${index}.diff`, `${patch.unifiedDiff}\n`);

    execFileSync("git", ["apply", "--check", patchPath], { cwd, encoding: "utf8" });
    execFileSync("git", ["apply", patchPath], { cwd, encoding: "utf8" });

    const applied = await fs.readFile(filePath, "utf8");
    assert.match(applied, /## 目标与范围/);
    assert.match(applied, /## 功能需求/);
    assert.match(applied, /## 验收标准/);
    assert.notEqual(applied, example.content);
  }
});


test("passes a complete Markdown IR without writing output by default", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR);
  const outcome = await handleHook(hookInput(cwd, filePath, "Edit"), legacyIrOptions());

  assert.equal(outcome.result.status, "passed");
  assert.equal(outcome.result.metadata.stage, "ir");
  assert.deepEqual(outcome.result.diagnostics, []);
  assert.deepEqual(outcome.writtenFiles, []);
  assert.doesNotMatch(outcome.feedback, /\[runtime-corrector:public-commands\]/);
  await assert.rejects(fs.access(path.join(cwd, ".runtime-correction")));
});


test("does not treat Todo as an unfinished placeholder", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR.replaceAll("TodoList", "Todo"));
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions());

  assert.equal(outcome.result.status, "passed");
  assert.ok(!outcome.result.diagnostics.some(
    (item) => item.ruleId === "IR-CONTENT-PLACEHOLDER",
  ));
});


test("diagnoses missing platform context and executable acceptance items", async (t) => {
  const cwd = await workspace(t);
  const incomplete = VALID_IR
    .replaceAll("HarmonyOS", "通用移动平台")
    .replace("ArkTS 与 ArkUI", "声明式技术")
    .replaceAll("- [ ]", "-");
  const filePath = await writeFile(cwd, "ir.md", incomplete);
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions());

  assert.equal(outcome.result.status, "failed");
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "IR-HARMONY-PLATFORM"));
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "IR-CORE-ACCEPTANCE-FORM"));
});


test("accepts aliases and does not prescribe top-level section order", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR);
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions());

  assert.equal(outcome.result.status, "passed");
  assert.ok(!outcome.result.diagnostics.some((item) => item.ruleId.includes("ORDER")));
});


test("rejects duplicate required top-level sections", async (t) => {
  const cwd = await workspace(t);
  const duplicated = VALID_IR.replace(
    "## 运行约束",
    "## 产品概述\n\n重复的产品说明。\n\n## 运行约束",
  );
  const filePath = await writeFile(cwd, "ir.md", duplicated);
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions());

  assert.equal(outcome.result.status, "failed");
  assert.ok(outcome.result.diagnostics.some(
    (item) => item.ruleId === "IR-CORE-OVERVIEW-DUPLICATE",
  ));
});


test("persists adjacent diagnostics in a local normalized output tree without changing the artifact", async (t) => {
  const cwd = await workspace(t);
  const original = "# Feature IR\n";
  const filePath = await writeFile(cwd, "docs/ir/feature.ir.md", original);
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions({
    config: { output: { persist: true, mode: "adjacent" } },
  }));

  assert.equal(outcome.writtenFiles.length, 8);
  assert.equal(outcome.result.roundOutputFiles.length, 4);
  assert.equal(outcome.result.latestOutputFiles.length, 4);
  assert.ok(outcome.writtenFiles.every(
    (file) => file.startsWith(path.join(path.dirname(filePath), ".runtime-correction")),
  ));
  assert.equal(await fs.readFile(filePath, "utf8"), original);
  const diagnosticFile = outcome.writtenFiles.find(
    (file) => file.includes(`${path.sep}runs${path.sep}`) && path.basename(file) === "diagnostic.md",
  );
  const specificationFile = outcome.writtenFiles.find(
    (file) => file.includes(`${path.sep}runs${path.sep}`) && path.basename(file) === "spec.md",
  );
  const diffFile = outcome.writtenFiles.find(
    (file) => file.includes(`${path.sep}runs${path.sep}`) && path.basename(file) === "patch.diff",
  );
  assert.match(await fs.readFile(diagnosticFile, "utf8"), /diagnostic only/i);
  assert.match(await fs.readFile(specificationFile, "utf8"), /完整 Stage 规范：ir/);
  assert.match(await fs.readFile(diffFile, "utf8"), /\+## 目标与范围/);
});


test("uses a single centralized directory and collision-safe artifact paths", async (t) => {
  const cwd = await workspace(t);
  const first = await writeFile(cwd, "a/feature.ir.md", "# First\n");
  const second = await writeFile(cwd, "b/feature.ir.md", "# Second\n");
  const config = {
    output: { persist: true, mode: "centralized", directory: "diagnostics" },
  };

  const firstOutcome = await handleHook(hookInput(cwd, first), legacyIrOptions({ config }));
  const secondOutcome = await handleHook(hookInput(cwd, second), legacyIrOptions({ config }));
  const files = [...firstOutcome.writtenFiles, ...secondOutcome.writtenFiles];

  assert.equal(files.length, 16);
  assert.ok(files.every((file) => file.startsWith(path.join(cwd, "diagnostics"))));
  assert.equal(new Set(files).size, 16);
  assert.notEqual(
    path.basename(path.dirname(path.dirname(firstOutcome.writtenFiles[0]))),
    path.basename(path.dirname(path.dirname(secondOutcome.writtenFiles[0]))),
  );
});


test("normalized Run and Latest directories pair diagnostics with an empty patch", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR);
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions({
    config: { output: { persist: true, mode: "centralized" } },
  }));

  assert.equal(outcome.result.status, "passed");
  assert.equal(outcome.writtenFiles.length, 6);
  assert.equal(outcome.result.roundOutputFiles.length, 3);
  assert.equal(outcome.result.latestOutputFiles.length, 3);
  const diagnosticFile = outcome.writtenFiles.find(
    (file) => file.includes(`${path.sep}runs${path.sep}`) && path.basename(file) === "diagnostic.md",
  );
  const diffFile = outcome.writtenFiles.find(
    (file) => file.includes(`${path.sep}runs${path.sep}`) && path.basename(file) === "patch.diff",
  );
  const latestDiagnosticFile = outcome.writtenFiles.find(
    (file) => file.includes(`${path.sep}latest${path.sep}`) && path.basename(file) === "diagnostic.md",
  );
  const latestDiffFile = outcome.writtenFiles.find(
    (file) => file.includes(`${path.sep}latest${path.sep}`) && path.basename(file) === "patch.diff",
  );
  assert.equal(path.dirname(diagnosticFile), path.dirname(diffFile));
  assert.match(
    path.dirname(diagnosticFile),
    // Platform-agnostic separators: backslash on Windows, slash on POSIX.
    new RegExp(`[\\\\/]runs[\\\\/]ir[\\\\/]ir-[a-f0-9]{8}[\\\\/]${outcome.result.metadata.roundId}$`),
  );
  assert.equal((await fs.stat(diffFile)).size, 0);
  assert.equal((await fs.stat(latestDiffFile)).size, 0);
  assert.equal(await fs.readFile(diagnosticFile, "utf8"), await fs.readFile(latestDiagnosticFile, "utf8"));
  assert.match(await fs.readFile(diagnosticFile, "utf8"), /Round ID: `\d{8}T\d{6}Z-[a-f0-9]{8}`/);
  assert.match(outcome.feedback, /本轮诊断结果路径：.*\/runs\/.*\/diagnostic\.md/);
  assert.match(outcome.feedback, /本轮 Diff 文件路径：.*0 字节空文件/);
  assert.match(outcome.feedback, /Latest 指针/);
});


test("successive checks retain immutable Run history while refreshing Latest", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR);
  const options = {
    config: { output: { persist: true, mode: "centralized" } },
  };
  const runtimeOptions = legacyIrOptions(options);
  const first = await handleHook(hookInput(cwd, filePath), runtimeOptions);
  const second = await handleHook(hookInput(cwd, filePath, "Edit"), runtimeOptions);

  assert.notEqual(first.result.metadata.roundId, second.result.metadata.roundId);
  assert.notDeepEqual(first.result.roundOutputFiles, second.result.roundOutputFiles);
  assert.deepEqual(first.result.latestOutputFiles, second.result.latestOutputFiles);
  for (const relativePath of [...first.result.roundOutputFiles, ...second.result.roundOutputFiles]) {
    await fs.access(path.join(cwd, relativePath));
  }
  const runDirectories = await fs.readdir(
    path.join(cwd, ".runtime-correction", "runs", "ir", path.basename(path.dirname(path.dirname(first.result.roundOutputFiles[0])))),
  );
  assert.equal(runDirectories.length, 2);
  assert.deepEqual((await fs.readdir(path.join(cwd, ".runtime-correction"))).sort(), ["latest", "runs"]);
  const latestDiagnostic = await fs.readFile(
    path.join(cwd, second.result.latestOutputFiles.find((file) => file.endsWith("/diagnostic.md"))),
    "utf8",
  );
  assert.match(latestDiagnostic, new RegExp(`Round ID: \`${second.result.metadata.roundId}\``));
});


test("a check recreates missing Run history from pre-existing Latest artifacts", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", VALID_IR);
  const options = {
    config: { output: { persist: true, mode: "centralized" } },
  };
  const runtimeOptions = legacyIrOptions(options);
  const legacy = await handleHook(hookInput(cwd, filePath), runtimeOptions);
  const archivedContents = new Map();
  for (const relativePath of legacy.result.roundOutputFiles) {
    const latestPath = legacy.result.latestOutputFiles.find(
      (candidate) => path.posix.basename(candidate) === path.posix.basename(relativePath),
    );
    archivedContents.set(relativePath, await fs.readFile(path.join(cwd, latestPath), "utf8"));
    await fs.rm(path.join(cwd, relativePath));
  }

  const upgraded = await handleHook(hookInput(cwd, filePath, "Edit"), runtimeOptions);
  assert.notEqual(legacy.result.metadata.roundId, upgraded.result.metadata.roundId);
  for (const [relativePath, expected] of archivedContents) {
    assert.equal(await fs.readFile(path.join(cwd, relativePath), "utf8"), expected);
  }
});


test("patch.diff is always persisted even when legacy generateDiff is false", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", "# Feature IR\n");
  const enabled = await handleHook(hookInput(cwd, filePath), legacyIrOptions({
    config: { output: { persist: true, mode: "centralized", generateDiff: true } },
  }));
  const roundDiffFile = enabled.writtenFiles.find(
    (file) => file.includes(`${path.sep}runs${path.sep}`) && path.basename(file) === "patch.diff",
  );
  const latestDiffFile = enabled.writtenFiles.find(
    (file) => file.includes(`${path.sep}latest${path.sep}`) && path.basename(file) === "patch.diff",
  );
  assert.ok(roundDiffFile);
  assert.ok((await fs.stat(roundDiffFile)).size > 0);
  assert.ok(enabled.result.diffs.length > 0);

  const disabled = await handleHook(hookInput(cwd, filePath, "Edit"), legacyIrOptions({
    config: { output: { persist: true, mode: "centralized", generateDiff: false } },
  }));
  assert.ok(disabled.writtenFiles.some((file) => file.endsWith(".diff")));
  await fs.access(roundDiffFile);
  await fs.access(latestDiffFile);
  assert.equal(disabled.result.metadata.diffGeneration.strategy, "always");
  assert.doesNotMatch(disabled.feedback, /output\.generateDiff=false/);
});


test("legacy diffStrategy no longer changes the always-present diff contract", async (t) => {
  const cwd = await workspace(t);
  const filePath = await writeFile(cwd, "ir.md", `${VALID_IR}\nTBD\n`);

  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions({
    config: {
      output: {
        persist: true,
        mode: "centralized",
        generateDiff: true,
        diffStrategy: "deterministic",
      },
    },
  }));
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.diffs.length, 0);
  const diffFile = outcome.writtenFiles.find((file) => file.endsWith(".diff"));
  assert.equal((await fs.stat(diffFile)).size, 0);
  assert.equal(outcome.result.metadata.diffGeneration.strategy, "always");
  assert.doesNotMatch(outcome.feedback, /\/runtime-corrector:generate-diff/);
});


test("supports custom matching and collection of multiple Markdown IR files", async (t) => {
  const cwd = await workspace(t);
  const triggerFile = await writeFile(
    cwd,
    "custom/model.md",
    `${VALID_IR}\n需求ID: REQ-100\n`,
  );
  await writeFile(cwd, "custom/secondary.md", "# Secondary\n\n需求ID: REQ-100\n");
  await writeFile(
    cwd,
    "matcher.mjs",
    `export function matchArtifact({ filePath }) {
      if (!filePath.endsWith("model.md")) return null;
      return {
        stage: "ir",
        artifactType: "ir",
        format: "markdown",
        primaryPath: filePath,
        knowledge: ["ir/default"]
      };
    }\n`,
  );
  await writeFile(
    cwd,
    "collector.mjs",
    `import path from "node:path";
    export function collectRelated({ triggerFile }) {
      return [path.join(path.dirname(triggerFile), "secondary.md")];
    }\n`,
  );

  const outcome = await handleHook(hookInput(cwd, triggerFile), legacyIrOptions({
    config: {
      extensions: {
        matcherModule: "./matcher.mjs",
        collectorModule: "./collector.mjs"
      }
    },
  }));

  assert.equal(outcome.matched, true);
  const duplicateDiagnostics = outcome.result.diagnostics.filter(
    (item) => item.ruleId === "IR-ID-DUPLICATE",
  );
  assert.equal(duplicateDiagnostics.length, 2);
  assert.ok(duplicateDiagnostics.some((item) => item.path.endsWith("secondary.md")));
});


test("CLI hook emits PostToolUse additionalContext JSON", async (t) => {
  const cwd = await workspace(t);
  await installIrTemplate(cwd);
  const filePath = await writeFile(cwd, "docs/feature.ir.md", "# Feature IR\n");
  const input = JSON.stringify(hookInput(cwd, filePath));
  const stdout = execFileSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, "scripts", "post-tool-use.mjs")],
    { cwd, input, encoding: "utf8" },
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(payload.hookSpecificOutput.additionalContext, /runtime-corrector/);
  assert.match(payload.hookSpecificOutput.additionalContext, /IR-REQUIRE-FUNCTIONS/);
});


test("CLI hook accepts UTF-8 BOM input from Windows orchestrators", async (t) => {
  const cwd = await workspace(t);
  await installIrTemplate(cwd);
  const filePath = await writeFile(cwd, "docs/feature.ir.md", "# Feature IR\n");
  const input = `\uFEFF${JSON.stringify(hookInput(cwd, filePath))}`;
  const stdout = execFileSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, "scripts", "post-tool-use.mjs")],
    { cwd, input, encoding: "utf8" },
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(payload.hookSpecificOutput.additionalContext, /IR-REQUIRE-FUNCTIONS/);
});


test("provides directive feedback for failed corrections", async (t) => {
  const cwd = await workspace(t);
  const incomplete = "# Feature IR\n\n## 目标\n\nSome text.\n\n## 需求\n\nTBD content\n";
  const filePath = await writeFile(cwd, "docs/feature.ir.md", incomplete);
  const outcome = await handleHook(hookInput(cwd, filePath), legacyIrOptions());

  assert.equal(outcome.result.status, "failed");
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "IR-CORE-FUNCTIONS"));
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "IR-CONTENT-PLACEHOLDER"));
  // Check that forbidden patterns are now errors
  const tbdDiagnostics = outcome.result.diagnostics.filter((item) => item.ruleId === "IR-CONTENT-PLACEHOLDER");
  assert.ok(tbdDiagnostics.length > 0);
  assert.equal(tbdDiagnostics[0].severity, "error");
  // Should include directive correction message
  assert.match(outcome.feedback, /请主 Agent/);
  assert.match(outcome.feedback, /修正、忽略、转人工或终止/);
});


test("applies permission guidance only when the IR uses sensitive capabilities", async (t) => {
  const cwd = await workspace(t);
  const sensitive = VALID_IR.replace(
    "- 输入非空文本后新增待办，列表立即显示新项目。",
    "- 用户可以扫码并使用麦克风录入待办，列表立即显示新项目。",
  );
  const sensitivePath = await writeFile(cwd, "sensitive.ir.md", sensitive);
  const sensitiveOutcome = await handleHook(hookInput(cwd, sensitivePath), legacyIrOptions());

  assert.ok(sensitiveOutcome.result.diagnostics.some(
    (item) => item.ruleId === "IR-HARMONY-PERMISSION-CONTEXT",
  ));

  const plainPath = await writeFile(cwd, "plain.ir.md", VALID_IR);
  const plainOutcome = await handleHook(hookInput(cwd, plainPath), legacyIrOptions());
  assert.ok(!plainOutcome.result.diagnostics.some(
    (item) => item.ruleId === "IR-HARMONY-PERMISSION-CONTEXT",
  ));
});


const SIMPLE_CONFIG = `version: 1

artifacts:
  - name: requirements
    stage: requirements
    type: requirements
    patterns:
      - docs/requirements.md
    rules:
      enabled: true
      file: rules.yaml
    review:
      enabled: true
      criteria: reviewer.md
`;


const SIMPLE_RULES = `version: 1

rules:
  - id: REQUIRE-OVERVIEW
    type: require-heading
    heading: 目标与范围
    aliases:
      - 产品概述
    severity: error

  - id: REQUIRE-ACCEPTANCE
    type: require-checklist
    under: 验收标准
    minimum: 1
    severity: error

  - id: REQUIRE-PLATFORM
    type: require-text
    values:
      - HarmonyOS
      - 鸿蒙
    severity: warning

  - id: FORBID-PLACEHOLDER
    type: forbid-text
    values:
      - TODO
      - TBD
    severity: error
`;


const REVIEWER = `# Agent 审阅标准

1. 检查验收标准是否真正可执行。
2. 每个问题必须引用具体证据。
`;


async function writeSimpleModeFiles(cwd) {
  await writeFile(cwd, ".runtime-corrector/config.yaml", SIMPLE_CONFIG);
  await writeFile(cwd, ".runtime-corrector/rules.yaml", SIMPLE_RULES);
  await writeFile(cwd, ".runtime-corrector/reviewer.md", REVIEWER);
}


async function installFourStageExample(cwd, stage = null) {
  const exampleRoot = path.join(
    PLUGIN_ROOT,
    "examples",
    "ir-planning-selection-prd-contract",
  );
  await fs.cp(
    path.join(exampleRoot, ".runtime-corrector"),
    path.join(cwd, ".runtime-corrector"),
    { recursive: true },
  );
  if (stage) {
    await fs.copyFile(
      path.join(exampleRoot, "single-stage-configs", `${stage}.config.yaml`),
      path.join(cwd, ".runtime-corrector", "config.yaml"),
    );
  }
}


async function installIrTemplate(cwd) {
  await installFourStageExample(cwd, "ir");
}


async function installPlanningTemplate(cwd) {
  await installFourStageExample(cwd, "planning");
}


async function installSelectionTemplate(cwd) {
  await installFourStageExample(cwd, "selection");
}


async function installPrdTemplate(cwd) {
  await installFourStageExample(cwd, "prd-contract");
}


test("simple mode preserves Agent review data without expanding it into failed feedback", async (t) => {
  const cwd = await workspace(t);
  await writeSimpleModeFiles(cwd);
  const filePath = await writeFile(
    cwd,
    "docs/requirements.md",
    "# 需求\n\n## 产品概述\n\nTODO\n\n## 验收标准\n\n尚未明确。\n",
  );

  const outcome = await handleHook(hookInput(cwd, filePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.metadata.configSource, "project-simple");
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "REQUIRE-ACCEPTANCE"));
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "FORBID-PLACEHOLDER"));
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.match(outcome.result.agentReview.criteria, /验收标准是否真正可执行/);
  assert.doesNotMatch(outcome.feedback, /验收标准是否真正可执行/);
  assert.match(outcome.feedback, /\/runtime-corrector:spec requirements/);
  assert.doesNotMatch(outcome.feedback, /尚未初始化专属规则/);
});


test("simple mode requests Agent review after deterministic rules pass", async (t) => {
  const cwd = await workspace(t);
  await writeSimpleModeFiles(cwd);
  const filePath = await writeFile(
    cwd,
    "docs/requirements.md",
    "# HarmonyOS 需求\n\n## 目标与范围\n\n只支持本地待办。\n\n## 验收标准\n\n- [ ] 新增待办后列表可见\n",
  );

  const outcome = await handleHook(hookInput(cwd, filePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "passed");
  assert.equal(outcome.result.metadata.stage, "requirements");
  assert.deepEqual(outcome.result.metadata.ruleSetIds, ["project:rules.yaml"]);
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.match(outcome.result.agentReview.criteria, /验收标准是否真正可执行/);
  assert.match(outcome.feedback, /同时/);
});


test("standalone CLI returns the same JSON contract for customer workflows", async (t) => {
  const cwd = await workspace(t);
  await writeSimpleModeFiles(cwd);
  await writeFile(
    cwd,
    "docs/requirements.md",
    "# HarmonyOS 需求\n\n## 目标与范围\n\n只支持本地待办。\n\n## 验收标准\n\n- [ ] 新增待办后列表可见\n",
  );

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(PLUGIN_ROOT, "scripts", "cli.mjs"),
      "check",
      "docs/requirements.md",
      "--cwd",
      cwd,
      "--format",
      "json",
    ],
    { cwd, encoding: "utf8" },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.status, "passed");
  assert.equal(result.metadata.artifactType, "requirements");
  assert.equal(result.agentReview.status, "requested");
});


test("CLI initializes an inactive generic template without overwriting project policy", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  const stdout = execFileSync(
    process.execPath,
    [cliPath, "init", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );

  assert.match(stdout, /已初始化项目配置/);
  assert.match(stdout, /物化/);
  await fs.access(path.join(cwd, ".runtime-corrector", "config.yaml"));
  await fs.access(path.join(cwd, ".runtime-corrector", "example.rules.yaml"));
  await fs.access(path.join(cwd, ".runtime-corrector", "example.reviewer.md"));
  // init MATERIALIZES the derived configuration instead of copying a static
  // template: config.yaml is the version 2 result of the same derivation the
  // zero-config runtime performs.
  const config = await fs.readFile(
    path.join(cwd, ".runtime-corrector", "config.yaml"),
    "utf8",
  );
  assert.match(config, /^version: 2$/m);
  assert.match(config, /^artifacts: \[\]$/m);
  assert.match(config, /^dynamicGroundTruth:$/m);
  assert.match(config, /^stopCorrection:$/m);
  // An empty temp project has no platform marker: the kit check stays off.
  assert.match(config, /^  platform: null$/m);
  assert.match(config, /apiKeyEnv/);
  assert.doesNotMatch(config, /stage: (ir|planning|selection|prd-contract)$/m);
  // The static v1 reference template stays available for artifact/stage work.
  const reference = await fs.readFile(
    path.join(cwd, ".runtime-corrector", "config.reference.yaml"),
    "utf8",
  );
  assert.match(reference, /^enabledStages: \[\]$/m);
  assert.match(reference, /patterns 与 pathTemplates 必须且只能填写一个/);
  assert.match(reference, /可选值：markdown、json、text、auto/);
  assert.match(reference, /^  semanticReviewTimeoutMs: 240000$/m);
  assert.match(reference, /20 分钟示例：1200000/);
  assert.throws(
    () => execFileSync(
      process.execPath,
      [cliPath, "init", "--cwd", cwd],
      { cwd, encoding: "utf8", stdio: "pipe" },
    ),
    (error) => error.status === 2 && /不会继续/.test(error.stderr),
  );
});


test("shipped IR criteria requires source traceability before Agent review", async (t) => {
  const cwd = await workspace(t);
  await installIrTemplate(cwd);
  const filePath = await writeFile(
    cwd,
    "ir.md",
    `# 鸿蒙 TodoList IR

## 目标与范围

目标用户使用鸿蒙应用管理待办，本期不包含账号和同步。

## 功能需求

- 用户输入非空事项后新增待办。
- 用户选择已有事项后删除待办。

## 验收标准

- [ ] 输入“购买牛奶”后列表出现对应事项
- [ ] 删除“购买牛奶”后列表不再显示该事项
`,
  );

  const outcome = await handleHook(hookInput(cwd, filePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "failed");
  assert.ok(outcome.result.diagnostics.some(
    (item) => item.ruleId === "IR-REQUIRE-TRACEABILITY",
  ));
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.match(outcome.result.agentReview.criteria, /默认禁止的无依据扩张/);
  assert.equal(outcome.writtenFiles.length, 8);
  assert.equal(outcome.result.outputFiles.length, 8);
  assert.equal(outcome.result.roundOutputFiles.length, 4);
  assert.equal(outcome.result.latestOutputFiles.length, 4);
  assert.ok(outcome.result.outputFiles.some((file) => file.endsWith("/diagnostic.md")));
  assert.ok(outcome.result.outputFiles.some((file) => file.endsWith("/spec.md")));
  assert.ok(outcome.result.outputFiles.some((file) => file.endsWith(".diff")));
  assert.match(outcome.feedback, /历史 Round 产物/);
  assert.match(outcome.feedback, /diagnostic\.md/);
  assert.match(outcome.feedback, /\.diff/);
  const diagnosticFile = outcome.writtenFiles.find((file) => path.basename(file) === "diagnostic.md");
  const diffFile = outcome.writtenFiles.find((file) => file.endsWith(".diff"));
  assert.match(await fs.readFile(diagnosticFile, "utf8"), /IR-REQUIRE-TRACEABILITY/);
  assert.match(await fs.readFile(diffFile, "utf8"), /\+## 来源追溯/);
  assert.match(await fs.readFile(diffFile, "utf8"), /用户明确要求/);
});


test("shipped IR criteria passes a grounded TodoList IR to semantic review", async (t) => {
  const cwd = await workspace(t);
  await installIrTemplate(cwd);
  const filePath = await writeFile(
    cwd,
    "ir.md",
    `# 鸿蒙 TodoList IR

## 目标与范围

目标用户是在鸿蒙设备上记录简单事项的个人用户。本期实现待办事项的新增和删除，范围外包括账号、同步、提醒和完成态。

## 功能需求

- 用户输入非空事项并确认后，系统把该事项加入列表；空白输入不创建事项。
- 用户对已有事项执行删除后，系统从列表移除该事项；目标不存在时保持列表不变。

## 验收标准

- [ ] 输入“购买牛奶”并确认后，列表出现同名事项
- [ ] 删除“购买牛奶”后，列表不再显示该事项

## 来源追溯

- 用户明确要求：实现鸿蒙 TodoList，以及待办事项的新增和删除。
- 必要推断：使用列表呈现新增和删除的结果。
- 待确认：是否需要本地持久化。
`,
  );

  const outcome = await handleHook(hookInput(cwd, filePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "passed");
  assert.deepEqual(outcome.result.diagnostics, []);
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.match(outcome.result.agentReview.criteria, /默认禁止的无依据扩张/);
  assert.match(outcome.feedback, /忠实性/);
  assert.equal(outcome.writtenFiles.length, 6);
  assert.equal(outcome.result.roundOutputFiles.length, 3);
  assert.equal(outcome.result.latestOutputFiles.length, 3);
  assert.ok(outcome.result.outputFiles.some((file) => file.endsWith("/diagnostic.md")));
  const emptyDiff = outcome.writtenFiles.find((file) => file.endsWith(".diff"));
  assert.equal((await fs.stat(emptyDiff)).size, 0);
  assert.match(outcome.feedback, /diagnostic\.md/);
});


const VALID_PLANNING_IR = `# 鸿蒙 TodoList IR

## 目标与范围

实现鸿蒙待办事项新增和删除。
`;


const VALID_PILOT_PLAN = `# Pilot Plan: 鸿蒙 TodoList

## Granularity

- Recommended: coarse
- Selected: coarse
- Milestone count: 1
- Confirmation: auto
- Reason: 小型单功能闭环适合一个里程碑。

## M1: 可用的待办增删闭环

- Contains SR: SR-1, SR-2
- Goal: 用户可以新增和删除待办事项。
- Review focus: 验证新增和删除结果立即可见。
- Risks: none
`;


const VALID_RELATIONS = {
  schema_version: "planning.relations.v1",
  nodes: [
    { id: "M1", type: "milestone", title: "可用的待办增删闭环" },
    { id: "SR-1", type: "sr", title: "新增待办事项" },
    { id: "SR-2", type: "sr", title: "删除待办事项" },
  ],
  edges: [
    { from: "M1", to: "SR-1", type: "contains" },
    { from: "M1", to: "SR-2", type: "contains" },
  ],
};


const VALID_CHOICE = {
  schema_version: "planning.granularity_choice.v1",
  mode: "auto",
  selected: "coarse",
  recommended: "coarse",
  milestone_count: 1,
  groups: [{ milestone: "M1", sr_ids: ["SR-1", "SR-2"] }],
  source: "auto_selected_recommended",
  reason: "小型单功能闭环适合一个里程碑。",
};


test("planning criteria diagnoses schema deviations and delegates cross-file semantics", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "granularity-choice.json", JSON.stringify({
    ...VALID_CHOICE,
    groups: [{ milestone: "M1", sr_ids: ["SR-1"] }],
    source: "",
  }, null, 2));
  const relationsPath = await writeFile(cwd, "relations.json", JSON.stringify({
    ...VALID_RELATIONS,
    nodes: VALID_RELATIONS.nodes.map(({ title, ...node }) => node),
    edges: VALID_RELATIONS.edges.slice(0, 1),
  }, null, 2));

  const outcome = await handleHook(hookInput(cwd, relationsPath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.matched, true);
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.metadata.stage, "planning");
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "PLANNING-RELATIONS-SCHEMA"));
  assert.ok(outcome.result.diagnostics.some((item) => item.ruleId === "PLANNING-GRANULARITY-SCHEMA"));
  assert.ok(!outcome.result.diagnostics.some((item) => item.ruleId.includes("CROSS-FILE-CONSISTENCY")));
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.match(outcome.result.agentReview.criteria, /同时读取上游 `ir\.md`/);
  assert.equal(outcome.result.diffs.length, 0);
  assert.equal(outcome.writtenFiles.length, 8);
  assert.ok(outcome.writtenFiles.some((file) => path.basename(file) === "spec.md"));
  const emptyDiff = outcome.writtenFiles.find((file) => file.endsWith(".diff"));
  assert.equal((await fs.stat(emptyDiff)).size, 0);
  assert.doesNotMatch(outcome.feedback, /diffStrategy|generate-diff/);
});


test("a schema-valid planning bundle proceeds to semantic review", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  const choicePath = await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));

  const outcome = await handleHook(hookInput(cwd, choicePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "passed");
  assert.deepEqual(outcome.result.diagnostics, []);
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.match(outcome.feedback, /Planning Stage Agent 纠偏标准/);
});


test("hook discovers the policy root from the written file when Claude has changed cwd", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  const choicePath = await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));
  const pollutedCwd = path.join(cwd, ".runtime-corrector");

  const outcome = await handleHook(hookInput(pollutedCwd, choicePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.matched, true);
  assert.equal(outcome.result.status, "passed");
  assert.equal(outcome.result.metadata.projectRootSource, "artifact-policy-discovery");
  assert.equal(outcome.result.metadata.triggerFile, "granularity-choice.json");
  assert.deepEqual(outcome.result.latestOutputFiles, [
    ".runtime-correction/latest/planning/bundle/diagnostic.md",
    ".runtime-correction/latest/planning/bundle/result.json",
    ".runtime-correction/latest/planning/bundle/patch.diff",
  ]);
  assert.equal(outcome.result.roundOutputFiles.length, 3);
  assert.match(outcome.result.roundOutputFiles[0], /^\.runtime-correction\/runs\/planning\/bundle\/\d{8}T\d{6}Z-[a-f0-9]{8}\/diagnostic\.md$/);
});


test("all Planning triggers refresh one canonical bundle diagnostic", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  const planPath = await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  const relationsPath = await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));

  const first = await handleHook(hookInput(cwd, relationsPath), { pluginRoot: PLUGIN_ROOT });
  const second = await handleHook(hookInput(cwd, planPath, "Edit"), { pluginRoot: PLUGIN_ROOT });

  const latestPlanningOutputs = [
    ".runtime-correction/latest/planning/bundle/diagnostic.md",
    ".runtime-correction/latest/planning/bundle/result.json",
    ".runtime-correction/latest/planning/bundle/patch.diff",
  ];
  assert.deepEqual(first.result.latestOutputFiles, latestPlanningOutputs);
  assert.deepEqual(second.result.latestOutputFiles, latestPlanningOutputs);
  assert.notDeepEqual(first.result.roundOutputFiles, second.result.roundOutputFiles);
  const planningRuns = await fs.readdir(path.join(cwd, ".runtime-correction", "runs", "planning", "bundle"));
  assert.equal(planningRuns.length, 2);
  assert.deepEqual(
    (await fs.readdir(path.join(cwd, ".runtime-correction", "latest", "planning", "bundle"))).sort(),
    ["diagnostic.md", "patch.diff", "result.json"],
  );
  const diagnostic = await fs.readFile(
    path.join(cwd, ".runtime-correction", "latest", "planning", "bundle", "diagnostic.md"),
    "utf8",
  );
  assert.match(diagnostic, /Trigger file: `PilotPlan\.md`/);
  assert.match(diagnostic, /Bundle files: .*`relations\.json`/);
  assert.match(diagnostic, /Bundle files: .*`granularity-choice\.json`/);
});


test("incomplete planning snapshots persist pending diagnostics and an empty diff", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  const planPath = await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);

  const outcome = await handleHook(hookInput(cwd, planPath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "pending");
  assert.ok(outcome.result.diagnostics.some((item) => item.severity === "pending"));
  assert.match(outcome.feedback, /Bundle 尚未齐备/);
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.ok(outcome.result.roundOutputFiles.some((item) => item.endsWith("/diagnostic.md")));
  const roundDiff = outcome.result.roundOutputFiles.find((item) => item.endsWith("/patch.diff"));
  assert.ok(roundDiff);
  assert.equal((await fs.stat(path.join(cwd, roundDiff))).size, 0);
});


test("an incomplete bundle still reports local errors in the file that was written", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  const relationsPath = await writeFile(cwd, "relations.json", JSON.stringify({
    ...VALID_RELATIONS,
    nodes: [{ id: "M1", type: "milestone" }],
    edges: [],
  }, null, 2));

  const outcome = await handleHook(hookInput(cwd, relationsPath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.metadata.bundleComplete, false);
  assert.ok(outcome.result.diagnostics.some((item) => item.severity === "pending"));
  assert.ok(outcome.result.diagnostics.some(
    (item) => item.ruleId === "PLANNING-RELATIONS-SCHEMA" && item.section === "/nodes/0/title",
  ));
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.ok(outcome.result.roundOutputFiles.some((item) => item.endsWith("/diagnostic.md")));
  assert.ok(outcome.result.roundOutputFiles.some((item) => item.endsWith("/patch.diff")));
});


test("planning JSON schema diagnostics expose the editable schema and JSON Pointer", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  const badChoicePath = await writeFile(cwd, "granularity-choice.json", JSON.stringify({
    ...VALID_CHOICE,
    groups: [{ milestone: "M1", srs: ["SR-1", "SR-2"] }],
  }, null, 2));

  const outcome = await handleHook(hookInput(cwd, badChoicePath), { pluginRoot: PLUGIN_ROOT });
  const schemaDiagnostic = outcome.result.diagnostics.find(
    (item) => item.ruleId === "PLANNING-GRANULARITY-SCHEMA" && item.section === "/groups/0/sr_ids",
  );

  assert.equal(outcome.result.status, "failed");
  assert.ok(schemaDiagnostic);
  assert.match(schemaDiagnostic.evidence.join("\n"), /granularity-choice\.schema\.json/);
  assert.match(schemaDiagnostic.message, /JSON Pointer: \/groups\/0\/sr_ids/);
  assert.match(schemaDiagnostic.suggestion, /schemas\/granularity-choice\.schema\.json/);
});


test("users can customize a project JSON schema without editing plugin code", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  const schemaPath = path.join(cwd, ".runtime-corrector", "schemas", "granularity-choice.schema.json");
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  schema.required.push("customer_approval_ticket");
  schema.properties.customer_approval_ticket = { type: "string", minLength: 1 };
  await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  const choicePath = await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));

  const outcome = await handleHook(hookInput(cwd, choicePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "failed");
  assert.ok(outcome.result.diagnostics.some(
    (item) => item.ruleId === "PLANNING-GRANULARITY-SCHEMA"
      && item.section === "/customer_approval_ticket",
  ));
});


test("users can rename a choice group field through the project schema", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  const policyRoot = path.join(cwd, ".runtime-corrector");
  const schemaPath = path.join(policyRoot, "schemas", "granularity-choice.schema.json");
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  const groupSchema = schema.properties.groups.items;
  groupSchema.required = groupSchema.required.map((name) => name === "sr_ids" ? "srs" : name);
  groupSchema.properties.srs = groupSchema.properties.sr_ids;
  delete groupSchema.properties.sr_ids;
  await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  const choicePath = await writeFile(cwd, "granularity-choice.json", JSON.stringify({
    ...VALID_CHOICE,
    groups: [{ milestone: "M1", srs: ["SR-1", "SR-2"] }],
  }, null, 2));

  const outcome = await handleHook(hookInput(cwd, choicePath), { pluginRoot: PLUGIN_ROOT });

  assert.equal(outcome.result.status, "passed");
  assert.deepEqual(outcome.result.diagnostics, []);
});


test("unsupported JSON Schema keywords fail visibly instead of being ignored", async (t) => {
  const cwd = await workspace(t);
  await installPlanningTemplate(cwd);
  const schemaPath = path.join(cwd, ".runtime-corrector", "schemas", "relations.schema.json");
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  schema.oneOf = [{ required: ["nodes"] }];
  await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  const relationsPath = await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));

  await assert.rejects(
    handleHook(hookInput(cwd, relationsPath), { pluginRoot: PLUGIN_ROOT }),
    /不支持的关键字.*oneOf/,
  );
});


const VALID_KIT_MAP = `# Kit Map: HarmonyOS TodoList

Input status: confirmed
Input confidence: confirmed

## SR-1 新增待办

- Selected kits: ability-kit, arkui, arkts
- Rationale: ability-kit hosts the UIAbility, arkui renders input and list state, and arkts implements the state logic.
- References: recall=unavailable; use local Ability Kit and ArkUI references.
- Rejected candidates: arkdata, because Planning does not require persistence.
- Recipe: ability-kit -> arkui; arkts is the language base.
- Confidence: auto-pass; recall=unavailable; auto_selected_recommended.
- Open questions: none; non-blocking.

## SR-2 删除待办

- Selected kits: arkui
- Rationale: arkui ListItem and Button remove the selected in-memory item.
- References: recall=unavailable; use local ArkUI List reference.
- Rejected candidates: arkdata, because delete is an in-memory state operation in this scope.
- Recipe: none.
- Confidence: auto-pass; recall=unavailable; auto_selected_recommended.
- Open questions: none; non-blocking.
`;


const VALID_PRD = `# PRD: HarmonyOS TodoList

## 1. Overview

Build a single-entry HarmonyOS TodoList that adds and deletes in-memory items. Persistence, accounts, reminders, edit, and completion are outside this milestone.

## 2. Input Source Trace

| Input | Source class | Summary |
|---|---|---|
| Intent Requirements (IR) | upstream | Add and delete TodoList scope. |
| Pilot Plan (Planning) | upstream | SR-1 and SR-2 are delivered in M1. |
| Kit Map (Selection) | upstream | Uses ability-kit, arkui, and arkts only. |

## 3. Feature Kit Mapping Table

| SR | Feature | Kits | Target files |
|---|---|---|---|
| SR-1 | Add a non-empty todo item | ability-kit, arkui, arkts | entry/src/main/ets/pages/Index.ets, entry/src/main/ets/entryability/EntryAbility.ets |
| SR-2 | Delete exactly the selected item | arkui | entry/src/main/ets/pages/Index.ets |

## 4. Data Structures And Keys

TodoItem contains a unique id and non-empty text. The page-owned TodoItem array is the in-memory source of truth and id is the list key and delete target.

## 5. Permission Matrix

| Permission | Reason | Required |
|---|---|---|
| none | In-memory ArkUI behavior needs no sensitive capability. | no |

## 6. Routes And Module Placement

The entry UIAbility loads pages/Index. entry/src/main/ets/pages/Index.ets owns the add row, List, empty state, and item deletion callback.

## 7. Acceptance Checklist

| SR | Check | Evidence expectation |
|---|---|---|
| SR-1 | AC_ADD_OK: adding trimmed non-empty text appends one uniquely keyed item and clears input. | runtime observation |
| SR-2 | AC_DEL_OK: deleting an item by id removes exactly that item and leaves other ids unchanged. | runtime observation |

## 8. Assumptions And Open Questions

- In-memory state is the reversible Planning default; persistence remains out of scope.
- No blocking open question affects this milestone.

## 9. Implementation Guardrails

- Keep upstream artifacts read-only and do not add features outside SR-1 and SR-2.
- Trim input, require non-empty text, generate a unique id, and delete by that id.

## 10. External Configuration Placeholders

Only DevEco Studio signing and a HarmonyOS device or emulator are external. No backend, account, or network configuration is required.
`;


test("selection criteria punctures missing per-SR Kit evidence and passes a corrected map", async (t) => {
  const cwd = await workspace(t);
  await installSelectionTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));
  const mapPath = await writeFile(cwd, "kit-map.md", `# Kit Map\n\n## SR-1\n\n- Selected kits: none\n`);

  const failed = await handleHook(hookInput(cwd, mapPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(failed.result.status, "failed");
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "SELECTION-KIT-MAP-SR-MISSING"));
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "SELECTION-KIT-MAP-REFERENCES"));
  assert.ok(failed.result.diagnostics.some(
    (item) => item.ruleId === "SELECTION-KIT-MAP-SELECTED-KITS-EMPTY",
  ));
  assert.match(failed.result.agentReview.criteria, /最小 HarmonyOS Kit 集/);

  await fs.writeFile(mapPath, VALID_KIT_MAP, "utf8");
  const passed = await handleHook(hookInput(cwd, mapPath, "Edit"), { pluginRoot: PLUGIN_ROOT });
  assert.equal(passed.result.status, "passed", JSON.stringify(passed.result.diagnostics, null, 2));
  assert.deepEqual(passed.result.diagnostics, []);
});


test("selection failure reports current diagnostics and adds public commands only when absent", async (t) => {
  const cwd = await workspace(t);
  await installSelectionTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));
  const mapPath = await writeFile(cwd, "kit-map.md", VALID_KIT_MAP.replace(/^Input/gm, "- Input"));

  const failed = await handleHook(hookInput(cwd, mapPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(failed.result.status, "failed");
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "SELECTION-KIT-MAP-INPUT-STATUS"));
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "SELECTION-KIT-MAP-INPUT-CONFIDENCE"));
  assert.equal(failed.result.diffs.length, 1);
  assert.match(failed.feedback, /候选 Git Patch：1/);
  assert.match(failed.feedback, /\[runtime-corrector:public-commands\]/);
  assert.match(failed.feedback, /\/runtime-corrector:spec selection/);
  assert.match(failed.feedback, /\/runtime-corrector:help/);
  assert.doesNotMatch(failed.feedback, /完整 selection 规范地图/);
  assert.doesNotMatch(failed.feedback, /type: selection-kit-map/);
  assert.ok(failed.writtenFiles.some((file) => path.basename(file) === "spec.md"));

  const transcriptPath = await writeFile(
    cwd,
    "transcript.jsonl",
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: failed.feedback },
    })}\n`,
  );
  const repeated = await handleHook(
    hookInput(cwd, mapPath, "Edit", transcriptPath),
    { pluginRoot: PLUGIN_ROOT },
  );
  assert.equal(repeated.result.status, "failed");
  assert.doesNotMatch(repeated.feedback, /\[runtime-corrector:public-commands\]/);
  assert.match(repeated.feedback, /SELECTION-KIT-MAP-INPUT-STATUS/);

  const diffFile = failed.writtenFiles.find((file) => file.endsWith(".diff"));
  execFileSync("git", ["apply", "--check", diffFile], { cwd, encoding: "utf8" });
  execFileSync("git", ["apply", diffFile], { cwd, encoding: "utf8" });

  const passed = await handleHook(hookInput(cwd, mapPath, "Edit"), { pluginRoot: PLUGIN_ROOT });
  assert.equal(passed.result.status, "passed", JSON.stringify(passed.result.diagnostics, null, 2));
});


test("semantic selection gaps report zero patches without expanding the full contract", async (t) => {
  const cwd = await workspace(t);
  await installSelectionTemplate(cwd);
  const configPath = path.join(cwd, ".runtime-corrector", "config.yaml");
  await fs.writeFile(
    configPath,
    (await fs.readFile(configPath, "utf8")).replace("maxFeedbackChars: 24000", "maxFeedbackChars: 200"),
    "utf8",
  );
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));
  const content = VALID_KIT_MAP.replace(/^Input (?:status|confidence):.*\r?\n/gm, "");
  const mapPath = await writeFile(cwd, "kit-map.md", content);

  const outcome = await handleHook(hookInput(cwd, mapPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.diffs.length, 0);
  assert.match(outcome.feedback, /候选 Git Patch：0/);
  assert.match(outcome.feedback, /插件不会编造内容/);
  assert.match(outcome.feedback, /\/runtime-corrector:spec selection/);
  assert.doesNotMatch(outcome.feedback, /完整 Stage 规范：selection/);
  assert.doesNotMatch(outcome.feedback, /Selection Agent 审阅标准/);
  assert.match(outcome.feedback, /runtime-corrector 不会自动修改目标文件/);
  assert.doesNotMatch(outcome.feedback, /诊断内容因长度限制被截断/);
  assert.ok(outcome.writtenFiles.some((file) => path.basename(file) === "spec.md"));
  const diffFile = outcome.writtenFiles.find((file) => file.endsWith(".diff"));
  assert.equal((await fs.stat(diffFile)).size, 0);
  assert.match(outcome.feedback, /本轮诊断结果路径：.*\/runs\/selection\/kit-map-[a-f0-9]{8}\/.*\/diagnostic\.md/);
  assert.match(outcome.feedback, /本轮 Diff 文件路径：.*\/runs\/selection\/kit-map-[a-f0-9]{8}\/.*\/patch\.diff/);
});


test("PRD criteria enforces generic structure and delegates upstream semantics", async (t) => {
  const cwd = await workspace(t);
  await installPrdTemplate(cwd);
  await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  await writeFile(cwd, "relations.json", JSON.stringify(VALID_RELATIONS, null, 2));
  await writeFile(cwd, "granularity-choice.json", JSON.stringify(VALID_CHOICE, null, 2));
  await writeFile(cwd, "kit-map.md", VALID_KIT_MAP);
  const prdPath = await writeFile(cwd, "PRD.md", `# PRD\n\n## 1. Overview\n\nTodoList.\n\n## 2. Input Source Trace\n\n| Intent Requirements | missing | unavailable |\n`);

  const failed = await handleHook(hookInput(cwd, prdPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(failed.result.status, "failed");
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "PRD-CONTRACT-SECTION-KIT-MAPPING"));
  assert.ok(!failed.result.diagnostics.some((item) => item.ruleId === "PRD-CONTRACT-SOURCE-FALSE-MISSING"));
  assert.match(failed.result.agentReview.criteria, /稳定 `\*_OK` 标识/);

  await fs.writeFile(prdPath, VALID_PRD, "utf8");
  const passed = await handleHook(hookInput(cwd, prdPath, "Edit"), { pluginRoot: PLUGIN_ROOT });
  assert.equal(passed.result.status, "passed", JSON.stringify(passed.result.diagnostics, null, 2));
  assert.deepEqual(passed.result.diagnostics, []);
});


test("four-stage delivery policy is a self-contained example", async (t) => {
  const cwd = await workspace(t);
  await installFourStageExample(cwd);
  for (const name of [
    "README.md",
    "config.yaml",
    "ir.rules.yaml",
    "ir.reviewer.md",
    "planning.rules.yaml",
    "planning.reviewer.md",
    "selection.rules.yaml",
    "selection.reviewer.md",
    "prd-contract.rules.yaml",
    "prd-contract.reviewer.md",
    "schemas/relations.schema.json",
    "schemas/granularity-choice.schema.json",
  ]) {
    await fs.access(path.join(cwd, ".runtime-corrector", name));
  }
  await fs.access(path.join(
    PLUGIN_ROOT,
    "examples",
    "ir-planning-selection-prd-contract",
    "workflow.yaml",
  ));
  const config = await fs.readFile(path.join(cwd, ".runtime-corrector", "config.yaml"), "utf8");
  assert.match(config, /name: ir/);
  assert.match(config, /name: planning-bundle/);
  assert.match(config, /name: selection/);
  assert.match(config, /name: prd-contract/);
  assert.match(config, /^  semanticReviewTimeoutMs: 1200000$/m);
});


test("PostToolUse diagnoses HarmonyOS ArkTS .ets source artifacts", async (t) => {
  const cwd = await workspace(t);
  const relativePath = "entry/src/main/ets/pages/ToDoListPage.ets";
  const filePath = await writeFile(
    cwd,
    relativePath,
    "@Entry\n@Component\nstruct ToDoListPage {\n  build() {\n    Column() {\n      Text('待办事项')\n    }\n  }\n}\n",
  );
  const outcome = await handleHook(hookInput(cwd, filePath), {
    pluginRoot: PLUGIN_ROOT,
    config: {
      artifacts: [{
        name: "implementation-code",
        stage: "implementation",
        type: "source-code",
        format: "text",
        patterns: ["entry/src/main/ets/**/*.ets"],
        relatedPatterns: [],
        rules: { enabled: false },
        review: { enabled: false },
      }],
      output: { persist: false },
    },
  });

  assert.equal(outcome.matched, true);
  assert.equal(outcome.result.status, "passed");
  assert.equal(outcome.result.metadata.triggerFile, relativePath);
  assert.deepEqual(outcome.result.metadata.artifactFiles, [relativePath]);
});


test("file-digest-manifest rejects stale checkpoint hashes and passes the current snapshot", async (t) => {
  const cwd = await workspace(t);
  const sourcePath = await writeFile(
    cwd,
    "entry/src/main/ets/application/PersistenceCoordinator.ts",
    "export const revision = 'current';\n",
  );
  const checkpointPath = await writeFile(
    cwd,
    "evidence/milestones/M3/checkpoint.json",
    `${JSON.stringify({
      sourceManifest: [{
        path: "entry/src/main/ets/application/PersistenceCoordinator.ts",
        sha256: "0".repeat(64),
      }],
    }, null, 2)}\n`,
  );
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
enabledStages: [milestone-evidence]
artifacts:
  - name: milestone-evidence
    stage: milestone-evidence
    format: json
    patterns:
      - evidence/milestones/*/checkpoint.json
    relatedPatterns:
      - entry/src/main/ets/**/*.ts
    relatedRoot: project
    rules:
      enabled: true
      file: milestone-evidence.rules.yaml
    review:
      enabled: false
output:
  persist: false
`);
  await writeFile(cwd, ".runtime-corrector/milestone-evidence.rules.yaml", `version: 1
rules:
  - id: EVIDENCE-CURRENT-FILE-DIGESTS
    type: file-digest-manifest
    artifact: checkpoint.json
    entriesPointer: /sourceManifest
    pathField: path
    digestField: sha256
`);

  const stale = await handleHook(hookInput(cwd, checkpointPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(stale.matched, true);
  assert.equal(stale.result.status, "failed");
  const mismatch = stale.result.diagnostics.find(
    (item) => item.ruleId === "EVIDENCE-CURRENT-FILE-DIGESTS",
  );
  assert.match(mismatch.message, /摘要不属于当前纠偏快照/);
  assert.match(mismatch.evidence[0], /^expected=0{64}$/);
  assert.match(mismatch.evidence[1], /^actual=[a-f0-9]{64}$/);

  const digest = createHash("sha256")
    .update(await fs.readFile(sourcePath, "utf8"), "utf8")
    .digest("hex");
  await fs.writeFile(checkpointPath, `${JSON.stringify({
    sourceManifest: [{
      path: "entry/src/main/ets/application/PersistenceCoordinator.ts",
      sha256: digest,
    }],
  }, null, 2)}\n`, "utf8");
  const current = await handleHook(
    hookInput(cwd, checkpointPath, "Edit"),
    { pluginRoot: PLUGIN_ROOT },
  );
  assert.equal(current.result.status, "passed");
  assert.deepEqual(current.result.diagnostics, []);
});


test("four-stage workflow prompt and correction policy share stage ids and output paths", async (t) => {
  const cwd = await workspace(t);
  await installFourStageExample(cwd);
  const exampleRoot = path.join(
    PLUGIN_ROOT,
    "examples",
    "ir-planning-selection-prd-contract",
  );
  const workflow = parseSimpleYaml(
    await fs.readFile(path.join(exampleRoot, "workflow.yaml"), "utf8"),
    { source: "workflow.yaml" },
  );
  assert.deepEqual(workflow.stages.map((stage) => stage.id), [
    "ir",
    "planning",
    "selection",
    "prd-contract",
  ]);
  assert.deepEqual(workflow.stages.map((stage) => stage.nextStageId), [
    "planning",
    "selection",
    "prd-contract",
    null,
  ]);
  assert.ok(workflow.stages.every(
    (stage) => Array.isArray(stage.description) && stage.description.length >= 2,
  ));

  const policy = await loadSimpleProjectConfig(cwd);
  const declaredPatterns = new Set(
    policy.configuredArtifacts.flatMap((artifact) => artifact.patterns),
  );
  const outputs = workflow.stages.flatMap(
    (stage) => stage.outputs.map((output) => output.path),
  );
  for (const output of outputs) {
    assert.ok(declaredPatterns.has(output), `${output} must be protected by the example config`);
  }
});


test("CLI spec returns the complete contract even when a stage is disabled", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  await installFourStageExample(cwd);
  execFileSync(
    process.execPath,
    [cliPath, "stage", "selection", "off", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );

  const specification = JSON.parse(execFileSync(
    process.execPath,
    [cliPath, "spec", "selection", "--cwd", cwd, "--format", "json"],
    { cwd, encoding: "utf8" },
  ));
  assert.equal(specification.stage, "selection");
  assert.equal(specification.stageEnabled, false);
  assert.equal(specification.globalSpecification.path, "plugin:specs/custom-stage.md");
  assert.match(specification.globalSpecification.content, /项目配置、\s*硬规则和 Agent reviewer/);
  assert.match(specification.criteria[0].rules.content, /type: markdown-records/);
  assert.match(specification.criteria[0].reviewer.content, /最小 HarmonyOS Kit 集/);
  assert.equal(specification.recovery.slashCommand, "/runtime-corrector:spec selection");
});


test("custom app-design stage is registered, inspectable, switchable, and self-explaining on failure", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1

enabledStages: []

artifacts:
  - name: app-design-document
    stage: app-design
    type: app-design
    format: markdown
    patterns:
      - design.md
      - "**/design.md"
    relatedPatterns:
      - requirements.md
      - "**/requirements.md"
    relatedRoot: artifact-directory
    rules:
      enabled: true
      file: app-design.rules.yaml
    review:
      enabled: true
      criteria: app-design.reviewer.md

output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`);
  await writeFile(cwd, ".runtime-corrector/app-design.rules.yaml", `version: 1

rules:
  - id: DESIGN-GOALS
    type: require-heading
    heading: 设计目标
    severity: error
  - id: DESIGN-ARCHITECTURE
    type: require-heading
    heading: 架构与模块
    severity: error
  - id: DESIGN-NO-PLACEHOLDER
    type: forbid-text
    values: [TODO, TBD]
    severity: error
`);
  await writeFile(cwd, ".runtime-corrector/app-design.reviewer.md", "# App Design Agent 审阅标准\n\n1. 设计必须能追溯到 requirements.md。\n2. 不得扩张需求。\n");
  await writeFile(cwd, "requirements.md", "# Requirements\n\n- 创建 Todo 应用。\n");
  const designPath = await writeFile(cwd, "docs/design.md", "# Todo Design\n\nTODO\n");

  const before = await handleHook(hookInput(cwd, designPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(before.matched, false);

  const explanation = JSON.parse(execFileSync(
    process.execPath,
    [cliPath, "explain", "app-design", "--cwd", cwd, "--format", "json"],
    { cwd, encoding: "utf8" },
  ));
  assert.equal(explanation.stage, "app-design");
  assert.deepEqual(explanation.artifacts[0].rules, {
    enabled: true,
    file: ".runtime-corrector/app-design.rules.yaml",
  });
  assert.deepEqual(explanation.artifacts[0].review, {
    enabled: true,
    criteria: ".runtime-corrector/app-design.reviewer.md",
  });
  assert.deepEqual(
    explanation.artifacts[0].checks.map((check) => check.id),
    ["DESIGN-GOALS", "DESIGN-ARCHITECTURE", "DESIGN-NO-PLACEHOLDER"],
  );
  assert.ok(explanation.artifacts[0].checks.every((check) => check.enabled));

  const disabledSpecification = JSON.parse(execFileSync(
    process.execPath,
    [cliPath, "spec", "app-design", "--cwd", cwd, "--format", "json"],
    { cwd, encoding: "utf8" },
  ));
  assert.equal(disabledSpecification.stageEnabled, false);
  assert.equal(disabledSpecification.globalSpecification.path, "plugin:specs/custom-stage.md");
  assert.match(disabledSpecification.criteria[0].rules.content, /DESIGN-ARCHITECTURE/);
  assert.match(disabledSpecification.criteria[0].reviewer.content, /不得扩张需求/);

  const enabledText = execFileSync(
    process.execPath,
    [cliPath, "stage", "app-design", "on", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );
  assert.match(enabledText, /\[on\] app-design/);

  const failed = await handleHook(hookInput(cwd, designPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(failed.matched, true);
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.result.metadata.stage, "app-design");
  assert.equal(failed.result.specification.globalPath, "plugin:specs/custom-stage.md");
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "DESIGN-GOALS"));
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "DESIGN-ARCHITECTURE"));
  assert.doesNotMatch(failed.feedback, /完整 Stage 规范：app-design/);
  assert.doesNotMatch(failed.feedback, /App Design Agent 审阅标准/);
  assert.match(failed.feedback, /\/runtime-corrector:spec app-design/);
  assert.ok(failed.result.outputFiles.some((item) => item.endsWith("/spec.md")));

  execFileSync(
    process.execPath,
    [cliPath, "stage", "app-design", "off", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );
  const after = await handleHook(hookInput(cwd, designPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(after.matched, false);
});


test("custom mini-planning stage corrects one Markdown and one JSON artifact as a bundle", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1

enabledStages:
  - mini-planning

artifacts:
  - name: mini-planning-bundle
    stage: mini-planning
    type: mini-planning-bundle
    format: auto
    patterns:
      - PilotPlan.md
      - relations.json
    relatedPatterns:
      - PilotPlan.md
      - relations.json
    relatedRoot: project
    rules:
      enabled: true
      file: mini-planning.rules.yaml
    review:
      enabled: true
      criteria: mini-planning.reviewer.md

output:
  persist: true
  mode: centralized
  directory: .runtime-correction
  generateDiff: true
  diffStrategy: deterministic
`);
  await writeFile(cwd, ".runtime-corrector/mini-planning.rules.yaml", `version: 1

rules:
  - id: MINI-PLANNING-REQUIRED
    type: require-artifacts
    artifacts:
      - PilotPlan.md
      - relations.json
    pendingUntilComplete: true
    severity: error

  - id: MINI-PLANNING-RELATIONS-SCHEMA
    type: json-schema
    artifact: relations.json
    schema: schemas/mini-relations.schema.json
    severity: error

  - id: MINI-PLANNING-RELATION-GRAPH
    type: graph-invariants
    artifact: relations.json
    caseSensitiveIds: false
    nodes:
      pointer: /nodes
      idField: id
      typeField: type
      typeRules:
        - id: RELATION-NODE-TYPE
          idPattern: "^SR-"
          expectedType: sr
        - id: RELATION-NODE-TYPE
          idPattern: "^M"
          expectedType: milestone
    edges:
      pointer: /edges
      fromField: from
      toField: to
      typeField: type
      endpointRules:
        - id: CONTAINS-DIRECTION
          edgeType: contains
          fromType: milestone
          toType: sr
        - id: REQUIRES-DIRECTION
          edgeType: requires
          fromType: sr
          toType: sr
          allowSelf: false
      acyclic:
        - id: REQUIRES-CYCLE
          types: [requires]
    severity: error
`);
  await writeFile(
    cwd,
    ".runtime-corrector/mini-planning.reviewer.md",
    "# Mini Planning Agent 审阅标准\n\n1. PilotPlan.md 与 relations.json 必须表达同一组里程碑和 SR。\n2. 不得出现只在一份文件中声明的里程碑、SR 或依赖。\n",
  );
  await writeFile(cwd, ".runtime-corrector/schemas/mini-relations.schema.json", JSON.stringify({
    type: "object",
    required: ["schema_version", "nodes", "edges"],
    properties: {
      schema_version: { const: "planning.relations.v1" },
      nodes: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          required: ["id", "type", "title"],
          properties: {
            id: { type: "string", pattern: "^(M[1-9][0-9]*|SR-[1-9][0-9]*)$" },
            type: { type: "string", enum: ["milestone", "sr"] },
            title: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      edges: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["from", "to", "type"],
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            type: { type: "string", enum: ["contains", "requires"] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  }, null, 2));
  const planPath = await writeFile(cwd, "PilotPlan.md", `# Mini Pilot Plan

- Recommended: fine
- Selected: fine
- Milestone count: 1
- Confirmation: auto
- Reason: 单一 Todo 闭环可以在一个里程碑内评审。

## M1: Todo vertical slice
- Contains SR: SR-1
- Goal: 用户可以新增 Todo。
- Review focus: 新增后立即可见。
- Risks: none
`);

  const pending = await handleHook(hookInput(cwd, planPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(pending.result.status, "pending");
  assert.equal(pending.result.metadata.bundleComplete, false);
  assert.equal(pending.result.agentReview.status, "requested");
  assert.ok(pending.result.outputFiles.some((item) => item.endsWith("/diagnostic.md")));
  assert.ok(pending.result.outputFiles.some((item) => item.endsWith("/patch.diff")));
  assert.ok(pending.result.diagnostics.some((item) => (
    item.ruleId === "MINI-PLANNING-REQUIRED" && item.severity === "pending"
  )));

  const relationsPath = await writeFile(cwd, "relations.json", JSON.stringify({
    schema_version: "planning.relations.v1",
    nodes: [
      { id: "M1", type: "milestone", title: "" },
      { id: "SR-1", type: "sr", title: "Add Todo" },
    ],
    edges: [{ from: "SR-1", to: "M1", type: "contains" }],
  }, null, 2));
  const failed = await handleHook(hookInput(cwd, relationsPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(failed.result.status, "failed");
  assert.deepEqual(failed.result.metadata.artifactFiles.sort(), ["PilotPlan.md", "relations.json"]);
  assert.ok(failed.result.diagnostics.some((item) => item.ruleId === "MINI-PLANNING-RELATIONS-SCHEMA"));
  assert.ok(failed.result.diagnostics.some((item) => (
    item.ruleId === "MINI-PLANNING-RELATION-GRAPH-CONTAINS-DIRECTION"
  )));
  assert.equal(failed.result.agentReview.status, "requested");
  assert.doesNotMatch(failed.feedback, /完整 Stage 规范：mini-planning/);
  assert.doesNotMatch(failed.feedback, /Mini Planning Agent 审阅标准/);
  assert.match(failed.feedback, /\/runtime-corrector:spec mini-planning/);
  assert.ok(failed.result.outputFiles.some((item) => item.endsWith("/spec.md")));

  await writeFile(cwd, "relations.json", JSON.stringify({
    schema_version: "planning.relations.v1",
    nodes: [
      { id: "M1", type: "milestone", title: "Todo vertical slice" },
      { id: "SR-1", type: "sr", title: "Add Todo" },
    ],
    edges: [{ from: "M1", to: "SR-1", type: "contains" }],
  }, null, 2));
  const passed = await handleHook(hookInput(cwd, relationsPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(passed.result.status, "passed");
  assert.equal(passed.result.agentReview.status, "requested");
  assert.deepEqual(passed.result.diffs, []);
  assert.ok(passed.result.roundOutputFiles.some((item) => item.endsWith("/patch.diff")));
  assert.ok(!passed.result.outputFiles.some((item) => item.endsWith("/spec.md")));
  const relationsLatestDiagnostic = passed.result.latestOutputFiles.find((item) => item.endsWith("/diagnostic.md"));
  assert.ok(relationsLatestDiagnostic.includes("/latest/mini-planning/relations-"));
  const relationsPatch = passed.result.roundOutputFiles.find((item) => item.endsWith("/patch.diff"));
  assert.equal((await fs.stat(path.join(cwd, relationsPatch))).size, 0);

  const passedFromPlan = await handleHook(hookInput(cwd, planPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(passedFromPlan.result.status, "passed");
  assert.deepEqual(passedFromPlan.result.metadata.artifactFiles.sort(), ["PilotPlan.md", "relations.json"]);
  const planLatestDiagnostic = passedFromPlan.result.latestOutputFiles.find((item) => item.endsWith("/diagnostic.md"));
  assert.ok(planLatestDiagnostic.includes("/latest/mini-planning/pilotplan-"));
  assert.notEqual(path.posix.dirname(planLatestDiagnostic), path.posix.dirname(relationsLatestDiagnostic));
});


test("CLI explains the active planning policy using only project-owned paths", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  await installFourStageExample(cwd);

  const stdout = execFileSync(
    process.execPath,
    [cliPath, "explain", "planning", "--cwd", cwd, "--format", "json"],
    { cwd, encoding: "utf8" },
  );
  const explanation = JSON.parse(stdout);

  assert.equal(explanation.stage, "planning");
  assert.equal(explanation.config, ".runtime-corrector/config.yaml");
  assert.ok(explanation.artifacts[0].checks.some(
    (check) => check.schema === ".runtime-corrector/schemas/granularity-choice.schema.json",
  ));
  assert.ok(explanation.artifacts[0].checks.some(
    (check) => check.type === "graph-invariants",
  ));
  assert.doesNotMatch(stdout, /lib\/planning-validator/);
});


test("CLI explains Selection and PRD criteria through project-owned contracts", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  await installFourStageExample(cwd);

  for (const [stage, expectedType, expectedRules] of [
    ["selection", "markdown-records", ".runtime-corrector/selection.rules.yaml"],
    ["prd-contract", "require-heading", ".runtime-corrector/prd-contract.rules.yaml"],
  ]) {
    const explanation = JSON.parse(execFileSync(
      process.execPath,
      [cliPath, "explain", stage, "--cwd", cwd, "--format", "json"],
      { cwd, encoding: "utf8" },
    ));
    assert.equal(explanation.stage, stage);
    assert.deepEqual(explanation.artifacts[0].rules, {
      enabled: true,
      file: expectedRules,
    });
    assert.ok(explanation.artifacts[0].checks.some((check) => check.type === expectedType));
  }
});


test("stage control lists and toggles stages without changing criteria files", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  await installFourStageExample(cwd);
  const rulesPath = path.join(cwd, ".runtime-corrector", "planning.rules.yaml");
  const reviewerPath = path.join(cwd, ".runtime-corrector", "planning.reviewer.md");
  const rulesBefore = await fs.readFile(rulesPath, "utf8");
  const reviewerBefore = await fs.readFile(reviewerPath, "utf8");

  const initial = JSON.parse(execFileSync(
    process.execPath,
    [cliPath, "stages", "--cwd", cwd, "--format", "json"],
    { cwd, encoding: "utf8" },
  ));
  assert.deepEqual(initial.stages.map((item) => [item.stage, item.enabled]), [
    ["ir", true],
    ["planning", true],
    ["selection", true],
    ["prd-contract", true],
  ]);

  const disabledText = execFileSync(
    process.execPath,
    [cliPath, "stage", "planning", "off", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );
  assert.match(disabledText, /\[off\] planning/);
  const planPath = await writeFile(cwd, "PilotPlan.md", VALID_PILOT_PLAN);
  const disabledOutcome = await handleHook(hookInput(cwd, planPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(disabledOutcome.matched, false);

  execFileSync(
    process.execPath,
    [cliPath, "stage", "planning", "on", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );
  const enabledOutcome = await handleHook(hookInput(cwd, planPath), { pluginRoot: PLUGIN_ROOT });
  assert.equal(enabledOutcome.matched, true);
  assert.equal(await fs.readFile(rulesPath, "utf8"), rulesBefore);
  assert.equal(await fs.readFile(reviewerPath, "utf8"), reviewerBefore);
});


test("enabledStages can select one stage or disable all stages", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  await installFourStageExample(cwd);
  for (const stage of ["ir", "planning", "prd-contract"]) {
    execFileSync(
      process.execPath,
      [cliPath, "stage", stage, "off", "--cwd", cwd],
      { cwd, encoding: "utf8" },
    );
  }
  const irPath = await writeFile(cwd, "ir.md", VALID_PLANNING_IR);
  const kitMapPath = await writeFile(cwd, "kit-map.md", VALID_KIT_MAP);
  assert.equal((await handleHook(hookInput(cwd, irPath), { pluginRoot: PLUGIN_ROOT })).matched, false);
  assert.equal((await handleHook(hookInput(cwd, kitMapPath), { pluginRoot: PLUGIN_ROOT })).matched, true);

  execFileSync(
    process.execPath,
    [cliPath, "stage", "selection", "off", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );
  const config = await fs.readFile(path.join(cwd, ".runtime-corrector", "config.yaml"), "utf8");
  assert.match(config, /^enabledStages: \[\]$/m);
  assert.equal((await handleHook(hookInput(cwd, kitMapPath), { pluginRoot: PLUGIN_ROOT })).matched, false);
});


test("project-aware help is safe before init and reports stage state after init", async (t) => {
  const cwd = await workspace(t);
  const cliPath = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");

  const before = execFileSync(
    process.execPath,
    [cliPath, "help", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );
  assert.match(before, /Claude 对话帮助/);
  assert.match(before, /尚未初始化/);
  await assert.rejects(fs.access(path.join(cwd, ".runtime-corrector")));

  execFileSync(process.execPath, [cliPath, "init", "--cwd", cwd], { cwd, encoding: "utf8" });
  const after = execFileSync(
    process.execPath,
    [cliPath, "help", "--cwd", cwd],
    { cwd, encoding: "utf8" },
  );
  // The materialized version 2 config declares no v1 artifact stage yet, and
  // project-aware help must stay safe rather than erroring on that.
  assert.match(after, /尚未声明 v1 artifact Stage/);
  assert.match(after, /\.runtime-corrector\/config\.yaml/);
  assert.match(after, /不自动修改产物/);
});


test("Claude command and control skill expose one guarded stage control model", async () => {
  const helpCommand = await fs.readFile(path.join(PLUGIN_ROOT, "commands", "help.md"), "utf8");
  const specCommand = await fs.readFile(path.join(PLUGIN_ROOT, "commands", "spec.md"), "utf8");
  const stagesCommand = await fs.readFile(path.join(PLUGIN_ROOT, "commands", "stages.md"), "utf8");
  const controlSkill = await fs.readFile(
    path.join(PLUGIN_ROOT, "skills", "runtime-corrector-control", "SKILL.md"),
    "utf8",
  );

  assert.match(helpCommand, /cli\.mjs" help --cwd/);
  assert.match(specCommand, /cli\.mjs" spec/);
  assert.match(specCommand, /complete packet/i);
  assert.match(stagesCommand, /runtime-corrector-control/);
  assert.match(controlSkill, /^name: runtime-corrector-control$/m);
  assert.match(controlSkill, /stages --cwd "\$PWD" --format json/);
  assert.match(controlSkill, /stage <stage> <on\|off>/);
  assert.match(controlSkill, /spec <stage>/);
  assert.match(controlSkill, /only enable/);
  assert.match(controlSkill, /Never edit generated stage artifacts/);
  assert.match(controlSkill, /Never delete criteria/);
});


test("README is a detailed standalone guide while contracts live under docs", async () => {
  const readme = await fs.readFile(path.join(PLUGIN_ROOT, "README.en.md"), "utf8");
  const readmeZh = await fs.readFile(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  const docs = await Promise.all([
    "README.md",
    "how-it-works.md",
    "configuration.md",
    "interfaces.md",
    "tutorial.md",
    "six-stage-workflow-from-zero.md",
  ].map((name) => fs.readFile(path.join(PLUGIN_ROOT, "docs", name), "utf8")));

  // Standalone publication: an English detailed guide plus a Chinese mirror
  // with the same seven-section structure, free of upstream project names.
  for (const document of [readme, readmeZh]) {
    assert.equal((document.match(/^## [1-7]\. /gm) ?? []).length, 7);
    assert.doesNotMatch(document, /VeriPilot/i);
    assert.match(document, /runtime-corrector@runtime-corrector-local/);
    assert.match(document, /--plugin-dir/);
    assert.match(document, /DERIVED_CONFIG/);
    assert.match(document, /ONBOARDING_DEGRADED/);
    assert.match(document, /REVIEWER_PROVIDER_DEGRADED/);
    assert.match(document, /apiKeyEnv/);
    assert.match(document, /modelPolicy/);
    assert.match(document, /maxCorrectionsPerEpoch/);
    assert.match(document, /docs\/README\.md/);
    assert.match(document, /docs\/how-it-works\.md/);
    assert.match(document, /docs\/configuration\.md/);
    assert.match(document, /docs\/interfaces\.md/);
    assert.match(document, /docs\/tutorial\.md/);
    assert.match(document, /docs\/six-stage-workflow-from-zero\.md/);
  }
  assert.ok(readme.split(/\r?\n/).length > 150, "root README is a detailed guide");
  // zh is the default README; the English alternative links back to it and vice versa.
  assert.match(readme, /README\.md/);
  assert.match(readmeZh, /README\.en\.md/);
  assert.match(docs[1], /`UserPromptSubmit` Hook/);
  assert.match(docs[1], /Skill 看护/);
  assert.match(docs[1], /compact_boundary/);
  assert.match(docs[1], /PostToolUse/);
  assert.match(docs[1], /agentReview\.status = requested/);
  assert.match(docs[2], /enabledStages/);
  assert.match(docs[2], /markdown-records/);
  assert.match(docs[2], /checkpoint-review/);
  assert.match(docs[2], /file-digest-manifest/);
  assert.match(docs[2], /prd-contract/);
  assert.match(docs[3], /退出码/);
  assert.match(docs[3], /自定义 Matcher/);
  assert.match(docs[3], /RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE/);
  assert.match(docs[3], /"session_id": "parent-session-id"/);
  assert.match(docs[4], /完整使用教程/);
  assert.match(docs[4], /CLI `check` 不会创建 Claude 隔离 session/);
  assert.match(docs[5], /配置六阶段文档看护 Workflow/);
  assert.match(docs[5], /workflow\.yaml/);
  assert.match(docs[5], /six-stage\.rules\.yaml/);
  assert.match(docs[5], /six-stage\.reviewer\.md/);
  assert.match(docs[5], /workflow-edge\.reviewer\.md/);
  assert.match(docs[5], /端到端穿刺案例/);
});


test("six-stage YAML example keeps execution inputs aligned with review edges", async () => {
  const exampleRoot = path.join(PLUGIN_ROOT, "examples", "six-stage-workflow");
  const workflowSource = await fs.readFile(path.join(exampleRoot, "workflow.yaml"), "utf8");
  const workflow = parseSimpleYaml(workflowSource, {
    source: "examples/six-stage-workflow/workflow.yaml",
  });
  for (const stage of workflow.stages) {
    assert.equal(stage.purpose.length, 2, `${stage.name} must have exactly two purpose sentences`);
    assert.ok(stage.purpose.every((sentence) => (
      typeof sentence === "string" && sentence.endsWith("。")
    )), `${stage.name} purpose entries must be complete Chinese sentences`);
  }
  assert.deepEqual(
    workflow.stages.map((stage) => [
      stage.name,
      stage.inputs.map((input) => input.from),
    ]),
    [
      ["requirement-analysis", []],
      ["requirement-breakdown", ["requirement-analysis"]],
      ["code-understanding", []],
      ["solution-design", [
        "requirement-analysis",
        "requirement-breakdown",
        "code-understanding",
      ]],
      ["manual-test-cases", [
        "requirement-analysis",
        "requirement-breakdown",
        "solution-design",
      ]],
      ["dt-design", [
        "requirement-breakdown",
        "code-understanding",
        "solution-design",
      ]],
    ],
  );
  const config = await loadSimpleProjectConfig(exampleRoot);
  for (const stage of workflow.stages) {
    assert.deepEqual(
      config.reviewGraph
        .incomingEdges(stage.name)
        .filter((edge) => edge.reviewEnabled)
        .map((edge) => edge.from),
      stage.inputs.map((input) => input.from),
      `${stage.name} inputs must match its enabled Runtime Corrector incoming edges`,
    );
  }

  const explanation = JSON.parse(execFileSync(
    process.execPath,
    [
      path.join(PLUGIN_ROOT, "scripts", "cli.mjs"),
      "explain",
      "solution-design",
      "--cwd",
      exampleRoot,
      "--format",
      "json",
    ],
    { cwd: exampleRoot, encoding: "utf8" },
  ));
  assert.equal(explanation.stage, "solution-design");
  assert.deepEqual(
    explanation.artifacts[0].workflow.incomingEdges.map((edge) => edge.from),
    workflow.stages
      .find((stage) => stage.name === "solution-design")
      .inputs
      .map((input) => input.from),
  );
  assert.equal(explanation.artifacts[0].review.enabled, true);
  assert.equal(
    explanation.artifacts[0].rules.file,
    ".runtime-corrector/six-stage.rules.yaml",
  );
  assert.equal(
    explanation.artifacts[0].review.criteria,
    ".runtime-corrector/six-stage.reviewer.md",
  );
  assert.ok(explanation.artifacts[0].workflow.incomingEdges.every(
    (edge) => edge.criteria === ".runtime-corrector/workflow-edge.reviewer.md",
  ));
});


test("standalone custom-stage tutorial exposes Markdown-only and Markdown-plus-JSON journeys", async () => {
  const tutorial = await fs.readFile(path.join(PLUGIN_ROOT, "tutorial.html"), "utf8");
  assert.match(tutorial, /<!doctype html>/i);
  assert.match(tutorial, /app-design/);
  assert.match(tutorial, /\*\*\/design\.md/);
  assert.match(tutorial, /app-design\.rules\.yaml/);
  assert.match(tutorial, /app-design\.reviewer\.md/);
  assert.match(tutorial, /stage app-design on/);
  assert.match(tutorial, /PostToolUse/);
  assert.match(tutorial, /不会自动修改/);
  assert.match(tutorial, /左侧 · 被检查的文档/);
  assert.match(tutorial, /右侧 · 当前检查标准/);
  assert.match(tutorial, /Agent 标准 · 3/);
  assert.match(tutorial, /data-rule="architecture"/);
  assert.match(tutorial, /data-target-section="architecture"/);
  assert.match(tutorial, /六阶段 Workflow 图约束演示/);
  assert.match(tutorial, /需求分析/);
  assert.match(tutorial, /需求拆分/);
  assert.match(tutorial, /代码理解/);
  assert.match(tutorial, /方案设计/);
  assert.match(tutorial, /人工测试用例设计/);
  assert.match(tutorial, /DT 设计/);
  assert.match(tutorial, /data-edge-path="ra-mt"/);
  assert.match(tutorial, /直接入边约束/);
  assert.match(tutorial, /id="workflow-edges-code"/);
  assert.match(tutorial, /renderWorkflowNode\(selectedWorkflowNode, selectedWorkflowEdge\)/);
  assert.match(tutorial, /mini-planning/);
  assert.match(tutorial, /mini-planning\.rules\.yaml/);
  assert.match(tutorial, /mini-relations\.schema\.json/);
  assert.match(tutorial, /PilotPlan\.md/);
  assert.match(tutorial, /relations\.json/);
  assert.match(tutorial, /pendingUntilComplete/);
  assert.match(tutorial, /data-bundle-step="plan"/);
  assert.match(tutorial, /data-bundle-step="invalid-json"/);
  assert.match(tutorial, /data-bundle-step="corrected-json"/);
  assert.match(tutorial, /SEMANTIC REVIEW COMPLETED/);
  assert.doesNotMatch(tutorial, /不下发 reviewer|REVIEW REQUESTED|SIMULATED MAIN AGENT/);
  assert.doesNotMatch(tutorial, /<(?:script|link)[^>]+(?:src|href)=["']https?:/i);
});
