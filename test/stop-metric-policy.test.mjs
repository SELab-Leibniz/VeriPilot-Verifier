import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { METRIC_IDS, DEFAULT_STOP_METRICS, resolveStopReviewPolicy, restrictStopReviewOutput } from "../lib/runtime-v2/metric-policy.mjs";
import { buildMetricPopulation, calculateMetricReport, METRIC_CATALOG } from "../lib/runtime-v2/metrics.mjs";
import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { loadRuntimePlan } from "../lib/runtime-plan.mjs";
import { ensureTask, findTask, taskDirectory, decisionGuard, startCorrectionEpoch, startNewTask } from "../lib/runtime-v2/task-store.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { runImplementationReview } from "../lib/runtime-v2/impl-review.mjs";
import { withTestReviewProof } from "./helpers/review-proof.mjs";

const all = value => Object.fromEntries(METRIC_IDS.map(id => [id, value]));
const defaultsOn = ["M08", "M09", "M12", "M13", "M15", "M16"];
const base = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: true }, stopCorrection: { enabled: true } };
const claim = (id, category, extra = {}) => ({ claimId: id, revisionId: `${id}@1`, category,
  text: `Required ${category} obligation.`, status: "ACTIVE", authority: "USER_EXPLICIT", severity: "HARD",
  verificationTarget: "IMPLEMENTATION", applicability: "CURRENT_TASK", applicabilityKind: "CURRENT_TASK", ...extra });

async function scratch(t) {
  const parent = path.resolve(".runtime-correction/metric-policy-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("Stop defaults enable exactly the requested six metrics and support partial immutable overrides", () => {
  const policy = compileRuntimeV2Config(base).stopCorrection;
  assert.deepEqual(METRIC_IDS.filter(id => policy.metrics[id]), defaultsOn);
  assert.deepEqual(policy.metrics, DEFAULT_STOP_METRICS);
  assert.equal(policy.fileQualityReviewEnabled, false);
  assert(Object.isFrozen(policy.metrics));
  const explicit = resolveStopReviewPolicy({ metrics: { M01: true, M08: false } });
  assert.equal(explicit.metrics.M01, true); assert.equal(explicit.metrics.M08, false); assert.equal(explicit.metrics.M16, true);
  assert.equal(DEFAULT_STOP_METRICS.M08, true);
});

test("project validation accepts all sixteen boolean switches and rejects misspelled or nonboolean values", () => {
  validateProjectConfig({ ...base, stopCorrection: { enabled: true, metrics: all(false), fileQualityReviewEnabled: true } }, "config.yaml");
  for (const metrics of [{ M17: true }, { m08: true }, { M08: "false" }, { M16: 1 }, { M01: null }, [], null, false])
    assert.throws(() => validateProjectConfig({ ...base, stopCorrection: { enabled: true, metrics } }, "config.yaml"), /metrics/u);
  assert.throws(() => resolveStopReviewPolicy({ metrics: { M99: true } }), /known metric/u);
  assert.throws(() => validateProjectConfig({ ...base, stopCorrection: { enabled: true, fileQualityReviewEnabled: "false" } }, "config.yaml"), /fileQualityReviewEnabled/u);
});

test(".runtime-corrector/config.yaml and explicitly provided configuration each inherit missing metric defaults", async t => {
  const root = await scratch(t); await fs.mkdir(path.join(root, ".runtime-corrector"));
  await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), "version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\nstopCorrection:\n  enabled: true\n  metrics:\n    M01: true\n    M09: false\n  fileQualityReviewEnabled: true\n");
  const plan = await loadRuntimePlan({ cwd: root });
  const stop = plan.runtimeV2.stopCorrection;
  assert.equal(stop.metrics.M01, true); assert.equal(stop.metrics.M09, false); assert.equal(stop.metrics.M11, false);
  assert.equal(stop.metrics.M16, true); assert.equal(stop.metrics.M14, false); assert.equal(stop.fileQualityReviewEnabled, true);
  const provided = await loadRuntimePlan({ cwd: root, config: { ...base, stopCorrection: { enabled: true, metrics: { M11: true } } } });
  assert.equal(provided.runtimeV2.stopCorrection.metrics.M11, true);
  assert.equal(provided.runtimeV2.stopCorrection.metrics.M09, true);
});

test("the shipped complete YAML example compiles to the same six defaults", async () => {
  const plan = await loadRuntimePlan({ cwd: path.resolve("examples/stop-metric-switches") });
  assert.deepEqual(plan.runtimeV2.stopCorrection.metrics, DEFAULT_STOP_METRICS);
  assert.equal(plan.runtimeV2.stopCorrection.fileQualityReviewEnabled, false);
});

