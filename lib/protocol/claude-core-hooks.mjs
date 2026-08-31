const STRING = (value) => typeof value === "string";
const BOOLEAN = (value) => typeof value === "boolean";
const OBJECT = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const PRESENT = () => true;
const STRING_OR_NULL = (value) => value === null || typeof value === "string";

const COMMON_REQUIRED_FIELDS = Object.freeze({
  session_id: STRING,
  transcript_path: STRING,
  cwd: STRING,
  hook_event_name: STRING,
});

const EVENT_REQUIRED_FIELDS = Object.freeze({
  SessionStart: { source: STRING },
  UserPromptSubmit: { prompt: STRING },
  PreToolUse: {
    tool_name: STRING,
    tool_input: OBJECT,
    tool_use_id: STRING,
  },
  PostToolUse: {
    tool_name: STRING,
    tool_input: OBJECT,
    tool_response: PRESENT,
    tool_use_id: STRING,
  },
  Stop: { stop_hook_active: BOOLEAN },
  PreCompact: {
    trigger: STRING,
    custom_instructions: STRING_OR_NULL,
  },
  SessionEnd: { reason: STRING },
});


function assertRequiredFields(input, requiredFields, label) {
  for (const [field, accepts] of Object.entries(requiredFields)) {
    if (!Object.hasOwn(input, field) || !accepts(input[field])) {
      throw new TypeError(`Invalid ${label} field: ${field}`);
    }
  }
}


export function decodeHookInput(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new TypeError("Hook input must be one non-blank JSON object");
  }

  let input;
  try {
    input = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new SyntaxError(`Invalid hook JSON: ${error.message}`);
  }

  if (!OBJECT(input)) {
    throw new TypeError("Hook input must be a JSON object");
  }

  assertRequiredFields(input, COMMON_REQUIRED_FIELDS, "common");
  if (!Object.hasOwn(EVENT_REQUIRED_FIELDS, input.hook_event_name)) {
    throw new RangeError(`Unsupported hook event: ${input.hook_event_name}`);
  }
  const eventFields = EVENT_REQUIRED_FIELDS[input.hook_event_name];
  assertRequiredFields(input, eventFields, input.hook_event_name);

  return { ...input };
}


function contextOutput(eventName, feedback) {
  if (!STRING(feedback) || feedback.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: feedback,
    },
  };
}


export function encodeHookOutput(eventName, input, outcome) {
  if (eventName === "Stop") {
    if (outcome?.decision === "block") {
      return STRING(outcome.feedback)
        ? { decision: "block", reason: outcome.feedback }
        : null;
    }
    if (outcome?.verificationUnavailable || outcome?.stop?.verificationUnavailable) {
      return STRING(outcome.feedback)
        ? { continue: true, systemMessage: outcome.feedback }
        : null;
    }
    return null;
  }

  if (eventName === "PreToolUse") {
    if (input?.tool_name !== "Skill") return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...(STRING(outcome?.feedback) ? { additionalContext: outcome.feedback } : {}),
      },
    };
  }

  if (eventName === "UserPromptSubmit" || eventName === "PostToolUse") {
    return contextOutput(eventName, outcome?.feedback);
  }

  return null;
}
