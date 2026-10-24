import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { REVIEW_PROMPT_PROFILE_DIGEST } from "../lib/review-task/prompt-profile.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { ensureTask, taskDirectory, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { STOP_REVIEW_SCHEMA, reviewResultIssues } from "../lib/runtime-v2/reviewer.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { METRIC_CATALOG } from "../lib/runtime-v2/metrics.mjs";
import { observedFileCitation } from "./helpers/observed-review.mjs";

const report = () => ({ summary: "Scripted native review.", stopClassification: "TASK_COMPLETE", stage: null, findings: [], metricObjectJudgements: [] });
const row = (metric = "M01", target = "ARTIFACT") => ({ objectId: `${metric}:R1`, sourceId: "R1", sourceRevisionId: "R1@1",
  metricId: metric, description: "Acknowledge the current delivery.", authority: "USER_EXPLICIT", hard: true,
  applicability: "CURRENT_TASK", verificationTarget: target });

async function fixture(t) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-task-factory-test-runs/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "factory-host" });
  const groundTruth = { version: 1, digest: "factory-truth", claims: [{ claimId: "R1", revisionId: "R1@1", category: "requirements",
    text: "Acknowledge the current delivery.", authority: "USER_EXPLICIT", status: "ACTIVE", severity: "HARD", verificationTarget: "ARTIFACT" }] };
  const groundTruthPath = path.join(taskDirectory(root, task.taskId), "ground-truth/current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(groundTruth));
  const api = { rootDir: path.resolve("."), config: { agents: { defaults: { model: { primary: "fixture/model" } } },
    models: { providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", models: [
      { id: "model", contextWindow: 204800, maxTokens: 8192, input: ["text"] },
    ] } } } }, logger: { warn() {}, info() {}, error() {} }, runtime: { version: "2026.7.1-2", agent: {} } };
  const makeInput = (metric = "M01", role = "stop-reviewer", target = "ARTIFACT") => {
    const object = row(metric, target), population = { metrics: { [metric]: [object] } };
    return { projectRoot: root, taskId: task.taskId, role, schema: STOP_REVIEW_SCHEMA, reviewer: { timeoutMs: 10000, formatRepairAttempts: 0 },
      request: { groundTruthPath, population, fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: null },
        reviewScope: { objectIds: [object.objectId], sourceIds: ["R1"] } }, evidence: { groundTruth, population, snapshot: { entries: [] } } };
  };
  return { root, task, api, makeInput };
}

test("task-mode factory dispatches only eligible metric scopes with the selected model and inherited deadline/signal", async t => {
  const f = await fixture(t), controller = new AbortController(), captures = [];
  const parentDeadline = Date.now() + 6000;
  let nativeCalls = 0;
  const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine: "task", deadlineAt: parentDeadline, abortSignal: controller.signal,
    reviewerTimeoutMs: 15000, runEmbeddedAgent: async () => { nativeCalls++; throw new Error("Eligible work must not use native JSON review."); },
    runStopTask: async (input, transport) => { captures.push({ input, transport }); return { result: report(), close: async () => {} }; } });
  const inputs = [...Object.keys(METRIC_CATALOG).map(metric => f.makeInput(metric)),
    f.makeInput("M09", "implementation-reviewer", "IMPLEMENTATION"), f.makeInput("M12", "implementation-reviewer", "IMPLEMENTATION"),
    f.makeInput("M12", "stop-reviewer", "IMPLEMENTATION")];
  for (const input of inputs) {
    input.deadlineAt = parentDeadline + 1000;
    await factory(input);
  }
  assert.equal(captures.length, inputs.length); assert.equal(nativeCalls, 0);
  for (const value of captures) {
    assert.equal(value.input.deadlineAt, parentDeadline);
    assert.equal(value.input.abortSignal, controller.signal);
    assert.equal(value.transport.selection.provider, "fixture");
    assert.equal(value.transport.selection.model, "model");
  }
  const earlier = f.makeInput(); earlier.deadlineAt = parentDeadline - 1000;
  await factory(earlier);
  assert.equal(captures.at(-1).input.deadlineAt, earlier.deadlineAt);
  controller.abort();
  assert.ok(captures.every(value => value.input.abortSignal.aborted));
});

test("native-only direct factory use remains the default even for a task-eligible obligation", async t => {
  const f = await fixture(t); let taskCalls = 0, nativeCalls = 0;
  const factory = createOpenClawReviewerFactory(f.api, {
    runStopTask: async () => { taskCalls++; throw new Error("Task mode was not enabled."); },
    runEmbeddedAgent: async () => { nativeCalls++; return { payloads: [{ text: JSON.stringify(report()) }], meta: {} }; },
  });
  const handle = await factory(f.makeInput());
  await handle.close();
  assert.equal(nativeCalls, 1); assert.equal(taskCalls, 0);
  assert.equal(factory.reviewItemSize, undefined);
  assert.equal(factory.supportsSupplementalFileAssessment, undefined);
});