test("each metric switch changes the frozen population and disabled metrics have no denominator or PASS", async t => {
  const root = await scratch(t), taskId = "matrix";
  const claims = [...new Set(Object.values(METRIC_CATALOG).flatMap(spec => spec.source))]
    .filter(category => category !== "skillConstraints").map((category, index) => claim(`R${index}`, category));
  const truth = { version: 1, digest: "matrix-basis", claims };
  const skillDocuments = [{ skillId: "fixture", version: 1, constraints: [{ constraintId: "S1", modality: "MUST", statement: "Follow the selected step." }] }];
  const full = await buildMetricPopulation({ projectRoot: root, taskId, groundTruth: truth, skillDocuments,
    reviewPolicy: resolveStopReviewPolicy({ metrics: all(true) }) });
  for (const id of METRIC_IDS) assert(full.metrics[id].length > 0, `${id} needs an actual test denominator.`);
  for (const id of METRIC_IDS) {
    const population = await buildMetricPopulation({ projectRoot: root, taskId, groundTruth: truth, skillDocuments,
      reviewPolicy: resolveStopReviewPolicy({ metrics: { ...all(true), [id]: false } }) });
    assert.deepEqual(population.metrics[id], []); assert.notEqual(population.digest, full.digest);
    const report = calculateMetricReport({ population, judgements: [...Object.values(population.metrics).flat()
      .map(object => ({ objectId: object.objectId, judgement: "PASS", reason: "Scripted metric aggregate witness", evidence: [] })),
      { objectId: full.metrics[id][0].objectId, judgement: "DEVIATION", reason: "Stale disabled judgement", evidence: [] }] });
    const metric = report.metrics.find(metric => metric.metricId === id);
    assert.equal(metric.status, "DISABLED"); assert.equal(metric.denominator, 0); assert.equal(metric.value, null);
    assert.deepEqual(report.blockingObjects, []); assert.equal(report.status, "PASS");
    assert.equal(report.ignoredMetricJudgements.length, 1);
  }
  assert.deepEqual(calculateMetricReport({ population: full, metricIds: [] }).metrics, [], "An explicit empty selection must not expand to all metrics.");
});

test("disabled duties are not reassigned; only disabled output is ignored, with foreign enabled identities still rejected downstream", async t => {
  const root = await scratch(t), population = await buildMetricPopulation({ projectRoot: root, taskId: "disabled",
    groundTruth: { version: 1, claims: [claim("STD", "developmentStandards"), claim("WF", "workflowSteps", { verificationTarget: "PROCESS" }), claim("REQ", "requirements")] },
    reviewPolicy: resolveStopReviewPolicy({ metrics: { M09: false, M11: false } }) });
  assert(!population.metrics.M12.some(row => row.sourceId === "STD"));
  const result = restrictStopReviewOutput({ metricObjectJudgements: [{ objectId: "M11:WF", judgement: "DEVIATION" }, { objectId: "M99:FOREIGN", judgement: "PASS" }],
    findings: [{ violatedGroundTruthIds: ["WF"] }, { violatedGroundTruthIds: ["WF", "REQ"] }, { violatedGroundTruthIds: ["FOREIGN"] }], fileAssessments: [{ status: "DEVIATION" }] }, population, { includeIgnored: true });
  assert.deepEqual(result.metricObjectJudgements.map(row => row.objectId), ["M99:FOREIGN"]);
  assert.deepEqual(result.findings.map(row => row.violatedGroundTruthIds), [["REQ"], ["FOREIGN"]]);
  assert.deepEqual(result.fileAssessments, []); assert.equal(result.ignoredFindings.length, 1);
  const sourceOnly = restrictStopReviewOutput({ summary: "Source-only result", findings: [], metricObjectJudgements: [] }, population);
  assert.equal(Object.hasOwn(sourceOnly, "fileAssessments"), false, "The source-review schema must not acquire Stop-only result fields.");
  const malformed = restrictStopReviewOutput({ findings: null }, population);
  assert.equal(malformed.findings, null);
  assert.equal(Object.hasOwn(malformed, "metricObjectJudgements"), false, "Scope filtering must not repair malformed active review output into PASS.");
});

