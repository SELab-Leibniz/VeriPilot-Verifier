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
  const inputs = [...Object.keys(METRIC_CATALOG).map(metric => f.makeInput(metric, "stop-reviewer", metric === "M16" ? "IMPLEMENTATION" : "ARTIFACT")),
    f.makeInput("M09", "implementation-reviewer", "IMPLEMENTATION"), f.makeInput("M12", "implementation-reviewer", "IMPLEMENTATION"),
    f.makeInput("M16", "implementation-reviewer", "IMPLEMENTATION"),
    f.makeInput("M12", "stop-reviewer", "IMPLEMENTATION")];
  for (const input of inputs) {
    input.deadlineAt = parentDeadline + 1000;
    await factory(input);
  }
  assert.equal(captures.length, inputs.length); assert.equal(nativeCalls, 0);
  for (const value of captures) {
    assert.equal(value.input.reviewer.maxOutputTokens, 32768);
    assert.equal(value.input.deadlineAt, parentDeadline);
    assert.equal(value.input.abortSignal, controller.signal);
    assert.equal(value.transport.selection.provider, "fixture");
    assert.equal(value.transport.selection.model, "model");
  }
  const earlier = f.makeInput(); earlier.deadlineAt = parentDeadline - 1000;
  earlier.reviewer.maxOutputTokens = 49152;
  await factory(earlier);
  assert.equal(captures.at(-1).input.deadlineAt, earlier.deadlineAt);
  assert.equal(captures.at(-1).input.reviewer.maxOutputTokens, 32768);
  controller.abort();
  assert.ok(captures.every(value => value.input.abortSignal.aborted));
});


test('default and legacy native settings both dispatch Stop directly to task', async t => {
  const f = await fixture(t);
  for (const stopReviewEngine of [undefined, 'task', 'native']) {
    let taskCalls = 0;
    const factory = createOpenClawReviewerFactory(f.api, { stopReviewEngine,
      runStopTask: async input => { taskCalls++; assert.equal(input.taskLimits.maxTurns, 200); assert.equal(input.taskLimits.maxTokens, 32768); return { result: report() }; },
      runEmbeddedAgent: () => assert.fail('No legacy Stop execution') });
    await factory(f.makeInput()); assert.equal(taskCalls, 1); assert.equal(factory.supportsStopGroups, true);
  }
});

test('task item cancellation remains linked to the enclosing factory owner', async t => {
  const f = await fixture(t), owner = new AbortController(), item = new AbortController();
  let child, entered; const ready = new Promise(resolve => { entered = resolve; });
  const factory = createOpenClawReviewerFactory(f.api, { abortSignal: owner.signal,
    runStopTask: async input => { child = input.abortSignal; entered(); await new Promise(resolve => child.addEventListener('abort', resolve, { once: true })); child.throwIfAborted(); },
    runEmbeddedAgent: () => assert.fail('No native fallback') });
  const work = factory({ ...f.makeInput(), abortSignal: item.signal }); void work.catch(() => {});
  await ready; item.abort(new Error('Item cancelled')); await assert.rejects(work, /Item cancelled/);
  assert(child.aborted); assert.equal(owner.signal.aborted, false);
});

test('file UNVERIFIED may lack citations, while conclusive report files require evidence', () => {
  for (const status of ['UNVERIFIED', 'PASS', 'DEVIATION']) {
    const result = { ...report(), fileAssessments: [{ path: 'kitchen.py', status, reason: 'Unestablished proof', evidence: [] }] };
    assert.equal(reviewResultIssues(result, STOP_REVIEW_SCHEMA).length > 0, status !== 'UNVERIFIED');
  }
});

test('all supported worker types dispatch explicitly and unsupported scopes never fall into native', async t => {
  const f = await fixture(t), seen = [];
  const factory = createOpenClawReviewerFactory(f.api, { runStopTask: async input => { seen.push(input.workerType); return { result: report() }; },
    runEmbeddedAgent: () => assert.fail('No legacy Stop path') });
  const classification = f.makeInput(); classification.request.reviewScope.kind = 'classification';
  const stage = f.makeInput(); stage.request.fixedStopClassification = { stopClassification: 'STAGE_COMPLETE', stage: 'design' };
  const findings = f.makeInput(); findings.request.fixedStopClassification = { stopClassification: 'WAITING_FOR_USER', stage: null }; findings.request.reviewScope.findingsOnly = true;
  for (const input of [classification, stage, findings]) await factory(input);
  assert.deepEqual(seen, ['classification', 'review', 'findings']);
  const pending = f.makeInput(); pending.request.population.metrics.M01[0].authority = 'BASIS_PENDING';
  const conditional = f.makeInput(); conditional.request.population.metrics.M01[0].applicability = 'IF_DEPLOYED';
  for (const input of [pending, conditional, f.makeInput('M99')]) await assert.rejects(factory(input), { code: 'STOP_TASK_SCOPE_UNSUPPORTED' });
  assert.equal(seen.length, 3);
});

