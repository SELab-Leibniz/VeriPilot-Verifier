import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canUseStopTaskReview, runStopTaskReview } from "../lib/runtime-v2/stop-task-review.mjs";
import { persistSkillGroundTruth } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { buildMetricPopulation, METRIC_CATALOG } from "../lib/runtime-v2/metrics.mjs";
import { scanSkillDirectory } from "../lib/runtime-v2/skill-source.mjs";
import { taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { reviewPromptProfile } from "../lib/review-task/prompt-profile.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";

async function fixture(t, metricId = "M11", verificationTarget = "PROCESS", { projectFile = true } = {}) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-task-all-metric-test-runs/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const projectRoot = await fs.mkdtemp(path.join(scratch, "run-")), taskId = "all-metric-task";
  t.after(() => fs.rm(projectRoot, { force: true, recursive: true }));
  const claim = { claimId: "R1", revisionId: "R1@1", category: METRIC_CATALOG[metricId].source[0], text: "Check the assigned current obligation.",
    authority: "USER_EXPLICIT", severity: "HARD", applicability: "CURRENT_TASK", verificationTarget, status: "ACTIVE" };
  const common = { ...claim, claimId: "COMMON", category: "constraints", text: "Preserve all applicable exceptions and Unicode names." };
  const truth = { taskId, version: 1, claims: metricId === "M08" ? [common] : [claim, common] };
  truth.digest = sha256(truth.claims);
  const directory = taskDirectory(projectRoot, taskId), groundTruthPath = path.join(directory, "ground-truth/current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  await fs.writeFile(path.join(directory, "task.json"), JSON.stringify({ taskId, groundTruth: { version: 1, digest: truth.digest },
    correctionEpoch: { id: 1 }, control: { generation: 1, cancelEpoch: 0 } }));
  const source = path.join(projectRoot, "candidate.md");
  if (projectFile) await fs.writeFile(source, "Current candidate content, not an execution claim.\n");
  const object = { objectId: `${metricId}:R1`, metricId, sourceId: "R1", sourceRevisionId: "R1@1", description: claim.text,
    applicability: "CURRENT_TASK", authority: "USER_EXPLICIT", hard: true, verificationTarget };
  const population = { taskId, version: 1, groundTruthVersion: 1, digest: sha256(object), metrics: { [metricId]: [object] } };
  const snapshot = { entries: [{ type: "assistant", uuid: "original-call", message: { content: [{ type: "tool_use", id: "business-check", name: "exec", input: { command: "verify fixture", workdir: projectRoot } }] } },
    { type: "user", uuid: "original-result", message: { content: [{ type: "tool_result", tool_use_id: "business-check", content: "Observed current result." }] } }], digest: "original-snapshot" };
  const input = { projectRoot, taskId, role: "stop-reviewer", reviewer: { timeoutMs: 10000 }, deadlineAt: Date.now() + 30000,
    request: { population, groundTruthPath, fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: "VERIFICATION" },
      reviewScope: { objectIds: [object.objectId], sourceIds: [object.sourceId] }, instructions: ["Check only the frozen assigned object."] },
    evidence: { groundTruth: truth, snapshot, population } };
  return { projectRoot, directory, taskId, source, input, object, truth };
}

async function result(options, { file = options.task.targetFiles[0], verdict = "PASS" } = {}) {
  const bytes = await fs.readFile(path.join(options.root, file));
  const snapshot = path.join(options.outputDir, "frozen-source", file);
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await fs.writeFile(snapshot, bytes);
  return { completed: true, verdict, reason: "The selected witness supports only the assigned scope.",
    refs: [{ path: file, start: 1, end: Math.min(2, bytes.toString("utf8").split("\n").length), sha256: sha256(bytes) }] };
}
const judgement = handle => handle.result.metricObjectJudgements[0];

