import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { METRIC_CATALOG } from "../lib/runtime-v2/metrics.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { IMPL_REVIEW_SCHEMA } from "../lib/runtime-v2/impl-review.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

const classification = { stopClassification: "TASK_COMPLETE", stage: null };
const objectsOf = input => Object.values(input.request.population.metrics).flat();

async function fixture(t, metrics = ["M01"]) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/supplemental-review-test-runs/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "supplemental-test", taskRoot = path.join(root, ".runtime-correction/tasks", taskId);
  const groundTruthPath = path.join(taskRoot, "ground-truth/current.json"), source = path.join(root, "delivery.md");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(source, "Current deliverable body.\nIts coverage and file quality are separate proofs.\n");
  const groundTruth = { version: 1, digest: "ground-truth-test", claims: [
    { claimId: "R1", revisionId: "R1@1", text: "Deliver the requested content." },
  ] };
  await fs.writeFile(groundTruthPath, JSON.stringify(groundTruth));
  await fs.writeFile(path.join(taskRoot, "task.json"), JSON.stringify({ taskId, groundTruth: { version: 1, digest: groundTruth.digest },
    correctionEpoch: { id: "epoch-1" }, control: { generation: 1, cancelEpoch: 0 } }));
  const population = { version: 1, groundTruthVersion: 1, metrics: Object.fromEntries(metrics.map(metricId => [metricId, [{
    objectId: `${metricId}:R1`, metricId, sourceId: "R1", sourceRevisionId: "R1@1", description: "Deliver the requested content.",
    verificationTarget: "ARTIFACT", authority: "USER_EXPLICIT", applicability: "CURRENT_TASK",
  }]])) };
  const input = { projectRoot: root, taskId, role: "stop-reviewer", reviewer: { timeoutMs: 1000 }, classification,
    schema: STOP_REVIEW_SCHEMA, request: { groundTruthPath, population, instructions: ["Check only assigned metric obligations."],
      supplementalFileAssessments: true, supplementalFileAssessmentInstructions: ["Judge CURRENT requested deliverable file quality against its original obligations."] },
    evidence: { groundTruth, population, snapshot: { entries: [], digest: "snapshot-test" } } };
  const fileAssessment = (status = "PASS", evidence = [`${source}#L1-L2`]) => ({ path: source, status,
    reason: "Current file quality was checked independently of coverage.", evidence });
  const output = (params, extra = {}) => ({ summary: "Checked the current assigned evidence.", ...params.request.fixedStopClassification,
    findings: [], fileAssessments: [], metricObjectJudgements: objectsOf(params).map(object => ({ objectId: object.objectId,
      judgement: "PASS", reason: "The current source supports this assigned metric object.", evidence: [`${source}#L1-L2`] })), ...extra });
  const calls = [];
  const factory = (callback = null) => {
    const run = async params => {
      calls.push(params);
      return { result: callback ? await callback(params) : output(params, params.request.reviewScope.kind === "file-quality"
        ? { fileAssessments: [fileAssessment()] } : {}),
        reviewEvidence: { files: [source], fingerprints: { [source]: sha256(await fs.readFile(source)) }, unstable: false, missing: [] }, close() {} };
    };
    run.reviewItemSize = 1; run.singleReviewMetrics = Object.keys(METRIC_CATALOG);
    run.supportsSupplementalFileAssessment = true;
    run.reviewCacheIdentity = () => "supplemental-factory-test-v2";
    return run;
  };
  return { root, source, taskRoot, input, calls, factory, output, fileAssessment };
}

async function boundFiles(f) {
  const second = path.join(f.root, "second.md");
  await fs.writeFile(second, "Another real requested delivery file.\nIndependent content quality.\n");
  f.input.request.artifactCandidates = [{ artifactId: "requested-delivery", metricIds: [],
    files: await Promise.all([f.source, second].map(async file => ({ path: path.basename(file), sha256: sha256(await fs.readFile(file)) }))),
    declaration: { configPath: null, configSha256: null, digest: sha256("explicit-fixture-delivery") } }];
  // Repeating an identical declared file must not multiply quality calls.
  f.input.request.artifactCandidates[0].files.push({ ...f.input.request.artifactCandidates[0].files[0] });
  return second;
}

