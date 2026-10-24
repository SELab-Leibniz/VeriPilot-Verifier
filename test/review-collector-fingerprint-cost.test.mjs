import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t, count) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/collector-cost-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "cost", taskRoot = path.join(root, ".runtime-correction/tasks", taskId);
  const groundTruthPath = path.join(taskRoot, "ground-truth/current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  const truth = { version: 1, digest: "truth", claims: [] };
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  await fs.writeFile(path.join(taskRoot, "task.json"), JSON.stringify({ groundTruth: truth, correctionEpoch: { id: 1 } }));
  const files = [], rows = [];
  for (let index = 0; index < count; index++) {
    const file = `candidate-${index}.txt`; await fs.writeFile(path.join(root, file), `body ${index}`);
    files.push({ path: file, sha256: sha256(`body ${index}`) });
    rows.push({ objectId: `M01:R${index}`, metricId: "M01", sourceId: `R${index}`, description: "Review the candidate.", verificationTarget: "ARTIFACT" });
  }
  const population = { version: 1, digest: "population", metrics: { M01: rows } };
  const classification = { stopClassification: "TASK_COMPLETE", stage: null };
  const factory = async params => ({ result: { ...classification, summary: "No decisive evidence.", findings: [],
    metricObjectJudgements: Object.values(params.request.population.metrics).flat().map(row => ({ objectId: row.objectId,
      judgement: "UNVERIFIED", reason: "This fixture intentionally leaves the obligation unverified.", evidence: [] })) }, close() {} });
  const input = { projectRoot: root, taskId, role: "stop-reviewer", reviewerFactory: factory, reviewer: { timeoutMs: 1000 }, schema: STOP_REVIEW_SCHEMA,
    classification, request: { groundTruthPath, population, artifactCandidates: [{ artifactId: "delivery", metricIds: ["M01"], files }] },
    evidence: { groundTruth: truth, population }, deadlineAt: Date.now() + 30000 };
  return { root, files, input };
}

for (const count of [4, 8, 16]) test(`${count} isolated items hash unchanged candidate contents only at capture and publication`, async t => {
  const f = await fixture(t, count), candidates = new Set(f.files.map(file => path.join(f.root, file.path)));
  const originalRead = fs.readFile; let reads = 0;
  fs.readFile = async (file, ...args) => { if (candidates.has(file)) reads++; return originalRead(file, ...args); };
  t.after(() => { fs.readFile = originalRead; });
  const result = await collectReviewItems(f.input);
  assert.equal(result.collection.complete, true);
  assert.equal(result.collection.totalItems, count);
  assert.equal(reads, count * 2);
});

test("publication still detects changed content when intermediate metadata observations are unchanged", async t => {
  const f = await fixture(t, 1), target = path.join(f.root, f.files[0].path), originalStat = fs.lstat;
  const savedStat = await originalStat(target, { bigint: true });
  fs.lstat = async (file, ...args) => file === target ? savedStat : originalStat(file, ...args);
  t.after(() => { fs.lstat = originalStat; });
  const factory = f.input.reviewerFactory;
  f.input.reviewerFactory = async params => { const handle = await factory(params); await fs.writeFile(target, "changed"); return handle; };
  await assert.rejects(collectReviewItems(f.input), error => error.code === "REVIEW_COLLECTION_STALE");
});

test("an unbound supplemental quality duty cannot silently complete with an empty verdict list", async t => {
  const f = await fixture(t, 1);
  f.input.request.artifactCandidates = [];
  f.input.request.supplementalFileAssessments = true;
  f.input.reviewerFactory.supportsSupplementalFileAssessment = true;
  const result = await collectReviewItems(f.input);
  assert.equal(result.collection.complete, false);
  assert.equal(result.collection.totalItems, 2);
  assert.equal(result.collection.completedItems, 1);
  assert.equal(result.collection.failures[0].code, "REVIEW_ITEM_EVIDENCE_UNAVAILABLE");
  assert.match(result.collection.failures[0].reason, /FILE_QUALITY_SCOPE_UNRESOLVED/);
  assert.equal(result.result.metricObjectJudgements.length, 1);
  assert.deepEqual(result.result.fileAssessments, [], "The program must not invent a delivery path or a metric.");
});