async function skillFixture(t, { captured = true, privateSource = false, sourceRef = "project/SKILL.md#L2" } = {}) {
  const f = await fixture(t, "M08", "PROCESS", { projectFile: false }), skillId = "build-offline-kitchen";
  const sourceRoot = privateSource ? path.join(f.directory, "skills", skillId, "source") : path.join(f.projectRoot, "skills", skillId);
  await fs.mkdir(path.join(sourceRoot, "references"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "SKILL.md"), "# Kitchen Skill\nBefore completion, run the verifier. If it fails, fix and retry; require successful output.\nSee references/conditions.md for the preservation condition.\n");
  await fs.writeFile(path.join(sourceRoot, "references/conditions.md"), "Preserve frozen inputs, including when an optional configuration is absent.\n");
  const source = await scanSkillDirectory(sourceRoot);
  const saved = await persistSkillGroundTruth({ projectRoot: f.projectRoot, taskId: f.taskId, skillId, skillDigest: source.digest,
    constraints: [{ constraintId: "verify", modality: "MUST", kind: "STEP", statement: "Before completion, run the verifier.", condition: "CURRENT_TASK", dependsOn: ["preserve"], sourceRef },
      { constraintId: "preserve", modality: "MUST", kind: "CONDITION", statement: "Preserve frozen inputs.", condition: "CURRENT_TASK", sourceRef: "references/conditions.md#L1" }], taskOverlays: [] });
  const population = await buildMetricPopulation({ projectRoot: f.projectRoot, taskId: f.taskId, groundTruth: f.truth, skillDocuments: [saved.document] });
  population.metrics = { M08: population.metrics.M08.filter(row => row.sourceId === `${skillId}:verify`) };
  const object = population.metrics.M08[0];
  f.input.request.population = population;
  f.input.request.reviewScope = { objectIds: [object.objectId], sourceIds: [object.sourceId] };
  f.input.evidence.population = population;
  if (captured) {
    f.input.evidence.skillGroundTruth = saved.document;
    f.input.evidence.skillSource = source;
    f.input.request.skillGroundTruthPath = path.join(saved.directory, "skill-ground-truth.json");
    f.input.request.skillSourcePath = path.join(saved.directory, "skill-source.json");
    await fs.writeFile(f.input.request.skillSourcePath, JSON.stringify(source));
  }
  return { ...f, skillId, object, sourceRoot, skillDocument: saved.document, skillDirectory: saved.directory };
}

test("all fifteen metric IDs have single current-object Stop eligibility without guessing other applicability", async t => {
  for (const metric of Object.keys(METRIC_CATALOG)) {
    const f = await fixture(t, metric, "PROCESS");
    assert.equal(canUseStopTaskReview(f.input), true, metric);
    for (const applicability of ["FUTURE_STAGE", "if checkout occurs", "NOT_APPLICABLE"]) {
      const copy = structuredClone(f.input); copy.request.population.metrics[metric][0].applicability = applicability;
      assert.equal(canUseStopTaskReview(copy), false);
    }
  }
});

test("metric and evidence ownership choose a fixed scope and dedicated profile", async t => {
  const routes = [
    ...["M01", "M02", "M03", "M04", "M05", "M06", "M07"].map(metric => [metric, "PROCESS", "METRIC_ARTIFACT_REVIEW"]),
    ["M09", "IMPLEMENTATION", "SOURCE_IMPLEMENTATION"], ["M09", "PROCESS", "PROCESS_COMPLIANCE"], ["M09", "ARTIFACT", "METRIC_ARTIFACT_REVIEW"],
    ["M10", "IMPLEMENTATION", "SOURCE_IMPLEMENTATION"], ["M10", "PROCESS", "PROCESS_COMPLIANCE"], ["M10", "ARTIFACT", "METRIC_ARTIFACT_REVIEW"],
    ["M11", "IMPLEMENTATION", "PROCESS_COMPLIANCE"], ["M12", "IMPLEMENTATION", "RUNTIME_ACCEPTANCE"], ["M12", "PROCESS", "PROCESS_COMPLIANCE"], ["M12", "ARTIFACT", "ARTIFACT_EXECUTION"],
    ...["M13", "M14", "M15"].map(metric => [metric, "PROCESS", "EXECUTION_CLOSURE"]),
  ];
  for (const [metric, target, scope] of routes) await t.test(`${metric}/${target}`, async t => {
    const f = await fixture(t, metric, target);
    await runStopTaskReview(f.input, { runTask: async options => {
      assert.equal(options.task.scope, scope);
      assert.deepEqual({ promptAppend: options.promptAppend, reviewType: options.task.reviewType }, reviewPromptProfile(metric, scope));
      if (scope === "SOURCE_IMPLEMENTATION") await assert.rejects(fs.stat(path.join(options.root, "process")), { code: "ENOENT" });
      else assert.equal((await fs.readdir(path.join(options.root, "process"))).length, 2);
      return result(options);
    } });
  });
});