test("known delivery files each own one durable quality item without changing the metric denominator", async t => {
  const f = await fixture(t), second = await boundFiles(f);
  const factory = f.factory(params => {
    const target = params.request.reviewScope.qualityTarget;
    if (!target) return f.output(params);
    assert.equal(objectsOf(params).length, 0);
    assert.equal(params.request.reviewScope.kind, "file-quality");
    assert.deepEqual(Object.keys(target).sort(), ["artifactId", "path", "sha256"]);
    return f.output(params, { fileAssessments: [{ path: target.path, status: target.path === "delivery.md" ? "PASS" : "DEVIATION",
      reason: "This file's current content has been assessed.", evidence: [`${path.join(f.root, target.path)}#L1-L2`] }] });
  });
  const first = await collectReviewItems({ ...f.input, reviewerFactory: factory });
  assert.equal(f.calls.length, 3);
  assert.equal(first.collection.totalObjects, 1);
  assert.equal(first.collection.reviewedObjects, 1);
  assert.equal(first.collection.totalItems, 3);
  assert.equal(first.collection.complete, true);
  assert.deepEqual(first.result.fileAssessments.map(row => [row.path, row.status]), [["delivery.md", "PASS"], ["second.md", "DEVIATION"]]);
  for (const item of first.collection.items.slice(1)) {
    const saved = JSON.parse(await fs.readFile(item.path, "utf8"));
    assert.equal(saved.kind, "file-quality"); assert.deepEqual(saved.objectIds, []);
    assert.equal(saved.passReuseItemKey, undefined);
    assert.equal(saved.qualityTarget.path, saved.result.fileAssessments[0].path);
  }
  assert.equal(first.sourceCitations.some(citation => citation.path === second), true);
  await collectReviewItems({ ...f.input, reviewerFactory: factory });
  assert.equal(f.calls.length, 5, "Only the one metric PASS can be reused; both file-quality items run again.");
});

test("a later quality failure keeps earlier file and metric results and names the failed file U", async t => {
  const f = await fixture(t); await boundFiles(f);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(params => {
    const target = params.request.reviewScope.qualityTarget;
    if (!target) return f.output(params);
    if (target.path === "second.md") throw Object.assign(new Error("The later file worker failed."), { code: "CONTEXT_UNSAFE" });
    return f.output(params, { fileAssessments: [{ path: target.path, status: "PASS", reason: "Current delivery checked.", evidence: [`${f.source}#L1-L2`] }] });
  }) });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
  assert.deepEqual(handle.result.fileAssessments.map(row => [row.path, row.status]), [["delivery.md", "PASS"], ["second.md", "UNVERIFIED"]]);
  assert.deepEqual(handle.result.fileAssessments[1].evidence, []);
  assert.equal(handle.collection.complete, false);
  assert.deepEqual(handle.collection.failures[0].objectIds, []);
  assert.equal(JSON.parse(await fs.readFile(handle.collection.items[1].path, "utf8")).result.fileAssessments[0].status, "PASS");
});

test("stage completion keeps one native quality duty even when delivery bindings exist", async t => {
  const f = await fixture(t); await boundFiles(f);
  await collectReviewItems({ ...f.input, classification: { stopClassification: "STAGE_COMPLETE", stage: "planning" },
    reviewerFactory: f.factory() });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).request.reviewScope.kind, "file-quality");
  assert.equal(f.calls.at(-1).request.reviewScope.qualityTarget, undefined);
});

