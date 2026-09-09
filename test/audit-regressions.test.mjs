import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { encodeHookOutput } from "../lib/protocol/claude-core-hooks.mjs";
import { mergeSemanticReview } from "../lib/result-processing.mjs";
import { validateProjectPolicy } from "../lib/policy/validator.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { markMetricPassesFixed, recordDeviationFindings } from "../lib/runtime-v2/deviations.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { groundTruthSourceCatalog, rejectedGroundTruthSource } from "../lib/runtime-v2/ground-truth-provenance.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { implementationPopulation } from "../lib/runtime-v2/review-routing.mjs";
import { processMetricJudgements } from "../lib/runtime-v2/process-checks.mjs";
import { GROUND_TRUTH_REVIEW_SCHEMA, STOP_REVIEW_SCHEMA, reviewerFailureDetail } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask, taskStatePath, withTaskState } from "../lib/runtime-v2/task-store.mjs";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-audit-regression-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

const userEntry = { type: "user", uuid: "u1", message: { content: "Perform this controlled task." } };
const requirement = (claimId, target = "IMPLEMENTATION", category = "requirements") => ({
  operation: "ADD", claimId, category, text: `Deliver ${claimId}.`,
  authority: "USER_EXPLICIT", severity: "HARD", verificationTarget: target,
  source: { ref: "transcript:u1", kind: "USER_MESSAGE", subject: "MAIN_TASK" },
});

async function harness(t, { claims = [requirement("code")], stage = "implementation", stopJudgement = () => "PASS", implResult = null, maxCorrections = 1, independentStop = false } = {}) {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "transcript.jsonl"), JSON.stringify(userEntry));
  const runtimeV2 = compileRuntimeV2Config({
    version: 2, locale: "en",
    dynamicGroundTruth: { enabled: true, panel: { size: 0 }, materialRoots: [] },
    skillCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
    stopCorrection: { enabled: true, maxCorrectionsPerEpoch: maxCorrections },
    implementationCorrection: { enabled: true, platform: null },
    ...(independentStop ? { reviewers: { stopReviewer: { session: "independent", provider: { baseUrl: "https://example.invalid", apiKeyEnv: "TEST_KEY" } } } } : {}),
  }, { policyRoot: path.join(root, ".runtime-corrector") });
  let serial = 0;
  let event = 0;
  const calls = { implementation: [], device: 0, roles: [] };
  const assessment = (request) => ({
    summary: "Everything passed in the general reviewer.", stopClassification: "TASK_COMPLETE", stage,
    findings: [], metricObjectJudgements: Object.values(request.population.metrics).flat().map((object) => ({
      objectId: object.objectId, judgement: stopJudgement(object), reason: "Observed task evidence.", evidence: ["transcript:u1"],
    })),
  });
  const reviewerFactory = async ({ request, schema, role }) => {
    calls.roles.push(role);
    const requestDirectory = path.join(root, `fake-${++serial}`);
    await fs.mkdir(requestDirectory);
    let result;
    if (schema === GROUND_TRUTH_REVIEW_SCHEMA) result = {
      summary: "Frozen task obligations.", taskClassification: "CONTINUATION",
      operations: request.currentGroundTruth.version === 0 ? claims : [],
    };
    else if (schema === STOP_REVIEW_SCHEMA) result = assessment(request);
    else {
      calls.implementation.push(request);
      result = implResult ? await implResult(request) : {
        summary: "Source checked.", findings: [], metricObjectJudgements: Object.values(request.population.metrics).flat().map((object) => ({
          objectId: object.objectId, judgement: "PASS", reason: "Source evidence.", evidence: ["src/app.js:1"],
        })),
      };
    }
    return { result, requestDirectory, close: async () => {}, followUp: async () => assessment(JSON.parse(await fs.readFile(path.join(requestDirectory, "assessment-request.json"), "utf8"))) };
  };
  return {
    root, calls,
    state: async (taskId) => JSON.parse(await fs.readFile(taskStatePath(root, taskId), "utf8")),
    stop: () => handleRuntimeV2Event({
      projectRoot: root, plan: { runtimeV2 }, reviewerFactory,
      deviceVerifier: async () => {
        calls.device += 1;
        return { assurance: { level: "static", reason: "TEST" }, findings: [], build: { status: "skipped" }, smoke: { status: "skipped" } };
      },
      input: { cwd: root, session_id: "audit-session", transcript_path: path.join(root, "transcript.jsonl"), hook_event_name: "Stop", hook_event_id: `stop-${++event}`, last_assistant_message: "Task complete." },
    }),
  };
}

