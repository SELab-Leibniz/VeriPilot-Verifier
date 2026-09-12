import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { toolName } from "./tools.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// OpenClaw session records wrap messages in {type:"message", id, message}.
// Core correction deliberately keeps its existing transcript contract.
export function normalizeMessages(records = []) {
  const occurrences = new Map();
  return records.flatMap((record, index) => {
    const message = record.message ?? record;
    const role = message.role ?? (record.type === "user" || record.type === "assistant" ? record.type : null);
    if (!["user", "assistant", "toolResult"].includes(role)) return [];
    const signature = digest(message);
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    const id = record.id ?? record.uuid ?? message.id ?? `oc-${signature.slice(0, 24)}-${occurrence}`;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [];
    const content = role === "toolResult" ? [{
      type: "tool_result", tool_use_id: message.toolCallId, content: blocks, is_error: message.isError === true,
    }] : blocks.flatMap((block) => {
      if (block.type === "toolCall") return [{ type: "tool_use", id: block.id, name: toolName(block.name), input: block.arguments ?? {} }];
      if (block.type === "text" || block.type === "tool_use" || block.type === "tool_result") return [block];
      return [];
    });
    const provenance = message.provenance ?? message.inputProvenance ?? record.provenance ?? record.inputProvenance;
    const synthetic = record.isMeta === true || role === "toolResult"
      || (provenance?.kind && provenance.kind !== "external_user")
      || blocks.some((block) => block.type === "text" && /\[runtime-corrector:(?:internal|feedback)\]/u.test(block.text ?? ""));
    return [{ type: role === "assistant" ? "assistant" : "user", uuid: id,
      ...(synthetic ? { isMeta: true } : {}), timestamp: record.timestamp ?? message.timestamp,
      message: { id, role: role === "toolResult" ? "user" : role, content } }];
  });
}

export async function readOpenClawTranscript(file) {
  if (!file) return [];
  const text = await fs.readFile(file, "utf8");
  const records = text.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  // Only the active branch belongs to the current conversation. Compaction
  // and branch records are still followed even though they are not messages.
  const byId = new Map(records.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const leaf = records.findLast((entry) => entry.id);
  if (!leaf || !Object.hasOwn(leaf, "parentId")) return normalizeMessages(records);
  const chain = [];
  const seen = new Set();
  let cursor = leaf;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = byId.get(cursor.parentId);
  }
  return normalizeMessages(chain.reverse());
}

export async function persistTranscript(state, { messages, transcriptPath, prompt, realUser = false, runId } = {}) {
  if (!state.transcriptPath) {
    state.transcriptPath = path.join(state.projectRoot, ".runtime-correction", "openclaw",
      digest([state.agentId, state.sessionId]).slice(0, 24), "transcript.jsonl");
    try {
      state.entries = (await fs.readFile(state.transcriptPath, "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  let entries;
  if (transcriptPath) entries = await readOpenClawTranscript(transcriptPath);
  else if (Array.isArray(messages)) entries = normalizeMessages(messages);
  if (entries) {
    // Preserve each user source's identity when pre-prompt history is later
    // replaced by native transcript records. Otherwise one real request can
    // look like a new turn and reset correction budgets. Match occurrences,
    // not just text: repeating the same request is still a real new turn.
    const unmatched = (state.entries ?? []).filter((entry) => entry.type === "user" && !entry.isMeta);
    for (const entry of entries.filter((item) => item.type === "user" && !item.isMeta)) {
      const sameContent = (prior) => JSON.stringify(prior.message.content) === JSON.stringify(entry.message.content);
      let index = unmatched.findIndex((prior) => prior.nativeUuid === entry.uuid || prior.uuid === entry.uuid
        || (entry.timestamp && prior.timestamp === entry.timestamp && sameContent(prior)));
      if (index < 0) index = unmatched.findIndex(sameContent);
      if (index < 0) continue;
      const [prior] = unmatched.splice(index, 1);
      entry.nativeUuid = entry.uuid;
      entry.uuid = prior.uuid;
      entry.message.id = prior.uuid;
    }
    entries.push(...unmatched.filter((entry) => entry.pendingPrompt));
    state.entries = entries;
  }
  state.entries ??= [];
  if (typeof prompt === "string" && prompt.trim() && realUser) {
    const id = `oc-prompt-${digest([state.sessionId, runId, prompt]).slice(0, 24)}`;
    const content = [{ type: "text", text: prompt }];
    if (!state.entries.some((entry) => entry.uuid === id)) {
      state.entries.push({ type: "user", uuid: id, pendingPrompt: true, message: { id, content } });
    }
  }
  // Write atomically so parallel hooks never see a half-written snapshot.
  await fs.mkdir(path.dirname(state.transcriptPath), { recursive: true });
  const temp = `${state.transcriptPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, state.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
    await fs.rename(temp, state.transcriptPath);
  } finally { await fs.rm(temp, { force: true }); }
  return state.transcriptPath;
}
