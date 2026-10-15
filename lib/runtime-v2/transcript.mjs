import { promises as fs } from "node:fs";

import { sha256 } from "./utils.mjs";


function contentBlocks(message) {
  const content = message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}


function isRealUserEntry(entry) {
  if (entry?.type !== "user" || entry.isMeta === true) return false;
  const blocks = contentBlocks(entry.message);
  if (blocks.length === 0) return false;
  return blocks.some((block) => block?.type !== "tool_result" && (
    block?.type !== "text" || !String(block.text ?? "").includes("[runtime-corrector:internal]")
  ));
}


function userKey(entry) {
  return entry.uuid
    ?? entry.message?.id
    ?? `user-${sha256({ content: entry.message?.content, timestamp: entry.timestamp }).slice(0, 24)}`;
}


function assistantKey(entry) {
  return entry.message?.id ?? entry.uuid ?? null;
}


function textBlocks(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "text" && String(block.text ?? "").trim())
    .map((block) => String(block.text));
}


export function latestAssistantText(snapshot) {
  for (let index = (snapshot?.entries?.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index];
    if (entry?.type !== "assistant") continue;
    const text = textBlocks(entry.message).join("\n").trim();
    if (text) return text;
  }
  return null;
}


export function unresolvedSiblingToolUseIds(snapshot, currentToolUseId) {
  if (!currentToolUseId) return [];
  const entries = snapshot?.entries ?? [];
  let batchIndex = -1;
  let batchIds = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const ids = entry.message.content
      .filter((block) => block?.type === "tool_use" && typeof block.id === "string")
      .map((block) => block.id);
    if (!ids.includes(currentToolUseId)) continue;
    batchIndex = index;
    batchIds = ids;
    break;
  }
  if (batchIndex < 0) return [];
  const resolved = new Set([currentToolUseId]);
  for (const entry of entries.slice(batchIndex + 1)) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        resolved.add(block.tool_use_id);
      }
    }
  }
  return batchIds.filter((toolUseId) => !resolved.has(toolUseId));
}

// A compact index into the SAME captured transcript used by the reviewer.
// No shell/action inference and no wall-clock ordering: concurrent calls share
// an invocation index. Missing/duplicate/out-of-order identities stay unknown.
export function processToolEvidence(snapshot) {
  const calls = new Map();
  const results = new Map();
  for (const [index, entry] of (snapshot?.entries ?? []).entries()) {
    for (const block of contentBlocks(entry.message)) {
      if (entry.type === "assistant" && entry.isMeta !== true
        && block.type === "tool_use" && typeof block.id === "string") {
        const found = calls.get(block.id) ?? [];
        found.push({ toolUseId: block.id, toolName: block.name,
          invocationEntry: entry.uuid ?? entry.message?.id ?? null, invocationIndex: index });
        calls.set(block.id, found);
      }
      if (entry.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const found = results.get(block.tool_use_id) ?? [];
        found.push({ resultEntry: entry.uuid ?? entry.message?.id ?? null,
          resultIndex: index, isError: block.is_error === true });
        results.set(block.tool_use_id, found);
      }
    }
  }
  return [...calls].map(([id, invocations]) => {
    const returned = results.get(id) ?? [];
    const call = invocations[0];
    if (invocations.length !== 1 || returned.length > 1
      || (returned.length === 1 && returned[0].resultIndex <= call.invocationIndex)) {
      return { ...call, status: "AMBIGUOUS" };
    }
    if (!returned.length) return { ...call, status: "PENDING" };
    return { ...call, ...returned[0], status: returned[0].isError ? "ERROR" : "RETURNED" };
  });
}


export async function readTranscriptSnapshot(transcriptPath) {
  if (!transcriptPath) {
    return {
      entries: [],
      userKeys: [],
      assistantKeys: [],
      bytes: 0,
      digest: sha256(""),
      groundTruthDigest: sha256([]),
      lastUserEntryKey: null,
      lastEntryKey: null,
    };
  }
  let contents;
  try {
    contents = await fs.readFile(transcriptPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        entries: [],
        userKeys: [],
        assistantKeys: [],
        bytes: 0,
        digest: sha256(""),
        groundTruthDigest: sha256([]),
        lastUserEntryKey: null,
        lastEntryKey: null,
        missing: true,
      };
    }
    throw error;
  }
  const entries = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // The host can append a partial line while a hook reads the transcript.
    }
  }
  const userKeys = [...new Set(entries.filter(isRealUserEntry).map(userKey))];
  const groundTruthEntries = entries.filter(isRealUserEntry).map((entry) => ({
    key: userKey(entry),
    content: entry.message?.content,
  }));
  const assistantKeys = [...new Set(
    entries.filter((entry) => entry?.type === "assistant")
      .map(assistantKey)
      .filter(Boolean),
  )];
  const last = entries.at(-1);
  return {
    entries,
    userKeys,
    assistantKeys,
    bytes: Buffer.byteLength(contents, "utf8"),
    digest: sha256(contents),
    groundTruthDigest: sha256(groundTruthEntries),
    lastUserEntryKey: groundTruthEntries.at(-1)?.key ?? null,
    lastEntryKey: last?.uuid ?? last?.message?.id ?? null,
  };
}


export function reconcileTurnState(turnState, snapshot, input = {}) {
  const existingUsers = new Set(turnState.userKeys ?? []);
  const existingPrompts = new Set(turnState.promptKeys ?? []);
  const existingAssistants = new Set(turnState.assistantKeys ?? []);
  for (const key of snapshot.userKeys) existingUsers.add(key);
  for (const key of snapshot.assistantKeys) existingAssistants.add(key);
  if (input.hook_event_name === "UserPromptSubmit" && typeof input.prompt === "string") {
    const promptKey = `prompt-${sha256({
      prompt: input.prompt,
      transcriptBytes: snapshot.bytes,
      lastEntryKey: snapshot.lastEntryKey,
    }).slice(0, 24)}`;
    existingPrompts.add(promptKey);
  }
  const userKeys = [...existingUsers];
  const promptKeys = [...existingPrompts];
  const assistantKeys = [...existingAssistants];
  const previousTotal = turnState.total ?? 0;
  const total = Math.max(userKeys.length, promptKeys.length) + assistantKeys.length;
  Object.assign(turnState, {
    userKeys,
    promptKeys,
    assistantKeys,
    total,
    transcriptBytes: snapshot.bytes,
    transcriptDigest: snapshot.digest,
    lastEntryKey: snapshot.lastEntryKey,
  });
  return {
    previousTotal,
    total,
    delta: Math.max(0, total - previousTotal),
  };
}
