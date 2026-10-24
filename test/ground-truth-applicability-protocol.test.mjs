import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "../lib/json-schema-validator.mjs";
import { applyGroundTruthDelta, loadCurrentGroundTruth, persistSkillGroundTruth } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { buildMetricPopulation, calculateMetricReport } from "../lib/runtime-v2/metrics.mjs";
import { generationReviewSchema, GROUND_TRUTH_REVIEW_SCHEMA, SKILL_GROUND_TRUTH_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { scanSkillDirectory } from "../lib/runtime-v2/skill-source.mjs";
import { canUseStopTaskReview, runStopTaskReview } from "../lib/runtime-v2/stop-task-review.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";

const kinds = ["CURRENT_TASK", "CONDITIONAL", "FUTURE", "UNKNOWN"];
const source = { ref: "transcript:protocol-user", subject: "MAIN_TASK", kind: "USER_MESSAGE",
  excerpt: "pantry set NAME AMOUNT retains zero entries; only kitchen.py and local app data may be edited." };
const operation = (overrides = {}) => ({ operation: "ADD", claimId: "R1", category: "requirements",
  text: "Retain zero-amount entries.", authority: "USER_EXPLICIT", severity: "HARD",
  applicability: "pantry set command", applicabilityKind: "CURRENT_TASK", verificationTarget: "IMPLEMENTATION",
  source: structuredClone(source), ...overrides });
const response = op => ({ summary: "The original scope is retained.", taskClassification: "CONTINUATION", operations: [op] });
const constraint = (overrides = {}) => ({ constraintId: "verify", kind: "STEP", modality: "MUST",
  statement: "Before declaring completion, run the bundled verifier.", condition: null,
  sourceRef: "SKILL.md#L2", applicabilityKind: "CURRENT_TASK", ...overrides });
const skillResponse = item => ({ ...response(operation()), skillGroundTruth: { constraints: [item], taskOverlays: [] } });

async function fixture(t, op = operation()) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/applicability-protocol-test-runs/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const projectRoot = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(projectRoot), path.resolve(scratch));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot, sessionId: "protocol-fixture" });
  await applyGroundTruthDelta({ projectRoot, taskId: task.taskId, evidenceCapture: "full", delta: { operations: [op] } });
  const truth = await loadCurrentGroundTruth(projectRoot, task.taskId);
  const population = await buildMetricPopulation({ projectRoot, taskId: task.taskId, groundTruth: truth });
  await fs.writeFile(path.join(projectRoot, "kitchen.py"), "# Current source without captured execution evidence.\n");
  const inputFor = (metricId, currentPopulation = population) => {
    const object = currentPopulation.metrics[metricId][0];
    return { projectRoot, taskId: task.taskId, role: "stop-reviewer", reviewer: { timeoutMs: 10000 },
      request: { groundTruthPath: path.join(taskDirectory(projectRoot, task.taskId), "ground-truth/current.json"),
        population: { ...currentPopulation, metrics: { [metricId]: [object] } },
        fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: "VERIFICATION" },
        reviewScope: { objectIds: [object.objectId], sourceIds: [object.sourceId] }, instructions: [] },
      evidence: { groundTruth: truth, snapshot: { entries: [] }, population: currentPopulation } };
  };
  return { projectRoot, task, truth, population, inputFor };
}

test("new extraction requires a machine kind while retaining the independent natural scope field", () => {
  const strict = generationReviewSchema(GROUND_TRUTH_REVIEW_SCHEMA);
  for (const kind of kinds) {
    const op = operation({ applicabilityKind: kind });
    assert.deepEqual(validateJsonSchema(response(op), strict), [], kind);
    assert.equal(op.applicability, "pantry set command");
  }
  const missing = operation(); delete missing.applicabilityKind;
  assert.ok(validateJsonSchema(response(missing), strict).some(error => error.keyword === "required"
    && error.pointer.endsWith("/applicabilityKind")));
  for (const value of ["pantry set command", "main-task", "CONDITIONAL:if verification fails", "current_task", "", null]) {
    assert.ok(validateJsonSchema(response(operation({ applicabilityKind: value })), strict).length, String(value));
  }
  // Existing readers still accept an old claim. Strict generation never mutates their schema.
  assert.deepEqual(validateJsonSchema(response(missing), GROUND_TRUTH_REVIEW_SCHEMA), []);
  assert.equal(GROUND_TRUTH_REVIEW_SCHEMA.properties.operations.items.required.includes("applicabilityKind"), false);
});

