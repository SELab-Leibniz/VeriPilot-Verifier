import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canUseStopTaskReview, runStopTaskReview } from "../lib/runtime-v2/stop-task-review.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

const classification = { stopClassification: "TASK_COMPLETE", stage: null };
const object = (sourceId = "R1", metricId = "M01", target = "ARTIFACT") => ({
  objectId: `${metricId}:${sourceId}`, sourceId, sourceRevisionId: `${sourceId}@1`, metricId,
  description: `Deliver the complete ${sourceId} obligation.`, verificationTarget: target,
  applicability: "CURRENT_TASK", hard: true, authority: "USER_EXPLICIT",
});
const populated = rows => ({ taskId: "stop-task-review", version: 1, groundTruthVersion: 1,
  digest: sha256(rows), metrics: Object.fromEntries([...new Set(rows.map(row => row.metricId))]
    .map(id => [id, rows.filter(row => row.metricId === id)])) });

async function fixture(t, rows = [object()]) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-task-review-test-runs/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "stop-task-review", directory = taskDirectory(root, taskId);
  const groundTruthPath = path.join(directory, "ground-truth/current.json");
  const claims = [...new Set(rows.map(row => row.sourceId))].map(claimId => ({
    claimId, revisionId: `${claimId}@1`, text: `Deliver the complete ${claimId} obligation.`, category: "requirements",
    status: "ACTIVE", severity: "HARD", authority: "USER_EXPLICIT", verificationTarget: rows.find(row => row.sourceId === claimId).verificationTarget,
    applicability: "CURRENT_TASK", source: { ref: "user:1", kind: "USER_MESSAGE", subject: "MAIN_TASK" },
  }));
  claims.push({ claimId: "COMMON", revisionId: "COMMON@1", category: "constraints", status: "ACTIVE", severity: "HARD",
    authority: "USER_EXPLICIT", text: "Preserve Unicode names. If optional configuration is absent, use the declared default. Never write protected audit files.",
    applicability: "CURRENT_TASK", verificationTarget: "ARTIFACT", source: { ref: "user:1", kind: "USER_MESSAGE", subject: "MAIN_TASK" } });
  const truth = { version: 1, digest: sha256(claims), frozenAtVersion: 1, claims };
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  const state = { taskId, groundTruth: { version: truth.version, digest: truth.digest }, correctionEpoch: { id: 1 }, control: { generation: 1, cancelEpoch: 0 } };
  await fs.writeFile(path.join(directory, "task.json"), JSON.stringify(state));
  const source = path.join(root, "spec.md");
  await fs.writeFile(source, "# Requirement decomposition\nThe current deliverable covers each declared requirement.\n");
  const population = populated(rows);
  const snapshot = { digest: "stop-task-snapshot", entries: [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "write-spec", name: "write", input: { path: source, content: "Current candidate." } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "write-spec", content: "written" }] } },
  ] };
  const input = { projectRoot: root, taskId, role: "stop-reviewer", reviewer: { timeoutMs: 3000 },
    request: { population, groundTruthPath, reviewScope: { objectIds: rows.map(row => row.objectId), sourceIds: [...new Set(rows.map(row => row.sourceId))] },
      fixedStopClassification: classification, instructions: ["Judge the current frozen obligation."] },
    evidence: { groundTruth: truth, population, snapshot }, deadlineAt: Date.now() + 30000 };
  input.request.artifactCandidates = [{ artifactId: "fixture-decomposition", metricIds: [...new Set(rows.map(row => row.metricId))],
    files: [{ path: "spec.md", sha256: sha256(await fs.readFile(source)) }],
    declaration: { configPath: null, configSha256: null, digest: sha256({ fixture: true }) } }];
  return { root, directory, source, truth, state, groundTruthPath, population, input };
}