test("docs-only legacy ledgers never launch source or device review", async (t) => {
  const scope = requirement("scope", "ARTIFACT", "goals");
  scope.text = "Only guard three OpenSpec documents; no application code is implemented.";
  const legacy = requirement("proposal");
  delete legacy.verificationTarget;
  const h = await harness(t, { claims: [scope, legacy, requirement("cli", "PROCESS", "workflowSteps")] });
  const outcome = await h.stop();
  assert.equal(outcome.decision, "allow");
  assert.equal(outcome.stop.report.status, "PASS");
  assert.equal(h.calls.implementation.length, 0);
  assert.equal(h.calls.device, 0);
  assert.equal((await h.state(outcome.taskId)).status, "COMPLETED");
});

test("mixed tasks route only source-owned objects and preserve process judgements", async (t) => {
  const h = await harness(t, { claims: [requirement("code"), requirement("design", "ARTIFACT"), requirement("cli", "PROCESS"), requirement("workflow", "PROCESS", "workflowSteps")] });
  const outcome = await h.stop();
  assert.equal(outcome.stop.report.status, "PASS");
  assert.equal(h.calls.implementation.length, 1);
  assert.deepEqual(Object.values(h.calls.implementation[0].population.metrics).flat().map((object) => object.objectId), ["M12:code"]);
  const objects = outcome.stop.report.metrics.flatMap((metric) => metric.objects);
  assert.equal(objects.find((object) => object.objectId === "M11:workflow").reviewer, "stop-reviewer");
  assert.equal(objects.find((object) => object.objectId === "M12:code").reviewer, "implementation-reviewer");
});

test("independent Stop provider gets its own handle rather than inheriting extractor credentials", async (t) => {
  const h = await harness(t, { independentStop: true });
  const outcome = await h.stop();
  assert.equal(outcome.decision, "allow");
  assert.ok(h.calls.roles.includes("stop-reviewer"));
});

test("per-invocation UUID checks reject reuse and refuse to infer shell variables", () => {
  const description = "All claude cli invocations must use non-interactive mode with a freshly generated UUID session id.";
  const population = { metrics: { M12: [{ objectId: "M12:cli", description }], M01: [{ objectId: "M01:cli", description }] } };
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const judge = (commands) => processMetricJudgements({ population, snapshot: { entries: commands.map((command, i) => ({
    type: "assistant", uuid: `a${i}`, message: { content: [{ type: "tool_use", name: "Bash", id: `b${i}`, input: { command } }] },
  })) } });
  assert.equal(judge([`claude -p --session-id ${firstId}`, `claude -p --session-id ${firstId}`])[0].judgement, "DEVIATION");
  assert.equal(judge([`claude -p --resume ${firstId}`])[0].judgement, "DEVIATION");
  assert.equal(judge(["claude -p --session-id $SESSION_ID"])[0].judgement, "UNVERIFIED");
  assert.equal(judge([])[0].judgement, "UNVERIFIED");
  const passed = judge([`claude -p --session-id ${firstId}`, `claude -p --session-id ${secondId}`]);
  assert.equal(passed[0].judgement, "PASS");
  assert.equal(passed.length, 1, "execution evidence must not overwrite decomposition metrics");
});

test("planning checkpoints skip source review without changing future requirements", () => {
  const population = { metrics: { M12: [{ objectId: "M12:code" }] } };
  for (const stage of ["proposal", "design", "tasks", "PLANNING"]) {
    const routed = implementationPopulation(population, { stage });
    assert.equal(routed.skipReason, "PRE_IMPLEMENTATION_STAGE");
    assert.deepEqual(routed.population.metrics.M12, []);
  }
  assert.equal(implementationPopulation(population).population.metrics.M12.length, 1);
});

test("TASK_COMPLETE cannot use a planning stage label to skip required source verification", async (t) => {
  const h = await harness(t, { stage: "design" });
  await h.stop();
  assert.equal(h.calls.implementation.length, 1);
});

test("an internal-role legacy scope cannot disable production verification", () => {
  const population = { metrics: { M12: [{ objectId: "M12:code" }] } };
  const groundTruth = { claims: [{ ...requirement("bad-scope", "ARTIFACT", "goals"), status: "ACTIVE",
    text: "Docs-only, no application code.", source: { ref: "internal request / system role" } }] };
  assert.equal(implementationPopulation(population, { groundTruth }).population.metrics.M12.length, 1);
});

