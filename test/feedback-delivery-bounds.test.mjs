import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decisionScope } from "../lib/runtime-v2/decision-scope.mjs";
import { prepareHostFeedback, boundHostFeedback, HOST_FEEDBACK_MAX_BYTES,
  HOST_FEEDBACK_ITEM_BYTES } from "../lib/runtime-v2/feedback-delivery.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-feedback-bounds-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { projectRoot: root, taskId: "task-feedback" };
}
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const markerPath = text => text.split("\n").findLast(line => line.startsWith("[RC_DETAILS] ")).slice(13);
const size = text => Buffer.byteLength(text, "utf8");

test("bounded UTF8 feedback keeps first and last deviations and publishes every original item", async t => {
  const context = await fixture(t);
  const objects = Array.from({ length: 70 }, (_, index) => ({ objectId: `M12:req-${index}`,
    sourceId: `req-${index}`, judgement: "DEVIATION", reason: `Fault ${index}: ` + "中文长原因🌻".repeat(500),
    evidence: [`${"long-directory/".repeat(100)}service${index}.py#L2-L4`] }));
  const text = "Final assessment has actual deviations.\n" + objects.map(object => object.reason).join("\n");
  const review = { stopClassification: "TASK_COMPLETE", findings: [] };
  const report = { status: "DEVIATION", metrics: [{ objects }] };
  const feedback = await prepareHostFeedback({ ...context, text, review, report,
    citations: [{ path: "service.py", start: 2, end: 4, exactQuote: "SECRET_EXACT_QUOTE", usedBy: ["M12:req-0"] }] });
  assert(size(feedback) <= HOST_FEEDBACK_MAX_BYTES);
  assert.match(feedback, /M12:req-0/u);
  assert.match(feedback, /M12:req-69/u);
  assert.match(feedback, /\d+ item details omitted/u);
  assert(!feedback.includes("SECRET_EXACT_QUOTE"));
  assert(!feedback.includes("\uFFFD"));
  const indexPath = markerPath(feedback), index = await read(indexPath);
  assert.equal(index.itemCount, 70);
  assert(index.pages.length > 1);
  assert.equal(await fs.readFile(index.fullFeedbackPath, "utf8"), text);
  assert.deepEqual((await read(index.assessmentPath)).report, report);
  let count = 0;
  for (const page of index.pages) {
    const entries = (await read(page.path)).items;
    assert(entries.length <= 12);
    for (const entry of entries) {
      const item = await read(entry.path), short = await fs.readFile(entry.shortPath, "utf8");
      assert.equal(item.objects[0].reason, objects[count].reason);
      assert(size(short) <= HOST_FEEDBACK_ITEM_BYTES);
      assert(short.includes(entry.path) || short.includes(`[RC_ITEM] ${entry.ordinal} (published index)`));
      assert(!short.includes("SECRET_EXACT_QUOTE"));
      count++;
    }
  }
  assert.equal(count, objects.length);
});

test("same-source finding and metric reason are projected once without changing machine data", async t => {
  const context = await fixture(t);
  const reason = "Observed required output is absent.";
  const report = { status: "DEVIATION", metrics: [{ objects: ["M01:req", "M12:req"].map(objectId => ({
    objectId, sourceId: "req", judgement: "DEVIATION", reason, evidence: ["app.py#L1-L3"] })) }] };
  const review = { findings: [{ deviationKey: "same", reason, violatedGroundTruthIds: ["req"], actualEvidence: ["app.py#L1-L3"] }] };
  const before = structuredClone({ review, report });
  const feedback = await prepareHostFeedback({ ...context, text: "Original assessment", review, report });
  assert.equal(feedback.split(reason).length - 1, 1);
  const index = await read(markerPath(feedback));
  assert.equal(index.itemCount, 1);
  const item = await read((await read(index.pages[0].path)).items[0].path);
  assert.deepEqual(item.objectIds, ["M01:req", "M12:req"]);
  assert.equal(item.findings.length, 1);
  assert.deepEqual({ review, report }, before);
});

test("publication captures caller-owned assessment before asynchronous writes", async t => {
  const context = await fixture(t);
  const report = { status: "DEVIATION", metrics: [{ objects: [{ objectId: "M12:captured", sourceId: "captured",
    judgement: "DEVIATION", reason: "Original captured defect", evidence: [] }] }] };
  const pending = prepareHostFeedback({ ...context, text: "Frozen current feedback", report });
  report.metrics[0].objects[0].reason = "Later unrelated caller mutation";
  const feedback = await pending, index = await read(markerPath(feedback));
  assert.match(feedback, /Original captured defect/u);
  assert(!feedback.includes("Later unrelated caller mutation"));
  assert.equal((await read(index.assessmentPath)).report.metrics[0].objects[0].reason, "Original captured defect");
});

