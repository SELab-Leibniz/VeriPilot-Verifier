import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderStopDetails } from "../lib/runtime-v2/stop-feedback.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { ensureTask, taskStatePath } from "../lib/runtime-v2/task-store.mjs";

test("all original findings remain visible, including a HARD deviation after five informational findings", () => {
  const findings = Array.from({ length: 6 }, (_, index) => ({ deviationKey: `f${index}`, severity: index === 5 ? "error" : "info",
    reason: index === 5 ? "Required output is missing" : `Original information ${index}`, violatedGroundTruthIds: [`req${index}`],
    suggestedNextAction: "Invent an additional repair step", actualEvidence: [] }));
  const before = structuredClone(findings);
  const feedback = renderStopDetails({ review: { findings } });
  for (const finding of findings) assert.ok(feedback.includes(finding.reason));
  assert.ok(!feedback.includes("Invent an additional repair step"));
  assert.deepEqual(findings, before);
});

test("related original metric ids and findings are grouped without changing or losing their judgements", () => {
  const object = { sourceId: "req", judgement: "DEVIATION", reason: "Same actual deviation", evidence: ["raw:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#L2-L4"] };
  const report = { metrics: [{ objects: [{ ...object, objectId: "M01:req" }, { ...object, objectId: "M12:req" }] }] };
  const review = { findings: [{ deviationKey: "same", reason: object.reason, violatedGroundTruthIds: ["req"], actualEvidence: object.evidence }] };
  const citations = [{ selection: object.evidence[0], path: "business.py", start: 2, end: 4, exactQuote: "program-only quote", usedBy: ["M12:req", "same"] }];
  const original = structuredClone({ report, review, citations });
  const feedback = renderStopDetails({ review, report, citations });
  assert.equal(feedback.match(/Same actual deviation/gu).length, 1);
  assert.match(feedback, /M01:req, M12:req/u);
  assert.match(feedback, /business\.py#L2-L4/u);
  assert.ok(!feedback.includes("program-only quote"));
  assert.deepEqual({ report, review, citations }, original);
});

test("frozen private citations use durable snapshots while business citations retain the source path", () => {
  const review = { findings: [
    { deviationKey: "private", reason: "Original requirement point", actualEvidence: ["raw:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#L2-L4"] },
    { deviationKey: "business", reason: "Actual code point", actualEvidence: ["raw:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#L3-L5"] },
  ] };
  const feedback = renderStopDetails({ review, citations: [
    { frozen: true, path: ".internal-requests/deleted/request.md", snapshotPath: "reviewer-progress/session/sources/hash.txt",
      start: 2, end: 4, usedBy: ["private"] },
    { frozen: false, path: "business.py", snapshotPath: "reviewer-progress/session/sources/code.txt",
      start: 3, end: 5, usedBy: ["business"] },
  ] });
  assert.match(feedback, /reviewer-progress\/session\/sources\/hash\.txt#L2-L4/u);
  assert.match(feedback, /business\.py#L3-L5/u);
  assert.ok(!feedback.includes(".internal-requests/deleted/request.md"));
  assert.ok(!feedback.includes("reviewer-progress/session/sources/code.txt"));
});

test("partial progress does not classify completion or expand unreviewed objects into repair instructions", () => {
  const partialReview = { status: "PARTIAL", finalClassification: null, totalObjects: 60, recoveredObjects: 1,
    metricObjectJudgements: [{ objectId: "M12:req", judgement: "PASS", reason: "Completed local observation", evidence: [] }],
    unreviewedObjectIds: Array.from({ length: 59 }, (_, index) => `M12:pending${index}`), rejectedObjectIds: [] };
  const feedback = renderStopDetails({ partialReview, released: true });
  assert.match(feedback, /1\/60/u);
  assert.match(feedback, /classification is unconfirmed/u);
  assert.match(feedback, /Unreviewed scope: 59/u);
  assert.match(feedback, /ALLOW is not an acceptance PASS/u);
  assert.ok(!feedback.includes("pending58"));
  assert.ok(feedback.length < 1000);
});

test("checker failures are summarized separately from actual deviations", () => {
  const feedback = renderStopDetails({ report: { metrics: [{ objects: Array.from({ length: 57 }, (_, index) => ({
    objectId: `M12:req${index}`, judgement: "CHECKER_ERROR", reason: "Implementation reviewer did not complete" })) }],
    checkerIssues: [{ objectId: "M03:invented-object", message: "Unknown frozen object" }] } });
  assert.match(feedback, /CHECKER_ERROR 57/u);
  assert.match(feedback, /M03:invented-object/u);
  assert.equal(feedback.match(/Implementation reviewer did not complete/gu).length, 1);
  assert.ok(!feedback.includes("[DEVIATION"));
});

for (const active of [true, false]) test(`Stop failure ${active ? "persists valid partial progress" : "suppresses inactive progress"} without changing budgets`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-partial-core-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "partial-host" });
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [{ operation: "ADD", category: "requirements",
    text: "A confirmed output requirement", authority: "USER_EXPLICIT", severity: "HARD", source: { ref: "user" } }] } });
  const transcript = path.join(root, "transcript.jsonl");
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "user-1", message: { content: "A confirmed output requirement" } }));
  const plan = { runtimeV2: compileRuntimeV2Config({ version: 2, locale: "en", dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: false }, stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 } }, { policyRoot: path.join(root, ".runtime-corrector") }) };
  let partialReview;
  const factory = async ({ request }) => {
    const objects = Object.values(request.population.metrics).flat();
    const first = objects[0];
    partialReview = { status: "PARTIAL", finalClassification: null, totalObjects: objects.length, recoveredObjects: 1,
      metricObjectJudgements: [{ objectId: first.objectId, judgement: "DEVIATION", reason: "Actual local deviation", evidence: ["business.py#L2-L4"] }],
      unreviewedObjectIds: objects.slice(1).map(object => object.objectId), rejectedObjectIds: [], citations: [] };
    throw Object.assign(new Error("Reviewer final output invalid"), { partialReview, partialReviewIsActive: () => active });
  };
  factory.handoff = factory;
  const stop = id => handleRuntimeV2Event({ input: { cwd: root, session_id: "partial-host", transcript_path: transcript,
    hook_event_name: "Stop", hook_event_id: id, last_assistant_message: "Task complete." }, projectRoot: root, plan, reviewerFactory: factory });
  const first = await stop("p1");
  assert.equal(first.decision, "block");
  assert.equal(first.stop.status, "UNVERIFIED");
  assert.equal(first.stop.partialReview?.status, active ? "PARTIAL" : undefined);
  assert.equal(first.feedback.includes("Actual local deviation"), active);
  if (active) {
    const persisted = JSON.parse(await fs.readFile(first.stop.persisted.filePath, "utf8"));
    assert.deepEqual(persisted.partialReview, partialReview);
    assert.equal(persisted.status, "UNVERIFIED");
    assert.equal(persisted.partialReview.finalClassification, null);
  }
  await stop("p2");
  const released = await stop("p3");
  assert.equal(released.decision, "allow");
  assert.match(released.feedback, /STOP_VERIFICATION_UNAVAILABLE/u);
  assert.ok(!released.feedback.includes("never verified"));
  const state = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  assert.equal(state.stop.correctionAttempts, 0);
  assert.equal(state.stop.infrastructureFailures, 3);
});
