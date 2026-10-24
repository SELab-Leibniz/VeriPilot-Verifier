import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canUseStopTaskReview, runStopTaskReview } from "../lib/runtime-v2/stop-task-review.mjs";
import { persistSkillGroundTruth } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { buildMetricPopulation, calculateMetricReport, METRIC_CATALOG } from "../lib/runtime-v2/metrics.mjs";
import { scanSkillDirectory } from "../lib/runtime-v2/skill-source.mjs";
import { taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { reviewPromptProfile } from "../lib/review-task/prompt-profile.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";

async function fixture(t, metricId = "M11", verificationTarget = "PROCESS", { projectFile = true, applicability = "CURRENT_TASK", applicabilityKind, text = "Check the assigned current obligation." } = {}) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-task-all-metric-test-runs/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const projectRoot = await fs.mkdtemp(path.join(scratch, "run-")), taskId = "all-metric-task";
  t.after(() => fs.rm(projectRoot, { force: true, recursive: true }));
  const claim = { claimId: "R1", revisionId: "R1@1", category: METRIC_CATALOG[metricId].source[0], text,
    authority: "USER_EXPLICIT", severity: "HARD", applicability,
    ...(applicabilityKind !== undefined ? { applicabilityKind } : {}), verificationTarget, status: "ACTIVE" };
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
    applicability, ...(applicabilityKind !== undefined ? { applicabilityKind } : {}), authority: "USER_EXPLICIT", hard: true, verificationTarget };
  const population = { taskId, version: 1, groundTruthVersion: 1, digest: sha256(object), metrics: { [metricId]: [object] } };
  const snapshot = { entries: [{ type: "assistant", uuid: "original-call", message: { content: [{ type: "tool_use", id: "business-check", name: "exec", input: { command: "verify fixture", workdir: projectRoot } }] } },
    { type: "user", uuid: "original-result", message: { content: [{ type: "tool_result", tool_use_id: "business-check", content: "Observed current result." }] } }], digest: "original-snapshot" };
  const input = { projectRoot, taskId, role: "stop-reviewer", reviewer: { timeoutMs: 10000 }, deadlineAt: Date.now() + 30000,
    request: { population, groundTruthPath, fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: "VERIFICATION" },
      reviewScope: { objectIds: [object.objectId], sourceIds: [object.sourceId] }, instructions: ["Check only the frozen assigned object."] },
    evidence: { groundTruth: truth, snapshot, population } };
  if (projectFile) input.request.artifactCandidates = [{ artifactId: "fixture-candidate", metricIds: [metricId],
    files: [{ path: "candidate.md", sha256: sha256(await fs.readFile(source)) }],
    declaration: { configPath: null, configSha256: null, digest: sha256({ fixture: true, metricId }) } }];
  return { projectRoot, directory, taskId, source, input, object, truth };
}

// These are explicitly known witnesses authored by this fixture, never an
// arbitrary first copied file or a targetFiles seed supplied by the adapter.
async function result(options, { file = ["PROCESS_COMPLIANCE", "RUNTIME_ACCEPTANCE", "EXECUTION_CLOSURE"].includes(options.task.scope)
  ? "process/000000.json" : "project/candidate.md", verdict = "PASS" } = {}) {
  const bytes = await fs.readFile(path.join(options.root, file));
  const snapshot = path.join(options.outputDir, "frozen-source", file);
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await fs.writeFile(snapshot, bytes);
  return { completed: true, verdict, reason: "The selected witness supports only the assigned scope.",
    refs: [{ path: file, start: 1, end: Math.min(2, bytes.toString("utf8").split("\n").length), sha256: sha256(bytes) }] };
}
const judgement = handle => handle.result.metricObjectJudgements[0];

