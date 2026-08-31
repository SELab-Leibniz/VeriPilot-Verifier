import { sha256 } from "./utils.mjs";


export function eventId(input) {
  return (input.hook_event_name === "PreToolUse" || input.hook_event_name === "PostToolUse"
    ? input.tool_use_id
    : null)
    ?? input.hook_event_id
    ?? `${input.hook_event_name}-${sha256({
      session: input.session_id,
      tool: input.tool_name,
      prompt: input.prompt,
      input: input.tool_input,
      transcript: input.transcript_path,
    }).slice(0, 20)}`;
}
