import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { METRIC_IDS } from "../lib/runtime-v2/config.mjs";
import { buildMetricPopulation, calculateMetricReport, METRIC_CATALOG, METRIC_CATALOG_VERSION } from "../lib/runtime-v2/metrics.mjs";
import { implementationPopulation } from "../lib/runtime-v2/review-routing.mjs";
import { reviewProofOwners, validateReviewJudgement } from "../lib/runtime-v2/review-result-validation.mjs";
import { canUseStopTaskReview, runStopTaskReview } from "../lib/runtime-v2/stop-task-review.mjs";
import { collectArtifactCandidates } from "../lib/runtime-v2/artifact-candidates.mjs";
import { validateJsonSchema } from "../lib/json-schema-validator.mjs";
import { reviewPromptProfile } from "../lib/review-task/prompt-profile.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { observedTaskResult } from "./helpers/observed-review.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { ensureTask, taskDirectory, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { collectSourceManifest } from "../lib/runtime-v2/impl-review.mjs";

const claim = (claimId, category = "requirements", extra = {}) => ({
  claimId, revisionId: `${claimId}@1`, category, text: "Persist submitted entries through the production save path.",
  authority: "USER_EXPLICIT", severity: "HARD", status: "ACTIVE", verificationTarget: "IMPLEMENTATION",
  applicability: "CURRENT_TASK", applicabilityKind: "CURRENT_TASK", ...extra,
});
async function fixture(t, claims = [claim("R1"), claim("S1", "inScope")]) {
  const scratch = path.resolve(".runtime-correction/m16-tests");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "m16", truth = { version: 1, claims, digest: sha256(claims) };
  const population = await buildMetricPopulation({ projectRoot: root, taskId, groundTruth: truth });
  return { root, taskId, truth, population };
}

test("M16 freezes requirements and implementation scope without counting docs, process, inactive or pending claims", async t => {
  const f = await fixture(t, [claim("R1"), claim("S1", "inScope"),
    claim("D1", "requirements", { verificationTarget: "ARTIFACT" }),
    claim("P1", "inScope", { verificationTarget: "PROCESS" }),
    claim("OLD", "requirements", { status: "SUPERSEDED" }),
    claim("Q1", "openQuestions", { authority: "BASIS_PENDING", severity: "SOFT" }),
    claim("OUT", "outOfScope"), claim("LEGACY", "requirements", { verificationTarget: undefined }),
  ]);
  assert.deepEqual(METRIC_IDS, Object.keys(METRIC_CATALOG));
  assert.equal(f.population.catalogVersion, METRIC_CATALOG_VERSION);
  assert.equal(f.population.metricCatalog.M16.earliestPhase, "IMPLEMENTATION");
  assert.deepEqual(f.population.metrics.M16.map(row => row.sourceId), ["R1", "S1", "LEGACY"]);
  assert(f.population.metrics.M16.every(row => row.evidenceRequired && row.verificationTarget === "IMPLEMENTATION"));
  const original = structuredClone(f.truth);
  await fs.writeFile(path.join(f.root, "app.js"), "// Placeholder only.\n");
  const again = await buildMetricPopulation({ projectRoot: f.root, taskId: f.taskId, groundTruth: f.truth });
  assert.equal(again.digest, f.population.digest, "Candidate code must not redefine the denominator.");
  assert.deepEqual(f.truth, original);
  const sourceOnly = await buildMetricPopulation({ projectRoot: f.root, taskId: f.taskId, groundTruth: {
    version: 2, claims: [claim("R1"), claim("S1", "inScope")],
  }, sourceOnlyDelivery: true, artifactMetricIds: ["M16"] });
  assert.deepEqual(sourceOnly.metrics.M16.map(row => row.sourceId), ["R1", "S1"]);
  assert(sourceOnly.metrics.M12.some(row => row.sourceId === "S1"), "M16 must not remove M12 fulfillment checks.");
});

test("explicit document-only authority and pre-implementation stages do not acquire implementation work", async t => {
  const f = await fixture(t, [claim("R1", "requirements", { verificationTarget: undefined }),
    claim("S1", "inScope", { text: "Documents only; application code is out of scope.", verificationTarget: "ARTIFACT" })]);
  assert.deepEqual(f.population.metrics.M16, []);
  assert.equal(calculateMetricReport({ population: f.population, metricIds: ["M16"] }).metrics[0].status, "NOT_COMPUTABLE");
  const implementation = await fixture(t);
  const routing = implementationPopulation(implementation.population, { groundTruth: implementation.truth, stage: "design" });
  assert.equal(routing.skipReason, "PRE_IMPLEMENTATION_STAGE");
  assert.deepEqual(routing.population.metrics.M16, []);
  assert.equal(implementationPopulation(implementation.population).population.metrics.M16.length, 2);
});

test("M16 aggregates covered obligations and keeps missing implementation proof blocking and unverified", async t => {
  const f = await fixture(t), [first, second] = f.population.metrics.M16;
  const report = judgement => calculateMetricReport({ population: f.population, metricIds: ["M16"], judgements: [
    { objectId: first.objectId, judgement: "PASS", evidence: ["src/save.js:1"] },
    { objectId: second.objectId, judgement, evidence: judgement === "DEVIATION" ? ["src/main.js:1"] : [] },
  ] });
  assert.equal(report("DEVIATION").metrics[0].value, 0.5);
  assert.equal(report("DEVIATION").status, "DEVIATION");
  const unverified = report("UNVERIFIED");
  assert.equal(unverified.metrics[0].value, null);
  assert.equal(unverified.metrics[0].denominator, 2);
  assert.equal(unverified.blockingObjects[0].objectId, second.objectId);
  assert.equal(report("PASS").metrics[0].value, 1);
});

test("mixed baselines retain actual artifact views and every HARD source fulfillment without document projections of explicit source/process claims", async t => {
  const f = await fixture(t, []);
  const claims = [claim("REQ"), claim("GOAL", "taskGoals"), claim("SCOPE", "inScope"),
    claim("DOC", "requirements", { verificationTarget: "ARTIFACT" }),
    claim("PROCESS", "constraints", { verificationTarget: "PROCESS" })];
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.taskId,
    groundTruth: { version: 1, claims }, sourceOnlyDelivery: true, artifactMetricIds: ["M16"] });
  const docs = Object.entries(population.metrics).filter(([id]) => /^M0[1-7]$/u.test(id)).flatMap(([, rows]) => rows);
  assert(docs.length > 0);
  assert(docs.every(object => object.sourceId === "DOC"));
  assert(population.metrics.M11.some(object => object.sourceId === "PROCESS"));
  for (const id of ["REQ", "GOAL", "SCOPE"]) assert(population.metrics.M12.some(object => object.sourceId === id));
  const mixedDocs = await buildMetricPopulation({ projectRoot: f.root, taskId: f.taskId,
    groundTruth: { version: 1, claims }, sourceOnlyDelivery: false, artifactMetricIds: ["M01"] });
  assert(mixedDocs.metrics.M01.some(object => object.sourceId === "REQ"), "Real document deliveries retain their represented-requirement checks.");
});