test('factory cache identity uses the sole task protocol and all metric profiles', async t => {
  const f = await fixture(t), factory = createOpenClawReviewerFactory(f.api);
  assert.deepEqual(factory.singleReviewMetrics, Object.keys(METRIC_CATALOG));
  assert.equal(factory.supportsSupplementalFileAssessment, true);
  for (const stopReviewEngine of ['task', 'native']) assert.equal(factory.reviewCacheIdentity(), createOpenClawReviewerFactory(f.api, { stopReviewEngine }).reviewCacheIdentity());
  assert.notEqual(factory.reviewCacheIdentity({ maxOutputTokens: 32768 }), factory.reviewCacheIdentity({ maxOutputTokens: 65536 }));
  const promptBytes = await fs.readFile(new URL('../lib/review-task/prompts.json', import.meta.url));
  assert.equal(REVIEW_PROMPT_PROFILE_DIGEST, createHash('sha256').update(promptBytes).digest('hex'));
});
for (const supplemental of [false, true]) test(`the canonical Stop wrapper preserves cache identity and ${supplemental ? "isolates enabled" : "skips disabled"} file quality`, async t => {
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
      assert.ok(input.request.instructions.some(line => line.includes("current delivery file")));
      assert.equal(input.schema.properties.metricObjectJudgements.maxItems, 0);
    } else assert.equal(input.request.instructions.some(line => line.includes("current delivery file")), false);
    const qualityPath=input.request.reviewScope.qualityTarget?.path;
    const citation = await observedFileCitation({ file, basisFiles: [input.request.groundTruthPath],
      usedBy: quality ? [qualityPath] : assigned.map(object => object.objectId) });
    return { result: { summary: "The checked current source supports this item.", ...input.request.fixedStopClassification, findings: [],
      fileAssessments: quality ? [{ path: qualityPath, status: "PASS", reason: "Current requested file quality is supported.", evidence: [citation.selection] }] : [],
      metricObjectJudgements: assigned.map(object => ({ objectId: object.objectId, judgement: "PASS", reason: "The checked current candidate matches.", evidence: [citation.selection] })) },
      sourceCitations: [citation],
      reviewEvidence: { files: [file], fingerprints: { [file]: sha256(await fs.readFile(file)) }, unstable: false, missing: [] }, close: async () => {} };
  };
  factory.supportsReviewCollection = true; factory.reviewItemSize = 1;
  factory.supportsSupplementalFileAssessment = supplemental;
  factory.singleReviewMetrics = Object.keys(METRIC_CATALOG);
  factory.reviewCacheIdentity = () => { identityCalls++; return "canonical-scripted-task-runtime-v1"; };
  const config = compileRuntimeV2Config({ version: 2, locale: "en", dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false }, implementationCorrection: { enabled: false }, stopCorrection: { enabled: true, fileQualityReviewEnabled: supplemental } },
    { policyRoot: path.join(f.root, ".runtime-corrector") });
  const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), "task.json"), "utf8"));
  const result = await handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2: config,artifacts:[{nodeId:'spec',patterns:['spec.md'],metrics:['M12']}] }, reviewerFactory: factory,
    assessmentContext: { mode: "verify_only", assessmentId: "canonical-factory-check", guard: decisionGuard(state), deadlineAt: Date.now() + 30000, maxCorrections: 1 },
    input: { cwd: f.root, session_id: "factory-host", transcript_path: transcript, hook_event_name: "Stop", hook_event_id: "canonical-stop",
      last_assistant_message: "The delivery is complete." } });
  assert.ok(identityCalls > 0, "The orchestrator wrapper must forward runtime identity to PASS reuse.");
  assert.equal(qualityCalls, supplemental ? 1 : 0, "The canonical wrapper must forward the supplemental capability.");
  assert.ok(itemCalls > 0); assert.equal(result.stop.report.status, "PASS");
});
