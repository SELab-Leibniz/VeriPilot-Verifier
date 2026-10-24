import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { IMPL_REVIEW_SCHEMA } from "../lib/runtime-v2/impl-review.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

const row = (id, metric = "M01", target = "ARTIFACT") => ({ objectId: `${metric}:${id}`, metricId: metric,
  sourceId: id, sourceRevisionId: `${id}@1`, description: `Check ${id}.`, verificationTarget: target });
async function fixture(t, objects = [row("R1")]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-pass-reuse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "pass-reuse", taskRoot = path.join(root, ".runtime-correction", "tasks", taskId);
  const groundTruthPath = path.join(taskRoot, "ground-truth", "current.json"), source = path.join(root, "output.txt");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true }); await fs.writeFile(source, "Current checked output.\n");
  const truth = { version: 1, digest: "truth-1", frozenAtVersion: 1, claims: [...new Set(objects.map(item => item.sourceId))].map(claimId => ({ claimId, text: `Original ${claimId}.` })) };
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  const task = { taskId, groundTruth: { version: 1, digest: truth.digest }, correctionEpoch: { id: "epoch-1" }, control: { generation: 1, cancelEpoch: 0 } };
  await fs.writeFile(path.join(taskRoot, "task.json"), JSON.stringify(task));
  const metrics = {}; for (const object of objects) (metrics[object.metricId] ??= []).push(object);
  const population = { taskId, version: 1, digest: sha256(metrics), groundTruthVersion: 1, metrics };
  const input = { projectRoot: root, taskId, role: "stop-reviewer", reviewer: { model: "fixture/model-1", timeoutMs: 1000 }, schema: STOP_REVIEW_SCHEMA,
    classification: { stopClassification: "TASK_COMPLETE", stage: null }, request: { population, groundTruthPath, instructions: ["Inspect the frozen original inputs."] },
    evidence: { population, groundTruth: truth, snapshot: { digest: "snapshot-1", entries: [] } } };
  let calls = 0, runItem = null;
  function output(params, judgement = "PASS") {
    return { summary: "Checked the assigned exact source.", findings: [], fileAssessments: [], ...params.request.fixedStopClassification,
      metricObjectJudgements: Object.values(params.request.population.metrics).flat().map(object => ({ objectId: object.objectId, judgement,
        reason: "The checked current output establishes this object.", evidence: [`${source}#L1`] })) };
  }
  const factory = async params => { const index = calls++; return { result: runItem ? await runItem(params, index) : output(params),
    reviewEvidence: { files: [source], fingerprints: { [source]: sha256(await fs.readFile(source)) }, unstable: false, missing: [] }, close() {} }; };
  factory.reviewCacheIdentity = () => "fixture/provider/model-1";
  const run = (extra = {}) => collectReviewItems({ ...input, reviewerFactory: factory, ...extra });
  return { root, taskRoot, source, truth, task, groundTruthPath, input, factory, run, output,
    calls: () => calls, setItem: callback => { runItem = callback; } };
}

test("identical frozen Stop inputs reuse complete PASS items with no new model calls and fresh provenance", async t => {
  const f = await fixture(t, [row("R1"), row("R2")]);
  const first = await f.run(), second = await f.run();
  assert.equal(f.calls(), 2); assert.equal(second.collection.reusedItems, 2); assert.equal(second.collection.reusedObjects, 2);
  assert.equal(second.collection.completedItems, 2); assert.equal(second.collection.complete, true);
  assert.match(second.result.summary, /reused 2 items\/2 objects/u);
  for (let index = 0; index < 2; index++) {
    const item = second.collection.items[index]; assert.notEqual(item.path, first.collection.items[index].path);
    assert.equal(item.reusedFrom, first.collection.items[index].path);
    const saved = JSON.parse(await fs.readFile(item.path, "utf8"));
    assert.equal(saved.reusedFrom, item.reusedFrom);
    assert.ok(saved.sourceCitations.every(citation => citation.snapshotPath.startsWith(second.collection.path)));
  }
});

