import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decisionScope } from "../lib/runtime-v2/decision-scope.mjs";
import { IMPL_REVIEW_SCHEMA } from "../lib/runtime-v2/impl-review.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { withTestReviewProof } from "./helpers/review-proof.mjs";

const classification = { stopClassification: "TASK_COMPLETE", stage: null };
const object = (id, metric = "M01", target = "ARTIFACT") => ({
  objectId: `${metric}:${id}`, sourceId: id, sourceRevisionId: `${id}@1`, metricId: metric,
  verificationTarget: target, description: `Check the actual source for ${id}.`,
});
const objectsOf = input => Object.values(input.request.population.metrics).flat();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, objects = [object("R1"), object("R2"), object("R3")]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-collector-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.txt");
  await fs.writeFile(source, "Original application source.\nIts actual behavior is observable here.\n");
  const taskId = "task-collector", directory = path.join(root, ".runtime-correction", "tasks", taskId);
  const groundTruthPath = path.join(directory, "ground-truth", "current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  const truth = { version: 1, digest: "gt-v1", frozenAtVersion: 1,
    claims: [...new Set(objects.map(row => row.sourceId))].map(id => ({ claimId: id, revisionId: `${id}@1`, text: `Requirement ${id}.` })) };
  const task = { taskId, groundTruth: { version: 1, digest: truth.digest }, correctionEpoch: { id: "epoch-1" }, control: { generation: 1, cancelEpoch: 0 } };
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  await fs.writeFile(path.join(directory, "task.json"), JSON.stringify(task));
  const metrics = {};
  for (const row of objects) (metrics[row.metricId] ??= []).push(row);
  const population = { taskId, version: 1, groundTruthVersion: 1, digest: sha256(metrics), metrics };
  const request = { instructions: ["Judge only the supplied frozen objects."], population, groundTruthPath };
  const input = { projectRoot: root, taskId, role: "stop-reviewer", reviewer: { timeoutMs: 1000 }, schema: STOP_REVIEW_SCHEMA,
    request, evidence: { groundTruth: truth, population, snapshot: { entries: [], digest: "snapshot-1" } }, classification };
  let calls = 0, closes = 0;
  function output(params, extra = {}) {
    return { summary: "Compared exact source lines.", findings: [], fileAssessments: [],
      metricObjectJudgements: objectsOf(params).map(row => ({ objectId: row.objectId, judgement: "PASS", reason: "The source establishes the assigned requirement.", evidence: [`${source}#L1-L2`] })),
      ...(params.request.fixedStopClassification ?? {}), ...extra };
  }
  function factory(run = null) {
    return async params => {
      const index = calls++;
      try {
        const result = run ? await run(params, index) : output(params);
        return withTestReviewProof(params, { result, close: async () => { closes++; } });
      } catch (error) {
        if (error.partialReview) {
          const observed = await withTestReviewProof(params, { result: error.partialReview });
          error.partialReview = { ...error.partialReview, citations: await observed.getSourceCitations(error.partialReview) };
        }
        throw error;
      }
    };
  }
  return { root, directory, source, truth, task, groundTruthPath, input, output, factory,
    counts: () => ({ calls, closes }) };
}

test("short review tasks preserve the full denominator and group only the same obligation and owner", async t => {
  const rows = [object("R1", "M01"), object("R1", "M02"), object("R1", "M03"), object("R1", "M04"), object("R1", "M05"),
    object("R1", "M12", "IMPLEMENTATION"), object("R2", "M01")];
  const f = await fixture(t, rows), seen = [];
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async params => {
    seen.push(objectsOf(params));
    assert.equal(params.reviewer.session, "detached");
    assert(params.request.instructions.some(line => line.includes("owns ONLY")));
    assert(params.request.instructions.some(line => line.includes("Keep stopClassification=TASK_COMPLETE")));
    assert.deepEqual(params.request.reviewScope.objectIds, objectsOf(params).map(row => row.objectId));
    assert.equal(params.evidence.groundTruth.claims.length, 2, "The canonical GT remains intact; its local delivery is a separate concern.");
    return f.output(params);
  }) });
  assert.deepEqual(seen.map(group => group.length), [4, 1, 1, 1]);
  assert.equal(new Set(seen.flat().map(row => row.objectId)).size, rows.length);
  assert.deepEqual(new Set(handle.result.metricObjectJudgements.map(row => row.objectId)), new Set(rows.map(row => row.objectId)));
  assert.equal(handle.collection.complete, true);
  assert.equal(f.input.request.population.metrics.M01.length, 2, "The caller's population is never replaced by a subset.");
  assert.deepEqual(f.counts(), { calls: 4, closes: 4 });
});