test("a declared quality file cannot be proved by another file or returned under a foreign path", async t => {
  for (const wrong of ["source", "path"]) await t.test(wrong, async t => {
    const f = await fixture(t); await boundFiles(f);
    const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(params => {
      const target = params.request.reviewScope.qualityTarget;
      if (!target) return f.output(params);
      return f.output(params, { fileAssessments: [{ path: wrong === "path" ? "foreign.md" : target.path, status: "PASS",
        reason: "Unrelated proof cannot certify this file.", evidence: [`${wrong === "source" ? path.join(f.root, target.path === "delivery.md" ? "second.md" : "delivery.md") : f.source}#L1`] }] });
    }) });
    assert.equal(handle.collection.complete, false);
    assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
    assert.equal(handle.result.fileAssessments.every(row => row.status === "UNVERIFIED"), true);
    assert.deepEqual(handle.result.fileAssessments.map(row => row.path), ["delivery.md", "second.md"]);
  });
});

test("the existing shared cutoff records every unstarted known quality target without invented metric rows", async t => {
  const f = await fixture(t); await boundFiles(f);
  const started = Date.now(), deadlineAt = started + 30000; let now = started;
  t.mock.method(Date, "now", () => now);
  const handle = await collectReviewItems({ ...f.input, deadlineAt, reviewerFactory: f.factory(params => {
    now = deadlineAt - 1000; return f.output(params);
  }) });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.collection.totalObjects, 1);
  assert.equal(handle.collection.totalItems, 3);
  assert.equal(handle.collection.items.slice(1).every(item => item.unstarted && item.qualityTarget), true);
  assert.deepEqual(handle.result.fileAssessments.map(row => [row.path, row.status]), [["delivery.md", "UNVERIFIED"], ["second.md", "UNVERIFIED"]]);
  assert.equal(handle.result.metricObjectJudgements.length, 1);
});

test("task collection assigns all fifteen metrics independently and checks file quality exactly once afterward", async t => {
  const f = await fixture(t, Object.keys(METRIC_CATALOG));
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(params => {
    const quality = params.request.reviewScope.kind === "file-quality";
    assert.equal(params.request.supplementalFileAssessments, undefined);
    assert.equal(params.request.supplementalFileAssessmentInstructions, undefined);
    if (quality) {
      assert.equal(objectsOf(params).length, 0);
      assert.deepEqual(params.request.reviewScope.objectIds, []);
      assert.deepEqual(params.request.reviewScope.sourceIds, ["R1"]);
      assert.equal(params.schema.properties.metricObjectJudgements.maxItems, 0);
      assert.equal(params.schema.properties.findings.maxItems, 0);
      assert.ok(params.request.instructions.some(line => line.includes("Do not read generated metric reports")));
      assert.equal(params.request.instructions.includes("Check only assigned metric obligations."), false);
    } else {
      assert.equal(objectsOf(params).length, 1);
      assert.equal(params.schema.properties.fileAssessments.maxItems, 0);
      assert.equal(params.request.instructions.some(line => line.includes("CURRENT requested deliverable file quality")), false);
    }
    return f.output(params, quality ? { fileAssessments: [f.fileAssessment("DEVIATION")] } : {});
  }) });
  assert.equal(f.calls.length, 16);
  assert.equal(f.calls.at(-1).request.reviewScope.kind, "file-quality");
  assert.equal(handle.collection.totalObjects, 15);
  assert.equal(handle.collection.reviewedObjects, 15);
  assert.equal(handle.collection.totalItems, 16);
  assert.equal(handle.collection.completedItems, 16);
  assert.equal(handle.collection.complete, true);
  assert.equal(handle.result.metricObjectJudgements.length, 15);
  assert.ok(handle.result.metricObjectJudgements.every(row => row.judgement === "PASS"));
  assert.equal(handle.result.fileAssessments[0].status, "DEVIATION", "A coverage PASS must not become a file-quality PASS.");
  const saved = JSON.parse(await fs.readFile(handle.collection.items.at(-1).path, "utf8"));
  assert.equal(saved.kind, "file-quality"); assert.deepEqual(saved.objectIds, []);
  assert.equal(saved.passReuseItemKey, undefined);
});

