#!/usr/bin/env node

import path from "node:path";

import {
  finalizeArtifactCheck,
  handleHook,
  loadConfig,
} from "../lib/runtime-corrector.mjs";
import { runSemanticReview } from "../lib/semantic-review.mjs";
import { inspectInternalRun } from "../lib/runtime-v2/internal-run.mjs";
import { recordFailOpenWarning } from "../lib/runtime-v2/fail-open.mjs";
import {
  finalizeArtifactRuntimeV2,
  handleRuntimeV2Event,
} from "../lib/runtime-v2/orchestrator.mjs";


async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}


function hookOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  };
}


let input = null;
// Mode knowledge for the fail-open catch: an observe-only run (or one whose
// mode could not be determined) must never receive fail-open text — silence
// is the only safe output.
let armShadowKnown = false;
let armShadowMode = false;
try {
  const rawInput = await readStdin();
  input = JSON.parse(rawInput.replace(/^\uFEFF/, ""));
  const internal = await inspectInternalRun(process.env);
  if (internal.internal) process.exit(0);
  const prepared = await handleHook(input, { deferPersistence: true });
  if (prepared.matched) {
    const plan = await loadConfig({
      cwd: prepared.projectRoot,
      pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
    });
    armShadowMode = plan?.runtimeV2?.shadowMode === true;
    armShadowKnown = true;
    let runtimeV2 = {
      handled: false,
      taskId: null,
      feedback: null,
      artifactReviewContext: null,
      reviewerHandle: null,
    };
    try {
      runtimeV2 = await handleRuntimeV2Event({
        input,
        projectRoot: prepared.projectRoot,
        pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
        plan,
        artifact: prepared.reviewContext.artifact,
      });
    } catch (error) {
      const warning = await recordFailOpenWarning({
        projectRoot: prepared.projectRoot,
        category: "ARTIFACT_V2_FAILED",
        message: error.message,
      });
      runtimeV2.feedback = warning.shouldNotify
        ? `[runtime-corrector] v2 artifact features failed open: ${error.message}`
        : null;
      prepared.reviewContext.enabled = prepared.reviewContext.nodeReviewEnabled
        || (prepared.reviewContext.workflow?.incomingEdges?.length ?? 0) > 0;
    }
    prepared.reviewContext.runtimeV2 = runtimeV2.artifactReviewContext ?? null;
    const review = prepared.reviewContext.enabled
      ? await runSemanticReview({
          input,
          prepared,
          pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
          runtimeV2Handle: runtimeV2.reviewerHandle ?? null,
          runtimeV2Context: runtimeV2.artifactReviewContext ?? null,
        })
      : null;
    const outcome = await finalizeArtifactCheck(prepared, review);
    const shadowMode = plan?.runtimeV2?.shadowMode === true;
    const metricOutcome = runtimeV2.artifactReviewContext
      ? await finalizeArtifactRuntimeV2({
          runtimeV2: plan?.runtimeV2 ?? null,
          projectRoot: prepared.projectRoot,
          taskId: runtimeV2.taskId,
          artifactReviewContext: runtimeV2.artifactReviewContext,
          semanticReview: review,
          // ACTUAL emission, not mode: the artifact findings reach the
          // developer via the v1 diagnostics feedback (outcome.feedback). If
          // that channel is empty this round, nothing was spoken even outside
          // observe-only mode, and closure attribution must not credit the
          // corrector.
          delivered: !shadowMode && Boolean(outcome.feedback),
        })
      : { feedback: null };
    if (runtimeV2.reviewerHandle && !prepared.reviewContext.enabled) {
      await runtimeV2.reviewerHandle.close();
    }
    // Observe-only mode: every subsystem above still records (families,
    // evaluations, metric reports), but nothing may reach the developer. This
    // covers the v1 artifact feedback (outcome.feedback) and the metric
    // finalize feedback, which run OUTSIDE the handleRuntimeV2Event
    // observe-only wrapper — the leak that once let an observe-only run
    // receive live corrections.
    const feedback = shadowMode
      ? ""
      : [outcome.feedback, runtimeV2.feedback, metricOutcome.feedback]
        .filter(Boolean)
        .join("\n\n");
    process.stdout.write(`${JSON.stringify(hookOutput(feedback))}\n`);
  }
} catch (error) {
  const warning = await recordFailOpenWarning({
    projectRoot: path.resolve(input?.cwd ?? process.cwd()),
    category: "POST_TOOL_USE_FAILED",
    message: error.message,
  });
  // Observe-only (or mode-unknown) fail-open stays SILENT: the warning text
  // is model-visible and would break the mode's no-feedback guarantee.
  if (armShadowMode || !armShadowKnown) process.exit(0);
  if (!warning.shouldNotify) process.exit(0);
  const message = [
    "[runtime-corrector] 纠偏诊断未能完成。",
    `原因：${error.message}`,
    "原文件未被 runtime-corrector 修改。请检查插件配置或纠偏知识。",
  ].join("\n");
  process.stdout.write(`${JSON.stringify(hookOutput(message))}\n`);
}
