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
      // Claude Code can append a partial line while a hook reads the transcript.
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