test("implementation retries reuse only their own unchanged, validated PASS items", async t => {
  const f = await fixture(t, [row("R1", "M12", "IMPLEMENTATION")]);
  f.input.request.sourceManifest = [{ path: "output.txt", sha256: sha256(await fs.readFile(f.source)) }];
  const base = f.output;
  f.setItem(params => {
    const result = base(params);
    if (params.role === "implementation-reviewer") {
      delete result.fileAssessments; delete result.stopClassification; delete result.stage;
    }
    return result;
  });
  const impl = { role: "implementation-reviewer", schema: IMPL_REVIEW_SCHEMA, classification: null };
  const first = await f.run(impl), second = await f.run(impl);
  assert.equal(first.collection.complete, true);
  assert.equal(second.collection.reusedItems, 1);
  assert.equal(f.calls(), 1);
  assert.equal(second.collection.items[0].reusedFrom, first.collection.items[0].path);
  const stop = await f.run();
  assert.equal(stop.collection.reusedItems, 0, "a source PASS cannot be reused as runtime acceptance");
  assert.equal((await f.run(impl)).collection.reusedItems, 1, "the role index survives another role's review");
  await fs.writeFile(f.source, "Changed current output.\n");
  f.input.request.sourceManifest[0].sha256 = sha256(await fs.readFile(f.source));
  assert.equal((await f.run(impl)).collection.reusedItems, 0);
  assert.equal(f.calls(), 3);
});

test("candidate identity participates in PASS reuse and changed declarations cannot publish stale judgements", async t => {
  const f = await fixture(t), config = path.join(f.root, "policy.yaml");
  await fs.writeFile(config, "metrics: [M01]\n");
  f.input.request.artifactCandidates = [{ artifactId: "decomposition", metricIds: ["M01"],
    files: [{ path: "output.txt", sha256: sha256(await fs.readFile(f.source)) }],
    declaration: { configPath: config, configSha256: sha256(await fs.readFile(config)), digest: "declaration-1" } }];
  await f.run();
  assert.equal((await f.run()).collection.reusedItems, 1);
  f.input.request.artifactCandidates[0].artifactId = "different-owner";
  assert.equal((await f.run()).collection.reusedItems, 0);
  await fs.writeFile(config, "metrics: [M05]\n");
  const before = f.calls();
  await assert.rejects(f.run(), error => error.code === "REVIEW_COLLECTION_STALE");
  assert.equal(f.calls(), before, "A stale ownership declaration must be rejected before a model or cache dispatch.");
});

test("uncited candidate and declaration mutations invalidate a running collection", async t => {
  for (const changed of ["candidate", "declaration"]) await t.test(changed, async t => {
    const f = await fixture(t), candidate = path.join(f.root, "candidate.txt"), config = path.join(f.root, "policy.yaml");
    await fs.writeFile(candidate, "An explicitly owned candidate.\n");
    await fs.writeFile(config, "metrics: [M01]\n");
    f.input.request.artifactCandidates = [{ artifactId: "decomposition", metricIds: ["M01"],
      files: [{ path: "candidate.txt", sha256: sha256(await fs.readFile(candidate)) }],
      declaration: { configPath: config, configSha256: sha256(await fs.readFile(config)), digest: "declaration-1" } }];
    f.setItem(async params => {
      await fs.writeFile(changed === "candidate" ? candidate : config, "Changed during review.\n");
      return f.output(params);
    });
    await assert.rejects(f.run(), error => error.code === "REVIEW_COLLECTION_STALE");
  });
});

test("an explicit external policy remains a hash dependency without becoming business evidence", async t => {
  const f = await fixture(t), policyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-external-policy-"));
  t.after(() => fs.rm(policyRoot, { recursive: true, force: true }));
  const config = path.join(policyRoot, "policy.yaml");
  await fs.writeFile(config, "metrics: [M01]\n");
  f.input.request.artifactCandidates = [{ artifactId: "decomposition", metricIds: ["M01"],
    files: [{ path: "output.txt", sha256: sha256(await fs.readFile(f.source)) }],
    declaration: { configPath: config, configSha256: sha256(await fs.readFile(config)), digest: "declaration-1" } }];
  const first = await f.run();
  assert(first.sourceCitations.every(citation => citation.path !== config));
  await fs.writeFile(config, "metrics: [M05]\n");
  await assert.rejects(f.run(), error => error.code === "REVIEW_COLLECTION_STALE");
  assert.equal(f.calls(), 1);
});