test("supplemental file review requires both flags and leaves direct native collection behavior intact", async t => {
  for (const [requested, supported] of [[false, false], [true, false], [false, true]]) await t.test(`${requested}/${supported}`, async t => {
    const f = await fixture(t), factory = f.factory(params => f.output(params, { fileAssessments: [f.fileAssessment()] }));
    f.input.request.supplementalFileAssessments = requested; factory.supportsSupplementalFileAssessment = supported;
    const handle = await collectReviewItems({ ...f.input, reviewerFactory: factory });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].schema.properties.fileAssessments.maxItems, STOP_REVIEW_SCHEMA.properties.fileAssessments.maxItems);
    assert.equal(handle.result.fileAssessments.length, 1);
  });
});

test("supplemental review is completion-scoped and never added to findings-only or implementation work", async t => {
  for (const stopClassification of ["TASK_COMPLETE", "STAGE_COMPLETE", "INTERMEDIATE"]) await t.test(stopClassification, async t => {
    const f = await fixture(t);
    const fixed = { stopClassification, stage: stopClassification === "STAGE_COMPLETE" ? "planning" : null };
    await collectReviewItems({ ...f.input, classification: fixed, reviewerFactory: f.factory() });
    assert.equal(f.calls.length, stopClassification === "INTERMEDIATE" ? 1 : 2);
    if (stopClassification === "INTERMEDIATE") assert.equal(f.calls[0].request.reviewScope.findingsOnly, true);
  });
  await t.test("implementation role", async t => {
    const f = await fixture(t, ["M12"]);
    const handle = await collectReviewItems({ ...f.input, role: "implementation-reviewer", schema: IMPL_REVIEW_SCHEMA, classification: null,
      request: { ...f.input.request, sourceManifest: [{ path: f.source, sha256: sha256(await fs.readFile(f.source)) }] },
      reviewerFactory: f.factory(params => { const report = f.output(params); delete report.fileAssessments; return report; }) });
    assert.equal(f.calls.length, 1);
    assert.equal(handle.collection.complete, true);
    assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
  });
});

test("a failed file-quality transport preserves all completed metric rows and an explicit empty-owned failed item", async t => {
  const f = await fixture(t, ["M01", "M05"]);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(params => {
    if (params.request.reviewScope.kind === "file-quality") throw Object.assign(new Error("The supplemental session overflowed."), { code: "CONTEXT_UNSAFE" });
    return f.output(params);
  }) });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["PASS", "PASS"]);
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.collection.failures[0].code, "CONTEXT_UNSAFE");
  assert.deepEqual(handle.collection.failures[0].objectIds, []);
  assert.equal(handle.collection.reviewedObjects, 2);
  assert.equal(handle.collection.items.at(-1).kind, "file-quality");
  assert.equal(handle.collection.items.at(-1).status, "UNVERIFIED");
});

test("a metric item cannot publish the separately owned supplemental file verdict", async t => {
  const f = await fixture(t);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(params =>
    f.output(params, { fileAssessments: [f.fileAssessment()] })) });
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_OWNERSHIP_INVALID");
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  assert.equal(handle.result.fileAssessments.length, 1, "The separate quality item still produces its own checked verdict.");
  assert.equal(handle.collection.items.at(-1).status, "COMPLETED");
});

