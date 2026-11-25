import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeMessages } from "./transcript.mjs";
import { loadNativeCompatibility } from "./compat-2026.10.3.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameFile = (left, right) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"]
  .every(key => left[key] === right[key]);
const unavailable = reason => ({ status: "UNAVAILABLE", reason, messages: [], entries: [], lastExternalUser: null });
const stale = reason => ({ ...unavailable(reason), status: "STALE" });
const invalid = reason => ({ ...unavailable(reason), status: "INVALID" });

export function nativeToolPolicyDigest(api, state) {
  const config = api.runtime.config?.current?.() ?? api.config ?? {};
  const agent = config.agents?.list?.find(value => value.id === (state.agentId ?? 'main'));
  return hash([config.tools ?? null, agent?.tools ?? null, config.agents?.defaults?.sandbox?.tools ?? null,
    agent?.sandbox?.tools ?? null, state.provider ?? null, state.model ?? null]);
}

/** Actual model-visible catalog, never a business-agent capability claim. */
export async function observeNativeToolPolicy(api, state) {
  const sessions = api.runtime.agent?.session;
  if (!state.sessionId || !state.sessionKey || typeof sessions?.getSessionEntry !== 'function'
    || typeof sessions.resolveStorePath !== 'function') return null;
  const config = api.runtime.config?.current?.() ?? api.config ?? {};
  const entry = await sessions.getSessionEntry({ agentId: state.agentId ?? 'main', sessionKey: state.sessionKey,
    sessionId: state.sessionId, readConsistency: 'latest',
    storePath: sessions.resolveStorePath(config.session?.store, { agentId: state.agentId ?? 'main' }) });
  const report = entry?.systemPromptReport, tools = report?.tools?.entries;
  if (entry?.sessionId !== state.sessionId || report?.sessionId !== state.sessionId
    || report.sessionKey !== state.sessionKey || report.source !== 'run' || !Array.isArray(tools)) return null;
  const policyDigest = nativeToolPolicyDigest(api, state);
  return { source: 'HOST_EFFECTIVE_TOOL_CATALOG', hostVersion: api.runtime.version, sessionId: state.sessionId,
    current: policyDigest === state.businessToolPolicyDigest, policyDigest,
    catalogDigest: hash(tools), tools: tools.map(({ name, schemaHash }) => ({ name, schemaHash })) };
}

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