async function scriptedResult(options, verdict = "PASS", reason = "The checked current source establishes this obligation.") {
  const file = "project/spec.md", content = await fs.readFile(path.resolve(options.root, file));
  const refs = [{ path: file, start: 1, end: Math.min(2, content.toString("utf8").split("\n").length), sha256: sha256(content) }];
  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.writeFile(path.join(options.outputDir, "reads.json"), JSON.stringify(refs.map(({ path: selected, start, end }) => ({ path: selected, start, end }))));
  const result = { taskId: options.task.id, scope: options.task.scope, completed: true, verdict, reason, refs,
    metrics: { turns: 1, toolCalls: 2, readBytes: content.length, repeatedLines: 0 }, attempts: 1, elapsedMs: 1 };
  await fs.writeFile(path.join(options.outputDir, "result.json"), JSON.stringify(result));
  return result;
}

const judgement = handle => handle.result.metricObjectJudgements[0];

test("eligibility admits all current single-object metrics while keeping unsupported review work native", () => {
  const input = (metric, role = "stop-reviewer", target = "ARTIFACT") => {
    const row = object("R1", metric, target);
    return { role, request: { population: populated([row]), fixedStopClassification: classification,
      reviewScope: { objectIds: [row.objectId], sourceIds: [row.sourceId] } } };
  };
  assert.equal(canUseStopTaskReview(input("M01")), true);
  assert.equal(canUseStopTaskReview(input("M05")), true);
  assert.equal(canUseStopTaskReview(input("M12", "implementation-reviewer", "IMPLEMENTATION")), true);
  assert.equal(canUseStopTaskReview(input("M12", "stop-reviewer", "IMPLEMENTATION")), true);
  assert.equal(canUseStopTaskReview(input("M02")), true);
  assert.equal(canUseStopTaskReview(input("M09", "implementation-reviewer", "IMPLEMENTATION")), true);
  assert.equal(canUseStopTaskReview(input("M01", "stop-reviewer", "PROCESS")), true);
  assert.equal(canUseStopTaskReview(input("M12", "stop-reviewer", "ARTIFACT")), true);
  for (const value of [input("M12", "implementation-reviewer", "PROCESS"), input("M01", "ground-truth-reviewer"), input("M99")])
    assert.equal(canUseStopTaskReview(value), false);
  const later = input("M01"); later.request.population.metrics.M01[0].applicability = "FUTURE_STAGE";
  assert.equal(canUseStopTaskReview(later), false);
  const pending = input("M01"); pending.request.population.metrics.M01[0].authority = "BASIS_PENDING";
  assert.equal(canUseStopTaskReview(pending), false);
  for (const status of ["INTERMEDIATE", "USER_BLOCKED", "STAGE_COMPLETE"]) {
    const value = input("M01"); value.request.fixedStopClassification = { stopClassification: status, stage: "design" };
    assert.equal(canUseStopTaskReview(value), false);
  }
  const classifier = input("M01"); classifier.request.reviewScope.kind = "classification";
  assert.equal(canUseStopTaskReview(classifier), false);
  const findingsOnly = input("M01"); findingsOnly.request.reviewScope.findingsOnly = true;
  assert.equal(canUseStopTaskReview(findingsOnly), false);
  const multiple = input("M01"); multiple.request.population = populated([object("R1"), object("R2")]);
  multiple.request.reviewScope.objectIds.push("M01:R2");
  assert.equal(canUseStopTaskReview(multiple), false);
});