test("a failed middle or last task does not discard its successful siblings", async t => {
  for (const failAt of [1, 2]) await t.test(`failure at ${failAt}`, async t => {
    const f = await fixture(t);
    const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
      if (index === failAt) throw Object.assign(new Error("Reviewer transport failed."), { code: "MODEL_TRANSPORT_FAILED" });
      return f.output(params);
    }) });
    assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), [0, 1, 2].map(index => index === failAt ? "UNVERIFIED" : "PASS"));
    assert.equal(handle.collection.failures.length, 1);
    assert.equal(handle.collection.complete, false);
    assert.equal(f.counts().calls, 3);
    assert.equal(f.counts().closes, 2);
    for (const item of handle.collection.items) assert.equal(JSON.parse(await fs.readFile(item.path, "utf8")).objectIds.length, 1);
  });
});

test("an individually oversized obligation stays unverified while the remaining tasks still finish", async t => {
  const f = await fixture(t);
  f.input.evidence.groundTruth.claims[1].text = "A very large single requirement. ".repeat(12000);
  await fs.writeFile(f.groundTruthPath, JSON.stringify(f.input.evidence.groundTruth));
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
    if (index === 1) throw Object.assign(new Error("Prompt exceeds this model's context window."), { code: "REVIEWER_INPUT_LIMIT" });
    return f.output(params);
  }) });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["PASS", "UNVERIFIED", "PASS"]);
  assert.equal(handle.collection.failures[0].code, "REVIEWER_INPUT_LIMIT");
});

test("valid source-bound partial rows survive an item failure; invalid and duplicate rows never become PASS", async t => {
  const f = await fixture(t, [object("R1"), object("R1", "M12"), object("R2")]);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
    if (!index) {
      const good = f.output(params).metricObjectJudgements[0];
      throw Object.assign(new Error("Final JSON was invalid."), { partialReview: { status: "PARTIAL", metricObjectJudgements: [good,
        { ...good, objectId: "M12:R1", evidence: ["raw:unknown"] },
        { ...good, objectId: "M01:FOREIGN" }, { ...good, objectId: "M01:FOREIGN" }] } });
    }
    return f.output(params);
  }) });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["PASS", "UNVERIFIED", "PASS"]);
  assert.equal(handle.collection.complete, false);
});

test("foreign, duplicate or missing object rows fail only their assigned task", async t => {
  for (const kind of ["foreign", "duplicate", "missing"]) await t.test(kind, async t => {
    const f = await fixture(t);
    const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
      const report = f.output(params);
      if (!index && kind === "foreign") report.metricObjectJudgements[0].objectId = "M01:FOREIGN";
      if (!index && kind === "duplicate") report.metricObjectJudgements.push(clone(report.metricObjectJudgements[0]));
      if (!index && kind === "missing") report.metricObjectJudgements = [];
      return report;
    }) });
    assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["UNVERIFIED", "PASS", "PASS"]);
    assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_OWNERSHIP_INVALID");
  });
});

const clone = value => structuredClone(value);

test("nonexistent IDs, out-of-range lines and unknown raw citations cannot establish PASS", async t => {
  for (const ref of ["raw:unverified", "missing.txt#L1", "source.txt#L999", "../outside.txt#L1"]) await t.test(ref, async t => {
    const f = await fixture(t, [object("R1")]);
    const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async params => {
      const report = f.output(params); report.metricObjectJudgements[0].evidence = [ref]; return report;
    }) });
    assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
    assert.equal(handle.collection.complete, false);
  });
});

