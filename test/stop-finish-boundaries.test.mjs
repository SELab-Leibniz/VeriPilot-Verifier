import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { ensureTask, taskDirectory, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { runtimeState } from "../scripts/diagnostics/lib/isolated-openclaw.mjs";
import { classifyStopTerminal } from "../experiments/review-metrics-20261024/e2e-plan/stop-terminal.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { prepareHostFeedback, boundHostFeedback } from "../lib/runtime-v2/feedback-delivery.mjs";

async function fixture(t, { quality = null, severity = "HARD", legacyChecker = false, legacyMode = null, expireAfterSave = false } = {}) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-finish-boundary-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = Date.now;
  t.after(() => { Date.now = now; });
  const task = await ensureTask({ projectRoot: root, sessionId: "finish-host" });
  const mixedFinding = ["mixed-finding", "foreign-finding", "basis-finding"].includes(legacyMode);
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [{
    operation: "ADD", category: "requirements", text: "Deliver the originally requested file content.",
    authority: "USER_EXPLICIT", severity, verificationTarget: mixedFinding ? "IMPLEMENTATION" : "ARTIFACT", source: { ref: "user" },
  }] } });
  const directory = taskDirectory(root, task.taskId), source = path.join(root, "delivery.md");
  const transcript = path.join(root, "transcript.jsonl");
  await fs.writeFile(source, "The concrete observed current delivery body.\n");
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "user-1", message: { content: "Deliver the requested file." } }));
  const factory = async input => {
    const classification = { stopClassification: "TASK_COMPLETE", stage: null };
    if (input.request.reviewScope?.kind === "classification") return {
      result: { summary: "Classified the Stop.", ...classification, findings: [], metricObjectJudgements: [] }, close() {},
    };
    const file = input.request.reviewScope?.kind === "file-quality" || legacyMode === "file";
    // Scripted transport actually reads its complete fixture basis and source;
    // the collector independently checks these program-owned proof locations.
    await fs.readFile(input.request.groundTruthPath);
    const sourceBytes = await fs.readFile(source);
    const objects = Object.values(input.request.population.metrics).flat();
    const rows = objects.map((object, index) => ({
      objectId: object.objectId, judgement: (legacyChecker || legacyMode === "sibling") && index === 0 ? "DEVIATION" : "PASS",
      reason: (legacyChecker || legacyMode === "sibling") && index === 0 ? "A confirmed original HARD requirement has a concrete mismatch." : "The assigned metric evidence matches.",
      evidence: [`${source}#L1`],
    }));
    if (["PASS", "NOT_APPLICABLE"].includes(legacyMode)) { rows[0].judgement = legacyMode; rows[0].evidence = []; }
    if (legacyMode === "sibling") rows[1].evidence = [];
    if (mixedFinding) for (const row of rows) if (/^M(?:12|16):/u.test(row.objectId)) row.judgement = "UNVERIFIED";
    if (legacyChecker) rows.push({ ...rows[1] });
    const sourceCitations = [...rows.map(row => row.objectId), ...(file ? ["delivery.md"] : [])].map(owner => ({
      selection: `${source}#L1`, path: source, snapshotPath: source, contentHash: sha256(sourceBytes), start: 1, end: 1,
      usedBy: [owner], readProof: { version: 1, owner: "ARTIFACT", observed: true, basisComplete: true },
    }));
    if (mixedFinding) sourceCitations.push({ ...sourceCitations[0], usedBy: ["unproved-finding"],
      readProof: { version: 1, owner: legacyMode === "basis-finding" ? "BASIS" : "ARTIFACT", observed: true, basisComplete: true } });
    return { sourceCitations, result: { summary: "Compared the current source.", ...classification,
      findings: legacyMode === "finding" || mixedFinding ? [{ deviationKey: "unproved-finding", rootCauseId: "REQUIREMENT_OMITTED", severity: "error",
        reason: "A concrete original observation demonstrates the finding.", actualEvidence: mixedFinding ? [`${source}#L1`] : [], expectedConstraint: "The original requirement.",
        violatedGroundTruthIds: [objects[0].sourceId, ...(legacyMode === "foreign-finding" ? ["foreign-claim"] : [])] }] : [], metricObjectJudgements: rows,
      fileAssessments: file ? [{ path: "delivery.md", status: quality,
        reason: quality === "UNVERIFIED" ? "The file quality baseline is unresolved." : "The current file omits a concrete required section.",
        evidence: quality === "UNVERIFIED" || legacyMode === "file" ? [] : [`${source}#L1`] }] : [] },
      close() { if (expireAfterSave) Date.now = () => input.deadlineAt + 1; } };
  };
  factory.supportsReviewCollection = !legacyChecker && legacyMode === null;
  factory.supportsSupplementalFileAssessment = quality !== null;
  factory.handoff = factory;
  const plan = { artifacts: [{ nodeId: "delivery", stage: "requirements", patterns: ["delivery.md"], metrics: [] }],
    runtimeV2: compileRuntimeV2Config({ version: 2, locale: "en", dynamicGroundTruth: { enabled: false },
      skillCorrection: { enabled: false }, stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
      reviewers: { stopReviewer: { timeoutMs: 15000 } },
    }, { policyRoot: path.join(root, ".runtime-corrector") }) };
  const before = JSON.parse(await fs.readFile(path.join(directory, "task.json"), "utf8"));
  let result;
  try { result = await handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory: factory,
    assessmentContext: { mode: "execute_and_correct", assessmentId: "finish-assessment", guard: decisionGuard(before) },
    input: { cwd: root, session_id: "finish-host", transcript_path: transcript, hook_event_name: "Stop",
      hook_event_id: "finish-stop", last_assistant_message: "Task complete." } }); }
  finally { Date.now = now; }
  const state = JSON.parse(await fs.readFile(path.join(directory, "task.json"), "utf8"));
  return { root, directory, task, state, result };
}