async function skillFixture(t, { captured = true, privateSource = false, sourceRef = "project/SKILL.md#L2", applicabilityKind, condition = "CURRENT_TASK" } = {}) {
  const f = await fixture(t, "M08", "PROCESS", { projectFile: false }), skillId = "build-offline-kitchen";
  const sourceRoot = privateSource ? path.join(f.directory, "skills", skillId, "source") : path.join(f.projectRoot, "skills", skillId);
  await fs.mkdir(path.join(sourceRoot, "references"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "SKILL.md"), "# Kitchen Skill\nBefore completion, run the verifier. If it fails, fix and retry; require successful output.\nSee references/conditions.md for the preservation condition.\n");
  await fs.writeFile(path.join(sourceRoot, "references/conditions.md"), "Preserve frozen inputs, including when an optional configuration is absent.\n");
  const source = await scanSkillDirectory(sourceRoot);
  const saved = await persistSkillGroundTruth({ projectRoot: f.projectRoot, taskId: f.taskId, skillId, skillDigest: source.digest,
    constraints: [{ constraintId: "verify", modality: "MUST", kind: "STEP", statement: "Before completion, run the verifier.", condition,
      ...(applicabilityKind !== undefined ? { applicabilityKind } : {}), dependsOn: ["preserve"], sourceRef },
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
    for (const applicability of ["main-task", "MAIN_TASK", " current-task ", " MaIn-TaSk ", undefined, null, ""]) {
      const copy = structuredClone(f.input); copy.request.population.metrics[metric][0].applicability = applicability;
      assert.equal(canUseStopTaskReview(copy), true, `${metric}: ${String(applicability)}`);
    }
    for (const applicability of ["FUTURE_STAGE", "future-task", "if checkout occurs", "NOT_APPLICABLE", "main-task if ready", "main-task/future-task", "unknown", "   ", true, 1, {}, []]) {
      const copy = structuredClone(f.input); copy.request.population.metrics[metric][0].applicability = applicability;
      assert.equal(canUseStopTaskReview(copy), false);
    }
    const typed = structuredClone(f.input), object = typed.request.population.metrics[metric][0];
    object.applicability = "pantry set command";
    object.applicabilityKind = "CURRENT_TASK";
    assert.equal(canUseStopTaskReview(typed), true, `${metric}: typed current scope`);
    object.applicability = "CURRENT_TASK";
    for (const kind of ["CONDITIONAL", "FUTURE", "UNKNOWN", "file modifications", undefined, null, true, 1, {}, []]) {
      object.applicabilityKind = kind;
      assert.equal(canUseStopTaskReview(typed), false, `${metric}: present kind ${String(kind)}`);
    }
  }
});

test("typed routing keeps a scope carried only by applicability and does not turn kind into acceptance proof", async t => {
  const f = await fixture(t, "M01", "IMPLEMENTATION", { applicability: "pantry set command", applicabilityKind: "CURRENT_TASK", text: "R02: Retain zero-amount entries." });
  const original = await fs.readFile(f.input.request.groundTruthPath);
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(options.task.scope, "METRIC_ARTIFACT_REVIEW");
    assert.match(options.task.requirement, /applicabilityKind only selects the executor/u);
    assert.match(options.task.requirement, /does not prove/u);
    const parts = async name => JSON.parse((await Promise.all(options.task.basisFiles.filter(file => file.startsWith(`basis/${name}-`))
      .map(file => fs.readFile(path.join(options.root, file), "utf8")))).join(""));
    assert.equal((await parts("assigned-object")).object.applicability, "pantry set command");
    const claim = (await parts("ground-truth")).claims.find(row => row.claimId === "R1");
    assert.equal(claim.text, "R02: Retain zero-amount entries.");
    assert.equal(claim.applicability, "pantry set command");
    assert.equal(claim.applicabilityKind, "CURRENT_TASK");
    return { completed: true, verdict: "UNVERIFIED", reason: "Candidate requirement decomposition is not established.", refs: [] };
  } });
  assert.equal(judgement(handle).judgement, "UNVERIFIED");
  assert.deepEqual(await fs.readFile(f.input.request.groundTruthPath), original);
});

test("typed Skill kinds propagate while legacy documents and original nullable conditions remain readable", async t => {
  for (const kind of ["CURRENT_TASK", "CONDITIONAL", "FUTURE", "UNKNOWN"]) {
    const f = await skillFixture(t, { applicabilityKind: kind, condition: null });
    assert.equal(f.object.applicabilityKind, kind);
    assert.equal(f.skillDocument.constraints[0].condition, null);
    assert.equal(canUseStopTaskReview(f.input), kind === "CURRENT_TASK");
    if (kind === "CURRENT_TASK") {
      const handle = await runStopTaskReview(f.input, { runTask: options => result(options) });
      assert.equal(judgement(handle).judgement, "PASS");
    }
  }
  const legacy = await skillFixture(t);
  assert.equal(Object.hasOwn(legacy.object, "applicabilityKind"), false);
  assert.equal(canUseStopTaskReview(legacy.input), true);
});