test("native fallback honors an item cancellation as well as its factory owner", async t => {
  const f = await fixture(t), owner = new AbortController(), item = new AbortController();
  let entered, childSignal;
  const ready = new Promise(resolve => { entered = resolve; });
  const factory = createOpenClawReviewerFactory(f.api, { abortSignal: owner.signal,
    runEmbeddedAgent: async params => {
      childSignal = params.abortSignal; entered();
      await new Promise(resolve => childSignal.addEventListener("abort", resolve, { once: true }));
      childSignal.throwIfAborted();
    } });
  const work = factory({ ...f.makeInput(), abortSignal: item.signal });
  void work.catch(() => {});
  try {
    await ready;
    item.abort(new Error("Only this review item was cancelled."));
    assert.equal(childSignal.aborted, true);
  } finally { owner.abort(); await work.catch(() => {}); }
});

test("SDK item signal cannot detach the enclosing factory cancellation", async t => {
  const f = await fixture(t), owner = new AbortController(), item = new AbortController();
  let signal;
  const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine: "task", abortSignal: owner.signal,
    runEmbeddedAgent: async () => { throw new Error("No native calls expected"); },
    runStopTask: async input => { signal = input.abortSignal; return { result: report() }; } });
  await factory({ ...f.makeInput(), abortSignal: item.signal });
  owner.abort(new Error("The enclosing Stop ended."));
  assert.equal(signal.aborted, true);
  assert.equal(item.signal.aborted, false);
});

test("file UNVERIFIED may have no citations, but both native and CLI result validation reject unproved conclusive files", async t => {
  for (const status of ["UNVERIFIED", "PASS", "DEVIATION"]) await t.test(status, async t => {
    const f = await fixture(t), result = { ...report(), fileAssessments: [
      { path: "kitchen.py", status, reason: "The file's required proof has not been established.", evidence: [] },
    ] };
    assert.equal(reviewResultIssues(result, STOP_REVIEW_SCHEMA).length > 0, status !== "UNVERIFIED");
    const factory = createOpenClawReviewerFactory(f.api, { runEmbeddedAgent: async () => ({
      payloads: [{ text: JSON.stringify(result) }], meta: {},
    }) });
    const input = f.makeInput();
    if (status === "UNVERIFIED") {
      const handle = await factory(input);
      assert.deepEqual(handle.result.fileAssessments[0].evidence, []);
      await handle.close();
    } else await assert.rejects(factory(input), /conclusive file assessment requires source evidence/iu);
  });
});

test("native classification does not receive the collector's potentially large candidate inventory", async t => {
  const f = await fixture(t), input = f.makeInput();
  input.request.population = { metrics: {} };
  input.request.reviewScope = { kind: "classification", boundedBasis: true, objectIds: [], sourceIds: [] };
  input.request.artifactCandidates = [{ artifactId: "source", metricIds: [], files: Array.from({ length: 2000 }, (_, index) => ({
    path: `source/feature-${index}.py`, sha256: "a".repeat(64),
  })) }];
  let prepared;
  input.onPrepared = value => { prepared = value.request; };
  const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine: "task", runEmbeddedAgent: async () => ({
    payloads: [{ text: JSON.stringify(report()) }], meta: {},
  }) });
  const handle = await factory(input);
  assert.equal(Object.hasOwn(prepared, "artifactCandidates"), false);
  assert.equal(input.request.artifactCandidates[0].files.length, 2000, "Program ownership/cache input remains intact.");
  await handle.close();
});

test("task mode preserves native fallback for unresolved ownership, classifier and stage/intermediate work", async t => {
  const f = await fixture(t); let taskCalls = 0, nativeCalls = 0;
  const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine: "task",
    runStopTask: async () => { taskCalls++; throw new Error("A legacy scope cannot use the task worker."); },
    runEmbeddedAgent: async () => { nativeCalls++; return { payloads: [{ text: JSON.stringify(report()) }], meta: {} }; },
  });
  const classifier = f.makeInput(); classifier.request.reviewScope.kind = "classification";
  const stage = f.makeInput(); stage.request.fixedStopClassification = { stopClassification: "STAGE_COMPLETE", stage: "design" };
  const intermediate = f.makeInput(); intermediate.request.fixedStopClassification = { stopClassification: "INTERMEDIATE", stage: null };
  const conditional = f.makeInput(); conditional.request.population.metrics.M01[0].applicability = "IF_DEPLOYED";
  const pending = f.makeInput(); pending.request.population.metrics.M01[0].authority = "BASIS_PENDING";
  const quality = f.makeInput(); quality.request.population.metrics.M01 = [];
  quality.request.reviewScope = { kind: "file-quality", boundedBasis: true, objectIds: [], sourceIds: ["R1"] };
  const inputs = [f.makeInput("M99"), f.makeInput("M12", "implementation-reviewer", "PROCESS"), conditional, pending,
    classifier, stage, intermediate, quality];
  for (const input of inputs) { const handle = await factory(input); await handle.close(); }
  assert.equal(taskCalls, 0); assert.equal(nativeCalls, inputs.length);
});

