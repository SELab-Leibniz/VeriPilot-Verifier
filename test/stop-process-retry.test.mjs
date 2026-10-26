import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureTask, taskDirectory, decisionGuard, findTask } from "../lib/runtime-v2/task-store.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import {runStartedHostEvent as handleRuntimeV2Event} from "./helpers/started-host.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { withTestReviewProof } from "./helpers/review-proof.mjs";
import {scriptedProductionProofs} from './helpers/observed-review.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-process-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "retry-host" });
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [
    { operation: "ADD", claimId: "scope", category: "constraints", verificationTarget: "PROCESS",
      text: "Only write kitchen.py and data; historical extra-script writes remain attributable.", authority: "USER_EXPLICIT", severity: "HARD", source: { ref: "user" } },
    { operation: "ADD", claimId: "runtime", category: "requirements", verificationTarget: "IMPLEMENTATION",
      text: "The app passes the real CLI acceptance.", authority: "USER_EXPLICIT", severity: "HARD", source: { ref: "user" } },
  ] } });
  const source = path.join(root, "kitchen.py"), transcript = path.join(root, "history.jsonl");
  await fs.writeFile(source, "# Validated app source\n");
  const entries = [{ type: "user", uuid: "u1", message: { content: "Build the app and preserve the scope." } }];
  const calls = []; let processVerdict = "DEVIATION";
  const factory = async params => {
    const fixed = { stopClassification: "TASK_COMPLETE", stage: null };
    if (params.request.reviewScope?.kind === "classification") return { result: { ...fixed, summary: "Delivery.", findings: [], metricObjectJudgements: [] }, close() {} };
    const objects = Object.values(params.request.population.metrics).flat();
    calls.push(objects.map(o => o.objectId));
    const rows = objects.map(o => ({ objectId: o.objectId, judgement: o.metricId === "M11" ? processVerdict : "PASS",
      reason: o.metricId === "M11" ? "Recorded extra-script writes remain outside the allowed scope." : "Frozen CLI acceptance is satisfied.", evidence: [`${source}#L1`] }));
    return withTestReviewProof(params, { proofs:scriptedProductionProofs(params,{metricObjectJudgements:rows}),result: { ...fixed, summary: "Reviewed.", findings: [], fileAssessments: [], metricObjectJudgements: rows },
      reviewEvidence: { files: [source], fingerprints: { [source]: sha256(await fs.readFile(source)) }, unstable: false, missing: [] }, close() {} });
  };
  factory.supportsReviewCollection = true;
  factory.reviewItemSize = 1;
  factory.reviewCacheIdentity = () => "fixed-reviewer-v1";
  const plan = { artifacts: [{ nodeId: "kitchen-source", stage: "implementation", patterns: ["kitchen.py"] }], runtimeV2: compileRuntimeV2Config({ version: 2, locale: "en", dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: false }, implementationCorrection: { enabled: false }, stopCorrection: { enabled: true, metrics: { M11: true } },
    reviewers: { defaults: { timeoutMs: 10000 } } }, { policyRoot: path.join(root, ".runtime-corrector") }) };
  let turn = 0;
  const run = async () => {
    await fs.writeFile(transcript, entries.map(JSON.stringify).join("\n"));
    const current = await findTask({ projectRoot: root, sessionId: "retry-host" });
    return handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory: factory,
      assessmentContext: { mode: "execute_and_correct", assessmentId: `attempt-${++turn}`, guard: decisionGuard(current) },
      input: { cwd: root, session_id: "retry-host", transcript_path: transcript, hook_event_name: "Stop",
        hook_event_id: `stop-${turn}`, last_assistant_message: "Task complete." } });
  };
  return { root, task, source, entries, calls, run, setProcessVerdict: value => { processVerdict = value; } };
}

test("a repeated process failure checks only the previous failing obligation and stops with retained failure, not PASS", async t => {
  const f = await fixture(t), first = await f.run();
  assert.equal(first.decision, "block", JSON.stringify(first));
  const state = await findTask({ projectRoot: f.root, sessionId: "retry-host" });
  assert(state.stop.processRetry, JSON.stringify(first));
  const before = f.calls.length;
  f.entries.push({ type: "assistant", uuid: "correction", message: { content: "The app is unchanged; historical writes cannot be undone." } });
  const second = await f.run();
  assert.equal(second.stop.reasonCode, "PROCESS_CORRECTION_NO_PROGRESS", JSON.stringify(second));
  assert.equal(second.decision, "allow"); assert.equal(second.stop.status, "UNVERIFIED");
  assert.equal(f.calls.length - before, 1);
  assert.deepEqual(f.calls.at(-1), ["M11:scope"]);
  const ended = await findTask({ projectRoot: f.root, sessionId: "retry-host" });
  assert.equal(ended.status, "STOPPED_UNVERIFIED"); assert.equal(ended.stop.correctionAttempts, 1);
  assert.equal(ended.verification.status, "UNVERIFIED");
  assert.match(second.feedback, /deviations are retained/u);
  assert(!second.stop.report, "a narrow negative recheck must not manufacture a new full-population PASS report");
});

for (const change of ["source", "new user", "fixed process"]) test(`${change} cannot trigger an unchanged-process shortcut`, async t => {
  const f = await fixture(t); await f.run(); const before = f.calls.length;
  if (change === "source") await fs.writeFile(f.source, "# Changed app source\n");
  if (change === "new user") f.entries.push({ type: "user", uuid: "u2", message: { content: "Please inspect new work." } });
  if (change === "fixed process") f.setProcessVerdict("PASS");
  const result = await f.run();
  assert.notEqual(result.stop.reasonCode, "PROCESS_CORRECTION_NO_PROGRESS");
  assert(f.calls.length - before > 1, "a changed or repaired case requires the full remaining assessment");
});
