import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateCandidateDiffs } from "./candidate-diff.mjs";
import { resolveClaudeExecutable } from "./claude-executable.mjs";
import { normalizeSlashes } from "./path-utils.mjs";
import { OUTPUT_TREE_DIRECTORY } from "./runtime-v2/paths.mjs";
import { startRoleReviewer } from "./runtime-v2/reviewer.mjs";

export { resolveClaudeExecutable } from "./claude-executable.mjs";


const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_CAPTURE_BYTES = 1024 * 1024;


export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "edits"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ruleId", "severity", "path", "message", "evidence"],
        properties: {
          ruleId: { type: "string", pattern: "^AGENT-[A-Z0-9][A-Z0-9_-]*$" },
          severity: { type: "string", enum: ["error", "warning", "info"] },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          message: { type: "string" },
          evidence: {
            type: "array",
            items: { type: "string" },
            maxItems: 20,
          },
          suggestion: { type: "string" },
          rootCauseId: { type: "string" },
          violatedGroundTruthIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    edits: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "operations"],
        properties: {
          target: { type: "string" },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "line", "expect"],
              properties: {
                type: {
                  type: "string",
                  enum: ["remove-line", "replace-line", "insert-before", "insert-after"],
                },
                line: { type: "integer", minimum: 1 },
                expect: { type: "string" },
                replacement: {
                  oneOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
              },
            },
          },
        },
      },
    },
    metricObjectJudgements: {
      type: "array",
      maxItems: 5000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["objectId", "judgement", "reason", "evidence"],
        properties: {
          objectId: { type: "string" },
          judgement: {
            type: "string",
            enum: ["PASS", "DEVIATION", "UNVERIFIED", "BASIS_PENDING", "EXTERNAL_BLOCKED", "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "CHECKER_ERROR"],
          },
          reason: { type: "string" },
          evidence: { type: "array", items: { type: "string" }, maxItems: 20 },
        },
      },
    },
  },
};


function forkEnvironment(source = process.env) {
  const env = { ...source };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ID;
  env.RUNTIME_CORRECTOR_SEMANTIC_REVIEW_ACTIVE = "1";
  return env;
}


function spawnCaptured(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    const capture = (target, chunk) => {
      if (capturedBytes >= MAX_CAPTURE_BYTES) return target;
      const buffer = Buffer.from(chunk);
      const accepted = buffer.subarray(0, MAX_CAPTURE_BYTES - capturedBytes);
      capturedBytes += accepted.length;
      return target + accepted.toString("utf8");
    };
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}


function nestedString(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    const match = nestedString(child, keys);
    if (match) return match;
  }
  return null;
}


function nestedObject(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const match = nestedObject(child, keys);
    if (match) return match;
  }
  return null;
}


export function parseClaudeReview(stdout) {
  const envelope = JSON.parse(stdout);
  const structured = nestedObject(envelope, ["structured_output", "structuredOutput"]);
  const resultText = structured ? null : nestedString(envelope, ["result", "text"]);
  if (!structured && !resultText) {
    throw new Error("隔离 session 没有返回 structured_output。");
  }
  const review = structured ?? JSON.parse(resultText);
  return {
    sessionId: nestedString(envelope, ["session_id", "sessionId"]),
    review,
  };
}


export function buildSemanticReviewArguments({
  sessionId,
  pluginRoot = MODULE_ROOT,
  prompt,
}) {
  return [
    prompt,
    "--resume", sessionId,
    "--fork-session",
    "--no-session-persistence",
    "--print",
    "--output-format", "json",
    "--json-schema", JSON.stringify(REVIEW_SCHEMA),
    "--effort", "low",
    "--permission-mode", "dontAsk",
    "--plugin-dir", pluginRoot,
    "--tools", "Read,Grep",
    "--allowedTools", "Read,Grep",
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
  ];
}


export async function invokeSemanticReviewFork({
  cwd,
  sessionId,
  pluginRoot = MODULE_ROOT,
  prompt,
  timeoutMs = 240000,
  env = process.env,
}) {
  const executable = await resolveClaudeExecutable(env);
  const args = buildSemanticReviewArguments({ sessionId, pluginRoot, prompt });
  const completed = await spawnCaptured(executable, args, {
    cwd,
    env: forkEnvironment(env),
    timeoutMs,
  });
  if (completed.timedOut) throw new Error(`隔离 semantic review 在 ${timeoutMs}ms 后超时。`);
  if (completed.code !== 0) {
    const reason = (completed.stderr || completed.stdout).trim();
    throw new Error(`隔离 semantic review 退出码 ${completed.code}${reason ? `：${reason}` : ""}`);
  }
  return { ...completed, ...parseClaudeReview(completed.stdout), executable, args };
}