for (const change of ["source", "truth", "schema", "instructions", "classification", "snapshot digest", "snapshot body", "reviewer", "guard", "manifest", "runtime model"])
  test(`${change} changes invalidate old PASS items`, async t => {
    const f = await fixture(t); let runtime = "resolved-runtime-1";
    f.factory.reviewCacheIdentity = () => runtime;
    await f.run();
    if (change === "source") await fs.writeFile(f.source, "Changed current checked output.\n");
    if (change === "truth") {
      f.input.evidence.groundTruth = { ...f.truth, version: 2, digest: "truth-2" };
      await fs.writeFile(f.groundTruthPath, JSON.stringify(f.input.evidence.groundTruth));
    }
    if (change === "schema") f.input.schema = { ...STOP_REVIEW_SCHEMA, $comment: "Changed validation contract." };
    if (change === "instructions") f.input.request.instructions = ["New mandatory review instruction."];
    if (change === "classification") f.input.classification = { stopClassification: "STAGE_COMPLETE", stage: "stage-2" };
    if (change === "snapshot digest") f.input.evidence.snapshot.digest = "snapshot-2";
    if (change === "snapshot body") f.input.evidence.snapshot.entries.push({ type: "user", message: { content: "New exact source, even with a stale supplied digest." } });
    if (change === "reviewer") f.input.reviewer = { ...f.input.reviewer, model: "fixture/model-2" };
    if (change === "guard") await fs.writeFile(path.join(f.taskRoot, "task.json"), JSON.stringify({ ...f.task, control: { ...f.task.control, generation: 2 } }));
    if (change === "manifest") f.input.request.sourceManifest = [{ path: f.source, sha256: sha256(await fs.readFile(f.source)) }];
    if (change === "runtime model") runtime = "resolved-runtime-2";
    const second = await f.run(); assert.equal(f.calls(), 2); assert.equal(second.collection.reusedItems, 0);
    assert.equal(second.result.metricObjectJudgements[0].judgement, "PASS");
  });

test("resolved runtime identities permit reuse across new factory instances; failed identity resolution disables reuse", async t => {
  const f = await fixture(t); f.factory.reviewCacheIdentity = () => "resolved-model-provider-protocol";
  await f.run(); let calls = 0;
  const fresh = async params => { calls++; return { result: f.output(params), close() {} }; };
  fresh.reviewCacheIdentity = f.factory.reviewCacheIdentity;
  assert.equal((await f.run({ reviewerFactory: fresh })).collection.reusedItems, 1); assert.equal(calls, 0);
  fresh.reviewCacheIdentity = () => { throw new Error("No valid model selection."); };
  assert.equal((await f.run({ reviewerFactory: fresh })).collection.reusedItems, 0); assert.equal(calls, 1);
});

test("an unresolved factory cannot reuse PASS even when the same object hides a changed default model", async t => {
  const f = await fixture(t);
  delete f.factory.reviewCacheIdentity;
  await f.run();
  const second = await f.run();
  assert.equal(second.collection.reusedItems, 0);
  assert.equal(f.calls(), 2);
});

for (const damage of ["index JSON", "item bytes", "source snapshot"])
  test(`damaged cached ${damage} falls back to normal review`, async t => {
    const f = await fixture(t), first = await f.run();
    if (damage === "index JSON") await fs.writeFile(path.join(f.taskRoot, "review-pass-cache.json"), "{ broken");
    if (damage === "item bytes") await fs.appendFile(first.collection.items[0].path, "\n");
    if (damage === "source snapshot") await fs.rm(first.sourceCitations[0].snapshotPath);
    const second = await f.run(); assert.equal(f.calls(), 2); assert.equal(second.collection.reusedItems, 0);
    assert.equal(second.collection.complete, true);
  });

test("a retry reuses successful siblings and checks only previously unfinished items", async t => {
  const f = await fixture(t, [row("R1"), row("R2"), row("R3")]);
  f.setItem((params, index) => { if (index === 1) throw new Error("Controlled missing middle result."); return f.output(params); });
  const first = await f.run(); assert.equal(first.collection.complete, false);
  f.setItem(params => f.output(params)); const second = await f.run();
  assert.equal(f.calls(), 4); assert.equal(second.collection.reusedItems, 2); assert.equal(second.collection.complete, true);
  assert.deepEqual(second.result.metricObjectJudgements.map(item => item.judgement), ["PASS", "PASS", "PASS"]);
});