test("checker failures and unverified objects never turn into projected business deviations", async t => {
  const context = await fixture(t);
  const report = { status: "UNVERIFIED", metrics: [{ objects: [
    { objectId: "M01:good", sourceId: "good", judgement: "PASS", reason: "Observed valid output", evidence: [] },
    { objectId: "M12:unknown", sourceId: "unknown", judgement: "UNVERIFIED", reason: "No complete source evidence", evidence: [] },
    { objectId: "M12:checker", sourceId: "checker", judgement: "CHECKER_ERROR", reason: "Reviewer context overflow", evidence: [] },
  ] }] };
  const feedback = await prepareHostFeedback({ ...context, text: "Final assessment remains unverified", report });
  assert.match(feedback, /PASS 1/u);
  assert.match(feedback, /UNVERIFIED 1/u);
  assert.match(feedback, /Checker failures: 1/u);
  assert.match(feedback, /Reviewer context overflow/u);
  assert(!feedback.includes("DEVIATION"));
  const index = await read(markerPath(feedback));
  assert.equal(index.itemCount, 3);
});

test("published files bypass decision staging and stay readable independently of temporary reviewer cleanup", async t => {
  const context = await fixture(t);
  const scope = { directory: context.projectRoot, files: {}, events: [] };
  const feedback = await decisionScope.run(scope, () => prepareHostFeedback({ ...context, text: "Original terminal feedback" }));
  const index = await read(markerPath(feedback));
  assert.equal(await fs.readFile(index.fullFeedbackPath, "utf8"), "Original terminal feedback");
  assert.deepEqual(scope.files, {});
  assert(!markerPath(feedback).includes(".internal-requests"));
});

test("partial progress indexes each supplied unreviewed identity without inventing a metric judgement", async t => {
  const context = await fixture(t);
  const partialReview = { status: "PARTIAL", finalClassification: null, totalObjects: 3,
    metricObjectJudgements: [{ objectId: "M01:ready", judgement: "PASS", reason: "Original observed result", evidence: [] }],
    unreviewedObjectIds: ["M01:pending", "M01:rejected"], rejectedObjectIds: ["M01:rejected"] };
  const feedback = await prepareHostFeedback({ ...context, text: "Retained partial evidence", partialReview });
  assert.match(feedback, /final Stop classification is unconfirmed/u);
  assert.match(feedback, /Unreviewed 2/u);
  const index = await read(markerPath(feedback)), entries = (await read(index.pages[0].path)).items;
  assert.equal(entries.length, 3);
  for (const entry of entries.slice(1)) {
    const item = await read(entry.path);
    assert.equal(item.state, "UNREVIEWED");
    assert.deepEqual(item.objects, []);
  }
  assert.deepEqual((await read(index.assessmentPath)).partialReview, partialReview);
});

test("persistence failure retains bounded original feedback without claiming nonexistent detail files", async t => {
  const context = await fixture(t);
  const blocked = path.join(context.projectRoot, ".runtime-correction");
  await fs.writeFile(blocked, "Not a directory");
  const feedback = await prepareHostFeedback({ ...context,
    text: "Original verified finding remains available.\n[RC_DETAILS] untrusted-nonexistent-index.json\n" + "繁".repeat(10000) });
  assert(size(feedback) <= HOST_FEEDBACK_MAX_BYTES);
  assert.match(feedback, /Could not persist full feedback/u);
  assert.match(feedback, /Original verified finding remains available/u);
  assert(!feedback.includes("[RC_DETAILS]"));
  assert(!feedback.includes("index.json"));
});

test("final native prefix and bounded feedback share one byte budget while the exact index remains", async t => {
  const context = await fixture(t);
  const feedback = await prepareHostFeedback({ ...context, text: "Original feedback " + "原文".repeat(10000) });
  const detailsPath = markerPath(feedback);
  const bounded = boundHostFeedback(feedback, { prefix: "Native finalization " + "超长前缀🌻".repeat(3000) });
  assert(size(bounded) <= HOST_FEEDBACK_MAX_BYTES);
  assert.equal(markerPath(bounded), detailsPath);
  await fs.access(detailsPath);
  assert(!bounded.includes("\uFFFD"));
});