test("M09 joins only implementation-owned source review and does not acquire process evidence", async t => {
  const f = await fixture(t, "M09", "IMPLEMENTATION"); f.input.role = "implementation-reviewer";
  f.input.request.sourceManifest = [{ path: f.source, sha256: sha256(await fs.readFile(f.source)) }];
  assert.equal(canUseStopTaskReview(f.input), true);
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(options.task.scope, "SOURCE_IMPLEMENTATION");
    assert.deepEqual(options.task.targetPrefixes, ["project/"]);
    return result(options);
  } });
  assert.equal(judgement(handle).judgement, "PASS");
  f.input.request.population.metrics.M09[0].verificationTarget = "PROCESS";
  assert.equal(canUseStopTaskReview(f.input), false);
});

test("process-only review needs no project file and cannot use the authoritative basis as its target", async t => {
  const f = await fixture(t, "M11", "PROCESS", { projectFile: false });
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    assert.match(options.task.targetFiles[0], /^process\//u);
    assert.deepEqual(options.task.targetPrefixes, ["process/"]);
    assert.equal(options.task.basisFiles.some(file => file.startsWith("process/")), false);
    return result(options);
  } });
  assert.equal(judgement(handle).judgement, "PASS");
  assert.equal(handle.sourceCitations[0].frozen, true);
  await assert.rejects(runStopTaskReview(f.input, { runTask: options => result(options, { file: options.task.basisFiles[0] }) }),
    error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
});

test("ordinary coverage may inspect a candidate in original messages, but source and process conclusions cannot swap owners", async t => {
  const f = await fixture(t, "M02", "PROCESS", { projectFile: false });
  const handle = await runStopTaskReview(f.input, { runTask: options => result(options) });
  assert.equal(judgement(handle).judgement, "PASS");
  const process = await fixture(t, "M11", "PROCESS");
  await assert.rejects(runStopTaskReview(process.input, { runTask: options => result(options, { file: "project/candidate.md" }) }),
    error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
  const coverage = await fixture(t, "M01", "ARTIFACT");
  await assert.rejects(runStopTaskReview(coverage.input, { runTask: options => result(options, { file: options.task.basisFiles[0] }) }),
    error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
});

test("M08 uses original Skill dictionaries and raw source without manufacturing a GT claim", async t => {
  const f = await skillFixture(t, { privateSource: true });
  assert.equal(f.truth.claims.some(claim => claim.claimId === f.object.sourceId), false);
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(options.task.scope, "PROCESS_COMPLIANCE");
    const parts = await Promise.all(options.task.basisFiles.map(file => fs.readFile(path.join(options.root, file), "utf8")));
    assert(parts.join("").includes(JSON.stringify(f.skillDocument, null, 2)), "Original constraint dictionaries are preserved.");
    assert.match(parts.join(""), /If it fails, fix and retry/u);
    assert.match(parts.join(""), /optional configuration is absent/u);
    assert.equal(await fs.readFile(path.join(options.root, "skill-source/SKILL.md"), "utf8"), await fs.readFile(path.join(f.sourceRoot, "SKILL.md"), "utf8"));
    return result(options);
  } });
  assert.equal(judgement(handle).judgement, "PASS");
});

test("M08 resolves the formal private document and original OpenClaw project Skill when no evidence copies are passed", async t => {
  const f = await skillFixture(t, { captured: false });
  const handle = await runStopTaskReview(f.input, { runTask: options => result(options) });
  assert.equal(judgement(handle).judgement, "PASS");
});