test("main-task routing preserves the original applicability and formal Ground Truth in worker input", async t => {
  const f = await fixture(t, "M13", "PROCESS", { applicability: "main-task" });
  const originalInput = structuredClone(f.input), originalTruth = await fs.readFile(f.input.request.groundTruthPath);
  let calls = 0;
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    calls++;
    assert.equal(options.task.scope, "EXECUTION_CLOSURE");
    const part = async name => JSON.parse((await Promise.all(options.task.basisFiles.filter(file => file.startsWith(`basis/${name}-`))
      .map(file => fs.readFile(path.join(options.root, file), "utf8")))).join(""));
    assert.equal((await part("assigned-object")).object.applicability, "main-task");
    assert.equal((await part("ground-truth")).claims.find(claim => claim.claimId === "R1").applicability, "main-task");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.root, "original-ground-truth.json"), "utf8")), f.truth);
    return result(options);
  } });
  assert.equal(calls, 1);
  assert.equal(judgement(handle).judgement, "PASS");
  assert.deepEqual(f.input, originalInput);
  assert.deepEqual(await fs.readFile(f.input.request.groundTruthPath), originalTruth);
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
      assert.deepEqual(options.task.targetFiles, scope === "METRIC_ARTIFACT_REVIEW" ? ["project/candidate.md"] : []);
      assert.deepEqual({ promptAppend: options.promptAppend, reviewType: options.task.reviewType }, reviewPromptProfile(metric, scope));
      if (["SOURCE_IMPLEMENTATION", "METRIC_ARTIFACT_REVIEW"].includes(scope)) await assert.rejects(fs.stat(path.join(options.root, "process")), { code: "ENOENT" });
      else assert.equal((await fs.readdir(path.join(options.root, "process"))).length, 2);
      return result(options);
    } });
  });
});

test("M09 joins only implementation-owned source review and does not acquire process evidence", async t => {
  const f = await fixture(t, "M09", "IMPLEMENTATION"); f.input.role = "implementation-reviewer";
  const helper = path.join(f.projectRoot, "helper.py"); await fs.writeFile(helper, "def helper(): return True\n");
  f.input.request.sourceManifest = [f.source, helper].map(source => ({ path: source }));
  for (const entry of f.input.request.sourceManifest) entry.sha256 = sha256(await fs.readFile(entry.path));
  assert.equal(canUseStopTaskReview(f.input), true);
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(options.task.scope, "SOURCE_IMPLEMENTATION");
    assert.deepEqual(options.task.targetPrefixes, ["project/"]);
    assert.deepEqual(options.task.targetFiles, ["project/candidate.md"]);
    assert.equal(await fs.readFile(path.join(options.root, "project/helper.py"), "utf8"), await fs.readFile(helper, "utf8"));
    return result(options);
  } });
  assert.equal(judgement(handle).judgement, "PASS");
  const helperHandle = await runStopTaskReview(f.input, { runTask: options => result(options, { file: "project/helper.py" }) });
  assert.equal(judgement(helperHandle).judgement, "PASS");
  assert.equal(helperHandle.sourceCitations[0].path, helper);
  await assert.rejects(runStopTaskReview(f.input, { runTask: async options => {
    const checked = await result(options); checked.refs[0].sha256 = "0".repeat(64); return checked;
  } }), error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
  f.input.request.population.metrics.M09[0].verificationTarget = "PROCESS";
  assert.equal(canUseStopTaskReview(f.input), false);
});

test("process-only review needs no project file and cannot use the authoritative basis as its target", async t => {
  const f = await fixture(t, "M11", "PROCESS", { projectFile: false });
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    assert.deepEqual(options.task.targetFiles, []);
    assert.deepEqual(options.task.targetPrefixes, ["process/"]);
    assert.equal(options.task.basisFiles.some(file => file.startsWith("process/")), false);
    return result(options);
  } });
  assert.equal(judgement(handle).judgement, "PASS");
  assert.equal(handle.sourceCitations[0].frozen, true);
  await assert.rejects(runStopTaskReview(f.input, { runTask: options => result(options, { file: options.task.basisFiles[0] }) }),
    error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
});