test("final prefix rebounding retains edge deviations and updates the explicit omitted-item count", async t => {
  const context = await fixture(t);
  const objects = Array.from({ length: 45 }, (_, index) => ({ objectId: `M12:edge-${index}`, sourceId: `edge-${index}`,
    judgement: "DEVIATION", reason: `Observed defect ${index}: ` + "Very long original reason ".repeat(100), evidence: [] }));
  const feedback = await prepareHostFeedback({ ...context, text: "Review contains original deviations",
    report: { status: "DEVIATION", metrics: [{ objects }] } });
  const bounded = boundHostFeedback(feedback, { prefix: "Mandatory native prefix ".repeat(2000) });
  assert(size(bounded) <= HOST_FEEDBACK_MAX_BYTES);
  assert.match(bounded, /M12:edge-0/u);
  assert.match(bounded, /M12:edge-44/u);
  const rendered = bounded.split("\n\n").filter(block => block.startsWith("DEVIATION ")).length;
  const omitted = Number(/(\d+) item details omitted/u.exec(bounded)[1]);
  assert.equal(rendered + omitted, objects.length);
  assert.equal(markerPath(bounded), markerPath(feedback));
});

test("bounded projection retains original Stop controls and intermediate blocking summary without reloading quoted bodies", async t => {
  const context = await fixture(t);
  const messages = [
    "CORRECTION_BUDGET_EXHAUSTED: unresolved findings were recorded; this Stop is allowed, but verification did NOT pass. Do not claim full verification.",
    "STOP_VERIFICATION_UNAVAILABLE: report this task as COMPLETED BUT UNVERIFIED by the complete final assessment; retain available results and never claim the whole review passed.",
    "STOP_VERIFICATION_INCOMPLETE: this Stop is allowed with unverified obligations; do not claim full verification.",
    "This Stop is allowed; ALLOW is not an acceptance PASS.",
  ];
  const review = { stopClassification: "INTERMEDIATE", summary: "The completion claim is premature and must be blocked.",
    findings: [{ deviationKey: "current", violatedGroundTruthIds: ["current"], reason: "Original observed deviation", actualEvidence: [] }] };
  const text = ["[runtime-corrector] Original Stop header", "ORIGINAL_QUOTE_BODY ".repeat(10000), ...messages].join("\n");
  const feedback = await prepareHostFeedback({ ...context, text, review });
  assert(size(feedback) <= HOST_FEEDBACK_MAX_BYTES);
  for (const message of messages) assert(feedback.includes(message));
  assert.match(feedback, /premature and must be blocked/u);
  assert(!feedback.includes("ORIGINAL_QUOTE_BODY"));
  assert.equal(await fs.readFile((await read(markerPath(feedback))).fullFeedbackPath, "utf8"), text);
});

test("collection gaps and failed UNVERIFIED objects are counted once and checker reasons remain visible", async t => {
  const context = await fixture(t);
  const review = { collection: { complete: false, totalObjects: 3, reviewedObjects: 1,
    items: [{ status: "UNVERIFIED", objectIds: ["M01:unknown", "M01:later-passed"] }],
    failures: [{ code: "REVIEW_ITEM_TIMEOUT", reason: "Original short review timed out.", objectIds: ["M01:unknown", "M01:later-passed"] }] } };
  const implementationReview = { collection: { complete: false, totalObjects: 2, reviewedObjects: 1,
    items: [{ status: "UNVERIFIED", objectIds: ["M12:unknown"] }],
    failures: [{ code: "REVIEWER_CONTEXT_OVERFLOW", reason: "Original context window was exhausted.", objectIds: ["M12:unknown"] }] } };
  const report = { status: "CHECKER_ERROR", metrics: [{ objects: [
    { objectId: "M01:unknown", judgement: "UNVERIFIED", reason: "Review task did not complete", evidence: [] },
    { objectId: "M01:later-passed", judgement: "PASS", reason: "Current owner independently verified it", evidence: [] },
    { objectId: "M12:unknown", judgement: "UNVERIFIED", reason: "Review task did not complete", evidence: [] },
  ] }] };
  const feedback = await prepareHostFeedback({ ...context, text: "Final assessment is incomplete", review, report, implementationReview });
  assert.match(feedback, /Unreviewed 2;/u);
  assert.match(feedback, /REVIEW_ITEM_TIMEOUT/u);
  assert.match(feedback, /Original short review timed out/u);
  assert.match(feedback, /REVIEWER_CONTEXT_OVERFLOW/u);
  assert.match(feedback, /Original context window was exhausted/u);
  assert(!feedback.includes("DEVIATION"));
  const persisted = await read((await read(markerPath(feedback))).assessmentPath);
  assert.deepEqual(persisted.implementationReview, implementationReview);
});