test("acceptance coverage and source/runtime proof tasks receive the correct selected prompt and scope", async t => {
  for (const config of [
    { metric: "M05", role: "stop-reviewer", target: "ARTIFACT", scope: "METRIC_ARTIFACT_REVIEW", prompt: /M05 judges coverage/u },
    { metric: "M12", role: "implementation-reviewer", target: "IMPLEMENTATION", scope: "SOURCE_IMPLEMENTATION", prompt: /proof before PASS/u },
    { metric: "M12", role: "stop-reviewer", target: "IMPLEMENTATION", scope: "RUNTIME_ACCEPTANCE", prompt: "" },
  ]) await t.test(`${config.metric}/${config.scope}`, async t => {
    const f = await fixture(t, [object("R1", config.metric, config.target)]);
    f.input.role = config.role;
    if (config.role === "implementation-reviewer") f.input.request.sourceManifest = [{ path: f.source, sha256: sha256(await fs.readFile(f.source)) }];
    const handle = await runStopTaskReview(f.input, { runTask: async options => {
      assert.equal(options.task.scope, config.scope);
      if (config.prompt instanceof RegExp) assert.match(options.promptAppend, config.prompt);
      else assert.equal(options.promptAppend, config.prompt);
      if (config.scope === "RUNTIME_ACCEPTANCE") {
        assert.equal(options.task.basisFiles.some(file => file.includes("process")), false, "Full process material must stay on demand.");
        assert.equal((await fs.readdir(path.join(options.root, "process"))).length, f.input.evidence.snapshot.entries.length);
        return scriptedResult(options, "UNVERIFIED", "No attributable current execution establishes the required runtime result.");
      }
      return scriptedResult(options);
    } });
    assert.equal(judgement(handle).judgement, config.scope === "RUNTIME_ACCEPTANCE" ? "UNVERIFIED" : "PASS");
  });
});

test("the Stop task adapter freezes complete common conditions and maps checked citations back to project files", async t => {
  const f = await fixture(t);
  let invoked = 0;
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    invoked++;
    assert.equal(options.task.metricId, "M01");
    assert.match(options.promptAppend, /semantic coverage/iu);
    assert.ok(options.outputDir.startsWith(path.join(f.directory, "review-task-runs")));
    const basis = (await Promise.all(options.task.basisFiles.map(file => fs.readFile(path.resolve(options.root, file), "utf8")))).join("\n");
    assert.match(basis, /Preserve Unicode names/u);
    assert.match(basis, /If optional configuration is absent/u);
    assert.match(basis, /Never write protected audit files/u);
    return scriptedResult(options);
  } });
  assert.equal(invoked, 1);
  assert.equal(judgement(handle).objectId, "M01:R1");
  assert.equal(judgement(handle).judgement, "PASS");
  assert.equal(handle.result.stopClassification, "TASK_COMPLETE");
  assert.ok(judgement(handle).evidence.some(ref => ref.includes("spec.md")));
  const citations = await handle.getSourceCitations?.(handle.result) ?? handle.sourceCitations ?? [];
  assert.ok(citations.length > 0);
  assert.ok(citations.some(ref => ref.path === f.source));
  assert.ok(handle.reviewEvidence.files.includes(f.source));
  assert.equal(handle.reviewEvidence.unstable, false);
  await handle.close?.();
  assert.equal(await fs.readFile(f.source, "utf8"), "# Requirement decomposition\nThe current deliverable covers each declared requirement.\n");
});

test("a completed negative review retains a concrete diagnosis and the assigned bare requirement identity", async t => {
  const f = await fixture(t);
  const handle = await runStopTaskReview(f.input, { runTask: options => scriptedResult(options, "DEVIATION", "The candidate omits the required gate, allowing an unacknowledged handover.") });
  assert.equal(judgement(handle).judgement, "DEVIATION");
  assert.match(judgement(handle).reason, /unacknowledged/u);
  assert.ok(judgement(handle).evidence.length > 0);
  for (const finding of handle.result.findings ?? []) assert.deepEqual(finding.violatedGroundTruthIds, ["R1"]);
});

test("a missing review target never reaches the model or manufactures PASS", async t => {
  const f = await fixture(t);
  await fs.rm(f.source);
  f.input.evidence.snapshot.entries = [];
  let calls = 0;
  const handle = await runStopTaskReview(f.input, { runTask: async () => { calls++; throw new Error("must not run without a target"); } });
  assert.equal(calls, 0);
  assert.equal(judgement(handle).judgement, "UNVERIFIED");
});