test("a finding cannot claim a requirement outside its short task", async t => {
  const f = await fixture(t);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => f.output(params, !index ? {
    findings: [{ deviationKey: "foreign", rootCauseId: "OTHER", severity: "error", reason: "An unrelated concern.",
      actualEvidence: [`${f.source}#L1`], expectedConstraint: "Foreign requirement.", violatedGroundTruthIds: ["R2"] }],
  } : {})) });
  assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_OWNERSHIP_INVALID");
  assert.equal(handle.result.findings.length, 0);
});

test("a model cannot forge a deterministic finding namespace without an owned claim", async t => {
  for (const partial of [false, true]) for (const explicitEmpty of [false, true])
    await t.test(`${partial ? "partial" : "final"}, ${explicitEmpty ? "empty" : "missing"} claim IDs`, async t => {
      const f = await fixture(t);
      const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
        const report = f.output(params);
        if (!index) {
          report.findings = [{ deviationKey: "impl:build:forged", rootCauseId: "OTHER", severity: "error",
            reason: "A model-generated build claim is not a program check.", actualEvidence: [`${f.source}#L1`],
            expectedConstraint: "The required output must be verified.", ...(explicitEmpty ? { violatedGroundTruthIds: [] } : {}) }];
          if (partial) throw Object.assign(new Error("Final JSON failed after partial output."), {
            partialReview: { status: "PARTIAL", ...report },
          });
        }
        return report;
      }) });
      assert.equal(handle.collection.complete, false);
      assert.equal(handle.result.findings.length, 0, "a model namespace must not acquire deterministic-check authority");
      assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement),
        [partial ? "PASS" : "UNVERIFIED", "PASS", "PASS"], "valid partial rows and unrelated tasks stay available");
      if (!partial) assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_OWNERSHIP_INVALID");
    });
});

test("fixed Stop classification cannot be changed by an individual task", async t => {
  const f = await fixture(t, [object("R1")]);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async params => f.output(params, { stopClassification: "INTERMEDIATE" })) });
  assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_CLASSIFICATION_INVALID");
  assert.equal(handle.result.stopClassification, "TASK_COMPLETE");
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
});

test("program source snapshots remain readable after the reviewer closes its private files", async t => {
  const f = await fixture(t, [object("R1")]);
  const privateFile = path.join(f.root, ".runtime-correction", ".internal-requests", "private", "transcript.json");
  const text = "Original frozen user evidence.\n";
  await fs.mkdir(path.dirname(privateFile), { recursive: true }); await fs.writeFile(privateFile, text);
  let closed = false, citationsBeforeClose = false;
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => {
    const report = f.output(params); report.metricObjectJudgements[0].evidence = [`${privateFile}#L1`];
    return withTestReviewProof(params, { result: report, getSourceCitations: async () => {
      assert.equal(closed, false); citationsBeforeClose = true;
      return [{ selection: `${privateFile}#L1`, path: privateFile, snapshotPath: privateFile, frozen: true,
        start: 1, end: 1, contentHash: sha256(text), usedBy: ["M01:R1"] }];
    }, close: async () => { closed = true; await fs.rm(path.dirname(privateFile), { recursive: true, force: true }); } });
  } });
  assert.equal(citationsBeforeClose, true); assert.equal(closed, true);
  const citations = await handle.getSourceCitations();
  assert.equal(citations[0].exactQuote, "Original frozen user evidence.");
  assert.equal(await fs.readFile(citations[0].snapshotPath, "utf8"), text);
  assert.equal(handle.result.metricObjectJudgements[0].evidence[0], citations[0].selection);
});

