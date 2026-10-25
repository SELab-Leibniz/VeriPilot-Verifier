import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { compileRuntimeV2Config, METRIC_IDS } from "../lib/runtime-v2/config.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { ensureTask, taskDirectory, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t, failed = -1, stopClassification = "TASK_COMPLETE", severity = "HARD", findingKey = "premature-output", businessDeviation = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-collector-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "collector-host" });
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: {
    operations: ["first", "middle", "last"].map(name => ({ operation: "ADD", category: "requirements",
      text: `Deliver the ${name} requirement.`, authority: "USER_EXPLICIT", severity,
      verificationTarget: "ARTIFACT", source: { ref: "user" } })),
  } });
  const source = path.join(root, "output.txt");
  await fs.writeFile(source, "Current original output for source-bound assessment.\n");
  const transcript = path.join(root, "transcript.jsonl");
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { content: "Deliver all three requirements." } }));
  const calls = [];
  let item = 0;
  const factory = async options => {
    calls.push(options);
    if (options.request.reviewScope?.kind === "classification") return {
      result: { summary: "Classified the stopping situation.", stopClassification, stage: null,
        findings: [], metricObjectJudgements: [] }, close: async () => {},
    };
    const index = item++;
    const localClassification = options.request.fixedStopClassification?.stopClassification ?? stopClassification;
    if (index === failed) throw Object.assign(new Error("prompt exceeds context window"), { code: "CONTEXT_OVERFLOW" });
    const objects = Object.values(options.request.population.metrics).flat();
    await fs.readFile(options.request.groundTruthPath);
    const sourceHash = sha256(await fs.readFile(source));
    const findings = localClassification === "INTERMEDIATE" && index === 0 && businessDeviation ? [{
      deviationKey: findingKey, rootCauseId: "REQUIREMENT_OMITTED", severity: "error",
      reason: "A required evidence gate is absent, so the attempted stop is premature and must be blocked.",
      actualEvidence: [`${source}#L1-L1`], expectedConstraint: "Observe the original evidence gate.",
      violatedGroundTruthIds: options.request.reviewScope.sourceIds,
    }] : [];
    return { sourceCitations: [...objects.map(object => object.objectId), ...findings.map(finding => finding.deviationKey)].map(owner => ({
      selection: `${source}#L1-L1`, path: source, snapshotPath: source, contentHash: sourceHash,
      start: 1, end: 1, usedBy: [owner],
      readProof: { version: 1, owner: "ARTIFACT", observed: true, basisComplete: true },
    })), result: { summary: "Compared the assigned originals.", stopClassification: localClassification, stage: null,
      findings, metricObjectJudgements: objects.map(object => ({ objectId: object.objectId,
        judgement: failed >= 0 && businessDeviation && index === 0 ? "DEVIATION" : "PASS",
        reason: failed >= 0 && businessDeviation && index === 0 ? "The first output has a confirmed local discrepancy." : "Assigned evidence matches.",
        evidence: [`${source}#L1-L1`] })) }, close: async () => {},
    };
  };
  factory.supportsReviewCollection = true;
  const plan = { runtimeV2: compileRuntimeV2Config({ version: 2, locale: "en", dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: false }, stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3,
      metrics: Object.fromEntries(METRIC_IDS.map(id => [id, true])) },
    reviewers: { stopReviewer: { timeoutMs: 15000 } },
  }, { policyRoot: path.join(root, ".runtime-corrector") }) };
  const run = (extra = {}) => handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory: factory, ...extra,
    input: { cwd: root, session_id: "collector-host", transcript_path: transcript,
      hook_event_name: "Stop", hook_event_id: "collector-stop", last_assistant_message: "Task complete." } });
  return { root, task, calls, run };
}

for (const classification of ["TASK_COMPLETE", "INTERMEDIATE"]) test(`checker-only ${classification} failure retains results without requesting business continuation`, async t => {
  const f = await fixture(t, 1, classification, "HARD", "premature-output", false);
  const result = await f.run();
  assert.equal(result.stop.status, "UNVERIFIED");
  assert.equal(result.stop.decision, "block");
  assert.notEqual(result.stop.partialFeedbackEligible, true);
  assert.equal(result.stop.review.collection.complete, false);
  assert.equal(result.stop.review.collection.reviewedObjects > 0, true);
  assert.equal(result.stop.correctionAttempt ?? 0, 0);
  assert.equal(result.stop.infrastructureAttempt, 1);
  assert.equal(result.stop.report?.blockingObjects.filter(row => row.judgement === "DEVIATION").length ?? 0, 0);
});