test("file-quality evidence and empty ownership reject invalid ranges, private reports and foreign metric rows", async t => {
  for (const kind of ["range", "private", "foreign", "finding"]) await t.test(kind, async t => {
    const f = await fixture(t);
    const privateFile = path.join(f.taskRoot, "old-review.json"); await fs.writeFile(privateFile, "A prior review claims PASS.\n");
    const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(params => {
      if (params.request.reviewScope.kind !== "file-quality") return f.output(params);
      const report = f.output(params, { fileAssessments: [f.fileAssessment("PASS", [kind === "range" ? `${f.source}#L999` : kind === "private" ? `${privateFile}#L1` : `${f.source}#L1`])] });
      if (kind === "foreign") report.metricObjectJudgements.push({ objectId: "M01:FOREIGN", judgement: "PASS", reason: "Foreign.", evidence: [`${f.source}#L1`] });
      if (kind === "finding") report.findings.push({ deviationKey: "unowned", rootCauseId: "OTHER", severity: "error", reason: "Unowned.",
        actualEvidence: [`${f.source}#L1`], expectedConstraint: "Unowned.", violatedGroundTruthIds: ["R1"] });
      return report;
    }) });
    assert.equal(handle.collection.complete, false);
    assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.objectId), ["M01:R1"]);
    assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
    assert.deepEqual(handle.result.fileAssessments, []);
    assert.deepEqual(handle.result.findings, []);
    assert.equal(handle.collection.failures[0].code, ["range", "private"].includes(kind) ? "REVIEW_ITEM_EVIDENCE_INVALID" : "REVIEW_ITEM_OWNERSHIP_INVALID");
  });
});

test("identical metric PASS items can be reused while supplemental file quality always runs again", async t => {
  const f = await fixture(t), factory = f.factory();
  const first = await collectReviewItems({ ...f.input, reviewerFactory: factory });
  const second = await collectReviewItems({ ...f.input, reviewerFactory: factory });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter(input => input.request.reviewScope.kind === "file-quality").length, 2);
  assert.equal(second.collection.reusedItems, 1);
  assert.equal(second.collection.reusedObjects, 1);
  assert.equal(second.collection.complete, true);
  assert.equal(second.collection.items[0].reusedFrom, first.collection.items[0].path);
  assert.equal(second.collection.items.at(-1).reusedFrom, undefined);
  const index = JSON.parse(await fs.readFile(path.join(f.taskRoot, "review-pass-cache.json"), "utf8"));
  assert.equal(Object.keys(index.items).length, 1);
});

test("checked partial file verdicts can survive supplemental failure without accepting foreign metric ownership", async t => {
  const f = await fixture(t);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(params => {
    if (params.request.reviewScope.kind !== "file-quality") return f.output(params);
    throw Object.assign(new Error("Final supplemental reply failed."), { code: "QUALITY_TRANSPORT_FAILED", partialReview: {
      fileAssessments: [f.fileAssessment("DEVIATION")], metricObjectJudgements: [{ objectId: "M01:FOREIGN", judgement: "PASS",
        reason: "Foreign output cannot become owned.", evidence: [`${f.source}#L1`] }], findings: [] } });
  }) });
  assert.equal(handle.collection.complete, false);
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.objectId), ["M01:R1"]);
  assert.equal(handle.result.fileAssessments[0].status, "DEVIATION");
  assert.ok(handle.sourceCitations.some(citation => citation.usedBy.includes(f.source)));
});

test("the shared cutoff accounts for an unstarted supplemental item without inventing metric rows", async t => {
  const f = await fixture(t), started = Date.now(), deadlineAt = started + 30000;
  let now = started;
  t.mock.method(Date, "now", () => now);
  const handle = await collectReviewItems({ ...f.input, deadlineAt, reviewerFactory: f.factory(params => {
    now = deadlineAt - 1000;
    return f.output(params);
  }) });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.collection.totalObjects, 1);
  assert.equal(handle.collection.items.length, 2);
  assert.equal(handle.collection.items.at(-1).kind, "file-quality");
  assert.equal(handle.collection.items.at(-1).unstarted, true);
  assert.deepEqual(handle.collection.items.at(-1).sourceIds, ["R1"]);
  assert.deepEqual(handle.collection.items.at(-1).objectIds, []);
  assert.equal(handle.result.metricObjectJudgements.length, 1);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
});