test("GT or task-generation changes stop publication and preserve earlier durable task results", async t => {
  for (const change of ["truth", "generation"]) await t.test(change, async t => {
    const f = await fixture(t);
    let error;
    try {
      await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
        if (index === 1) {
          if (change === "truth") await fs.writeFile(f.groundTruthPath, JSON.stringify({ ...f.truth, version: 2 }));
          else await fs.writeFile(path.join(f.directory, "task.json"), JSON.stringify({ ...f.task, control: { ...f.task.control, generation: 2 } }));
        }
        return f.output(params);
      }) });
    } catch (caught) { error = caught; }
    assert.equal(error.code, "REVIEW_COLLECTION_STALE");
    assert.equal(error.collection.items.length, 3);
    assert.equal(error.collection.items.filter(item => item.status === "COMPLETED").length, 1);
    assert.deepEqual(error.collection.items.slice(1).map(item => [item.status, item.unstarted]), [["UNVERIFIED", false], ["UNVERIFIED", true]]);
    assert.equal(JSON.parse(await fs.readFile(error.collection.items[0].path, "utf8")).result.metricObjectJudgements[0].judgement, "PASS");
    assert.equal(JSON.parse(await fs.readFile(error.collection.progressPath, "utf8")).status, "STALE");
  });
});

test("a source checked by an earlier task cannot change before the final collection is published", async t => {
  const f = await fixture(t);
  await assert.rejects(collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
    if (index === 1) await fs.writeFile(f.source, "Changed application source.\n");
    return f.output(params);
  }) }), error => error.code === "REVIEW_COLLECTION_STALE" && error.collection.items.length === 3
    && error.collection.items.filter(item => item.status === "COMPLETED").length === 1
    && error.collection.items.filter(item => item.status === "UNVERIFIED").length === 2);
});

test("caller cancellation preserves the progress ledger but cannot publish the old assessment", async t => {
  const f = await fixture(t), controller = new AbortController();
  let error;
  try {
    await collectReviewItems({ ...f.input, abortSignal: controller.signal,
      reviewerFactory: f.factory(async (params, index) => { if (index === 1) controller.abort(); return f.output(params); }) });
  } catch (caught) { error = caught; }
  assert.equal(error.code, "REVIEW_COLLECTION_CANCELLED");
  assert.equal(error.collection.items.length, 3);
  assert.equal(error.collection.items[0].status, "COMPLETED");
  assert.equal(error.collection.items[1].interrupted, true);
  assert.equal(error.collection.items[2].unstarted, true);
  assert.equal(JSON.parse(await fs.readFile(error.collection.progressPath, "utf8")).status, "CANCELLED");
});

test("the aggregation cutoff stops new tasks and explicitly accounts for every unreviewed object", async t => {
  const f = await fixture(t);
  const handle = await collectReviewItems({ ...f.input, deadlineAt: Date.now() + 500, reviewerFactory: f.factory() });
  assert.equal(f.counts().calls, 0);
  assert.equal(handle.collection.failures.length, 1);
  assert.equal(handle.collection.failures[0].itemCount, 3);
  const progress = JSON.parse(await fs.readFile(handle.collection.progressPath, "utf8"));
  for (const item of handle.collection.items) {
    assert.equal(item.path, handle.collection.progressPath);
    assert.equal(item.unstarted, true);
    assert.equal(progress.items[Number(item.jsonPointer.split("/").at(-1))].itemId, item.itemId);
  }
  assert(handle.result.metricObjectJudgements.every(row => row.judgement === "UNVERIFIED"));
  assert.equal(handle.collection.complete, false);
});