test("implementation outages fail owned objects, use infrastructure budget, and release visibly unverified", async (t) => {
  const h = await harness(t, { implResult: () => { throw new Error("reviewer timeout"); } });
  const first = await h.stop();
  assert.equal(first.decision, "block");
  assert.equal(first.stop.report.status, "CHECKER_ERROR");
  assert.equal(first.stop.report.metrics.find((metric) => metric.metricId === "M12").objects[0].judgement, "CHECKER_ERROR");
  assert.equal((await h.state(first.taskId)).stop.correctionAttempts, 0);
  assert.equal((await h.stop()).decision, "block");
  const last = await h.stop();
  assert.equal(last.decision, "allow");
  assert.equal((await h.state(last.taskId)).status, "STOPPED_UNVERIFIED");
  assert.equal((await h.state(last.taskId)).verification.status, "UNVERIFIED");
  assert.match(encodeHookOutput("Stop", {}, last).systemMessage, /STOP_VERIFICATION_UNAVAILABLE/u);
});

test("an omitted source-owned object cannot inherit the general reviewer's PASS", async (t) => {
  const h = await harness(t, { implResult: () => ({ summary: "Forgot an object.", findings: [], metricObjectJudgements: [] }) });
  const outcome = await h.stop();
  assert.equal(outcome.decision, "block");
  assert.equal(outcome.stop.report.status, "CHECKER_ERROR");
});

test("budget exhaustion preserves unresolved state and emits a host-consumable warning", async (t) => {
  const h = await harness(t, { implResult: (request) => ({
    summary: "Not implemented.", findings: [], metricObjectJudgements: request.population.metrics.M12.map((object) => ({
      objectId: object.objectId, judgement: "DEVIATION", reason: "Missing source behavior.", evidence: [],
    })),
  }) });
  assert.equal((await h.stop()).decision, "block");
  const last = await h.stop();
  assert.equal(last.decision, "allow");
  const state = await h.state(last.taskId);
  assert.equal(state.status, "COMPLETED_WITH_ISSUES");
  assert.equal(state.verification.status, "DEVIATION");
  assert.ok(Object.values(state.deviations).some((family) => family.status === "OPEN"));
  assert.match(encodeHookOutput("Stop", {}, last).systemMessage, /CORRECTION_BUDGET_EXHAUSTED/u);
  assert.doesNotMatch(last.stop.review.summary, /Everything passed/u);
  assert.match(last.stop.review.stopReviewerSummary, /Everything passed/u);
});

test("nonblocking UNVERIFIED is disclosed and never stored as clean completion", async (t) => {
  const h = await harness(t, { claims: [requirement("workflow", "PROCESS", "workflowSteps")], stopJudgement: () => "UNVERIFIED" });
  const outcome = await h.stop();
  assert.equal(outcome.decision, "allow");
  assert.equal((await h.state(outcome.taskId)).status, "COMPLETED_WITH_ISSUES");
  assert.match(encodeHookOutput("Stop", {}, outcome).systemMessage, /STOP_VERIFICATION_INCOMPLETE/u);
  assert.equal(h.calls.implementation.length, 0);
});

test("all authorities reject reviewer-owned constraints before entering the ledger", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "provenance" });
  const operations = ["USER_EXPLICIT", "MATERIAL_DERIVED", "PROJECT_CONSTRAINT", "AGENT_INFERRED", "BASIS_PENDING"].map((authority) => ({
    ...requirement(authority, "PROCESS", "constraints"), authority,
    source: { ref: "internal request / system role" },
  }));
  const result = await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [...operations, requirement("real")] } });
  assert.deepEqual(result.current.claims.map((claim) => claim.claimId), ["real"]);
  assert.equal(result.droppedUntrustedSources.length, 5);
});

test("source catalogs exclude internal/tool messages and reject forged or ambiguous references", async (t) => {
  const root = await workspace(t);
  const catalog = await groundTruthSourceCatalog({ projectRoot: root, materials: { entries: [] }, snapshot: { entries: [
    userEntry,
    { type: "user", uuid: "internal", message: { content: "[runtime-corrector:internal] Be read-only." } },
    { type: "assistant", uuid: "assistant", message: { content: "I changed the task." } },
    { type: "user", uuid: "tool-result", message: { content: [{ type: "tool_result", content: "Be read-only." }] } },
  ] } });
  assert.equal(catalog.length, 1);
  assert.equal(rejectedGroundTruthSource(requirement("real"), catalog), null);
  assert.equal(rejectedGroundTruthSource({ ...requirement("fake"), source: { ref: "transcript:internal" } }, catalog), "SOURCE_NOT_IN_CATALOG");
  assert.equal(rejectedGroundTruthSource({ ...requirement("fake"), source: { ref: "transcript:u1", subject: "REVIEWER" } }, catalog), "REVIEWER_SUBJECT");
  assert.equal(rejectedGroundTruthSource({ ...requirement("fake"), source: { ref: "transcript:u1", kind: "PROJECT_FILE" } }, catalog), "SOURCE_KIND_MISMATCH");
});

