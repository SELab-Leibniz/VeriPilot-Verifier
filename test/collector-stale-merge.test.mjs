import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import {runStartedHostEvent as handleRuntimeV2Event} from "./helpers/started-host.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';

test("a source changed after the single workspace review cannot publish its earlier PASS", async t => {
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
  const factory = async options => {
    assert.equal(options.role, 'stop-reviewer'); assert.equal(options.request.reviewScope.kind, 'workspace-stop');
    stopItems++;
    const handle = await scriptedWorkspaceReview(options, { file: implementationSource });
    await fs.writeFile(implementationSource, "export const renderedOutput = 'changed after review';\n");
    return handle;
  };
  const plan = { runtimeV2: compileRuntimeV2Config({ version: 2, locale: "en",
    dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3,
      metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, '0')}`, i === 15])) },
    implementationCorrection: { enabled: true, platform: null },
    reviewers: { stopReviewer: { timeoutMs: 15000 }, implementationReviewer: { timeoutMs: 15000 } },
  }, { policyRoot: path.join(root, ".runtime-corrector") }) };
  const result = await handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory: factory,
    deviceVerifier: async () => ({ assurance: { level: "static", reason: "TEST_STUB" },
      build: { status: "skipped" }, smoke: { status: "skipped" }, findings: [] }),
    input: { cwd: root, session_id: "collector-stale-host", transcript_path: transcript,
      hook_event_name: "Stop", hook_event_id: "stale-merge-stop", last_assistant_message: "Task complete." },
  });
  assert.equal(stopItems, 1);
  assert.equal(result.decision, 'allow', 'stale proof cannot authorize a business repair');
  assert.equal(result.stop.status, 'UNVERIFIED');
  assert.equal(result.stop.reasonCode, 'REVIEW_COLLECTION_STALE');
  assert.notEqual(result.stop.report?.status, 'PASS');
  assert.equal(result.stop.admission, null);
  const directory = taskDirectory(root, task.taskId);
  const state = JSON.parse(await fs.readFile(path.join(directory, "task.json"), "utf8"));
  assert.equal(state.stop.correctionAttempts, 0, "a changed verification basis must not consume business correction budget");
  assert.equal(state.verification.status, "UNVERIFIED");
  const reviews = path.join(directory, 'workspace-reviews');
  const [id] = await fs.readdir(reviews);
  const historical = JSON.parse(await fs.readFile(path.join(reviews, id, 'result.json'), 'utf8'));
  assert.equal(historical.completed, true);
  assert(historical.result.metricObjectJudgements.some(row => row.judgement === 'PASS'), 'The valid earlier task receipts remain auditable without publishing a current PASS.');
  await assert.rejects(fs.access(path.join(reviews, id, 'input/project')), { code: 'ENOENT' });
});
