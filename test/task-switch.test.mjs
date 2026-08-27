import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import {
  GROUND_TRUTH_REVIEW_SCHEMA,
  STOP_REVIEW_SCHEMA,
} from "../lib/runtime-v2/reviewer.mjs";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-switch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, contents) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

function transcript(turns) {
  const entries = [];
  for (let index = 1; index <= turns; index += 1) {
    entries.push({ type: "user", uuid: `user-${index}`, message: { id: `um-${index}`, content: `request ${index}` } });
    entries.push({ type: "assistant", uuid: `assistant-${index}`, message: { id: `am-${index}`, content: `work ${index}` } });
  }
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

test("a mid-turn NEW_TASK reclassification is suppressed instead of aborting the active task", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcript(1));
  const plan = {
    runtimeV2: compileRuntimeV2Config({
      version: 2,
      dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
      skillCorrection: { enabled: false, selection: { mode: "include", include: [] } },
      artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
      stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
    }, { policyRoot: path.join(root, ".runtime-corrector") }),
  };
  let classification = "CONTINUATION";
  const factory = async ({ projectRoot, request, schema }) => {
    const requestDirectory = path.join(projectRoot, ".runtime-correction", "fake-review", String(Math.random()).slice(2));
    await fs.mkdir(requestDirectory, { recursive: true });
    let result;
    if (schema === GROUND_TRUTH_REVIEW_SCHEMA) {
      result = {
        summary: "gt",
        taskClassification: classification,
        operations: request.currentGroundTruth.version === 0 ? [{
          operation: "ADD",
          category: "requirements",
          text: "Build the confirmed feature.",
          authority: "USER_EXPLICIT",
          severity: "HARD",
          source: { ref: "transcript:user-1" },
        }] : [],
        skillGroundTruth: null,
      };
    } else {
      throw new Error(`unexpected schema in this test: ${JSON.stringify(schema.required)}`);
    }
    return {
      result,
      requestDirectory,
      async followUp({ nextSchema }) {
        if (nextSchema === STOP_REVIEW_SCHEMA) {
          const assessment = JSON.parse(await fs.readFile(path.join(requestDirectory, "assessment-request.json"), "utf8"));
          const objects = Object.values(assessment.population.metrics).flat();
          return {
            summary: "ok",
            stopClassification: "INTERMEDIATE",
            stage: "implementation",
            findings: [],
            metricObjectJudgements: objects.map((object) => ({ objectId: object.objectId, judgement: "PASS", reason: "ok", evidence: ["e"] })),
          };
        }
        throw new Error("unexpected followUp");
      },
      async close() {},
    };
  };
  const stopInput = (id) => ({
    cwd: root,
    session_id: "session-switch",
    transcript_path: path.join(root, "transcript.jsonl"),
    hook_event_name: "Stop",
    hook_event_id: id,
    last_assistant_message: "progress",
  });

  // The lazy barrier creates the original task before the first project-
  // changing action. Stop 1 then extracts version 1 for that task.
  await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-switch",
      transcript_path: path.join(root, "transcript.jsonl"),
      hook_event_name: "PreToolUse",
      hook_event_id: "pre-write",
      tool_name: "Write",
    },
    projectRoot: root,
    plan,
    reviewerFactory: factory,
  });
  await handleRuntimeV2Event({ input: stopInput("stop-1"), projectRoot: root, plan, reviewerFactory: factory });
  const tasksRoot = path.join(root, ".runtime-correction", "tasks");
  const tasksBefore = await fs.readdir(tasksRoot);
  assert.equal(tasksBefore.length, 1, "one task exists after the first stop");
  const taskId = tasksBefore[0];

  // Stop 2: the extractor drifts to NEW_TASK mid-run. The switch must be
  // suppressed — the task keeps its state instead of ABORTED_TASK_SWITCH.
  // Advance the transcript so the refresh does not short-circuit on an
  // unchanged cursor.
  await write(root, "transcript.jsonl", transcript(2));
  classification = "NEW_TASK";
  await handleRuntimeV2Event({ input: stopInput("stop-2"), projectRoot: root, plan, reviewerFactory: factory });
  const tasksAfter = await fs.readdir(tasksRoot);
  assert.deepEqual(tasksAfter, [taskId], "no new task was minted mid-run");
  const state = JSON.parse(await fs.readFile(path.join(tasksRoot, taskId, "task.json"), "utf8"));
  assert.notEqual(state.status, "ABORTED_TASK_SWITCH", "the active task survives classification drift");
  const journal = await fs.readFile(path.join(tasksRoot, taskId, "journal", "events.jsonl"), "utf8");
  assert.ok(journal.includes("TASK_SWITCH_SUPPRESSED"), "the suppression is journaled for audit");
});