test("a large unstarted scope is saved once before the shared deadline without losing completed results", async t => {
  const count = 1500;
  const f = await fixture(t, Array.from({ length: count }, (_, index) => object(`R${index + 1}`)));
  const deadlineAt = Date.now() + 2200;
  const handle = await collectReviewItems({ ...f.input, deadlineAt, reviewerFactory: f.factory(async params => {
    // Leave real wall-clock time for aggregation, but close dispatch while
    // this first item's model budget still permits its valid result.
    await wait(Math.max(0, deadlineAt - Date.now() - 1250));
    return f.output(params);
  }) });
  assert.ok(Date.now() < deadlineAt, "recording unstarted tasks must not exhaust the shared publication deadline");
  assert.equal(f.counts().calls, 1);
  assert.equal(handle.collection.reviewedObjects, 1);
  assert.equal(handle.result.metricObjectJudgements.length, count, "the frozen denominator remains complete");
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
  assert.ok(handle.result.metricObjectJudgements.slice(1).every(row => row.judgement === "UNVERIFIED"));
  assert.equal(handle.collection.failures.length, 1);
  assert.equal(handle.collection.failures[0].itemCount, count - 1);
  assert.equal(handle.collection.items.length, count);
  assert.equal(handle.collection.complete, false);
  const completed = handle.collection.items[0];
  assert.equal(JSON.parse(await fs.readFile(completed.path, "utf8")).result.metricObjectJudgements[0].judgement, "PASS");
  assert.deepEqual(await fs.readdir(path.dirname(completed.path)), ["item-0001.json"],
    "unstarted tasks must not each create another item file");
  const progress = JSON.parse(await fs.readFile(handle.collection.progressPath, "utf8"));
  for (const item of handle.collection.items.slice(1)) {
    assert.equal(item.path, handle.collection.progressPath);
    const stored = progress.items[Number(item.jsonPointer.split("/").at(-1))];
    assert.equal(stored.itemId, item.itemId);
    assert.equal(stored.status, "UNVERIFIED");
    assert.equal(stored.unstarted, true);
    assert.equal(stored.reasonCode, "REVIEW_COLLECTION_DEADLINE");
  }
});

test("a hanging factory cannot consume all later short tasks", async t => {
  const f = await fixture(t);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async (params, index) => {
    if (index === 1) return new Promise(() => {});
    return f.output(params);
  }) });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["PASS", "UNVERIFIED", "PASS"]);
  assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_TIMEOUT");
});

test("an expired shared deadline cannot publish an otherwise valid PASS", async t => {
  const f = await fixture(t);
  await assert.rejects(collectReviewItems({ ...f.input, deadlineAt: Date.now() - 1, reviewerFactory: f.factory() }),
    error => error.code === "REVIEW_COLLECTION_STALE" && error.collection.complete === false);
  assert.equal(f.counts().calls, 0);
});

test("collection progress is outside a surrounding decision's staged writes", async t => {
  const f = await fixture(t);
  const scope = { directory: f.directory, files: {}, events: [] };
  const handle = await decisionScope.run(scope, () => collectReviewItems({ ...f.input, reviewerFactory: f.factory() }));
  assert.equal(JSON.parse(await fs.readFile(handle.collection.progressPath, "utf8")).status, "COMPLETED");
  assert.deepEqual(scope.files, {});
});

test("implementation short tasks accept only evidence owned by the declared source manifest", async t => {
  const f = await fixture(t, [object("R1", "M12", "IMPLEMENTATION")]);
  const other = path.join(f.root, "other.txt"); await fs.writeFile(other, "An unrelated implementation.\n");
  for (const valid of [true, false]) {
    const handle = await collectReviewItems({ ...f.input, role: "implementation-reviewer", schema: IMPL_REVIEW_SCHEMA, classification: null,
      request: { ...f.input.request, sourceManifest: [{ path: f.source, sha256: sha256(await fs.readFile(f.source)) }] },
      reviewerFactory: async params => withTestReviewProof(params, { result: { summary: "Checked implementation.", findings: [], metricObjectJudgements: [{
        objectId: "M12:R1", judgement: "PASS", reason: "The assigned implementation exists.", evidence: [`${valid ? f.source : other}#L1`],
      }] }, close() {} }) });
    assert.equal(handle.result.metricObjectJudgements[0].judgement, valid ? "PASS" : "UNVERIFIED");
    assert.equal(handle.result.stopClassification, undefined);
  }
});