test("new Skill output requires its own routing kind without tightening persisted Skill document readers", () => {
  const strict = generationReviewSchema(SKILL_GROUND_TRUTH_REVIEW_SCHEMA);
  const legacy = constraint({ condition: "if the authorized verifier fails" }); delete legacy.applicabilityKind;
  assert.deepEqual(validateJsonSchema(skillResponse(legacy), SKILL_GROUND_TRUTH_REVIEW_SCHEMA), []);
  assert.ok(validateJsonSchema(skillResponse(legacy), strict).some(error => error.keyword === "required"
    && error.pointer === "/skillGroundTruth/constraints/0/applicabilityKind"));
  for (const kind of kinds) {
    assert.deepEqual(validateJsonSchema(skillResponse(constraint({ applicabilityKind: kind })), strict), [], kind);
  }
  const missingCondition = constraint(); delete missingCondition.condition;
  assert.ok(validateJsonSchema(skillResponse(missingCondition), strict).some(error => error.keyword === "required"
    && error.pointer === "/skillGroundTruth/constraints/0/condition"));
  for (const condition of [undefined, "CURRENT_TASK", "if the authorized verifier fails"]) {
    const old = constraint(); delete old.applicabilityKind;
    if (condition === undefined) delete old.condition; else old.condition = condition;
    assert.deepEqual(validateJsonSchema({ constraints: [old], taskOverlays: [] },
      SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth), [], String(condition));
  }
  assert.ok(validateJsonSchema(skillResponse(constraint({ applicabilityKind: "verifier execution" })), strict).length);
  assert.equal(SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth.properties.constraints.items.required
    .includes("applicabilityKind"), false);
  assert.equal(SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth.properties.constraints.items.required
    .includes("condition"), false);
});

test("CURRENT_TASK preserves the original command scope, text and source through the real ledger and metric population", async t => {
  const original = operation({ applicability: "pantry set command — 盐/0", source: { ...source, excerpt: "仅 pantry set：零数量条目应保留。" } });
  const f = await fixture(t, original), saved = f.truth.claims[0];
  assert.equal(saved.applicabilityKind, "CURRENT_TASK");
  assert.deepEqual(Buffer.from(saved.applicability), Buffer.from(original.applicability));
  assert.equal(saved.text, original.text);
  assert.deepEqual(saved.source, original.source);
  for (const metricId of ["M01", "M02", "M05", "M12"]) {
    const object = f.population.metrics[metricId][0];
    assert.equal(object.applicabilityKind, "CURRENT_TASK");
    assert.equal(object.applicability, original.applicability);
    assert.equal(object.description, original.text);
    assert.equal(canUseStopTaskReview(f.inputFor(metricId)), true);
  }
  let workerCalls = 0;
  const handle = await runStopTaskReview(f.inputFor("M01"), { runTask: async options => {
    workerCalls++;
    const basis = async name => JSON.parse((await Promise.all(options.task.basisFiles
      .filter(file => file.startsWith(`basis/${name}-`)).map(file => fs.readFile(path.join(options.root, file), "utf8")))).join(""));
    const deliveredClaim = (await basis("ground-truth")).claims.find(claim => claim.claimId === "R1");
    assert.equal(deliveredClaim.applicability, original.applicability);
    assert.equal(deliveredClaim.applicabilityKind, "CURRENT_TASK");
    assert.equal(deliveredClaim.text, original.text);
    assert.deepEqual(deliveredClaim.source, original.source);
    assert.equal((await basis("assigned-object")).object.applicability, original.applicability);
    return { completed: true, verdict: "UNVERIFIED", reason: "The routing tag supplies no candidate coverage proof.", refs: [] };
  } });
  assert.equal(workerCalls, 1);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
});

