import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeMessages } from "./transcript.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameFile = (left, right) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"]
  .every(key => left[key] === right[key]);
const unavailable = reason => ({ status: "UNAVAILABLE", reason, messages: [], entries: [], lastExternalUser: null });
const stale = reason => ({ ...unavailable(reason), status: "STALE" });
const invalid = reason => ({ ...unavailable(reason), status: "INVALID" });

// A transcript file is an append-only tree. Only its active parent chain is
// evidence for this session; abandoned branches never update its requirements.
export function activeNativeTranscriptRecords(records) {
  const byId = new Map();
  for (const record of records) if (record.id) {
    if (byId.has(record.id)) throw new Error("Host transcript contains duplicate entry identities.");
    byId.set(record.id, record);
  }
  const leaf = records.findLast(record => record.id && record.type !== "session");
  if (!leaf) return [];
  if (!Object.hasOwn(leaf, "parentId")) return records.filter(record => record.type !== "session");
  const chain = [], visited = new Set();
  let cursor = leaf;
  while (cursor) {
    if (visited.has(cursor.id)) throw new Error("Host transcript active branch contains a cycle.");
    visited.add(cursor.id);
    if (cursor.type !== "session") chain.push(cursor);
    if (cursor.parentId === null || cursor.parentId === undefined) break;
    const parent = byId.get(cursor.parentId);
    if (!parent) throw new Error("Host transcript active branch has a missing parent.");
    cursor = parent;
  }
  return chain.reverse();
}

export function nativeTranscriptObservation(messages, { source = "host-hook-messages", transcriptPath = null } = {}) {
  const sourceMessages = messages.map(record => {
    const message = record.message ?? record;
    // The host persists a redacted policy-block explanation as a user-role
    // message. Its host-owned marker makes it operational evidence, not a new
    // user requirement. Keep it visible and unchanged in the source file.
    return message.role === "user" && message.__openclaw?.beforeAgentRunBlocked
      ? { ...record, isMeta: true } : record;
  });
  const entries = normalizeMessages(sourceMessages);
  // normalizeMessages marks internal_system/inter_session/tool results and
  // isMeta records as metadata. Legacy native user messages without explicit
  // provenance retain the host's own external-user semantics.
  const users = entries.filter(entry => entry.type === "user" && !entry.isMeta);
  return { status: "OBSERVED", source, transcriptPath, messages: sourceMessages, entries,
    lastExternalUser: users.at(-1) ?? null,
    externalUsersDigest: hash(users.map(entry => ({ uuid: entry.uuid, sourceMessageId: entry.sourceMessageId,
      content: entry.message.content }))),
    evidenceDigest: hash(messages) };
}

/** Read the current host branch through the public session API, without writes. */
export async function observeNativeTranscript(api, state, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const sessions = api.runtime.agent?.session;
  if (!state.sessionId || !state.sessionKey) return unavailable("HOST_SESSION_IDENTITY_REQUIRED");
  if (typeof sessions?.getSessionEntry !== "function" || typeof sessions.resolveSessionFilePath !== "function"
    || typeof sessions.resolveStorePath !== "function") return unavailable("HOST_PUBLIC_SESSION_READER_UNAVAILABLE");
  const params = { agentId: state.agentId ?? "main", sessionKey: state.sessionKey, readConsistency: "latest" };
  const before = await sessions.getSessionEntry(params);
  if (!before) return unavailable("HOST_SESSION_ENTRY_MISSING");
  if (before.sessionId !== state.sessionId) return stale("HOST_SESSION_REPLACED");
  const config = api.runtime.config?.current?.() ?? api.config ?? {};
  const storePath = sessions.resolveStorePath(config.session?.store, { agentId: params.agentId });
  const options = { agentId: params.agentId, sessionsDir: path.dirname(storePath) };
  const transcriptPath = sessions.resolveSessionFilePath(state.sessionId, before, options);
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return invalid("HOST_TRANSCRIPT_PATH_INVALID");
  let text, readStat;
  try {
    const file = await fs.open(transcriptPath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return unavailable("HOST_TRANSCRIPT_READ_LIMIT");
      text = await file.readFile("utf8");
      if (Buffer.byteLength(text) > maxBytes) return unavailable("HOST_TRANSCRIPT_READ_LIMIT");
      readStat = await file.stat();
      if (!sameFile(stat, readStat)) return stale("HOST_TRANSCRIPT_CHANGED_DURING_READ");
    } finally { await file.close(); }
  } catch (error) {
    if (error.code === "ENOENT") return unavailable("HOST_TRANSCRIPT_NOT_PERSISTED");
    throw error;
  }
  let records;
  try { records = text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { return invalid("HOST_TRANSCRIPT_INCOMPLETE_OR_MALFORMED"); }
  const headers = records.filter(record => record.type === "session");
  if (headers.length !== 1 || headers[0].id !== state.sessionId) return stale("HOST_TRANSCRIPT_SESSION_MISMATCH");
  const after = await sessions.getSessionEntry(params);
  if (!after || after.sessionId !== state.sessionId
    || sessions.resolveSessionFilePath(state.sessionId, after, options) !== transcriptPath) return stale("HOST_SESSION_CHANGED_DURING_READ");
  try {
    if (!sameFile(readStat, await fs.stat(transcriptPath))) return stale("HOST_TRANSCRIPT_CHANGED_DURING_READ");
  } catch (error) {
    if (error.code === "ENOENT") return stale("HOST_TRANSCRIPT_CHANGED_DURING_READ");
    throw error;
  }
  let messages;
  try { messages = activeNativeTranscriptRecords(records); }
  catch (error) { return invalid(error.message); }
  if (state.projectNativeRecords) messages = await state.projectNativeRecords(messages);
  return nativeTranscriptObservation(messages, { source: "host-session-file", transcriptPath });
}