test("valid task results and progress are durable before a hung reviewer close", async t => {
  const f = await fixture(t);
  let calls = 0, savedBeforeClose = false;
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => {
    const index = calls++;
    return withTestReviewProof(params, { result: f.output(params), close: async () => {
      if (!index) {
        const collections = path.join(f.directory, "review-collections");
        const [run] = await fs.readdir(collections);
        const item = JSON.parse(await fs.readFile(path.join(collections, run, "items", "item-0001.json"), "utf8"));
        const progress = JSON.parse(await fs.readFile(path.join(collections, run, "progress.json"), "utf8"));
        savedBeforeClose = item.result.metricObjectJudgements[0].judgement === "PASS" && progress.completedItems === 1;
        return new Promise(() => {});
      }
    } });
  } });
  assert.equal(savedBeforeClose, true);
  assert.equal(calls, 3);
  assert.equal(handle.collection.complete, true);
  assert(handle.result.metricObjectJudgements.every(row => row.judgement === "PASS"));
});

test("hung recovery and citation callbacks are bounded and do not prevent later tasks", async t => {
  for (const kind of ["recoverProgress", "getSourceCitations"]) await t.test(kind, async t => {
    const f = await fixture(t); let calls = 0;
    const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => {
      const index = calls++, report = f.output(params);
      if (!index && kind === "recoverProgress") report.metricObjectJudgements = [];
      return withTestReviewProof(params, { result: report, ...(!index ? { [kind]: () => new Promise(() => {}) } : {}), close() {} });
    } });
    assert.equal(calls, 3);
    assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement), ["UNVERIFIED", "PASS", "PASS"]);
  });
});

test("runtime reports cannot establish business PASS through a direct private-file reference", async t => {
  const f = await fixture(t, [object("R1")]);
  const reportFile = path.join(f.directory, "old-assessment.json");
  await fs.writeFile(reportFile, "An old report claims PASS.\n");
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: f.factory(async params => {
    const report = f.output(params); report.metricObjectJudgements[0].evidence = [`${reportFile}#L1`]; return report;
  }) });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_EVIDENCE_INVALID");
});

test("a frozen private citation belonging to a foreign scope cannot authorize a local judgement", async t => {
  const f = await fixture(t, [object("R1")]);
  const privateFile = path.join(f.directory, "other-scope.json");
  const text = "A foreign review scope.\n"; await fs.writeFile(privateFile, text);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => {
    const report = f.output(params); report.metricObjectJudgements[0].evidence = [`${privateFile}#L1`];
    return { result: report, getSourceCitations: async () => [{ selection: `${privateFile}#L1`, path: privateFile,
      snapshotPath: privateFile, frozen: true, start: 1, end: 1, contentHash: sha256(text), usedBy: ["M01:FOREIGN"] }], close() {} };
  } });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
});

test("noncompletion tasks still find current HARD deviations without inventing metric judgements", async t => {
  for (const failSecond of [false, true]) await t.test(`middle failure=${failSecond}`, async t => {
    const f = await fixture(t);
    const handle = await collectReviewItems({ ...f.input, classification: { stopClassification: "INTERMEDIATE", stage: null },
      reviewerFactory: f.factory(async (params, index) => {
        assert.equal(params.request.reviewScope.findingsOnly, true);
        assert.equal(objectsOf(params).length, 0);
        assert.equal(params.schema.properties.metricObjectJudgements.maxItems, 0);
        assert(params.request.reviewScope.sourceIds.length);
        if (index === 1 && failSecond) throw new Error("A middle findings task overflowed.");
        return f.output(params, !index ? { findings: [{ deviationKey: "current-hard-deviation", rootCauseId: "OTHER", severity: "error",
          reason: "The current output contradicts this mandatory obligation.", actualEvidence: [`${f.source}#L1`],
          expectedConstraint: "Original mandatory requirement.", violatedGroundTruthIds: ["R1"] }] } : {});
      }) });
    assert.equal(handle.result.stopClassification, "INTERMEDIATE");
    assert.equal(handle.result.metricObjectJudgements.length, 0);
    assert.equal(handle.result.findings.length, 1);
    assert.equal(handle.collection.mode, "findings-only");
    assert.equal(handle.collection.complete, !failSecond);
    assert.equal(handle.collection.reviewedObjects, failSecond ? 2 : 3);
  });
});
