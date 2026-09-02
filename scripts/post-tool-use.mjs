#!/usr/bin/env node

import path from "node:path";

import {
  decodeHookInput,
  encodeHookOutput,
} from "../lib/protocol/claude-core-hooks.mjs";
import { resolvePluginRoot } from "../lib/plugin-root.mjs";
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


function writeHookOutput(input, feedback) {
  const output = encodeHookOutput(input.hook_event_name, input, { feedback });
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}


function hookFailureMessage(error) {
  return [
    "[runtime-corrector] 纠偏诊断未能完成。",
    `原因：${error.message}`,
    "原文件未被 runtime-corrector 修改。请检查插件配置或纠偏知识。",
  ].join("\n");
}


let input = null;
// Mode knowledge for the fail-open catch: an observe-only run (or one whose
// mode could not be determined) must never receive fail-open text — silence
// is the only safe output.
let armShadowKnown = false;
let armShadowMode = false;
try {
  const rawInput = await readStdin();
  input = decodeHookInput(rawInput);
  const runtimeProjectRoot = path.resolve(input.cwd ?? process.cwd());
  const internal = await inspectInternalRun(process.env);
  if (internal.internal) process.exit(0);
  const { root: pluginRoot } = await resolvePluginRoot({
    env: process.env,
    executingModuleUrl: import.meta.url,
  });
  let preparationError = null;
  let prepared = { matched: false, reason: "artifact-preparation-failed" };
  try {
    prepared = await handleHook(input, { deferPersistence: true, pluginRoot });
  } catch (error) {
    preparationError = error;
  }
  const plan = await loadConfig({
    cwd: runtimeProjectRoot,
    pluginRoot,
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
      projectRoot: runtimeProjectRoot,
      pluginRoot,
      plan,
      artifact: prepared.matched ? prepared.reviewContext.artifact : null,
    });
  } catch (error) {
    const warning = await recordFailOpenWarning({
      projectRoot: runtimeProjectRoot,
      category: prepared.matched ? "ARTIFACT_V2_FAILED" : "POST_TOOL_RUNTIME_V2_FAILED",
      message: error.message,
    });
    runtimeV2.feedback = warning.shouldNotify
      ? `[runtime-corrector] v2 ${prepared.matched ? "artifact" : "post-tool"} features failed open: ${error.message}`
      : null;
    if (prepared.matched) {
      prepared.reviewContext.enabled = prepared.reviewContext.nodeReviewEnabled
        || (prepared.reviewContext.workflow?.incomingEdges?.length ?? 0) > 0;
    }
  }
  if (preparationError) {
    const warning = await recordFailOpenWarning({
      projectRoot: runtimeProjectRoot,
      category: "POST_TOOL_USE_FAILED",
      message: preparationError.message,
    });
    const feedback = armShadowMode
      ? ""
      : [runtimeV2.feedback, warning.shouldNotify ? hookFailureMessage(preparationError) : null]
        .filter(Boolean)
        .join("\n\n");
    if (feedback) writeHookOutput(input, feedback);
    process.exit(0);
  }
  if (!prepared.matched) {
    if (!armShadowMode && runtimeV2.feedback) {
      writeHookOutput(input, runtimeV2.feedback);
    }
    process.exit(0);
  }
  prepared.reviewContext.enabled = prepared.reviewContext.nodeReviewEnabled
    || (prepared.reviewContext.workflow?.incomingEdges?.length ?? 0) > 0
    || Boolean(runtimeV2.artifactReviewContext);
  prepared.reviewContext.runtimeV2 = runtimeV2.artifactReviewContext ?? null;
  const review = prepared.reviewContext.enabled
    ? await runSemanticReview({
        input,
        prepared,
        pluginRoot,
        runtimeV2Handle: runtimeV2.reviewerHandle ?? null,
        runtimeV2Context: runtimeV2.artifactReviewContext ?? null,
      })
    : null;
  const outcome = await finalizeArtifactCheck(prepared, review);
  const shadowMode = plan?.runtimeV2?.shadowMode === true;
  const metricOutcome = runtimeV2.artifactReviewContext
    ? await finalizeArtifactRuntimeV2({
        runtimeV2: plan?.runtimeV2 ?? null,
        projectRoot: runtimeProjectRoot,
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
  writeHookOutput(input, feedback);
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
  const message = hookFailureMessage(error);
  writeHookOutput(input, message);
}