test("M16 requires actual SOURCE proof in Stop as well as implementation review", async t => {
  const f = await fixture(t), object = f.population.metrics.M16[0], row = { judgement: "PASS" };
  assert.deepEqual(reviewProofOwners(object), ["SOURCE"]);
  for (const owner of ["ARTIFACT", "PROCESS", "BASIS"]) assert.throws(() => validateReviewJudgement({ row, object,
    citations: [{ readProof: { version: 1, observed: true, basisComplete: true, owner } }] }), { code: "REVIEW_ITEM_EVIDENCE_UNAVAILABLE" });
  assert.equal(validateReviewJudgement({ row, object, citations: [
    { readProof: { version: 1, observed: true, basisComplete: true, owner: "SOURCE" } },
  ] }), row);
});

test("generic source collection includes root entries, configuration, resources and Python data flow", async t => {
  const f = await fixture(t);
  const files = {
    "main.py": "from lib.store import save\nsubmit = save\n",
    "package.json": '{"main":"main.py"}',
    "lib/store.py": "def save(value): return write(value)\n",
    "config/runtime.toml": 'storage = "disk"',
    "resources/defaults.json": '{"items":[]}',
    "test_main.py": "# Only a test double.",
    "auth-profiles.json": '{"synthetic":"restricted fixture"}',
    "lib/tests/test_store.py": "# Test implementation is not production.",
    "examples/sample.py": "# Example implementation is not production.",
  };
  for (const [file, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
    await fs.writeFile(path.join(f.root, file), bytes);
  }
  const manifest = await collectSourceManifest(f.root);
  assert.deepEqual(manifest.map(file => file.path).sort(), ["config/runtime.toml", "lib/store.py", "main.py", "package.json", "resources/defaults.json"]);
  for (const file of manifest) assert.equal(file.sha256, sha256(files[file.path]));
});

test("M16 workers use frozen source/config, exclude process proof and reject stale source", async t => {
  const f = await fixture(t, [claim("R1")]), object = f.population.metrics.M16[0];
  const groundTruthPath = path.join(f.root, ".runtime-correction/tasks/m16/ground-truth/current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(f.truth));
  await fs.mkdir(path.join(f.root, "src"));
  await fs.writeFile(path.join(f.root, "src/main.js"), "import { save } from './save.js';\nexport const submit = value => save(value);\n");
  await fs.writeFile(path.join(f.root, "src/save.js"), "export const save = value => store.write(value);\n");
  await fs.writeFile(path.join(f.root, "package.json"), '{"main":"src/main.js"}\n');
  const sourceManifest = await Promise.all(["src/main.js", "src/save.js", "package.json"].map(async file => ({ path: file,
    sha256: sha256(await fs.readFile(path.join(f.root, file))) })));
  const input = { projectRoot: f.root, taskId: f.taskId, role: "stop-reviewer", reviewer: { timeoutMs: 10000 },
    request: { groundTruthPath, sourceManifest, population: { ...f.population, metrics: { M16: [object] } },
      fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: null }, reviewScope: { objectIds: [object.objectId] } },
    evidence: { groundTruth: f.truth, snapshot: { entries: [{ message: { content: "Claimed complete." } }] } } };
  for (const role of ["stop-reviewer", "implementation-reviewer"]) {
    input.role = role;
    assert(canUseStopTaskReview(input));
    const result = await runStopTaskReview(input, { runTask: async options => {
      assert.equal(options.task.scope, "SOURCE_IMPLEMENTATION");
      assert.equal(options.task.reviewType, "production-implementation-coverage-reviewer");
      assert.match(options.task.requirement, /trace backward to every production producer/u);
      assert.match(options.task.requirement, /including auxiliary writes/u);
      assert.deepEqual(options.task.targetPrefixes, ["project/"]);
      await assert.rejects(fs.stat(path.join(options.root, "process")), { code: "ENOENT" });
      assert.equal(await fs.readFile(path.join(options.root, "project/package.json"), "utf8"), '{"main":"src/main.js"}\n');
      return observedTaskResult(options, { file: "project/src/main.js" });
    } });
    assert.equal(result.result.metricObjectJudgements[0].judgement, "PASS");
    assert.equal(result.sourceCitations[0].readProof.owner, "SOURCE");
  }
  await assert.rejects(runStopTaskReview(input, { runTask: async options => {
    const result = await observedTaskResult(options, { file: "project/src/main.js" });
    delete result.productionTrace;
    return result;
  } }), error => error.code === "REVIEW_ITEM_EVIDENCE_UNAVAILABLE");
  await fs.writeFile(path.join(f.root, "src/main.js"), "// Changed after freezing.\n");
  await assert.rejects(runStopTaskReview(input, { runTask: () => assert.fail("Stale source must not reach review.") }),
    { code: "REVIEW_COLLECTION_STALE" });
  input.request.sourceManifest = [];
  const missing = await runStopTaskReview(input, { runTask: () => assert.fail("Missing source must remain unverified.") });
  assert.equal(missing.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  delete input.request.sourceManifest;
  const unbound = await runStopTaskReview(input, { runTask: () => assert.fail("An unbound inventory cannot replace the source manifest.") });
  assert.equal(unbound.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
});

test("canonical Stop supplies M16 source once and retries only unverified or unproven source in the implementation role", async t => {
  for (const scenario of [{ enabled: false, verdict: "PASS" }, { enabled: true, verdict: "PASS" },
    { enabled: true, verdict: "DEVIATION" }, { enabled: true, verdict: "UNVERIFIED" }, { enabled: true, verdict: "FORGED" }])
    await t.test(`${scenario.enabled}:${scenario.verdict}`, async t => {
      const f = await fixture(t, []), sessionId = "m16-stop-host";
      const task = await ensureTask({ projectRoot: f.root, sessionId });
      const source = path.join(f.root, "src/main.js");
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, "export const submit = value => store.write(value);\n");
      await applyGroundTruthDelta({ projectRoot: f.root, taskId: task.taskId, delta: { operations: [{
        operation: "ADD", category: "requirements", text: "Persist submitted entries.", authority: "USER_EXPLICIT", severity: "HARD",
        verificationTarget: "IMPLEMENTATION", applicabilityKind: "CURRENT_TASK", applicability: "CURRENT_TASK",
        source: { ref: "user:1", kind: "USER_MESSAGE", subject: "MAIN_TASK" },
      }] } });
      const transcript = path.join(f.root, "transcript.jsonl");
      await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "user:1", message: { content: "Persist submitted entries." } }) + "\n");
      let m16Calls = 0;
      const factory = async input => {
        if (!scenario.enabled) assert.equal(input.role, "stop-reviewer");
        const objects = Object.values(input.request.population.metrics).flat();
        if (objects[0]?.metricId === "M16") {
          m16Calls++;
          if (m16Calls === 1) assert.equal(input.role, "stop-reviewer");
          else assert.equal(input.role, "implementation-reviewer");
          assert(input.request.sourceManifest.some(file => file.path === "src/main.js" && file.sha256 === sha256("export const submit = value => store.write(value);\n")));
          if (scenario.verdict === "FORGED" && m16Calls === 1) return { result: {
            summary: "Unproven claim", ...input.request.fixedStopClassification, findings: [], fileAssessments: [],
            metricObjectJudgements: [{ objectId: objects[0].objectId, judgement: "PASS", reason: "Claim without proof", evidence: [] }],
          }, close() {} };
          return runStopTaskReview(input, { runTask: options => observedTaskResult(options, { file: "project/src/main.js",
            verdict: m16Calls === 1 ? scenario.verdict : "PASS" }) });
        }
        return { result: { summary: "Other metrics are outside this controlled source-wiring test.", ...input.request.fixedStopClassification,
          findings: [], fileAssessments: [], metricObjectJudgements: objects.map(object => ({ objectId: object.objectId,
            judgement: "UNVERIFIED", reason: "Outside this test's source proof.", evidence: [] })) }, close: async () => {} };
      };
      factory.supportsReviewCollection = true;
      factory.singleReviewMetrics = Object.keys(METRIC_CATALOG);
      const config = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
        skillCorrection: { enabled: false }, implementationCorrection: { enabled: scenario.enabled, platform: null },
        stopCorrection: { enabled: true } }, { policyRoot: path.join(f.root, ".runtime-corrector") });
      const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, task.taskId), "task.json"), "utf8"));
      const result = await handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2: config }, reviewerFactory: factory,
        assessmentContext: { mode: "verify_only", assessmentId: "m16-source-identity", guard: decisionGuard(state),
          deadlineAt: Date.now() + 30000, maxCorrections: 1 },
        input: { cwd: f.root, session_id: sessionId, transcript_path: transcript, hook_event_name: "Stop",
          hook_event_id: "m16-stop", last_assistant_message: "Completed." } });
      const fallback = ["UNVERIFIED", "FORGED"].includes(scenario.verdict);
      assert.equal(m16Calls, fallback ? 2 : 1);
      assert.equal(result.stop.report.metrics.find(metric => metric.metricId === "M16").objects[0].judgement,
        scenario.verdict === "DEVIATION" ? "DEVIATION" : "PASS");
      if (scenario.enabled) assert.equal(result.stop.implementationReview.reusedStopSourceObjectIds.length, fallback ? 0 : 1);
  });
});