for (const [quality, severity] of [["DEVIATION", "HARD"], ["UNVERIFIED", "HARD"], ["DEVIATION", "SOFT"]]) {
  test(`file quality ${quality}/${severity} is visible without inventing a HARD metric or business retry`, async t => {
    const f = await fixture(t, { quality, severity }), stop = f.result.stop;
    assert.equal(f.result.decision, "allow");
    assert.equal(stop.fileQualityIncomplete, true);
    assert.equal(stop.verificationIncomplete, true);
    assert.equal(stop.report.status, "UNVERIFIED");
    assert.ok(stop.report.metrics.flatMap(metric => metric.objects).every(object => object.judgement === "PASS"));
    assert.equal(stop.report.blockingObjects.length, 0);
    assert.equal(f.state.verification.status, "UNVERIFIED");
    assert.equal(f.state.status, "COMPLETED_WITH_ISSUES");
    assert.equal(f.state.stop.correctionAttempts, 0);
    assert.equal(f.state.stop.infrastructureFailures, 0);
    assert.match(f.result.feedback, new RegExp(`FILE_QUALITY_${quality}`));
    assert.match(f.result.feedback, quality === "DEVIATION" ? /concrete required section/ : /baseline is unresolved/);
    assert.ok(Buffer.byteLength(f.result.feedback) <= 8192);
    const indexPath = /^\[RC_DETAILS\] ([^\n]+)/mu.exec(f.result.feedback)?.[1];
    assert(indexPath);
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    assert.ok(index.itemCount > 0);
  });
}

test("conclusive file PASS keeps the ordinary complete Stop behavior", async t => {
  const f = await fixture(t, { quality: "PASS" });
  assert.equal(f.result.decision, "allow");
  assert.equal(f.result.feedback, null);
  assert.equal(f.result.stop.fileQualityIncomplete, false);
  assert.equal(f.state.status, "COMPLETED");
  assert.equal(f.state.verification.status, "PASS");
});

test("a finished file-quality gap is not certified as a complete Stop PASS", async t => {
  const f = await fixture(t, { quality: "DEVIATION" });
  const native = createNativeStopReviews();
  await native.schedule({ projectRoot: f.root, sessionId: "finish-host", sessionKey: "agent:main:finish", runId: "finish-run",
    signal: new AbortController().signal, budgetMs: 10000, run: async ({ commit }) => {
      const result = { reviewStatus: f.state.verification.status, evaluationId: f.state.verification.evaluationId };
      await commit(result); return result;
    } });
  await native.wait();
  const state = await runtimeState(f.root);
  const population = JSON.parse(await fs.readFile(path.join(f.directory, "metrics/population.json"), "utf8"));
  const result = classifyStopTerminal(state, { taskId: f.task.taskId, population });
  assert.equal(result.kind, "SETTLED_WITH_UNVERIFIED");
  assert.equal(result.allMetricsPass, false);
  assert.deepEqual(result.incompleteFiles, [{ path: "delivery.md", status: "DEVIATION" }]);
  const report = state.evaluations[0].metricReport;
  report.status = "PASS";
  const task = state.tasks[0], saved = task.assessments[task.verification.assessmentId].result.stop;
  saved.report = structuredClone(report);
  task.verification.status = "PASS"; task.status = "COMPLETED";
  state.records[0].reviewStatus = "PASS";
  assert.equal(classifyStopTerminal(state, { taskId: f.task.taskId, population }).kind, "NOT_ACCEPTED",
    "The observer must also reject an older core's false all-PASS projection with file D.");
});

test("deadline-only failure retains saved item navigation without republishing expired PASS", async t => {
  const f = await fixture(t, { expireAfterSave: true });
  const stop = f.result.stop;
  assert.equal(stop.status, "UNVERIFIED");
  assert.equal(stop.report, undefined);
  assert.equal(stop.partialReview, undefined);
  assert.equal(stop.savedReviewCollection.completedItems, 1);
  const progress = JSON.parse(await fs.readFile(stop.savedReviewCollection.progressPath, "utf8"));
  assert.equal(progress.completedItems, 1);
  const item = JSON.parse(await fs.readFile(progress.items[0].path, "utf8"));
  assert.equal(item.status, "COMPLETED");
  assert.ok(item.result.metricObjectJudgements.every(object => object.judgement === "PASS"));
  assert.match(f.result.feedback, /historical work, not current valid verification/);
  assert.match(f.result.feedback, /\[RC_SAVED_REVIEW\]/);
  assert.equal(f.state.verification.status, "UNVERIFIED");
  assert.equal(f.state.stop.correctionAttempts, 0);
});