async function stopFixture(t, switches = {}, options = {}) {
  const root = await scratch(t), sessionId = "policy-host", calls = [], task = await ensureTask({ projectRoot: root, sessionId });
  await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, "src/main.js"), "export const run = input => input;\n");
  await fs.writeFile(path.join(root, "delivery.md"), "Current delivery.\n");
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [
    ["requirements", "Implement the requested input flow.", "IMPLEMENTATION"],
    ["developmentStandards", "Use the prescribed development convention.", "IMPLEMENTATION"],
    ["workflowSteps", "Follow the prescribed operation order.", "PROCESS"],
    ["acceptanceCriteria", "Complete the original acceptance check.", "PROCESS"],
    ["milestoneTargets", "Complete the milestone.", "PROCESS"],
    ["criticalJourneys", "Complete the critical journey.", "PROCESS"],
  ].map(([category, text, verificationTarget]) => ({ operation: "ADD", category, text, verificationTarget,
    authority: "USER_EXPLICIT", severity: "HARD", applicabilityKind: "CURRENT_TASK", applicability: "CURRENT_TASK",
    source: { ref: "user:1", kind: "USER_MESSAGE", subject: "MAIN_TASK" } })) } });
  const transcript = path.join(root, "transcript.jsonl");
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "user:1", message: { content: "Implement the requested input flow." } }) + "\n");
  const factory = async input => {
    calls.push(input);
    const frame = { stopClassification: "TASK_COMPLETE", stage: null };
    if (input.request.reviewScope?.kind === "classification") return { result: { ...frame, summary: "Delivery checkpoint", findings: [], metricObjectJudgements: [] }, close() {} };
    const objects = Object.values(input.request.population.metrics).flat();
    const quality = input.request.reviewScope?.kind === "file-quality", target = input.request.reviewScope?.qualityTarget;
    const result = { summary: "Assigned fixture scope checked", ...frame, findings: [],
      fileAssessments: quality ? [{ path: target?.path ?? "delivery.md", status: "PASS", reason: "Current file checked", evidence: ["delivery.md#L1"] }] : [],
      metricObjectJudgements: objects.map(object => ({ objectId: object.objectId, judgement: object.metricId === "M11" ? "DEVIATION" : "PASS",
        reason: "Scripted source/process transport witness", evidence: ["src/main.js#L1"] })) };
    return withTestReviewProof(input, { result, close() {} });
  };
  factory.supportsReviewCollection = true; factory.supportsSupplementalFileAssessment = true;
  factory.reviewItemSize = 1; factory.singleReviewMetrics = METRIC_IDS;
  const makePlan = metrics => ({ artifacts: [{ nodeId: "delivery", patterns: ["delivery.md"], metrics: ["M12"] }],
    runtimeV2: compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: options.dynamic ?? false, panel: { size: 2 } },
      skillCorrection: { enabled: false }, implementationCorrection: { enabled: options.implementation ?? false, platform: null },
      stopCorrection: { enabled: true, metrics, fileQualityReviewEnabled: options.quality ?? false } }, { policyRoot: path.join(root, ".runtime-corrector") }) });
  let turn = 0;
  const run = async (plan = makePlan(switches), reviewer = factory) => {
    const current = await findTask({ projectRoot: root, sessionId });
    return handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory: reviewer,
      deviceVerifier: () => assert.fail("No disabled implementation/device duty may execute."),
      assessmentContext: { mode: "execute_and_correct", assessmentId: `policy-${++turn}`, guard: decisionGuard(current) },
      input: { cwd: root, session_id: sessionId, transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "Task complete.", hook_event_id: `stop-${turn}` } });
  };
  return { root, sessionId, task, calls, run, makePlan, factory };
}

test("default Stop only dispatches enabled metrics and no independent file quality", async t => {
  const f = await stopFixture(t), result = await f.run();
  const ids = f.calls.flatMap(c => Object.values(c.request.population.metrics).flat().map(o => o.metricId));
  assert.deepEqual([...new Set(ids)].sort(), ["M09", "M12", "M13", "M15", "M16"]);
  assert(!f.calls.some(c => c.request.reviewScope?.kind === "file-quality"));
  assert.equal(result.decision, "allow");
  assert.equal(result.stop.report.metrics.find(m => m.metricId === "M11").status, "DISABLED");
});

for (const collection of [false, true]) test(`${collection ? "collected" : "legacy"} Stop cannot revive disabled workflow judgements, findings or file quality`, async t => {
  const f = await stopFixture(t);
  await fs.writeFile(path.join(f.root, "src/main.js"), "export const run = input => input;\n// fixture source witness 2\n// fixture source witness 3\n// fixture source witness 4\n// fixture source witness 5\n// fixture source witness 6\n");
  const truth = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), "ground-truth/current.json"), "utf8"));
  const workflowId = truth.claims.find(claim => claim.category === "workflowSteps").claimId;
  const reviewer = async input => {
    const handle = await f.factory(input);
    if (input.request.reviewScope?.kind === "classification") return handle;
    handle.result.metricObjectJudgements = handle.result.metricObjectJudgements.map((row, index) => ({ ...row, evidence: [`src/main.js#L${index + 1}`] }));
    handle.result.metricObjectJudgements.push({ objectId: `M11:${workflowId}`, judgement: "DEVIATION", reason: "Disabled workflow result", evidence: ["src/main.js#L6"] });
    handle.result.findings.push({ deviationKey: "disabled-workflow", rootCauseId: "REQUIREMENT_OMITTED", severity: "error",
      reason: "Disabled workflow finding", actualEvidence: ["src/main.js#L6"], expectedConstraint: "An intentionally disabled view", violatedGroundTruthIds: [workflowId] });
    handle.result.fileAssessments = [{ path: "delivery.md", status: "DEVIATION", reason: "Unrequested file-quality result", evidence: ["delivery.md#L1"] }];
    return handle;
  };
  reviewer.supportsReviewCollection = collection; reviewer.handoff = reviewer; reviewer.reviewItemSize = 1;
  reviewer.singleReviewMetrics = METRIC_IDS;
  const result = await f.run(undefined, reviewer);
  assert.equal(result.decision, "allow"); assert.equal(result.stop.report.status, "PASS");
  assert.deepEqual(result.stop.review.findings, []); assert.deepEqual(result.stop.review.fileAssessments, []);
  assert(!result.stop.review.metricObjectJudgements.some(row => row.objectId.startsWith("M11:")));
});