test("typed non-current or unknown scope keeps its full source-backed condition and stays native without removing denominator objects", async t => {
  const originals = {
    CONDITIONAL: ["If the authorized verifier fails, fix kitchen.py, preserve all baseline files, then rerun the original verifier.",
      "if the authorized verifier fails; retain the original workdir and source revision"],
    FUTURE: ["Online recipe synchronization is explicitly deferred to the next release and is outside this offline delivery.",
      "next release only; excluded from the current offline app"],
    UNKNOWN: ["Honor the store migration requirement from the supplied applicability note.",
      "scope unresolved: the supplied applicability-note version is unavailable"],
  };
  for (const kind of ["CONDITIONAL", "FUTURE", "UNKNOWN"]) await t.test(kind, async t => {
    const [text, applicability] = originals[kind];
    const original = operation({ applicabilityKind: kind, text, applicability,
      source: { ...source, excerpt: text } });
    const f = await fixture(t, original), saved = f.truth.claims[0], object = f.population.metrics.M12[0];
    assert.equal(saved.text, text);
    assert.equal(saved.applicability, applicability);
    assert.deepEqual(saved.source, original.source);
    assert.equal(object.applicabilityKind, kind);
    assert.equal(object.applicability, applicability);
    assert.equal(canUseStopTaskReview(f.inputFor("M12")), false);
    const report = calculateMetricReport({ population: f.population, judgements: [], metricIds: ["M12"] });
    const metric = report.metrics.find(item => item.metricId === "M12");
    assert.equal(metric.denominator, 1);
    assert.equal(metric.objects[0].judgement, "CHECKER_ERROR");
  });
});

test("natural legacy labels are not upgraded to current-task scope merely by their wording", async t => {
  const legacy = operation(); delete legacy.applicabilityKind;
  const f = await fixture(t, legacy);
  assert.equal(Object.hasOwn(f.truth.claims[0], "applicabilityKind"), false);
  assert.equal(f.truth.claims[0].applicability, "pantry set command");
  assert.equal(canUseStopTaskReview(f.inputFor("M12")), false);
  for (const kind of ["CONDITIONAL", "FUTURE", "UNKNOWN"]) {
    const input = f.inputFor("M12"), object = input.request.population.metrics.M12[0];
    object.applicability = "CURRENT_TASK";
    object.applicabilityKind = kind;
    assert.equal(canUseStopTaskReview(input), false, "the typed state takes precedence over a legacy-looking label");
  }
});

test("a CURRENT_TASK routing tag alone cannot close a runtime obligation without captured execution evidence", async t => {
  const f = await fixture(t), input = f.inputFor("M12");
  assert.equal(canUseStopTaskReview(input), true);
  let workerCalls = 0;
  const handle = await runStopTaskReview(input, { runTask: async () => { workerCalls++; throw new Error("No runtime proof was supplied."); } });
  assert.equal(workerCalls, 0);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  assert.match(handle.result.metricObjectJudgements[0].reason, /process evidence|unverified/iu);
});

test("typed Skill routing metadata preserves the separate original condition and source through persistence", async t => {
  const f = await fixture(t);
  const originals = [
    constraint({ constraintId: "current", applicabilityKind: "CURRENT_TASK", condition: null }),
    constraint({ constraintId: "conditional", applicabilityKind: "CONDITIONAL", condition: "if verification fails — preserve 盐/0" }),
    constraint({ constraintId: "future", applicabilityKind: "FUTURE", condition: "only in the explicitly deferred next release" }),
    constraint({ constraintId: "unknown", applicabilityKind: "UNKNOWN", condition: "the authoritative activation note is unavailable" }),
  ];
  const saved = await persistSkillGroundTruth({ projectRoot: f.projectRoot, taskId: f.task.taskId, skillId: "typed-skill",
    skillDigest: "original-source-digest", constraints: originals, taskOverlays: [] });
  const population = await buildMetricPopulation({ projectRoot: f.projectRoot, taskId: f.task.taskId,
    groundTruth: f.truth, skillDocuments: [saved.document] });
  assert.equal(population.metrics.M08.length, originals.length);
  for (const original of originals) {
    const stored = saved.document.constraints.find(item => item.constraintId === original.constraintId);
    const object = population.metrics.M08.find(item => item.sourceId === `typed-skill:${original.constraintId}`);
    assert.equal(stored.condition, original.condition);
    assert.equal(stored.statement, original.statement);
    assert.equal(stored.sourceRef, original.sourceRef);
    assert.equal(object.applicabilityKind, original.applicabilityKind);
    assert.equal(object.applicability, original.condition ?? "CURRENT_TASK");
    const scoped = { ...population, metrics: { M08: [object] } };
    assert.equal(canUseStopTaskReview(f.inputFor("M08", scoped)), original.applicabilityKind === "CURRENT_TASK");
  }
});