test("an unbound process message does not manufacture an artifact subject, and proof owners cannot swap", async t => {
  const f = await fixture(t, "M02", "PROCESS", { projectFile: false });
  const handle = await runStopTaskReview(f.input, { runTask: () => assert.fail("No declared artifact subject.") });
  assert.equal(judgement(handle).judgement, "UNVERIFIED");
  const process = await fixture(t, "M11", "PROCESS");
  await assert.rejects(runStopTaskReview(process.input, { runTask: options => result(options, { file: "project/candidate.md" }) }),
    error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
  const coverage = await fixture(t, "M01", "ARTIFACT");
  await assert.rejects(runStopTaskReview(coverage.input, { runTask: options => result(options, { file: options.task.basisFiles[0] }) }),
    error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
});

test("an earlier configuration file is not manufactured into an artifact candidate", async t => {
  const f = await fixture(t, "M03", "ARTIFACT");
  await fs.mkdir(path.join(f.projectRoot, ".runtime-corrector"));
  await fs.writeFile(path.join(f.projectRoot, ".runtime-corrector/config.yaml"), "enabled: true\n");
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    assert.deepEqual(options.task.targetFiles, ["project/candidate.md"]);
    assert.deepEqual(options.task.targetPrefixes, ["project/"]);
    await assert.rejects(fs.stat(path.join(options.root, "project/.runtime-corrector/config.yaml")), { code: "ENOENT" });
    return result(options, { file: "project/candidate.md" });
  } });
  assert.equal(judgement(handle).judgement, "PASS");
});

test("unbound artifact metrics stay eligible but finish programmatically unverified before evidence capture", async t => {
  for (const metric of ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M09", "M10"]) await t.test(metric, async t => {
    const f = await fixture(t, metric, "ARTIFACT"), population = structuredClone(f.input.request.population);
    delete f.input.request.artifactCandidates;
    assert.equal(canUseStopTaskReview(f.input), true, "Missing subject must not route back to a native search.");
    const handle = await runStopTaskReview(f.input, { runTask: () => assert.fail("Unbound subject must not invoke a model.") });
    assert.equal(judgement(handle).judgement, "UNVERIFIED");
    assert.match(judgement(handle).reason, /has not been provided or established/u);
    assert.doesNotMatch(judgement(handle).reason, /does not exist|missing requirement|must create/iu);
    assert.deepEqual(await fs.readdir(path.join(handle.artifacts, "input")), [], "No project or process copy is needed.");
    assert.deepEqual(f.input.request.population, population);
    const report = calculateMetricReport({ population, judgements: handle.result.metricObjectJudgements, metricIds: [metric] });
    assert.equal(report.status, "UNVERIFIED");
    assert.equal(report.metrics[0].denominator, 1);
    assert.equal(report.metrics[0].numerator, 0);
    assert.equal(report.metrics[0].objects[0].hard, true);
  });
});

test("empty, invalid, mismatched or stale artifact bindings cannot dispatch a worker", async t => {
  const changes = {
    empty: input => { input.request.artifactCandidates = []; },
    wrongMetric: input => { input.request.artifactCandidates[0].metricIds = ["M05"]; },
    unknownMetric: input => { input.request.artifactCandidates[0].metricIds.push("M99"); },
    noFiles: input => { input.request.artifactCandidates[0].files = []; },
    missingFile: input => { input.request.artifactCandidates[0].files[0].path = "not-captured.md"; },
    staleHash: input => { input.request.artifactCandidates[0].files[0].sha256 = "0".repeat(64); },
    escape: input => { input.request.artifactCandidates[0].files[0].path = "../candidate.md"; },
    absolute: input => { input.request.artifactCandidates[0].files[0].path = path.join(input.projectRoot, "candidate.md"); },
    invalidDeclaration: input => { input.request.artifactCandidates[0].declaration.digest = "unverified declaration"; },
    privateSource: async input => {
      await fs.writeFile(path.join(input.projectRoot, ".env"), "PRIVATE_CANDIDATE_CANARY");
      input.request.artifactCandidates[0].files[0] = { path: ".env", sha256: sha256("PRIVATE_CANDIDATE_CANARY") };
    },
    configurationAsCandidate: async input => {
      const config = path.join(input.projectRoot, "config.yaml"), bytes = Buffer.from("artifacts: []\n");
      await fs.writeFile(config, bytes);
      input.request.artifactCandidates[0].files = [{ path: "config.yaml", sha256: sha256(bytes) }];
      Object.assign(input.request.artifactCandidates[0].declaration, { configPath: config, configSha256: sha256(bytes) });
    },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const f = await fixture(t, "M01", "ARTIFACT"); await change(f.input);
    const handle = await runStopTaskReview(f.input, { runTask: () => assert.fail("Invalid binding must not dispatch.") });
    assert.equal(judgement(handle).judgement, "UNVERIFIED");
    assert.deepEqual(await fs.readdir(path.join(handle.artifacts, "input")), []);
  });
});