test("M16 is accepted in configuration and artifact declarations, and has a dedicated coverage profile", async t => {
  const f = await fixture(t);
  const schema = JSON.parse(await fs.readFile(new URL("../config/schemas/project-config.schema.json", import.meta.url), "utf8"));
  const metricsSchema = schema.properties.artifacts.items.properties.metrics;
  assert.deepEqual(validateJsonSchema(["M16"], metricsSchema), []);
  assert(validateJsonSchema(["M17"], metricsSchema).length > 0);
  await fs.writeFile(path.join(f.root, "main.js"), "export const main = () => true;\n");
  const candidates = await collectArtifactCandidates({ projectRoot: f.root, plan: {
    artifacts: [{ nodeId: "source", patterns: ["main.js"], stage: "implementation", metrics: ["M16"] }],
  } });
  assert.deepEqual(candidates[0].metricIds, ["M16"]);
  const profile = reviewPromptProfile("M16", "SOURCE_IMPLEMENTATION");
  assert.equal(profile.reviewType, "production-implementation-coverage-reviewer");
  assert.equal(profile.promptAppend, METRIC_CATALOG.M16.description, "Native and isolated reviewers must use the same six-condition policy.");
  for (const condition of ["REAL EXISTENCE", "PRODUCTION REACHABILITY", "REAL CORE PROCESSING", "EFFECTIVE DATA FLOW", "REQUIRED BRANCHES", "TRACEABLE EVIDENCE"])
    assert(profile.promptAppend.includes(condition));
  assert.match(profile.promptAppend, /UNVERIFIED/);
});
