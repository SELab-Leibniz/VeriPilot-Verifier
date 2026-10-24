// Consume only host-authored Claude stream-json message frames. Assistant
// prose, tool inputs alone and unmatched/duplicate results never prove reads.
export async function replayReviewReadEvents(proof, frames, sessionId) {
  if (!proof || !Array.isArray(frames) || typeof sessionId !== "string" || !sessionId.trim()) return;
  const calls = new Map(), results = new Map();
  let ordinal = 0;
  for (const frame of frames) {
    if (frame.parent_tool_use_id || frame.session_id !== sessionId) continue;
    const blocks = frame.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      ordinal++;
      if (frame.type === "assistant" && block.type === "tool_use" && String(block.name).toLowerCase() === "read") {
        if (typeof block.id !== "string" || !block.id) continue;
        calls.set(block.id, calls.has(block.id) ? null : { ...block, ordinal });
      }
      if (frame.type === "user" && block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || !block.tool_use_id) continue;
        results.set(block.tool_use_id, results.has(block.tool_use_id) ? null : { ...block, ordinal });
      }
    }
  }
  for (const [id, call] of calls) {
    const result = results.get(id);
    if (!call || !result || result.is_error || result.ordinal <= call.ordinal) continue;
    const args = call.input ?? {}, content = typeof result.content === "string"
      ? [{ type: "text", text: result.content }] : result.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0].type !== "text") continue;
    let text = content[0].text, actual = args;
    // Claude Read's numbered display is a host rendering, not source content.
    // Accept only consecutive explicit line numbers and still match every
    // disclosed character against the actual original in the shared ledger.
    const lines = typeof text === "string" ? text.split("\n") : [];
    const first = /^\s*([1-9]\d*)→(.*)$/u.exec(lines[0] ?? "");
    if (first) {
      const start = Number(first[1]), body = [];
      const requested = args.offset ?? 1;
      if (!Number.isInteger(requested) || requested < 0 || (args.offset == null ? start !== 1 : start !== requested && start !== requested + 1)) continue;
      for (const line of lines) {
        const match = /^\s*([1-9]\d*)→(.*)$/u.exec(line);
        if (!match) break;
        if (Number(match[1]) !== start + body.length) { body.length = 0; break; }
        body.push(match[2]);
      }
      if (!body.length || args.limit != null && body.length > args.limit) continue;
      actual = { ...args, offset: start, limit: body.length }; text = body.join("\n");
    }
    await proof.observe("read", actual);
    await proof.observe("read:result", { toolName: "Read", toolCallId: id, args: actual,
      result: { content: [{ type: "text", text }], ...(first ? { details: { readDisplay: "CLAUDE_NUMBERED_LINES" } } : {}) } });
  }
}