function validateReview(review, artifactFiles, workflow) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new Error("semantic review 必须返回 JSON 对象。");
  }
  if (typeof review.summary !== "string"
    || !Array.isArray(review.findings)
    || !Array.isArray(review.edits)) {
    throw new Error("semantic review 缺少 summary、findings 或 edits。");
  }
  const hasWorkflow = workflow !== null && workflow !== undefined;
  const allowedFiles = hasWorkflow
    ? Array.isArray(workflow.targetFiles)
      ? workflow.targetFiles
      : Array.isArray(workflow.editableArtifactFiles)
        ? workflow.editableArtifactFiles
        : []
    : artifactFiles ?? [];
  const allowed = new Set(allowedFiles.map(normalizeSlashes));
  for (const finding of review.findings) {
    finding.path = normalizeSlashes(finding.path);
    if (!allowed.has(finding.path)) {
      // An off-list path is a real cross-artifact subject, not a review
      // failure. Throwing here discarded the ENTIRE review (round 3 lost
      // every post-requirements review this way); instead the finding is
      // demoted to informational, keeps its true location as evidence, and
      // re-anchors to the primary artifact. Edit/diff targets stay strictly
      // whitelisted elsewhere.
      const listName = hasWorkflow ? "可编辑产物列表" : "产物列表";
      const anchor = allowedFiles.length ? normalizeSlashes(allowedFiles[0]) : finding.path;
      finding.evidence = [...(Array.isArray(finding.evidence) ? finding.evidence : []), `原路径不在本轮${listName}：${finding.path}`].slice(0, 20);
      finding.path = anchor;
      finding.severity = "info";
    }
  }
  return review;
}


async function writeReviewRequest({
  cwd,
  result,
  nodeReviewEnabled = true,
  reviewer,
  specification,
  workflow,
  runtimeV2 = null,
}) {
  const relativeDirectory = normalizeSlashes(
    path.join(OUTPUT_TREE_DIRECTORY, ".semantic-review", result.metadata.roundId),
  );
  const absoluteDirectory = path.resolve(cwd, relativeDirectory);
  await fs.mkdir(absoluteDirectory, { recursive: true });
  const requestPath = path.join(absoluteDirectory, "request.json");
  await fs.writeFile(requestPath, JSON.stringify({
    version: 1,
    projectRoot: normalizeSlashes(cwd),
    stage: result.metadata.stage,
    artifactType: result.metadata.artifactType,
    triggerFile: result.metadata.triggerFile,
    artifactFiles: result.metadata.artifactFiles,
    bundleComplete: result.metadata.bundleComplete,
    deterministicStatus: result.status,
    deterministicDiagnostics: result.diagnostics,
    nodeReviewEnabled,
    reviewer: reviewer
      ? { path: reviewer.path, criteria: reviewer.criteria }
      : null,
    specification,
    ...(workflow !== null && workflow !== undefined ? { workflow } : {}),
    ...(runtimeV2 ? { runtimeV2 } : {}),
  }, null, 2), "utf8");
  return {
    absoluteDirectory,
    absolutePath: normalizeSlashes(requestPath),
    relativePath: normalizeSlashes(path.relative(cwd, requestPath)),
  };
}