// The pinned MA Gateway persists a same-run, zero-token reply when a text
// command completes without starting an agent. A slash prefix alone is not evidence.
const rcSettingsCommand = /^\/(?:rc-project[ \t]+(?:init|on|off|status)|rc-session(?:-default)?(?:[ \t]+(?:on|off|status))?)$/u;
function maSettingsRecords(records) {
  const result = new Set();
  for (let i = 1; i < records.length; i++) {
    const user = records[i - 1], reply = records[i];
    const input = user.message, output = reply.message;
    const key = output?.idempotencyKey;
    if (user.type !== "message" || reply.type !== "message" || !user.id || !reply.id || reply.parentId !== user.id
      || input?.role !== "user" || input.__openclaw?.senderIsOwner !== true || input.__openclaw.beforeAgentRunBlocked
      || typeof input.content !== "string" || !rcSettingsCommand.test(input.content.trim())
      || output?.role !== "assistant" || output.provider !== "openclaw" || output.model !== "gateway-injected"
      || output.api !== "openai-responses" || output.stopReason !== "stop" || output.usage?.totalTokens !== 0
      || typeof key !== "string" || !key || input.idempotencyKey !== key + ":user") continue;
    result.add(user.id);
    result.add(reply.id);
  }
  return result;
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
  if (api.runtime.version === "2026.10.3") {
    if (typeof sessions?.getSessionEntry !== "function" || typeof sessions.resolveStorePath !== "function") return unavailable("HOST_PUBLIC_SESSION_READER_UNAVAILABLE");
    const config = api.runtime.config?.current?.() ?? api.config ?? {};
    const params = { agentId: state.agentId ?? "main", sessionId: state.sessionId, sessionKey: state.sessionKey,
      storePath: sessions.resolveStorePath(config.session?.store, { agentId: state.agentId ?? "main" }), readConsistency: "latest" };
    const before = await sessions.getSessionEntry(params);
    if (!before || before.sessionId !== state.sessionId) return stale("HOST_SESSION_REPLACED");
    const sdk = await (state.hostCompatibility ?? loadNativeCompatibility)();
    let records = sdk.loadTranscriptEvents(params);
    if (!Array.isArray(records) || Buffer.byteLength(JSON.stringify(records)) > maxBytes) return unavailable("HOST_TRANSCRIPT_READ_LIMIT");
    const headers = records.filter(record => record.type === "session");
    if (headers.length !== 1 || headers[0].id !== state.sessionId) return stale("HOST_TRANSCRIPT_SESSION_MISMATCH");
    const after = await sessions.getSessionEntry(params);
    if (!after || after.sessionId !== state.sessionId) return stale("HOST_SESSION_CHANGED_DURING_READ");
    try { records = activeNativeTranscriptRecords(records); } catch (error) { return invalid(error.message); }
    if (state.projectNativeRecords) records = await state.projectNativeRecords(records);
    return nativeTranscriptObservation(records, { source: "host-session-sdk" });
  }
  if (typeof sessions?.getSessionEntry !== "function" || typeof sessions.resolveSessionFilePath !== "function"
    || typeof sessions.resolveStorePath !== "function") return unavailable("HOST_PUBLIC_SESSION_READER_UNAVAILABLE");
  const config = api.runtime.config?.current?.() ?? api.config ?? {};
  const params = { agentId: state.agentId ?? "main", sessionKey: state.sessionKey, readConsistency: "latest",
    storePath: sessions.resolveStorePath(config.session?.store, { agentId: state.agentId ?? "main" }) };
  const before = await sessions.getSessionEntry(params);
  if (!before) return unavailable("HOST_SESSION_ENTRY_MISSING");
  if (before.sessionId !== state.sessionId) return stale("HOST_SESSION_REPLACED");
  const storePath = params.storePath;
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
  const settings = api.runtime.version === "2026.7.1-2" ? maSettingsRecords(messages) : new Set();
  const oneBranch = messages.length === records.length - 1;
  // Inspect the full file for zero-use proof. An abandoned model turn or a
  // compaction can conceal previous starts even when the active branch is empty.
  const execution = records.filter(record => !settings.has(record.id) && (record.message
    || !["session", "model_change", "thinking_level_change"].includes(record.type)
      && !(record.type === "custom" && record.customType === "model-snapshot")));
  const settingsEvidence = settings.size ? { settingsRecordIds: [...settings] } : {};
  const emptySessionEvidence = execution.length === 0 && (!settings.size || oneBranch)
    ? { kind: "EMPTY_HOST_EXECUTION_HISTORY", sessionId: state.sessionId, transcriptPath,
      transcriptDigest: hash(records), recordCount: records.length, observedAt: Date.now(), ...settingsEvidence } : null;
  // The first ordinary user turn proves zero prior RC continuations on this
  // host, where every continuation persists its own user-role record.
  const first = execution[0], firstMessage = first?.message;
  const initialTurn = oneBranch && execution.length > 0
    && execution.every(record => record.type === "message") && firstMessage?.role === "user"
    && execution.filter(record => record.message?.role === "user").length === 1
    && !first.isMeta && !first.provenance && !first.inputProvenance && !firstMessage.inputProvenance && !firstMessage.provenance
    && !firstMessage.__openclaw?.beforeAgentRunBlocked
    && !/runtime-corrector:stop-(?:feedback|reference)/u.test(JSON.stringify(firstMessage));
  const initialTurnEvidence = initialTurn ? { kind: "VERIFIED_FIRST_NATIVE_TURN", sessionId: state.sessionId,
    transcriptPath, transcriptDigest: hash(records), firstUserRecordId: first.id, recordCount: records.length,
    protocol: "MA_OPENCLAW_2026_7_1_PERSISTED_CONTINUATIONS", observedAt: Date.now(), ...settingsEvidence } : null;
  messages = messages.map(record => settings.has(record.id) ? { ...record, isMeta: true, rcControl: true } : record);
  if (state.projectNativeRecords) messages = await state.projectNativeRecords(messages);
  return { ...nativeTranscriptObservation(messages, { source: "host-session-file", transcriptPath }), emptySessionEvidence, initialTurnEvidence };
}
