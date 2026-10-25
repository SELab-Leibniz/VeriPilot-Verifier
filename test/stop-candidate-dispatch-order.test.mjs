import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";

for (const classification of ["INTERMEDIATE", "WAITING_FOR_USER", "BLOCKED_EXTERNAL", "TASK_COMPLETE"])
  test(`${classification} selects its scope before any candidate content scan`, async t => {
    const scratch = fileURLToPath(new URL("../.runtime-correction/candidate-order-tests/", import.meta.url));
    await fs.mkdir(scratch, { recursive: true });
    const root = await fs.mkdtemp(path.join(scratch, "run-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const task = await ensureTask({ projectRoot: root, sessionId: "host" });
    await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [{ operation: "ADD", category: "requirements",
      text: "Deliver the requested draft.", authority: "USER_EXPLICIT", severity: "HARD", verificationTarget: "ARTIFACT", source: { ref: "user" } }] } });
    const candidate = path.join(root, "delivery.txt"), transcript = path.join(root, "transcript.jsonl");
    await fs.writeFile(candidate, "Current candidate body.\n");
    await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "u", message: { content: "Deliver a draft." } }) + "\n");
    let classified = false, reads = 0;
    const originalRead = fs.readFile;
    fs.readFile = async (file, ...args) => {
      if (file === candidate) { assert.equal(classified, true); reads++; }
      return originalRead(file, ...args);
    };
    t.after(() => { fs.readFile = originalRead; });
    const factory = async params => {
      if (params.request.reviewScope?.kind === "classification") {
        assert.equal(reads, 0); classified = true;
        return { result: { summary: "Scope only.", stopClassification: classification, stage: null, findings: [], metricObjectJudgements: [] }, close() {} };
      }
      return { result: { summary: "No decisive proof in this controlled fixture.", stopClassification: classification, stage: null, findings: [],
        metricObjectJudgements: ["TASK_COMPLETE"].includes(classification) ? Object.values(params.request.population.metrics).flat().map(row => ({
          objectId: row.objectId, judgement: "UNVERIFIED", reason: "The fixture deliberately leaves this obligation unverified.", evidence: [],
        })) : [] }, close() {} };
    };
    factory.supportsReviewCollection = true;
    const plan = { configuredArtifacts: [{ nodeId: "delivery", patterns: ["delivery.txt"], metrics: ["M01"] }],
      runtimeV2: compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
        implementationCorrection: { enabled: false }, stopCorrection: { enabled: true, metrics: { M01: true } } }, { policyRoot: path.join(root, ".runtime-corrector") }) };
    await handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory: factory, input: { cwd: root, session_id: "host", transcript_path: transcript,
      hook_event_name: "Stop", hook_event_id: "order", last_assistant_message: "Task complete." } });
    assert.equal(classified, true);
    if (classification === "TASK_COMPLETE") assert.ok(reads > 0);
    else assert.equal(reads, 0);
  });