export async function runSemanticReview({
  input,
  prepared,
  pluginRoot = MODULE_ROOT,
  invokeFork = invokeSemanticReviewFork,
  timeoutMs,
  runtimeV2Handle = null,
  runtimeV2Context = null,
  runtimeV2ReviewerFactory = startRoleReviewer,
}) {
  if (process.env.RUNTIME_CORRECTOR_SEMANTIC_REVIEW_ACTIVE === "1") {
    return { status: "failed", error: "检测到递归 semantic review。", findings: [], diffs: [] };
  }
  if (!input?.session_id) {
    return {
      status: "failed",
      error: "PostToolUse 输入没有 session_id，无法创建隔离 semantic review session。",
      findings: [],
      diffs: [],
    };
  }
  const cwd = prepared.projectRoot;
  // Claude Code resolves --resume sessions in the project associated with the
  // process cwd. Policy discovery may move `prepared.projectRoot` to a nested
  // workspace, while the parent session still belongs to the hook's original
  // cwd. Keep artifact persistence rooted at the discovered project, but fork
  // from the session cwd so the parent conversation can be resolved.
  const sessionCwd = path.resolve(input.cwd ?? cwd);
  const effectiveTimeoutMs = timeoutMs
    ?? prepared.reviewContext?.semanticReviewTimeoutMs
    ?? 240000;
  const workflow = prepared.reviewContext.workflow ?? null;
  const hasWorkflow = workflow !== null && workflow !== undefined;
  const editableArtifactFiles = hasWorkflow
    ? Array.isArray(workflow.editableArtifactFiles)
      ? workflow.editableArtifactFiles
      : []
    : null;
  const request = await writeReviewRequest({
    cwd,
    result: prepared.result,
    nodeReviewEnabled: prepared.reviewContext.nodeReviewEnabled !== false,
    reviewer: prepared.reviewContext.reviewer,
    specification: prepared.reviewContext.specification,
    workflow,
    runtimeV2: runtimeV2Context,
  });
  let validatedReview = null;
  let forkSessionId = null;
  let activeRuntimeV2Handle = runtimeV2Handle;
  try {
    let fork;
    if (activeRuntimeV2Handle) {
      const review = await activeRuntimeV2Handle.followUp({
        prompt: `[runtime-corrector:internal] Ground Truth is frozen. Read ${request.absolutePath} and perform the composite artifact review. This session is intentionally read-only: only Read and Grep are available; Write/Edit/Bash are disabled by design — never attempt them and never report their absence as a finding. Every finding path must be one of the round's artifact files; cite other locations inside the evidence text. Do not continue the parent conversation's task. Return only structured output.`,
        nextSchema: REVIEW_SCHEMA,
        nextReviewer: runtimeV2Context.reviewerExecution,
      });
      fork = { sessionId: activeRuntimeV2Handle.sessionId, review };
    } else if (runtimeV2Context) {
      activeRuntimeV2Handle = await runtimeV2ReviewerFactory({
        projectRoot: cwd,
        sessionCwd,
        taskId: runtimeV2Context.taskId,
        parentSessionId: input.session_id,
        role: "artifact-reviewer",
        reviewer: runtimeV2Context.reviewerExecution,
        schema: REVIEW_SCHEMA,
        request: {
          schemaVersion: "runtime-corrector.artifact-role-request.v2",
          instructions: "Read semanticReviewRequestPath and perform the composite artifact review against the frozen Ground Truth.",
          semanticReviewRequestPath: request.absolutePath,
        },
      });
      fork = { sessionId: activeRuntimeV2Handle.sessionId, review: activeRuntimeV2Handle.result };
    } else {
      const prompt = `/runtime-corrector:semantic-review --request "${request.absolutePath}"`;
      fork = await invokeFork({
        cwd: sessionCwd,
        sessionId: input.session_id,
        pluginRoot,
        prompt,
        timeoutMs: effectiveTimeoutMs,
      });
    }
    forkSessionId = fork.sessionId ?? null;
    const review = validateReview(
      fork.review,
      prepared.result.metadata.artifactFiles,
      workflow,
    );
    validatedReview = review;
    const diffs = await generateCandidateDiffs({
      cwd,
      artifactFiles: prepared.result.metadata.artifactFiles,
      ...(hasWorkflow
        ? { editableArtifactFiles }
        : {}),
      edits: review.edits,
    });
    return {
      status: "completed",
      parentSessionId: input.session_id,
      forkSessionId,
      summary: review.summary,
      findings: review.findings,
      edits: review.edits,
      diffs,
      metricObjectJudgements: review.metricObjectJudgements ?? [],
    };
  } catch (error) {
    return {
      status: "failed",
      error: error.message,
      parentSessionId: input.session_id,
      forkSessionId,
      summary: validatedReview?.summary ?? null,
      findings: validatedReview?.findings ?? [],
      edits: validatedReview?.edits ?? [],
      diffs: [],
    };
  } finally {
    await fs.rm(request.absoluteDirectory, { recursive: true, force: true });
    if (activeRuntimeV2Handle) await activeRuntimeV2Handle.close();
  }
}
