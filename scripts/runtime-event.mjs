#!/usr/bin/env node

import path from "node:path";

import { loadConfig } from "../lib/runtime-corrector.mjs";
import { DEFAULT_LOCALE, formatMessage } from "../lib/messages.mjs";
import { inspectInternalRun } from "../lib/runtime-v2/internal-run.mjs";
import {
  clearOuterStopFailures,
  countOuterStopFailure,
  MAX_OUTER_STOP_FAILURES,
  recordFailOpenWarning,
} from "../lib/runtime-v2/fail-open.mjs";
import {
  handleRuntimeV2Event,
  handleRuntimeV2SessionEnd,
} from "../lib/runtime-v2/orchestrator.mjs";


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
// Locale for the fail-closed Stop texts below: they are the highest-visibility
// messages the plugin emits, so they must not fall back to English once the
// project locale is known.
let locale = DEFAULT_LOCALE;
try {
  input = await readStdin();
  const projectRoot = path.resolve(input.cwd ?? process.cwd());
  if (input.hook_event_name === "SessionEnd") {
    await handleRuntimeV2SessionEnd({ input, projectRoot });
    process.exit(0);
  }
  const internal = await inspectInternalRun(process.env);
  if (internal.internal) process.exit(0);
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const plan = await loadConfig({ cwd: projectRoot, pluginRoot });
  shadowMode = plan?.runtimeV2?.shadowMode === true;
  shadowKnown = true;
  stopGateArmed = plan?.runtimeV2?.stopCorrection?.enabled === true;
  locale = plan?.runtimeV2?.locale ?? DEFAULT_LOCALE;
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
          consecutiveFailures === null
            ? formatMessage(locale, "stop.outerReleasedUnwritable")
            : formatMessage(locale, "stop.outerReleasedAttempts", { maximum: MAX_OUTER_STOP_FAILURES }),
          formatMessage(locale, "stop.outerLastError", { error: error.message }),
          formatMessage(locale, "stop.outerReleasedNote"),
          formatMessage(locale, "stop.disarmHint"),
        ].join("\n"),
      })}\n`);
    } else {
      const reason = [
        formatMessage(locale, "stop.outerBlocked", { attempt: consecutiveFailures, maximum: MAX_OUTER_STOP_FAILURES }),
        formatMessage(locale, "stop.outerError", { error: error.message }),
        formatMessage(locale, "stop.unverifiedRetry"),
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
