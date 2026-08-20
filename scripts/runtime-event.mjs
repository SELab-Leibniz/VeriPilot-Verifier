#!/usr/bin/env node

import path from "node:path";

import { loadConfig } from "../lib/runtime-corrector.mjs";
import { inspectInternalRun } from "../lib/runtime-v2/internal-run.mjs";
import { recordFailOpenWarning } from "../lib/runtime-v2/fail-open.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";


async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}


function contextOutput(eventName, feedback) {
  if (!feedback) return null;
  if (!new Set([
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolBatch",
    "Stop",
    "SubagentStop",
  ]).has(eventName)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: feedback,
    },
  };
}


function eventOutput(input, outcome) {
  if (input.hook_event_name === "Stop" && outcome.decision === "block") {
    return { decision: "block", reason: outcome.feedback };
  }
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "Skill") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...(outcome.feedback ? { additionalContext: outcome.feedback } : {}),
      },
    };
  }
  return contextOutput(input.hook_event_name, outcome.feedback);
}


let input = null;
// Loaded OUTSIDE the main try: the fail-open catch below must know the mode.
// An observe-only run must stay silent even when the corrector itself
// crashes — a fail-open warning is model-visible text like any other.
let shadowKnown = false;
let shadowMode = false;
try {
  input = await readStdin();
  const internal = await inspectInternalRun(process.env);
  if (internal.internal) process.exit(0);
  const projectRoot = path.resolve(input.cwd ?? process.cwd());
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const plan = await loadConfig({ cwd: projectRoot, pluginRoot });
  shadowMode = plan?.runtimeV2?.shadowMode === true;
  shadowKnown = true;
  const outcome = await handleRuntimeV2Event({
    input,
    projectRoot,
    pluginRoot,
    plan,
  });
  const output = eventOutput(input, outcome);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const inputEvent = input?.hook_event_name ?? "SessionStart";
  const warning = await recordFailOpenWarning({
    projectRoot: path.resolve(input?.cwd ?? process.cwd()),
    category: "LIFECYCLE_HOOK_FAILED",
    message: error.message,
  });
  // Fail SAFE: emit nothing in observe-only mode, and emit nothing when the
  // mode could not be determined (a config-load failure is exactly the case
  // where the mode is unknown — silence is the only output that cannot break
  // the no-feedback guarantee).
  if (shadowMode || !shadowKnown) process.exit(0);
  if (!warning.shouldNotify) process.exit(0);
  const output = contextOutput(
    inputEvent,
    `[runtime-corrector] v2 features failed open. Configuration or runtime error: ${error.message}`,
  );
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}