test("task factory cache identity is distinct from native identity and uses a frozen profile version", async t => {
  const f = await fixture(t);
  const native = createOpenClawReviewerFactory(f.api), task = createOpenClawReviewerFactory(f.api, { stopReviewEngine: "task" });
  const sameTask = createOpenClawReviewerFactory(f.api, { stopReviewEngine: "task" });
  assert.equal(task.reviewItemSize, 1);
  assert.deepEqual(task.singleReviewMetrics, Object.keys(METRIC_CATALOG));
  assert.equal(task.supportsSupplementalFileAssessment, true);
  assert.notEqual(task.reviewCacheIdentity({}), native.reviewCacheIdentity({}));
  assert.equal(task.reviewCacheIdentity({}), sameTask.reviewCacheIdentity({}));
  const promptBytes = await fs.readFile(new URL("../lib/review-task/prompts.json", import.meta.url));
  assert.equal(REVIEW_PROMPT_PROFILE_DIGEST, createHash("sha256").update(promptBytes).digest("hex"));
});

for (const supplemental of [false, true]) test(`the canonical Stop wrapper preserves cache identity and ${supplemental ? "isolates" : "inlines"} file quality`, async t => {
  const f = await fixture(t);
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: { operations: [
    { operation: "ADD", category: "requirements", text: "Deliver an acknowledged result.", authority: "USER_EXPLICIT", severity: "HARD",
      verificationTarget: "ARTIFACT", source: { ref: "user:1", kind: "USER_MESSAGE", subject: "MAIN_TASK" } },
  ] } });
  const file = path.join(f.root, "spec.md"); await fs.writeFile(file, "The current candidate is acknowledged.\n");
  const transcript = path.join(f.root, "transcript.jsonl");
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "user:1", message: { content: "Deliver an acknowledged result." } }) + "\n");
  let identityCalls = 0, itemCalls = 0, qualityCalls = 0;
  const factory = async input => {
    itemCalls++;
    const assigned = Object.values(input.request.population.metrics).flat();
    const quality = input.request.reviewScope.kind === "file-quality";
    assert.equal(assigned.length, quality ? 0 : 1);
    if (quality) {
      qualityCalls++;
      assert.ok(input.request.instructions.some(line => line.includes("For each requested deliverable file")));
      assert.equal(input.schema.properties.metricObjectJudgements.maxItems, 0);
    } else assert.equal(input.request.instructions.some(line => line.includes("For each requested deliverable file")), !supplemental);
    const citation = await observedFileCitation({ file, basisFiles: [input.request.groundTruthPath],
      usedBy: quality ? [file] : assigned.map(object => object.objectId) });
    return { result: { summary: "The checked current source supports this item.", ...input.request.fixedStopClassification, findings: [],
      fileAssessments: quality ? [{ path: file, status: "PASS", reason: "Current requested file quality is supported.", evidence: [citation.selection] }] : [],
      metricObjectJudgements: assigned.map(object => ({ objectId: object.objectId, judgement: "PASS", reason: "The checked current candidate matches.", evidence: [citation.selection] })) },
      sourceCitations: [citation],
      reviewEvidence: { files: [file], fingerprints: { [file]: sha256(await fs.readFile(file)) }, unstable: false, missing: [] }, close: async () => {} };
  };
  factory.supportsReviewCollection = true; factory.reviewItemSize = 1;
  factory.supportsSupplementalFileAssessment = supplemental;
  factory.singleReviewMetrics = Object.keys(METRIC_CATALOG);
  factory.reviewCacheIdentity = () => { identityCalls++; return "canonical-scripted-task-runtime-v1"; };
  const config = compileRuntimeV2Config({ version: 2, locale: "en", dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false }, implementationCorrection: { enabled: false }, stopCorrection: { enabled: true } },
    { policyRoot: path.join(f.root, ".runtime-corrector") });
  const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), "task.json"), "utf8"));
  const result = await handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2: config }, reviewerFactory: factory,
    assessmentContext: { mode: "verify_only", assessmentId: "canonical-factory-check", guard: decisionGuard(state), deadlineAt: Date.now() + 30000, maxCorrections: 1 },
    input: { cwd: f.root, session_id: "factory-host", transcript_path: transcript, hook_event_name: "Stop", hook_event_id: "canonical-stop",
      last_assistant_message: "The delivery is complete." } });
  assert.ok(identityCalls > 0, "The orchestrator wrapper must forward runtime identity to PASS reuse.");
  assert.equal(qualityCalls, supplemental ? 1 : 0, "The canonical wrapper must forward the supplemental capability.");
  assert.ok(itemCalls > 0); assert.equal(result.stop.report.status, "PASS");
});