test("bound artifacts keep complete candidate files off the prompt and require real candidate citations for P/D", async t => {
  const f = await fixture(t, "M01", "ARTIFACT"), second = path.join(f.projectRoot, "second.md");
  await fs.writeFile(second, "The candidate's genuine cross-referenced second unit.\n");
  f.input.request.artifactCandidates[0].files.push({ path: "second.md", sha256: sha256(await fs.readFile(second)) });
  for (const verdict of ["PASS", "DEVIATION"]) {
    const handle = await runStopTaskReview(f.input, { runTask: async options => {
      assert.deepEqual(options.task.targetFiles, ["project/candidate.md"], "Only one declared candidate is a navigation seed.");
      assert.deepEqual(options.task.targetPrefixes, ["project/"]);
      assert.equal(await fs.readFile(path.join(options.root, "project/second.md"), "utf8"), await fs.readFile(second, "utf8"));
      const bindings = JSON.parse(await fs.readFile(path.join(options.root, "candidate-bindings.json"), "utf8"));
      assert.equal(bindings[0].files.length, 2);
      assert.equal(options.task.basisFiles.some(file => file.includes("candidate-bindings")), false);
      assert.doesNotMatch(options.task.requirement, /Original process entries are available/u);
      return result(options, { file: "project/second.md", verdict });
    } });
    assert.equal(judgement(handle).judgement, verdict);
    assert(handle.reviewEvidence.files.includes(second));
  }
  for (const file of ["candidate-bindings.json", "basis/assigned-object-0000.txt"]) {
    await assert.rejects(runStopTaskReview(f.input, { runTask: options => result(options, { file }) }),
      error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
  }
});

test("all bound files and the real declaration config remain dependencies even without a selected citation", async t => {
  for (const changed of ["otherCandidate", "outsideConfig"]) await t.test(changed, async t => {
    const f = await fixture(t, "M05", "ARTIFACT"), other = path.join(f.projectRoot, "other.md");
    await fs.writeFile(other, "Another unit in the same acceptance artifact.\n");
    f.input.request.artifactCandidates[0].files.push({ path: "other.md", sha256: sha256(await fs.readFile(other)) });
    const config = path.join(path.dirname(f.projectRoot), `config-${path.basename(f.projectRoot)}.yaml`);
    await fs.writeFile(config, "artifacts: acceptance\n");
    t.after(() => fs.rm(config, { force: true }));
    Object.assign(f.input.request.artifactCandidates[0].declaration, { configPath: config, configSha256: sha256(await fs.readFile(config)) });
    await assert.rejects(runStopTaskReview(f.input, { runTask: async options => {
      assert.equal(options.task.targetFiles.includes(config), false);
      assert.equal((await fs.readdir(path.join(options.root, "project"))).includes(path.basename(config)), false);
      const answer = await result(options);
      await fs.appendFile(changed === "otherCandidate" ? other : config, "Changed after the frozen capture.\n");
      return answer;
    } }), error => error.code === "REVIEW_COLLECTION_STALE");
  });
});

test("an external real declaration config is checked without becoming business evidence or model source", async t => {
  const f = await fixture(t, "M02", "ARTIFACT"), config = path.join(path.dirname(f.projectRoot), `config-${path.basename(f.projectRoot)}.yaml`);
  await fs.writeFile(config, "PRIVATE_DECLARATION_BODY_NOT_MODEL_SOURCE\n");
  t.after(() => fs.rm(config, { force: true }));
  Object.assign(f.input.request.artifactCandidates[0].declaration, { configPath: config, configSha256: sha256(await fs.readFile(config)) });
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    const entries = await fs.readdir(path.join(options.root, "project"));
    assert.deepEqual(entries, ["candidate.md"]);
    assert.doesNotMatch(await fs.readFile(path.join(options.root, "candidate-bindings.json"), "utf8"), /PRIVATE_DECLARATION_BODY_NOT_MODEL_SOURCE/u);
    return result(options);
  } });
  assert.equal(judgement(handle).judgement, "PASS");
  assert.equal(handle.reviewEvidence.files.includes(config), false);
  assert.equal(Object.hasOwn(handle.reviewEvidence.fingerprints, config), false);
});

test("source and process standard/experience routes do not require an artifact candidate binding", async t => {
  for (const metric of ["M09", "M10"]) for (const target of ["IMPLEMENTATION", "PROCESS"]) {
    const f = await fixture(t, metric, target);
    delete f.input.request.artifactCandidates;
    let calls = 0;
    const handle = await runStopTaskReview(f.input, { runTask: async options => {
      calls++;
      assert.equal(options.task.scope, target === "IMPLEMENTATION" ? "SOURCE_IMPLEMENTATION" : "PROCESS_COMPLIANCE");
      return result(options);
    } });
    assert.equal(calls, 1);
    assert.equal(judgement(handle).judgement, "PASS");
  }
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