for (const failed of [1, 2]) test(`Stop retains and delivers source-bound results when ${failed === 1 ? "middle" : "last"} task overflows`, async t => {
  const f = await fixture(t, failed);
  const result = await f.run();
  assert.equal(result.stop.status, "UNVERIFIED");
  assert.equal(result.stop.partialFeedbackEligible, true);
  assert.equal(result.stop.infrastructureAttempt, 1);
  assert.equal(result.stop.review.collection.complete, false);
  assert.equal(result.stop.review.collection.items.length, 3);
  assert.equal(f.calls.length, 4);
  assert.match(result.feedback, /confirmed local discrepancy/u);
  assert.ok(Buffer.byteLength(result.feedback, "utf8") <= 8192);
  const indexPath = /^\[RC_DETAILS\] ([^\n]+)/mu.exec(result.feedback)?.[1];
  assert(indexPath); assert.equal(JSON.parse(await fs.readFile(indexPath, "utf8")).itemCount > 0, true);
  const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), "task.json"), "utf8"));
  assert.equal(state.stop.correctionAttempts, 0, "checker overflow must not spend a business correction");
  assert.equal(state.stop.infrastructureFailures, 1, "the whole round counts once, not once per object");
  assert.equal(state.verification.status, "UNVERIFIED");
  const population = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), "metrics/population.json"), "utf8"));
  assert.equal(result.stop.report.metrics.flatMap(metric => metric.objects).length,
    Object.values(population.metrics).flat().length, "failed tasks remain in the original denominator");
});

test("complete isolated reviews retain the original full-population PASS behavior", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.decision, "allow");
  assert.equal(result.stop.report.status, "PASS");
  assert.equal(result.stop.review.collection.complete, true);
  assert.equal(result.feedback, null);
  assert.equal(f.calls.length, 4);
  const [classification, ...items] = f.calls;
  assert.equal(classification.request.reviewScope.boundedBasis, true);
  assert.equal(classification.schema.properties.findings.maxItems, 0);
  assert.equal(classification.schema.properties.findings.items.properties, undefined,
    "scope selection does not carry the unused finding schema and its ID enums");
  assert.ok(Buffer.byteLength(JSON.stringify(classification.schema)) < 1024,
    "the classification schema stays independent of the business population");
  assert.ok(items.every(item => item.request.reviewScope.boundedBasis === true));
});

test("explicit verify_only uses the caller's current-output scope without a model classifier", async t => {
  const f = await fixture(t, -1, "INTERMEDIATE");
  const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), "task.json"), "utf8"));
  const result = await f.run({ assessmentContext: { mode: "verify_only", assessmentId: "caller-scope",
    guard: decisionGuard(state), deadlineAt: Date.now() + 30000, maxCorrections: 3 } });
  assert.equal(f.calls.length, 3, "only the three actual item checks consume model calls");
  assert.ok(f.calls.every(call => call.request.reviewScope.kind !== "classification"));
  assert.equal(result.stop.review.stopClassification, "TASK_COMPLETE", "caller scope cannot drift with old assistant progress");
  assert.equal(result.stop.report.status, "PASS", "PASS still requires every owned object to pass");
  assert.equal(result.stop.review.metricObjectJudgements.length, 12);
});

test("caller-selected verification scope cannot turn an overflowing item into PASS", async t => {
  const f = await fixture(t, 1, "INTERMEDIATE");
  const statePath = path.join(taskDirectory(f.root, f.task.taskId), "task.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const result = await f.run({ assessmentContext: { mode: "verify_only", assessmentId: "caller-scope-failed",
    guard: decisionGuard(state), deadlineAt: Date.now() + 30000, maxCorrections: 3 } });
  assert.equal(f.calls.length, 3);
  assert.equal(result.stop.status, "UNVERIFIED");
  assert.equal(result.stop.review.collection.complete, false);
  assert.equal(result.stop.review.metricObjectJudgements.filter(row => row.judgement === "UNVERIFIED").length, 4);
  assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).stop.correctionAttempts, 0);
});

for (const failed of [-1, 1]) test(`intermediate Stop retains hard findings${failed >= 0 ? " across an overflowing sibling" : " without metric PASS"}`, async t => {
  const f = await fixture(t, failed, "INTERMEDIATE");
  const result = await f.run();
  assert.equal(result.decision, "block");
  assert.equal(result.stop.review.stopClassification, "INTERMEDIATE");
  assert.equal(result.stop.review.collection.mode, "findings-only");
  assert.deepEqual(result.stop.review.metricObjectJudgements, []);
  assert.equal(result.stop.review.findings.length, 1);
  assert.match(result.feedback, /premature and must be blocked/u);
  assert.equal(f.calls.length, 4);
  const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), "task.json"), "utf8"));
  assert.equal(state.stop.correctionAttempts, failed >= 0 ? 0 : 1);
  if (failed >= 0) {
    assert.equal(result.stop.status, "UNVERIFIED");
    assert.equal(result.stop.partialFeedbackEligible, true);
    assert.equal(state.stop.infrastructureFailures, 1);
  }
});

test("a short reviewer cannot promote a SOFT obligation through a deterministic finding namespace", async t => {
  const f = await fixture(t, -1, "INTERMEDIATE", "SOFT", "impl:build:model-spoof");
  const result = await f.run();
  assert.equal(result.decision, "allow");
  assert.equal(result.stop.review.findings.length, 1, "the advisory finding stays visible in the machine assessment");
  assert.equal(result.stop.correctionAttempt, 0);
});
