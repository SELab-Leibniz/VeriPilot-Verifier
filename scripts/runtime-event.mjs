#!/usr/bin/env node

import path from "node:path";

import { loadConfig } from "../lib/runtime-corrector.mjs";
import { inspectInternalRun } from "../lib/runtime-v2/internal-run.mjs";
import {
  clearOuterStopFailures,
  countOuterStopFailure,
  MAX_OUTER_STOP_FAILURES,
  recordFailOpenWarning,
} from "../lib/runtime-v2/fail-open.mjs";
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
  // A Stop released because verification never ran: additionalContext is not
  // part of the Stop output contract, so the disclosure goes out as a
  // systemMessage the user actually sees.
  if (input.hook_event_name === "Stop" && outcome.verificationUnavailable) {
    return { continue: true, systemMessage: outcome.feedback };
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
// Loaded OUTSIDE the main try: the failure-policy catch below must know the mode.
// An observe-only run must stay silent even when the corrector itself
// crashes, while an active Stop must fail closed.
let shadowKnown = false;
let shadowMode = false;
// The Stop gate may only fail closed when it is actually armed: a project that
// disabled stopCorrection must not be blocked by a crash in a gate it turned
// off (that is the documented escape hatch, so it has to work).
let stopGateArmed = false;
try {
  input = await readStdin();
  const internal = await inspectInternalRun(process.env);
  if (internal.internal) process.exit(0);
  const projectRoot = path.resolve(input.cwd ?? process.cwd());
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const plan = await loadConfig({ cwd: projectRoot, pluginRoot });
  shadowMode = plan?.runtimeV2?.shadowMode === true;
  shadowKnown = true;
  stopGateArmed = plan?.runtimeV2?.stopCorrection?.enabled === true;
  const outcome = await handleRuntimeV2Event({
    input,
    projectRoot,
    pluginRoot,
    plan,
  });
  const output = eventOutput(input, outcome);
  // A Stop that reached a real decision clears the outer-crash ceiling: the
  // ceiling counts CONSECUTIVE failures, not failures ever seen.
  if (input.hook_event_name === "Stop") {
    await clearOuterStopFailures(path.resolve(input.cwd ?? process.cwd()));
  }
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const inputEvent = input?.hook_event_name ?? "SessionStart";
  let warning = { shouldNotify: true };
  try {
    warning = await recordFailOpenWarning({
      projectRoot: path.resolve(input?.cwd ?? process.cwd()),
      category: "LIFECYCLE_HOOK_FAILED",
      message: error.message,
    });
  } catch {
    // Recording a warning is best-effort. In particular, an active Stop must
    // still emit its fail-closed decision when local persistence is broken.
  }
  // Observe-only runs emit nothing. When config load fails the arm is unknown,
  // so silence is the only output that cannot contaminate a shadow run.
  if (shadowMode || !shadowKnown) process.exit(0);
  if (inputEvent === "Stop" && stopGateArmed) {
    const { consecutiveFailures, released } = await countOuterStopFailure(
      path.resolve(input?.cwd ?? process.cwd()),
    );
    if (released) {
      // The plugin's own fault must never trap a session. Release, but say so
      // on a channel the Stop hook actually consumes (additionalContext is not
      // part of the Stop output contract).
      process.stdout.write(`${JSON.stringify({
        continue: true,
        systemMessage: [
          "[runtime-corrector] STOP_VERIFICATION_UNAVAILABLE: the final review could not run"
            + `${consecutiveFailures === null ? " and local state is unwritable" : ` after ${MAX_OUTER_STOP_FAILURES} attempts`}.`,
          `Last error: ${error.message}`,
          "This completion is ALLOWED but was never verified — report it as completed but unverified.",
          "To stop the gate from blocking at all, set stopCorrection.enabled: false (or shadowMode: true) in .runtime-corrector/config.yaml.",
        ].join("\n"),
      })}\n`);
    } else {
      const reason = [
        `[runtime-corrector] Final Stop review is UNVERIFIED (runtime attempt ${consecutiveFailures}/${MAX_OUTER_STOP_FAILURES}); this completion is blocked.`,
        `Runtime Corrector failed before it could produce a terminal decision: ${error.message}`,
        "Retry after the runtime recovers. Do not report the task as fully verified or fully complete.",
        "If this keeps failing, set stopCorrection.enabled: false (or shadowMode: true) in .runtime-corrector/config.yaml to disarm the gate.",
      ].join("\n");
      process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    }
  } else {
    if (!warning.shouldNotify) process.exit(0);
    const output = contextOutput(
      inputEvent,
      `[runtime-corrector] v2 features failed open. Configuration or runtime error: ${error.message}`,
    );
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}
