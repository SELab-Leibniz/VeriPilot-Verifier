import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeHookInput,
  encodeHookOutput,
} from "../lib/protocol/claude-core-hooks.mjs";


const BASELINE_INPUTS = Object.freeze({
  SessionStart: {
    session_id: "session-1",
    transcript_path: "/tmp/session-1.jsonl",
    cwd: "/workspace",
    hook_event_name: "SessionStart",
    source: "startup",
  },
  UserPromptSubmit: {
    session_id: "session-1",
    transcript_path: "/tmp/session-1.jsonl",
    cwd: "/workspace",
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the adapter.",
  },
  PreToolUse: {
    session_id: "session-1",
    transcript_path: "/tmp/session-1.jsonl",
    cwd: "/workspace",
    hook_event_name: "PreToolUse",
    tool_name: "Skill",
    tool_input: { skill: "runtime-corrector-workflow" },
    tool_use_id: "toolu-pre-1",
  },
  PostToolUse: {
    session_id: "session-1",
    transcript_path: "/tmp/session-1.jsonl",
    cwd: "/workspace",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/workspace/notes.md", content: "notes" },
    tool_response: { filePath: "/workspace/notes.md", success: true },
    tool_use_id: "toolu-post-1",
  },
  Stop: {
    session_id: "session-1",
    transcript_path: "/tmp/session-1.jsonl",
    cwd: "/workspace",
    hook_event_name: "Stop",
    stop_hook_active: false,
  },
  PreCompact: {
    session_id: "session-1",
    transcript_path: "/tmp/session-1.jsonl",
    cwd: "/workspace",
    hook_event_name: "PreCompact",
    trigger: "manual",
    custom_instructions: null,
  },
  SessionEnd: {
    session_id: "session-1",
    transcript_path: "/tmp/session-1.jsonl",
    cwd: "/workspace",
    hook_event_name: "SessionEnd",
    reason: "other",
  },
});


test("decodeHookInput accepts every literal baseline event without hook_event_id", () => {
  for (const [eventName, input] of Object.entries(BASELINE_INPUTS)) {
    const decoded = decodeHookInput(JSON.stringify(input));

    assert.deepEqual(decoded, input, eventName);
    assert.equal(
      Object.hasOwn(decoded, "hook_event_id"),
      false,
      `${eventName} must not gain hook_event_id`,
    );
  }
});


test("decodeHookInput removes one leading BOM and preserves unknown input fields", () => {
  const raw = "\uFEFF" + JSON.stringify({
    ...BASELINE_INPUTS.UserPromptSubmit,
    future_host_field: { enabled: true },
  });

  assert.deepEqual(decodeHookInput(raw), {
    ...BASELINE_INPUTS.UserPromptSubmit,
    future_host_field: { enabled: true },
  });
});


test("decodeHookInput rejects malformed payloads and missing common fields", () => {
  for (const raw of ["", "   ", "null", "[]", "{} {}", "not json"]) {
    assert.throws(() => decodeHookInput(raw), Error, raw || "empty input");
  }

  for (const field of ["session_id", "transcript_path", "cwd", "hook_event_name"]) {
    const input = { ...BASELINE_INPUTS.UserPromptSubmit };
    delete input[field];
    assert.throws(() => decodeHookInput(JSON.stringify(input)), Error, field);
  }

  assert.throws(() => decodeHookInput(JSON.stringify({
    ...BASELINE_INPUTS.UserPromptSubmit,
    hook_event_name: "FutureEvent",
  })), Error);
});


test("decodeHookInput rejects wrong event-required field types", () => {
  const invalidInputs = [
    { ...BASELINE_INPUTS.SessionStart, source: false },
    { ...BASELINE_INPUTS.UserPromptSubmit, prompt: 1 },
    { ...BASELINE_INPUTS.PreToolUse, tool_name: false },
    { ...BASELINE_INPUTS.PreToolUse, tool_input: [] },
    { ...BASELINE_INPUTS.PreToolUse, tool_use_id: 1 },
    { ...BASELINE_INPUTS.PostToolUse, tool_response: null },
    { ...BASELINE_INPUTS.Stop, stop_hook_active: "false" },
    { ...BASELINE_INPUTS.PreCompact, trigger: false },
    { ...BASELINE_INPUTS.PreCompact, custom_instructions: false },
    { ...BASELINE_INPUTS.SessionEnd, reason: false },
  ];

  for (const input of invalidInputs) {
    assert.throws(() => decodeHookInput(JSON.stringify(input)), Error);
  }
});


test("decodeHookInput rejects missing event-required fields", () => {
  const invalidInputs = [
    ["SessionStart", "source"],
    ["UserPromptSubmit", "prompt"],
    ["PreToolUse", "tool_name"],
    ["PostToolUse", "tool_response"],
    ["Stop", "stop_hook_active"],
    ["PreCompact", "custom_instructions"],
    ["SessionEnd", "reason"],
  ];

  for (const [eventName, field] of invalidInputs) {
    const input = { ...BASELINE_INPUTS[eventName] };
    delete input[field];
    assert.throws(() => decodeHookInput(JSON.stringify(input)), Error, `${eventName}.${field}`);
  }
});


test("encodeHookOutput emits feedback for UserPromptSubmit and PostToolUse", () => {
  assert.deepEqual(
    encodeHookOutput("UserPromptSubmit", BASELINE_INPUTS.UserPromptSubmit, {
      feedback: "User feedback",
    }),
    {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "User feedback",
      },
    },
  );

  assert.deepEqual(
    encodeHookOutput("PostToolUse", BASELINE_INPUTS.PostToolUse, {
      feedback: "Tool feedback",
    }),
    {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Tool feedback",
      },
    },
  );
});


test("encodeHookOutput permits Skill PreToolUse with optional feedback", () => {
  assert.deepEqual(
    encodeHookOutput("PreToolUse", BASELINE_INPUTS.PreToolUse, {
      feedback: "Skill feedback",
    }),
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: "Skill feedback",
      },
    },
  );

  assert.deepEqual(
    encodeHookOutput("PreToolUse", BASELINE_INPUTS.PreToolUse, {}),
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    },
  );
});


test("encodeHookOutput emits the Stop block and verification-unavailable release unions", () => {
  assert.deepEqual(
    encodeHookOutput("Stop", BASELINE_INPUTS.Stop, {
      decision: "block",
      feedback: "Verification must finish.",
    }),
    { decision: "block", reason: "Verification must finish." },
  );

  assert.deepEqual(
    encodeHookOutput("Stop", BASELINE_INPUTS.Stop, {
      stop: { verificationUnavailable: true },
      feedback: "Verification infrastructure is unavailable.",
    }),
    {
      continue: true,
      systemMessage: "Verification infrastructure is unavailable.",
    },
  );
});


test("encodeHookOutput is silent for non-emitting outcomes and lifecycle events", () => {
  assert.equal(encodeHookOutput("Stop", BASELINE_INPUTS.Stop, { decision: "allow" }), null);
  assert.equal(
    encodeHookOutput("PreToolUse", { ...BASELINE_INPUTS.PreToolUse, tool_name: "Write" }, {
      feedback: "not emitted",
    }),
    null,
  );

  for (const eventName of ["SessionStart", "PreCompact", "SessionEnd"]) {
    assert.equal(
      encodeHookOutput(eventName, BASELINE_INPUTS[eventName], { feedback: "ignored" }),
      null,
      eventName,
    );
  }
});