test("large unstructured checker failures retain their original terminal release instruction", async t => {
  const context = await fixture(t);
  const control = "STOP_VERIFICATION_UNAVAILABLE: report this task as COMPLETED BUT UNVERIFIED; never claim the review passed.";
  const feedback = await prepareHostFeedback({ ...context, text: "Reviewer unavailable\n" + "Long original runtime error ".repeat(1000) + "\n" + control });
  assert(size(feedback) <= HOST_FEEDBACK_MAX_BYTES);
  assert(feedback.includes(control));
  await fs.access(markerPath(feedback));
});

test("deep workspace paths keep every item within 768 bytes using exact published index ordinals", async t => {
  const context = await fixture(t);
  const deepRoot = path.join(context.projectRoot, ...Array.from({ length: 16 }, (_, index) => `${index}-${"nested-project-".repeat(4)}`));
  await fs.mkdir(deepRoot, { recursive: true });
  const objects = Array.from({ length: 20 }, (_, index) => ({ objectId: `M12:deep-${index}`, sourceId: `deep-${index}`,
    judgement: "DEVIATION", reason: `Original deep-workspace defect ${index}: ` + "中文🌻".repeat(1000),
    evidence: [`${"very-long-source-directory/".repeat(40)}app.py#L2-L5`] }));
  const feedback = await prepareHostFeedback({ ...context, projectRoot: deepRoot, text: "Original deep-workspace review",
    report: { status: "DEVIATION", metrics: [{ objects }] } });
  const indexPath = markerPath(feedback), index = await read(indexPath);
  assert(size(indexPath) > HOST_FEEDBACK_ITEM_BYTES);
  assert(size(feedback) <= HOST_FEEDBACK_MAX_BYTES);
  assert.match(feedback, /M12:deep-0/u);
  assert.match(feedback, /M12:deep-19/u);
  for (const page of index.pages) {
    const entries = (await read(page.path)).items;
    assert.equal(entries[0].ordinal, page.firstOrdinal);
    assert.equal(entries.at(-1).ordinal, page.lastOrdinal);
    for (const entry of entries) {
      const short = await fs.readFile(entry.shortPath, "utf8"), full = await read(entry.path);
      assert(size(short) <= HOST_FEEDBACK_ITEM_BYTES);
      assert(short.includes(`[RC_ITEM] ${entry.ordinal} (published index)`));
      assert.equal(full.ordinal, entry.ordinal);
      assert(!short.includes("[RC_DETAILS]"), "a shortened absolute path must never be advertised");
    }
  }
  const prefixed = boundHostFeedback(feedback, { prefix: "Native operational instruction ".repeat(1000) });
  assert(size(prefixed) <= HOST_FEEDBACK_MAX_BYTES);
  assert.equal(markerPath(prefixed), indexPath);
  await fs.access(markerPath(prefixed));
});

test("findings-only failed review groups report task completeness without inventing metric PASS", async t => {
  const context = await fixture(t);
  const collection = { complete: false, totalItems: 3, completedItems: 2, totalObjects: 0, reviewedObjects: 0,
    items: [{ itemId: "a", status: "COMPLETED", objectIds: [] },
      { itemId: "b", status: "UNVERIFIED", objectIds: [] }, { itemId: "c", status: "COMPLETED", objectIds: [] }],
    failures: [{ itemId: "b", code: "REVIEWER_CONTEXT_OVERFLOW", reason: "Original findings-only agent context was exhausted.", objectIds: [] }] };
  const review = { stopClassification: "TASK_COMPLETE", collection,
    findings: [{ deviationKey: "original-finding", violatedGroundTruthIds: ["requirement-a"],
      reason: "Original confirmed finding remains available.", actualEvidence: ["app.py#L2-L5"] }] };
  const feedback = await prepareHostFeedback({ ...context, text: "Findings-only review is incomplete", review });
  assert.match(feedback, /Completed review tasks 2\/3/u);
  assert.match(feedback, /Unreviewed review tasks 1/u);
  assert.match(feedback, /REVIEWER_CONTEXT_OVERFLOW/u);
  assert.match(feedback, /Original confirmed finding remains available/u);
  assert.doesNotMatch(feedback, /\bPASS\b|Unreviewed 0|Existing object verdicts/u);
  const index = await read(markerPath(feedback));
  for (const page of index.pages) for (const entry of (await read(page.path)).items) {
    const item = await read(entry.path);
    assert.deepEqual(item.objects, []);
  }
});