test("the production collector accepts program-bound original Skill and process citations together, while Skill alone cannot prove compliance", async t => {
  const f = await skillFixture(t, { privateSource: true });
  const factory = input => runStopTaskReview(input, { runTask: async options => {
    const process = await result(options), original = await result(options, { file: "skill-source/SKILL.md" });
    return { ...process, refs: [...process.refs, ...original.refs] };
  } });
  factory.reviewItemSize = 1;
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: factory, schema: STOP_REVIEW_SCHEMA,
    classification: f.input.request.fixedStopClassification });
  assert.equal(handle.collection.complete, true);
  assert.equal(judgement(handle).judgement, "PASS");
  assert.equal(handle.sourceCitations.length, 2);
  assert.equal(handle.sourceCitations.every(citation => citation.frozen), true);
  assert(handle.sourceCitations.some(citation => citation.path.includes("skill-source")));
  await assert.rejects(runStopTaskReview(f.input, { runTask: options => result(options, { file: "skill-source/SKILL.md" }) }),
    error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
});

test("M08 missing or changed original source stays unverified before any model call", async t => {
  const f = await skillFixture(t);
  let calls = 0;
  await fs.rm(path.join(f.sourceRoot, "SKILL.md"));
  const handle = await runStopTaskReview(f.input, { runTask: () => { calls++; throw new Error("Must not review a derived label without source."); } });
  assert.equal(calls, 0);
  assert.equal(judgement(handle).judgement, "UNVERIFIED");
});

test("M08 preserves common line, heading and opaque source anchors while requiring explicit referenced files", async t => {
  for (const sourceRef of ["SKILL.md:L2-L3", "SKILL.md:Before declaring completion", "skill:build-offline-kitchen:SKILL.md:L2-L3", "S06: verifier completion gate"]) {
    await t.test(sourceRef, async t => {
      const f = await skillFixture(t, { sourceRef });
      const handle = await runStopTaskReview(f.input, { runTask: async options => {
        const parts = (await Promise.all(options.task.basisFiles.map(file => fs.readFile(path.join(options.root, file), "utf8")))).join("");
        assert(parts.includes(sourceRef));
        assert.match(parts, /If it fails, fix and retry/u);
        return result(options);
      } });
      assert.equal(judgement(handle).judgement, "PASS");
    });
  }
  const f = await skillFixture(t, { sourceRef: "references/missing.md#L1" });
  let calls = 0;
  const handle = await runStopTaskReview(f.input, { runTask: () => { calls++; throw new Error("No authoritative source."); } });
  assert.equal(calls, 0);
  assert.equal(judgement(handle).judgement, "UNVERIFIED");
});

test("M08 malformed private constraint payload is unverified rather than crashing the review", async t => {
  const f = await fixture(t, "M08", "PROCESS");
  f.input.request.population.metrics.M08[0].skillId = "build-offline-kitchen";
  f.input.evidence.skillGroundTruth = { taskId: f.taskId, skillId: "build-offline-kitchen", constraints: {}, taskOverlays: [] };
  let calls = 0;
  const handle = await runStopTaskReview(f.input, { runTask: () => { calls++; throw new Error("No valid original constraint."); } });
  assert.equal(calls, 0);
  assert.equal(judgement(handle).judgement, "UNVERIFIED");
});

test("M08 changing source, adding a new source file or replacing its private document fences an earlier PASS", async t => {
  for (const change of ["source", "new-file", "document"]) await t.test(change, async t => {
    const f = await skillFixture(t);
    await assert.rejects(runStopTaskReview(f.input, { runTask: async options => {
      const checked = await result(options);
      if (change === "source") await fs.appendFile(path.join(f.sourceRoot, "SKILL.md"), "New mandatory condition.\n");
      if (change === "new-file") await fs.writeFile(path.join(f.sourceRoot, "references/new.md"), "A newly introduced dependency.\n");
      if (change === "document") await fs.appendFile(path.join(f.skillDirectory, "skill-ground-truth.json"), " ");
      return checked;
    } }), error => error.code === "REVIEW_COLLECTION_STALE");
  });
});
