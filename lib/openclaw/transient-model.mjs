import { promises as fs } from "node:fs";

export function transientModelFailureCode(error) {
  if (error?.name !== "FailoverError") return null;
  if (error.reason === "overloaded") return "MODEL_SERVICE_OVERLOADED";
  if (error.reason === "rate_limit") return "MODEL_RATE_LIMITED";
  return null;
}

// Resume only a settled, rejected model request. A timeout or an unpaired tool
// call could have side effects still in flight and must never be replayed.
export async function canResumeTransientModelFailure(error, sessionFile) {
  if (!transientModelFailureCode(error)) return false;
  let rows;
  try { rows = (await fs.readFile(sessionFile, "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
  catch { return false; }
  const messages = rows.filter(row => row.type === "message").map(row => row.message);
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "error") return false;
  const pending = new Set();
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (message.role === "assistant" && ["toolCall", "tool_use"].includes(block.type)) {
        if (!block.id) return false;
        pending.add(block.id);
      }
    }
    if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  return pending.size === 0;
}