test("legacy checker faults take precedence without losing real HARD deviation feedback", async t => {
  const f = await fixture(t, { legacyChecker: true });
  assert.equal(f.result.decision, "block");
  assert.equal(f.result.stop.report.status, "CHECKER_ERROR");
  assert.equal(f.result.stop.partialFeedbackEligible, true);
  assert.ok(f.result.stop.report.checkerIssues.some(issue => issue.type === "DUPLICATE_OBJECT"));
  assert.match(f.result.feedback, /confirmed original HARD requirement/);
  assert.equal(f.state.stop.correctionAttempts, 0);
  assert.equal(f.state.stop.infrastructureFailures, 1);
});

for (const legacyMode of ["PASS", "NOT_APPLICABLE", "file", "finding", "sibling"]) {
  test(`legacy ${legacyMode} cannot bypass proof validation or spend business correction budget`, async t => {
    const f = await fixture(t, { legacyMode, ...(legacyMode === "file" ? { quality: "DEVIATION" } : {}) });
    assert.equal(f.result.decision, "block");
    assert.equal(f.result.stop.report.status, "CHECKER_ERROR");
    assert.ok(f.result.stop.review.validationIssues.length > 0);
    assert.equal(f.state.verification.status, "UNVERIFIED");
    assert.equal(f.state.stop.correctionAttempts, 0);
    assert.equal(f.state.stop.infrastructureFailures, 1);
    if (legacyMode === "sibling") {
      assert.match(f.result.feedback, /confirmed original HARD requirement/);
      assert.equal(f.result.stop.partialFeedbackEligible, true);
    } else assert.notEqual(f.result.stop.partialFeedbackEligible, true);
    if (legacyMode === "finding") assert.deepEqual(f.result.stop.review.findings, []);
    if (legacyMode === "file") assert.equal(f.result.stop.review.fileAssessments[0].status, "UNVERIFIED");
  });
}

test("one claim's finding needs one matching evidence owner, not every metric projection", async t => {
  const f = await fixture(t, { legacyMode: "mixed-finding" });
  assert.equal(f.result.stop.report.status, "DEVIATION");
  assert.deepEqual(f.result.stop.report.checkerIssues, []);
  assert.equal(f.result.stop.review.findings.length, 1);
  assert.equal(f.state.stop.correctionAttempts, 1);
  assert.match(f.result.feedback, /concrete original observation/);
});

for (const legacyMode of ["foreign-finding", "basis-finding"]) test(`${legacyMode} cannot hide behind a matching known projection`, async t => {
  const f = await fixture(t, { legacyMode });
  assert.equal(f.result.stop.report.status, "CHECKER_ERROR");
  assert.deepEqual(f.result.stop.review.findings, []);
  assert.equal(f.state.stop.correctionAttempts, 0);
  assert.equal(f.state.stop.infrastructureFailures, 1);
});

test("many long file diagnostics keep independent details under both host feedback caps", async t => {
  const f = await fixture(t, { quality: "PASS" });
  const files = Array.from({ length: 40 }, (_, index) => ({ path: `delivery-${index}.md`,
    status: index % 2 ? "UNVERIFIED" : "DEVIATION",
    reason: `Concrete file mechanism ${index} causes an observable gap. ` + "完整原因与后果。".repeat(300) + ` retained-tail-${index}`,
    evidence: [] }));
  const text = await prepareHostFeedback({ projectRoot: f.root, taskId: f.task.taskId, text: "[runtime-corrector] File verification incomplete.",
    review: { ...f.result.stop.review, fileAssessments: files }, report: { ...f.result.stop.report, status: "UNVERIFIED" } });
  assert.ok(Buffer.byteLength(text) <= 8192);
  assert.match(text, /FILE_QUALITY_DEVIATION/);
  const indexPath = /^\[RC_DETAILS\] ([^\n]+)/mu.exec(text)?.[1]; assert(indexPath);
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const entries = [];
  for (const page of index.pages) entries.push(...JSON.parse(await fs.readFile(page.path, "utf8")).items);
  const quality = entries.filter(item => item.state.startsWith("FILE_QUALITY_"));
  assert.equal(quality.length, files.length);
  for (const entry of quality) {
    const detail = JSON.parse(await fs.readFile(entry.path, "utf8"));
    assert.equal(detail.kind, "file-quality");
    assert.deepEqual(detail.objectIds, [], "File diagnostics cannot invent metric objects or GT identities.");
    assert.match(detail.reason, /retained-tail-/);
    assert.ok(Buffer.byteLength(await fs.readFile(entry.shortPath, "utf8")) <= 768);
  }
  const wrapped = boundHostFeedback(text, { prefix: "A host envelope. ".repeat(90) });
  assert.ok(Buffer.byteLength(wrapped) <= 8192);
  assert.match(wrapped, /FILE_QUALITY_/);
  assert.ok(wrapped.includes(indexPath));
});