test("cancellation before dispatch does not invoke a worker or publish a result", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(runStopTaskReview({ ...f.input, abortSignal: controller.signal }, {
    runTask: async () => { calls++; throw new Error("must not run after cancellation"); },
  }), error => error.code === "REVIEW_COLLECTION_CANCELLED");
  assert.equal(calls, 0);
});

test("cancellation after a worker decision fences late PASS publication", async t => {
  const f = await fixture(t), controller = new AbortController();
  let invoked = false;
  await assert.rejects(runStopTaskReview({ ...f.input, abortSignal: controller.signal }, { runTask: async options => {
    invoked = true;
    assert.equal(options.signal?.aborted, false);
    const result = await scriptedResult(options);
    controller.abort();
    assert.equal(options.signal.aborted, true);
    return result;
  } }), error => error.code === "REVIEW_COLLECTION_CANCELLED");
  assert.equal(invoked, true);
});

test("Ground Truth changes during review fence the old PASS", async t => {
  const f = await fixture(t);
  let invoked = false;
  await assert.rejects(runStopTaskReview(f.input, { runTask: async options => {
    invoked = true;
    const result = await scriptedResult(options);
    await fs.writeFile(f.groundTruthPath, JSON.stringify({ ...f.truth, version: 2, digest: "new-ground-truth" }));
    return result;
  } }), error => error.code === "REVIEW_COLLECTION_STALE");
  assert.equal(invoked, true);
});

test("a replacement task generation cannot receive an earlier worker PASS", async t => {
  const f = await fixture(t);
  let invoked = false;
  await assert.rejects(runStopTaskReview(f.input, { runTask: async options => {
    invoked = true;
    const result = await scriptedResult(options);
    await fs.writeFile(path.join(f.directory, "task.json"), JSON.stringify({ ...f.state,
      control: { ...f.state.control, generation: f.state.control.generation + 1 } }));
    return result;
  } }), error => error.code === "REVIEW_COLLECTION_STALE");
  assert.equal(invoked, true);
});

test("the existing dispatch deadline prevents a late valid worker result from becoming PASS", async t => {
  const f = await fixture(t);
  await assert.rejects(runStopTaskReview({ ...f.input, deadlineAt: Date.now() + 250 }, { runTask: async options => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return scriptedResult(options);
  } }), error => error.code === "REVIEW_ITEM_TIMEOUT");
});

test("a changed candidate cannot be published using its earlier frozen PASS", async t => {
  const f = await fixture(t);
  let invoked = false;
  await assert.rejects(runStopTaskReview(f.input, { runTask: async options => {
    invoked = true;
    const result = await scriptedResult(options);
    await fs.writeFile(f.source, "The candidate has now changed.\n");
    return result;
  } }), error => error.code === "REVIEW_COLLECTION_STALE");
  assert.equal(invoked, true);
});

test("implementation manifests cannot expose private files or sources outside the project", async t => {
  const f = await fixture(t, [object("R1", "M12", "IMPLEMENTATION")]);
  f.input.role = "implementation-reviewer";
  const privateFile = path.join(f.root, ".env");
  await fs.writeFile(privateFile, "PRIVATE_CANARY_MUST_NOT_REACH_A_WORKER\n");
  const outside = path.join(path.dirname(f.root), `outside-${path.basename(f.root)}.txt`);
  await fs.writeFile(outside, "OUTSIDE_CANARY_MUST_NOT_REACH_A_WORKER\n");
  t.after(() => fs.rm(outside, { force: true }));
  let calls = 0;
  for (const source of [privateFile, outside, f.groundTruthPath]) {
    const input = { ...f.input, request: { ...f.input.request, sourceManifest: [{ path: source, sha256: sha256(await fs.readFile(source)) }] } };
    await assert.rejects(runStopTaskReview(input, { runTask: async () => { calls++; throw new Error("unauthorized model call"); } }),
      error => error.code === "REVIEW_ITEM_SOURCE_INVALID");
  }
  assert.equal(calls, 0);
});