for (const incomplete of ["DEVIATION", "UNVERIFIED", "findings", "partial", "file assessment"])
  test(`${incomplete} results are never cached as complete PASS`, async t => {
    const f = await fixture(t);
    f.setItem(params => {
      const report = f.output(params, ["DEVIATION", "UNVERIFIED"].includes(incomplete) ? incomplete : "PASS");
      if (incomplete === "findings") report.findings = [{ deviationKey: "gap", rootCauseId: "OTHER", severity: "error", reason: "A current gap.",
        actualEvidence: [`${f.source}#L1`], expectedConstraint: "Original requirement.", violatedGroundTruthIds: ["R1"] }];
      if (incomplete === "partial") throw Object.assign(new Error("Only a partial result."), { partialReview: report });
      if (incomplete === "file assessment") report.fileAssessments = [{ path: "output.txt", status: "UNVERIFIED", reason: "Quality remains unchecked.", evidence: [] }];
      return report;
    });
    await f.run(); const second = await f.run(); assert.equal(f.calls(), 2); assert.equal(second.collection.reusedItems, 0);
  });

test("findings-only Stop checks each source and target once without shrinking the frozen denominator", async t => {
  const rows = ["M01", "M02", "M03", "M04", "M05", "M06"].map(metric => row("R1", metric));
  rows.push(row("R1", "M12", "IMPLEMENTATION"));
  const f = await fixture(t, rows);
  const input = { classification: { stopClassification: "INTERMEDIATE", stage: null } };
  const first = await f.run(input), second = await f.run(input);
  assert.equal(f.calls(), 4); assert.equal(first.collection.totalItems, 2); assert.equal(first.collection.totalObjects, 7);
  assert.equal(first.collection.reviewedObjects, 7); assert.equal(first.collection.completedItems, 2);
  assert.equal(second.collection.reusedItems, 0); assert.deepEqual(second.result.metricObjectJudgements, []);
  assert.equal(Object.values(f.input.request.population.metrics).flat().length, 7);
});

test("a large Stop queue grants the first item its configured capped budget instead of dividing it into unusable slices", async t => {
  const f = await fixture(t, Array.from({ length: 150 }, (_, index) => row(`R${index}`))), controller = new AbortController();
  let observed = null;
  f.setItem(params => { observed = params.reviewer.timeoutMs; controller.abort(); throw new Error("Budget observed without waiting."); });
  await assert.rejects(f.run({ reviewer: { ...f.input.reviewer, timeoutMs: 180000 }, deadlineAt: Date.now() + 300000,
    abortSignal: controller.signal }), error => error.code === "REVIEW_COLLECTION_CANCELLED");
  assert.equal(observed, 120000); assert.equal(f.calls(), 1);
});

test("uncited program-observed dependencies and directory membership are rechecked before reuse", async t => {
  for (const kind of ["uncited file", "directory"]) await t.test(kind, async t => {
    const f = await fixture(t), directory = path.join(f.root, "src"), dependency = path.join(directory, "dependency.txt");
    await fs.mkdir(directory); await fs.writeFile(dependency, "Original uncited dependency.\n");
    let calls = 0;
    const factory = async params => {
      calls++; const file = kind === "directory" ? directory : dependency;
      const dependencyHash = kind === "directory" ? sha256((await fs.readdir(directory)).sort()) : sha256(await fs.readFile(dependency));
      return { result: f.output(params), reviewEvidence: { files: [f.source, file],
        fingerprints: { [f.source]: sha256(await fs.readFile(f.source)), [file]: dependencyHash }, unstable: false, missing: [] }, close() {} };
    };
    await f.run({ reviewerFactory: factory });
    if (kind === "directory") await fs.writeFile(path.join(directory, "added.txt"), "A new possible input.\n");
    else await fs.writeFile(dependency, "Changed uncited dependency.\n");
    const second = await f.run({ reviewerFactory: factory });
    assert.equal(calls, 2); assert.equal(second.collection.reusedItems, 0); assert.equal(second.collection.complete, true);
  });
});

