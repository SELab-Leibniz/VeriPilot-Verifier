import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateCandidateDiffs } from "./candidate-diff.mjs";
import {
  buildReviewerInvocation,
  decorateReviewerLaunchError,
  resolveReviewerLaunchPlan,
  sanitizeReviewerEnvironment,
} from "./reviewer-launcher.mjs";
import * as activeHost from "./active-host.mjs";
import { resolveReviewTimeoutMs } from "./review-timeout.mjs";
import { withAgentOutputEnvironment } from "./agent-output.mjs";
import { normalizeSlashes } from "./path-utils.mjs";
import { OUTPUT_TREE_DIRECTORY } from "./runtime-v2/paths.mjs";
import { writeOriginalRequirementSources, ORIGINAL_REQUIREMENTS_SCHEMA } from "./runtime-v2/original-requirements.mjs";
import { handoffRoleReviewer, startRoleReviewer } from "./runtime-v2/reviewer.mjs";
import { sha256 } from './runtime-v2/utils.mjs';
import { bindHostOriginalCoverage, hostOriginalCapacityFailure,
  cloneHostLegacyOriginalCoverage, validateHostOriginalDutyContext,
  sealHostOriginalReview } from './runtime-v2/original-duty-publication.mjs';

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
    child.once("error", (error) => reject(decorateReviewerLaunchError(error)));
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
  hostAdapter = activeHost,
  pluginRoot = MODULE_ROOT,
  prompt,
}) {
  return [
    prompt,
    ...hostAdapter.buildReviewerSessionArguments({
      sessionId,
      fork: true,
      noSessionPersistence: true,
    }),
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
  timeoutMs = activeHost.defaultSemanticReviewTimeoutMs,
  maxOutputTokens,
  env = process.env,
  reviewerRuntime,
  projectRoot,
  hostAdapter = activeHost,
}) {
  env = sanitizeReviewerEnvironment(env);
  timeoutMs = resolveReviewTimeoutMs(timeoutMs, "limits.semanticReviewTimeoutMs");
  const launchPlan = await resolveReviewerLaunchPlan({ reviewerRuntime, env, projectRoot, hostAdapter });
  const { executable, args } = buildReviewerInvocation(launchPlan,
    buildSemanticReviewArguments({
      sessionId,
      hostAdapter,
      pluginRoot,
      prompt,
    }), hostAdapter);
  const completed = await spawnCaptured(executable, args, {
    cwd,
    env: withAgentOutputEnvironment(forkEnvironment(env), maxOutputTokens),
    timeoutMs,
  });
  if (completed.timedOut) throw new Error(`隔离 semantic review 在 ${timeoutMs}ms 后超时。`);
  if (completed.code !== 0) {
    const reason = (completed.stderr || completed.stdout).trim();
    throw new Error(`隔离 semantic review 退出码 ${completed.code}${reason ? `：${reason}` : ""}`);
  }
  const parsed = parseClaudeReview(completed.stdout);
  if (hostAdapter.host === "codeagent" && !parsed.sessionId) {
    throw new Error("CodeAgent forked semantic reviewer did not return a session ID.");
  }
  return { ...completed, ...parsed, executable, args };
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
  originalRequirements = null,
}) {
  const relativeDirectory = normalizeSlashes(
    path.join(OUTPUT_TREE_DIRECTORY, ".semantic-review", result.metadata.roundId),
  );
  const absoluteDirectory = path.resolve(cwd, relativeDirectory);
  const requestPath = path.join(absoluteDirectory, "request.json");
  let payload = {
    version: 1,
    projectRoot: normalizeSlashes(cwd),
    stage: result.metadata.stage,
    artifactType: result.metadata.artifactType,
    triggerFile: result.metadata.triggerFile,
    ...(result.metadata.triggerFiles ? { triggerFiles: result.metadata.triggerFiles } : {}),
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
  };
  try {
    await fs.mkdir(absoluteDirectory, { recursive: true });
    if (originalRequirements) payload = { ...payload,
      originalRequirements: await writeOriginalRequirementSources(absoluteDirectory, originalRequirements) };
    await fs.writeFile(requestPath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    await fs.rm(absoluteDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    payload,
    absoluteDirectory,
    absolutePath: normalizeSlashes(requestPath),
    relativePath: normalizeSlashes(path.relative(cwd, requestPath)),
  };
}


async function runtimeV2OriginalDutySources(originals, context, input, cwd, runtimeV2, execution, current) {
  if (!originals || !context) return null;
  if (originals.schemaVersion !== ORIGINAL_REQUIREMENTS_SCHEMA || !Array.isArray(originals.userMessages)
    || typeof originals.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(originals.digest))
    throw new Error('DOCUMENT_ORIGINAL_DUTY_SOURCE_IDENTITY_INVALID');
  const owner = context.owner, taskId = execution?.taskId ?? runtimeV2.taskId;
  const canonicalRoot = await fs.realpath(cwd);
  const workspaceRoots = [owner?.projectRoot, execution?.projectRoot, runtimeV2.projectRoot]
    .filter(value => value !== undefined && value !== null);
  const canonicalWorkspaces = await Promise.all(workspaceRoots.map(value => typeof value === 'string'
    ? fs.realpath(value).catch(() => null) : null));
  if (!owner || canonicalWorkspaces.some(value => value !== canonicalRoot)
    || Object.hasOwn(runtimeV2, 'taskId') && runtimeV2.taskId !== owner.taskId
    || owner.sessionId !== input.session_id || owner.sessionId !== (execution?.parentSessionId ?? input.session_id)
    || typeof owner.taskId !== 'string' || !owner.taskId || owner.taskId !== taskId
    || typeof owner.sessionKey !== 'string' || !owner.sessionKey
    || typeof owner.scopeFingerprint !== 'string' || !owner.scopeFingerprint
    || typeof context.sourceRunId !== 'string' || !context.sourceRunId
    || !Number.isSafeInteger(owner.enabledRevision) || owner.enabledRevision < 0
    || current && current() !== true) throw new Error('DOCUMENT_ORIGINAL_DUTY_PUBLICATION_OWNER_CHANGED');
  const refs = new Set(), orders = new Set();
  const userMessages = originals.userMessages.map(message => {
    if (!Number.isSafeInteger(message.order) || message.order < 1 || orders.has(message.order)
      || typeof message.ref !== 'string' || !message.ref.trim() || refs.has(message.ref)
      || typeof message.text !== 'string' || sha256(message.text) !== message.sha256)
      throw new Error('DOCUMENT_ORIGINAL_DUTY_SOURCE_IDENTITY_INVALID');
    refs.add(message.ref); orders.add(message.order);
    const { order, ref, text, sha256: hash, timestamp = null } = message;
    return { order, ref, text, sha256: hash, timestamp, characters: text.length };
  });
  // Read authority is only for the current host-supplied original user spans.
  // It neither replaces frozen Ground Truth nor promotes reference materials.
  return { schemaVersion: originals.schemaVersion, originalBasisDigest: originals.digest,
    digest: sha256({ protocol: 'runtime-v2-original-user-duty-read-v1', basis: originals.digest,
      users: userMessages.map(message => [message.ref, message.sha256]) }), userMessages,
    materials: [], projectFiles: [], referencedFiles: [],
    sourceRole: 'ORIGINAL_USER_DUTY_ACCOUNTING_ONLY_FROZEN_GROUND_TRUTH_UNCHANGED' };
}

export async function runSemanticReview({
  input,
  prepared,
  pluginRoot = MODULE_ROOT,
  invokeFork = invokeSemanticReviewFork,
  timeoutMs,
  runtimeV2Handle = null,
  runtimeV2Context = null,
  runtimeV2ExecutionContext = null,
  runtimeV2Evidence = null,
  originalDutyCohortContext = null,
  originalDutyPublicationGuard = null,
  runtimeV2ReviewerFactory = startRoleReviewer,
  originalRequirements = null,
}) {
  if (prepared.reviewContext?.deferSemanticReview && !runtimeV2Context && !runtimeV2Handle) {
    return { status: "deferred", reasonCode: "ARTIFACT_BUNDLE_INCOMPLETE", findings: [], diffs: [] };
  }
  if (process.env.RUNTIME_CORRECTOR_SEMANTIC_REVIEW_ACTIVE === "1") {
    await closeSemanticReviewerSafely(runtimeV2Handle);
    return { status: "failed", error: "检测到递归 semantic review。", findings: [], diffs: [] };
  }
  if (!input?.session_id) {
    await closeSemanticReviewerSafely(runtimeV2Handle);
    return {
      status: "failed",
      error: "PostToolUse 输入没有 session_id，无法创建隔离 semantic review session。",
      findings: [],
      diffs: [],
    };
  }
  const cwd = prepared.projectRoot;
  // The host resolves persisted reviewer sessions in the process cwd. Policy
  // discovery may move `prepared.projectRoot` to a nested
  // workspace, while the parent session still belongs to the hook's original
  // cwd. Keep artifact persistence rooted at the discovered project, but fork
  // from the session cwd so the parent conversation can be resolved.
  const sessionCwd = path.resolve(input.cwd ?? cwd);
  const effectiveTimeoutMs = resolveReviewTimeoutMs(timeoutMs
    ?? prepared.reviewContext?.semanticReviewTimeoutMs
    ?? activeHost.defaultSemanticReviewTimeoutMs, "limits.semanticReviewTimeoutMs");
  const workflow = prepared.reviewContext.workflow ?? null;
  const hasWorkflow = workflow !== null && workflow !== undefined;
  const editableArtifactFiles = hasWorkflow
    ? Array.isArray(workflow.editableArtifactFiles)
      ? workflow.editableArtifactFiles
      : []
    : null;
  let request = null;
  let validatedReview = null;
  let forkSessionId = null;
  let activeRuntimeV2Handle = runtimeV2Handle;
  try {
    originalDutyCohortContext = validateHostOriginalDutyContext(originalDutyCohortContext);
    if (originalDutyCohortContext) {
      const [root, ownerRoot] = await Promise.all([fs.realpath(cwd),
        fs.realpath(originalDutyCohortContext.owner.projectRoot).catch(() => null)]);
      if (root !== ownerRoot) throw new Error('DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID');
    }
    request = await writeReviewRequest({
      cwd,
      result: prepared.result,
      nodeReviewEnabled: prepared.reviewContext.nodeReviewEnabled !== false,
      reviewer: prepared.reviewContext.reviewer,
      specification: prepared.reviewContext.specification,
      workflow,
      runtimeV2: runtimeV2Context,
      originalRequirements: runtimeV2Context ? await runtimeV2OriginalDutySources(originalRequirements,
        originalDutyCohortContext, input, cwd, runtimeV2Context, runtimeV2ExecutionContext,
        originalDutyPublicationGuard) : originalRequirements,
    });
    let fork;
    if (runtimeV2Context) {
      const originHandle = activeRuntimeV2Handle;
      activeRuntimeV2Handle = null;
      activeRuntimeV2Handle = await (runtimeV2ReviewerFactory.handoff ?? handoffRoleReviewer)({
        originHandle,
        reviewerFactory: runtimeV2ReviewerFactory,
        projectRoot: runtimeV2ExecutionContext?.projectRoot ?? cwd,
        sessionCwd: runtimeV2ExecutionContext?.sessionCwd ?? sessionCwd,
        taskId: runtimeV2ExecutionContext?.taskId ?? runtimeV2Context.taskId,
        parentSessionId: runtimeV2ExecutionContext?.parentSessionId ?? input.session_id,
        role: "artifact-reviewer",
        reviewer: runtimeV2Context.reviewerExecution,
        schema: REVIEW_SCHEMA,
        pluginRoot: runtimeV2ExecutionContext?.pluginRoot ?? pluginRoot,
        reviewerRuntime: runtimeV2ExecutionContext?.reviewerRuntime,
        env: runtimeV2ExecutionContext?.env,
        deadlineAt: runtimeV2ExecutionContext?.deadlineAt ?? null,
        evidence: { ...runtimeV2Evidence, semanticRequest: request.payload,
          ...(originalDutyCohortContext ? { originalDutyCohortContext } : {}) },
        request: {
          schemaVersion: "runtime-corrector.artifact-role-request.v2",
          instructions: "Read semanticReviewRequestPath and perform the composite artifact review against the frozen Ground Truth. Every finding path must be one of the round's artifact files; cite other locations inside the evidence text. Source and artifact files still follow the current disk-read and diff validation rules.",
          semanticReviewRequestPath: request.absolutePath,
        },
      });
      fork = { sessionId: activeRuntimeV2Handle.sessionId, review: activeRuntimeV2Handle.result,
        originalRequirementCoverage: activeRuntimeV2Handle.originalRequirementCoverage,
        originalDutyAccounting: activeRuntimeV2Handle.originalDutyAccounting,
        ...(activeRuntimeV2Handle.planReadiness ? { planReadiness: activeRuntimeV2Handle.planReadiness } : {}) };
    } else {
      const prompt = `/runtime-corrector:semantic-review --request "${request.absolutePath}"`;
      fork = await invokeFork({
        cwd: sessionCwd,
        sessionId: input.session_id,
        pluginRoot,
        prompt,
        timeoutMs: effectiveTimeoutMs,
        maxOutputTokens: prepared.reviewContext.maxOutputTokens,
        projectRoot: cwd,
        semanticRequest: request.payload,
        reviewerRuntime: prepared.reviewContext.reviewerRuntime,
      });
    }
    forkSessionId = fork.sessionId ?? null;
    const originalRequirementCoverage = originalDutyCohortContext
      ? bindHostOriginalCoverage(fork.originalRequirementCoverage, originalDutyCohortContext, originalDutyPublicationGuard)
      : cloneHostLegacyOriginalCoverage(fork.originalRequirementCoverage);
    if (originalDutyCohortContext && (fork.originalRequirementCoverage || fork.originalDutyAccounting?.stagedCount > 0)
      && !originalRequirementCoverage) throw new Error('DOCUMENT_ORIGINAL_DUTY_HOST_RECEIPT_INVALID');
    if (!originalDutyCohortContext && (fork.originalRequirementCoverage && !originalRequirementCoverage
      || fork.originalDutyAccounting && (fork.originalDutyAccounting.status !== 'NOT_EXERCISED'
        || fork.originalDutyAccounting.stagedCount !== 0))) throw new Error('DOCUMENT_ORIGINAL_LEGACY_COVERAGE_INVALID');
    const originalMetadata = {
      ...(originalRequirementCoverage ? { originalRequirementCoverage } : {}),
      ...(originalDutyCohortContext && fork.originalDutyAccounting ? { originalDutyAccounting: fork.originalDutyAccounting } : {}),
    };
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
    return sealHostOriginalReview({
      status: "completed",
      parentSessionId: input.session_id,
      forkSessionId,
      summary: review.summary,
      findings: review.findings,
      edits: review.edits,
      diffs,
      ...(originalRequirementCoverage ? { originalRequirementCoverage } : {}),
      ...(originalDutyCohortContext && fork.originalDutyAccounting ? { originalDutyAccounting: fork.originalDutyAccounting } : {}),
      ...(fork.planReadiness ? { planReadiness: fork.planReadiness } : {}),
      metricObjectJudgements: review.metricObjectJudgements ?? [],
    }, originalMetadata);
  } catch (error) {
    const capacityFailure = hostOriginalCapacityFailure(error);
    const originalRequirementCoverage = bindHostOriginalCoverage(capacityFailure,
      originalDutyCohortContext, originalDutyPublicationGuard);
    const originalMetadata = originalRequirementCoverage ? { originalRequirementCoverage,
      originalDutyAccounting: originalRequirementCoverage.originalDutyAccounting } : {};
    return sealHostOriginalReview({
      status: "failed",
      semanticStatus: validatedReview ? "completed" : "failed",
      patchStatus: validatedReview ? "failed" : "not_generated",
      patchError: validatedReview ? error.message : null,
      error: error.message,
      parentSessionId: input.session_id,
      forkSessionId,
      summary: validatedReview?.summary ?? null,
      findings: validatedReview?.findings ?? [],
      edits: validatedReview?.edits ?? [],
      diffs: [],
      metricObjectJudgements: validatedReview?.metricObjectJudgements ?? [],
      ...originalMetadata,
    }, originalMetadata);
  } finally {
    // External semantic inputs remain readable through every target repair.
    // Cleanup failure must neither skip another owned resource nor replace the assessment.
    await Promise.allSettled([
      ...(request ? [fs.rm(request.absoluteDirectory, { recursive: true, force: true })] : []),
      closeSemanticReviewerSafely(activeRuntimeV2Handle),
    ]);
  }
}


async function closeSemanticReviewerSafely(handle) {
  try { await handle?.close(); } catch { /* Preserve the review's result/error. */ }
}