test("an old Skill document with no kind still reaches the existing M08 reader and preserves its original condition", async t => {
  const f = await fixture(t), skillId = "legacy-kitchen";
  const sourceRoot = path.join(taskDirectory(f.projectRoot, f.task.taskId), "skills", skillId, "source");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "SKILL.md"), "# Legacy kitchen Skill\nBefore declaring completion, run the bundled verifier.\n");
  const scanned = await scanSkillDirectory(sourceRoot);
  const legacy = constraint(); delete legacy.applicabilityKind;
  const saved = await persistSkillGroundTruth({ projectRoot: f.projectRoot, taskId: f.task.taskId, skillId,
    skillDigest: scanned.digest, constraints: [legacy], taskOverlays: [] });
  assert.equal(Object.hasOwn(saved.document.constraints[0], "applicabilityKind"), false);
  assert.equal(saved.document.constraints[0].condition, null);
  assert.deepEqual(validateJsonSchema({ constraints: saved.document.constraints, taskOverlays: [] },
    SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth), []);
  const population = await buildMetricPopulation({ projectRoot: f.projectRoot, taskId: f.task.taskId,
    groundTruth: f.truth, skillDocuments: [saved.document] });
  const input = f.inputFor("M08", population);
  input.evidence.skillGroundTruth = saved.document;
  input.evidence.skillSource = scanned;
  input.evidence.snapshot.entries = [{ type: "assistant", uuid: "old-business-call", message: { content: [
    { type: "tool_use", id: "verify", name: "exec", input: { command: "the original verifier", workdir: f.projectRoot } },
  ] } }];
  assert.equal(canUseStopTaskReview(input), true);
  let workerCalls = 0;
  const handle = await runStopTaskReview(input, { runTask: async options => {
    workerCalls++;
    assert.equal(options.task.scope, "PROCESS_COMPLIANCE");
    assert.ok(options.task.basisFiles.some(file => file.startsWith("basis/skill-source-")));
    return { completed: true, verdict: "UNVERIFIED", reason: "Reader succeeded; this fixture has no returned verification result.", refs: [] };
  } });
  assert.equal(workerCalls, 1, "legacy schema compatibility must not create a pre-worker UNVERIFIED result");
  assert.equal(handle.result.metricObjectJudgements[0].reason, "Reader succeeded; this fixture has no returned verification result.");

  const originalCondition = "if verification fails — preserve 盐/0 and the source revision";
  const conditioned = await persistSkillGroundTruth({ projectRoot: f.projectRoot, taskId: f.task.taskId, skillId,
    skillDigest: scanned.digest, constraints: [{ ...legacy, condition: originalCondition }], taskOverlays: [] });
  assert.deepEqual(validateJsonSchema({ constraints: conditioned.document.constraints, taskOverlays: [] },
    SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth), []);
  const conditionalPopulation = await buildMetricPopulation({ projectRoot: f.projectRoot, taskId: f.task.taskId,
    groundTruth: f.truth, skillDocuments: [conditioned.document] });
  assert.equal(conditionalPopulation.metrics.M08[0].applicability, originalCondition);
  assert.equal(canUseStopTaskReview(f.inputFor("M08", conditionalPopulation)), false);
});