test("re-verification preserves first closure time and reopening starts a new closure episode", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "closures" });
  const context = { projectRoot: root, taskId: task.taskId };
  const findings = [{ deviationKey: "missing", reason: "Missing behavior.", severity: "error", violatedGroundTruthIds: ["code"] }];
  await recordDeviationFindings({ ...context, pipeline: "STOP", groundTruthVersion: 1, findings });
  await markMetricPassesFixed({ ...context, passedObjectIds: ["code"] });
  const historical = "2000-01-01T00:00:00.000Z";
  await withTaskState(context, (state) => {
    const family = Object.values(state.deviations)[0];
    family.firstFixedAt = historical;
    family.fixedAt = historical;
  });
  await markMetricPassesFixed({ ...context, passedObjectIds: ["code"] });
  let state = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  let family = Object.values(state.deviations)[0];
  assert.equal(family.fixedAt, historical);
  assert.equal(family.firstFixedAt, historical);
  assert.notEqual(family.lastVerifiedAt, historical);
  await recordDeviationFindings({ ...context, pipeline: "STOP", groundTruthVersion: 1, findings });
  await markMetricPassesFixed({ ...context, passedObjectIds: ["code"] });
  state = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  family = Object.values(state.deviations)[0];
  assert.equal(family.firstFixedAt, historical);
  assert.notEqual(family.fixedAt, historical);
});

test("patch failure preserves semantic findings and never masquerades as API failure", () => {
  const result = mergeSemanticReview({ metadata: { triggerFile: "tasks.md" }, diagnostics: [], diffs: [] }, {
    status: "failed", semanticStatus: "completed", patchStatus: "failed", patchError: "expect mismatch",
    findings: [{ ruleId: "COVERAGE", path: "tasks.md", severity: "warning", message: "Missing requirement." }],
    edits: [], diffs: [], summary: "Coverage reviewed.",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.agentReview.status, "completed");
  assert.equal(result.metadata.semanticReview.patchStatus, "failed");
  assert.deepEqual(result.diagnostics.map((item) => item.ruleId), ["COVERAGE", "RUNTIME-PATCH-VALIDATION-FAILED"]);
});

test("reviewer failures retain both output channels while removing credentials", () => {
  const secret = "a-test-secret-do-not-log";
  const detail = reviewerFailureDetail({ stderr: "model warning", stdout: `429 overloaded; token=${secret}` }, { ARK_API_KEY: secret });
  assert.match(detail, /model warning/u);
  assert.match(detail, /429 overloaded/u);
  assert.ok(!detail.includes(secret));
  assert.ok(!reviewerFailureDetail({ stdout: '"authorization":"Bearer opaque-credential-value"' }).includes("opaque-credential-value"));
});

test("policy validation discloses independent-provider fallback without leaking keys", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, ".runtime-corrector"));
  await fs.writeFile(path.join(root, ".runtime-corrector", "config.yaml"), [
    "version: 2", "artifacts: []", "dynamicGroundTruth:", "  enabled: true", "stopCorrection:", "  enabled: true",
    "reviewers:", "  stopReviewer:", "    session: independent",
    "    provider:", "      baseUrl: https://example.invalid", "      apiKeyEnv: TEST_REVIEWER_KEY", "",
  ].join("\n"));
  const missing = await validateProjectPolicy({ cwd: root, env: {} });
  assert.ok(missing.issues.some((issue) => issue.code === "REVIEWER-PROVIDER-UNAVAILABLE"));
  const present = await validateProjectPolicy({ cwd: root, env: { TEST_REVIEWER_KEY: "test-secret-not-real" } });
  assert.ok(!present.issues.some((issue) => issue.code === "REVIEWER-PROVIDER-UNAVAILABLE"));
  assert.ok(!JSON.stringify(present).includes("test-secret-not-real"));
});
