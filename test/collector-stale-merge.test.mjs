import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { withTestReviewProof } from "./helpers/review-proof.mjs";

test("a Stop source changed during implementation review cannot publish the earlier PASS", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-collector-stale-merge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "collector-stale-host" });
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [{
    operation: "ADD", category: "requirements", text: "The application renders the required output.",
    authority: "USER_EXPLICIT", severity: "HARD", verificationTarget: "IMPLEMENTATION",
    source: { ref: "user" },
  }] } });
  const source = path.join(root, "output.txt");
  await fs.writeFile(source, "The original output is complete.\n");
  const implementationSource = path.join(root, "src", "app.mjs");
  await fs.mkdir(path.dirname(implementationSource), { recursive: true });
  await fs.writeFile(implementationSource, "export const renderedOutput = 'complete';\n");
  const transcript = path.join(root, "transcript.jsonl");
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "u1",
    message: { content: "Implement the required output." } }));
  let stopItems = 0;
  let implementationItems = 0;
  const factory = async options => {
    if (options.request.reviewScope?.kind === "classification") return {
      result: { summary: "Classified completion.", stopClassification: "TASK_COMPLETE", stage: null,
        findings: [], metricObjectJudgements: [] }, close: async () => {},
    };
    const implementation = options.role === "implementation-reviewer";
    if (implementation) {
      implementationItems += 1;
      assert.ok(stopItems > 0, "the Stop item must finish before the implementation phase begins");
      await fs.writeFile(source, "The output was replaced during the implementation phase.\n");
    } else stopItems += 1;
    const objects = Object.values(options.request.population.metrics).flat();
    const result = { summary: "Compared current original source.", findings: [],
      ...(!implementation ? { stopClassification: "TASK_COMPLETE", stage: null } : {}),
      metricObjectJudgements: objects.map(object => ({ objectId: object.objectId, judgement: "PASS",
        reason: "The original source matches this obligation.",
        evidence: [`${implementation ? implementationSource : source}#L1-L1`] })),
    };
    return { result, getSourceCitations: async () => {
      // One file is deliberately shared by different proof owners in this
      // mechanism fixture. Preserve each row's own provenance instead of
      // overwriting one citation's owner with the last grouped metric.
      const citations = [];
      for (const row of result.metricObjectJudgements) {
        const checked = await withTestReviewProof(options, { result: { metricObjectJudgements: [row] } });
        citations.push(...await checked.getSourceCitations());
      }
      return citations;
    }, close: async () => {} };
  };
  factory.supportsReviewCollection = true;
  const plan = { runtimeV2: compileRuntimeV2Config({ version: 2, locale: "en",
    dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
    implementationCorrection: { enabled: true, platform: null },
    reviewers: { stopReviewer: { timeoutMs: 15000 }, implementationReviewer: { timeoutMs: 15000 } },
  }, { policyRoot: path.join(root, ".runtime-corrector") }) };
  const result = await handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory: factory,
    deviceVerifier: async () => ({ assurance: { level: "static", reason: "TEST_STUB" },
      build: { status: "skipped" }, smoke: { status: "skipped" }, findings: [] }),
    input: { cwd: root, session_id: "collector-stale-host", transcript_path: transcript,
      hook_event_name: "Stop", hook_event_id: "stale-merge-stop", last_assistant_message: "Task complete." },
  });
  assert.ok(stopItems > 0);
  assert.ok(implementationItems > 0, "the regression must reach implementation review");
  assert.equal(result.decision, "block");
  assert.equal(result.stop.status, "UNVERIFIED");
  assert.notEqual(result.stop.report?.status, "PASS");
  assert.match(result.stop.error?.message ?? "", /source changed/iu);
  const directory = taskDirectory(root, task.taskId);
  const state = JSON.parse(await fs.readFile(path.join(directory, "task.json"), "utf8"));
  assert.equal(state.stop.correctionAttempts, 0, "a changed verification basis must not consume business correction budget");
  assert.equal(state.verification.status, "UNVERIFIED");
  const collectionRoot = path.join(directory, "review-collections");
  const collections = await Promise.all((await fs.readdir(collectionRoot)).map(async name => {
    const collectionPath = path.join(collectionRoot, name);
    const progress = JSON.parse(await fs.readFile(path.join(collectionPath, "progress.json"), "utf8"));
    return { collectionPath, progress };
  }));
  const stopCollection = collections.find(({ progress }) => progress.role === "stop-reviewer");
  assert.ok(stopCollection, "the independently committed Stop collection remains available for audit");
  assert.equal(stopCollection.progress.complete, true);
  const savedItems = await Promise.all(stopCollection.progress.items.map(item => fs.readFile(item.path, "utf8")));
  assert.ok(savedItems.some(item => JSON.parse(item).result.metricObjectJudgements.some(row => row.judgement === "PASS")),
    "the already completed item stays on disk even though its PASS cannot be published after the basis changes");
});