test("a cached frozen original remains reusable after its private reviewer page is deleted", async t => {
  const f = await fixture(t), privateFile = path.join(f.taskRoot, "private-review-page.txt"), text = "Frozen original session evidence.\n";
  let calls = 0;
  const factory = async params => {
    calls++; await fs.writeFile(privateFile, text);
    const result = f.output(params); result.metricObjectJudgements[0].evidence = [`${privateFile}#L1`];
    return { result, sourceCitations: [{ path: privateFile, snapshotPath: privateFile, selection: `${privateFile}#L1`, frozen: true,
      contentHash: sha256(text), start: 1, end: 1, usedBy: ["M01:R1"] }],
      reviewEvidence: { files: [f.source], fingerprints: { [f.source]: sha256(await fs.readFile(f.source)) }, unstable: false, missing: [] },
      close: () => fs.rm(privateFile) };
  };
  factory.reviewCacheIdentity = f.factory.reviewCacheIdentity;
  const first = await f.run({ reviewerFactory: factory }); await assert.rejects(fs.access(privateFile), { code: "ENOENT" });
  const second = await f.run({ reviewerFactory: factory });
  assert.equal(calls, 1); assert.equal(second.collection.reusedItems, 1);
  assert.equal(second.sourceCitations[0].exactQuote, first.sourceCitations[0].exactQuote);
  await fs.access(second.sourceCitations[0].snapshotPath);
});

for (const kind of ["missing read-set", "unstable read-set", "missing observed file"])
  test(`${kind} prevents PASS caching`, async t => {
    const f = await fixture(t); let calls = 0;
    const factory = async params => {
      calls++; return { result: f.output(params), ...(kind === "missing read-set" ? {} : {
        reviewEvidence: { files: [f.source], fingerprints: { [f.source]: sha256(await fs.readFile(f.source)) },
          unstable: kind === "unstable read-set", missing: kind === "missing observed file" ? ["unknown.txt"] : [] },
      }), close() {} };
    };
    factory.reviewCacheIdentity = f.factory.reviewCacheIdentity;
    await f.run({ reviewerFactory: factory }); const second = await f.run({ reviewerFactory: factory });
    assert.equal(calls, 2); assert.equal(second.collection.reusedItems, 0);
  });

test("a later item cannot publish an earlier reused PASS after its uncited dependency changes", async t => {
  const f = await fixture(t, [row("R1"), row("R2")]), dependency = path.join(f.root, "dependency.txt");
  await fs.writeFile(dependency, "Original dependency.\n"); let calls = 0, mutate = false;
  const factory = async params => {
    calls++; if (mutate) await fs.writeFile(dependency, "Changed after a sibling was reused.\n");
    return { result: f.output(params), reviewEvidence: { files: [f.source, dependency], fingerprints: {
      [f.source]: sha256(await fs.readFile(f.source)), [dependency]: sha256(await fs.readFile(dependency)),
    }, unstable: false, missing: [] }, close() {} };
  };
  factory.reviewCacheIdentity = f.factory.reviewCacheIdentity;
  const first = await f.run({ reviewerFactory: factory });
  await fs.appendFile(first.collection.items[1].path, "\n"); mutate = true;
  await assert.rejects(f.run({ reviewerFactory: factory }), error => error.code === "REVIEW_COLLECTION_STALE");
  assert.equal(calls, 3);
});

test("bounded cache I/O cannot dispatch a model after consuming the remaining dispatch window", async t => {
  const f = await fixture(t), first = await f.run(), originalRead = fs.readFile;
  fs.readFile = async (file, ...args) => {
    if (file === first.collection.items[0].path) await new Promise(resolve => setTimeout(resolve, 900));
    return originalRead(file, ...args);
  };
  t.after(() => { fs.readFile = originalRead; });
  const deadlineAt = Date.now() + 1650;
  const second = await f.run({ deadlineAt }); fs.readFile = originalRead;
  assert.ok(Date.now() < deadlineAt); assert.equal(f.calls(), 1);
  assert.equal(second.collection.complete, false); assert.equal(second.collection.reusedItems, 0);
  assert.equal(second.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
});

test("ordinary collector roles keep running models and retain their previous grouping", async t => {
  const f = await fixture(t);
  await f.run({ role: "other-reviewer" }); const second = await f.run({ role: "other-reviewer" });
  assert.equal(f.calls(), 2); assert.equal(second.collection.reusedItems, undefined);
  const grouped = await fixture(t, ["M01", "M02", "M03", "M04", "M05"].map(metric => row("R1", metric)));
  const result = await grouped.run({ role: "other-reviewer", classification: { stopClassification: "INTERMEDIATE", stage: null } });
  assert.equal(result.collection.totalItems, 2); assert.equal(grouped.calls(), 2);
});