test("a worker cannot establish PASS by changing the captured citation hash", async t => {
  const f = await fixture(t);
  await assert.rejects(runStopTaskReview(f.input, { runTask: async options => {
    const result = await scriptedResult(options);
    result.refs[0].sha256 = "0".repeat(64);
    return result;
  } }), error => error.code === "REVIEW_ITEM_EVIDENCE_INVALID");
});

test("the production collector retains PASS and DEVIATION siblings when one task worker does not complete", async t => {
  const rows = [object("R1"), object("R2"), object("R3")], f = await fixture(t, rows);
  let calls = 0;
  const factory = options => runStopTaskReview(options, { runTask: async worker => {
    const index = calls++;
    if (index === 1) return { completed: false, verdict: "UNVERIFIED", reason: "Context guard stopped this item before a valid submission.", refs: [] };
    return scriptedResult(worker, index === 0 ? "DEVIATION" : "PASS", index === 0 ? "The required gate is absent, allowing an unacknowledged handover." : undefined);
  } });
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: factory, schema: STOP_REVIEW_SCHEMA, classification });
  assert.equal(calls, 3);
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["DEVIATION", "UNVERIFIED", "PASS"]);
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.collection.totalObjects, rows.length);
  assert.equal(handle.collection.failures.length, 1);
  const first = JSON.parse(await fs.readFile(handle.collection.items[0].path, "utf8"));
  assert.equal(first.result.metricObjectJudgements[0].judgement, "DEVIATION");
  assert.equal(first.result.metricObjectJudgements[0].evidence.length > 0, true);
});

test("the task worker receives one object at a time even for different metrics of the same obligation", async t => {
  const f = await fixture(t, [object("R1", "M01"), object("R1", "M05")]);
  const seen = [];
  const factory = options => {
    const assigned = Object.values(options.request.population.metrics).flat();
    assert.equal(assigned.length, 1);
    assert.equal(canUseStopTaskReview(options), true);
    seen.push(assigned[0].objectId);
    return runStopTaskReview(options, { runTask: scriptedResult });
  };
  factory.reviewItemSize = 1;
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: factory, schema: STOP_REVIEW_SCHEMA, classification });
  assert.deepEqual(seen, ["M01:R1", "M05:R1"]);
  assert.equal(handle.collection.totalItems, 2);
  assert.equal(handle.collection.complete, true);
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["PASS", "PASS"]);
});

test("production PASS reuse checks the adapter's observed sources and skips unchanged successful workers", async t => {
  const f = await fixture(t, [object("R1", "M01"), object("R1", "M05")]);
  let calls = 0;
  const factory = options => runStopTaskReview(options, { runTask: async worker => { calls++; return scriptedResult(worker); } });
  factory.reviewItemSize = 1;
  factory.reviewCacheIdentity = () => "scripted-stop-task-review/selected-profile-v1";
  const run = () => collectReviewItems({ ...f.input, reviewerFactory: factory, schema: STOP_REVIEW_SCHEMA, classification });
  const first = await run(), second = await run();
  assert.equal(first.collection.complete, true);
  assert.equal(calls, 2);
  assert.equal(second.collection.reusedItems, 2);
  assert.equal(second.collection.complete, true);
  await fs.appendFile(f.source, "The reviewed artifact now has different content.\n");
  f.input.request.artifactCandidates[0].files[0].sha256 = sha256(await fs.readFile(f.source));
  const third = await run();
  assert.equal(third.collection.complete, true);
  assert.equal(calls, 4, "A content change requires fresh review for both dependent metric objects.");
  assert.equal(third.collection.reusedItems, 0);
});