test("all-off skips extractor/classifier/review/device work and records DISABLED instead of PASS", async t => {
  const f = await stopFixture(t, all(false), { dynamic: true, implementation: true });
  const result = await f.run(undefined, () => assert.fail("All Stop duties are disabled: no model call is allowed."));
  assert.equal(result.decision, "allow"); assert.equal(result.stop.status, "DISABLED");
  assert(result.stop.report.metrics.every(metric => metric.status === "DISABLED"));
  const task = await findTask({ projectRoot: f.root, sessionId: f.sessionId });
  assert.equal(task.verification.status, "DISABLED"); assert.equal(task.stop.correctionAttempts, 0);
});

test("explicit quality-only Stop dispatches its file duty without re-enabling M metrics", async t => {
  const f = await stopFixture(t, all(false), { quality: true });
  const result = await f.run();
  assert.equal(f.calls.filter(c => c.request.reviewScope?.kind === "file-quality").length, 1);
  assert.equal(f.calls.flatMap(c => Object.values(c.request.population.metrics).flat()).length, 0);
  assert(result.stop.report.metrics.every(metric => metric.status === "DISABLED"));
  assert.equal(result.stop.report.status, "PASS");
});

test("metric selection is frozen across corrections and epochs; a new task can use a new selection", async t => {
  const f = await stopFixture(t, { M11: true });
  const first = await f.run();
  assert.equal(first.decision, "block");
  assert(first.stop.report.metrics.find(metric => metric.metricId === "M11").objects.some(object => object.judgement === "DEVIATION"));
  assert.equal((await f.run(f.makePlan(all(false)))).decision, "block", "An agent cannot disable its failing check through config.");
  await startCorrectionEpoch({ projectRoot: f.root, taskId: f.task.taskId, reason: "REQUIREMENT_CHANGE" });
  assert.equal((await f.run(f.makePlan(all(false)))).decision, "block");
  const task = await findTask({ projectRoot: f.root, sessionId: f.sessionId });
  assert.equal(task.stop.reviewPolicy.metrics.M11, true);
  const fresh = await startNewTask({ projectRoot: f.root, sessionId: f.sessionId });
  assert.notEqual(fresh.taskId, f.task.taskId);
  const previousCalls = f.calls.length;
  assert.equal((await f.run(f.makePlan(all(false)))).stop.status, "DISABLED");
  assert.equal(f.calls.length, previousCalls);
});

test("M16-only source review needs no process payload, duplicate implementation review or kit/device scan", async t => {
  const f = await stopFixture(t, { ...all(false), M16: true }, { implementation: true });
  const result = await f.run();
  const jobs = f.calls.filter(c => c.request.reviewScope?.kind !== "classification");
  assert.equal(jobs.length, 1); assert.equal(jobs[0].request.population.metrics.M16.length, 1);
  assert.deepEqual(jobs[0].request.processToolEvidence, []);
  assert(jobs[0].request.sourceManifest.some(file => file.path === "src/main.js"));
  const task = await findTask({ projectRoot: f.root, sessionId: f.sessionId });
  const evaluation = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, task.taskId), "evaluations", `${task.stop.lastAssessmentId}.json`), "utf8"));
  assert.equal(evaluation.implementationReview.skipReason, "NO_ENABLED_IMPLEMENTATION_OBJECTS");
});

test("implementation entry itself skips all disabled source duties before probing any platform", async t => {
  const policy = resolveStopReviewPolicy({ metrics: all(false) });
  const result = await runImplementationReview({ projectRoot: "not-a-project", taskId: "none", runtimeV2: {},
    population: { metrics: {}, reviewPolicy: policy }, reviewerFactory: () => assert.fail("No reviewer"), deviceVerifier: () => assert.fail("No device probe") });
  assert.equal(result.skipReason, "NO_ENABLED_IMPLEMENTATION_OBJECTS");
});
