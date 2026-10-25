import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeNativeTranscript, nativeTranscriptObservation } from "../lib/openclaw/native-transcript.mjs";

async function fixture(t, records) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rc-native-transcript-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "host-session.jsonl");
  await fs.writeFile(transcriptPath, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const entry = { sessionId: "host-session", sessionFile: transcriptPath };
  const calls = [];
  const api = { config: { session: { store: path.join(directory, "sessions.json") } }, runtime: { agent: { session: {
    getSessionEntry(params) { calls.push(params); return entry; },
    resolveStorePath(store, opts) { assert.equal(opts.agentId, "main"); return store; },
    resolveSessionFilePath(id, value, opts) { assert.equal(id, "host-session"); assert.equal(opts.sessionsDir, directory); return value.sessionFile; },
  } } } };
  const state = { agentId: "main", sessionKey: "agent:main:conversation", sessionId: "host-session" };
  return { api, state, entry, calls, transcriptPath };
}
const header = { type: "session", id: "host-session", version: 3 };
const message = (id, parentId, role, content, extra = {}) => ({ type: "message", id, parentId,
  message: { role, content, ...extra } });

test("read only the host's active branch and retain genuine requirement updates", async t => {
  const f = await fixture(t, [header,
    message("first", null, "user", "Build the feature.", { provenance: { kind: "external_user" } }),
    message("old-branch", "first", "user", "Abandoned requirement."),
    message("new-branch", "first", "assistant", "[runtime-corrector:feedback] Review opinion."),
    message("system", "new-branch", "user", "Continue automatically.", { provenance: { kind: "internal_system" } }),
    message("tools", "system", "toolResult", "A tool said everything passed.", { toolCallId: "tool-call" }),
    message("update", "tools", "user", "Use persistent storage.", { provenance: { kind: "external_user" } }),
  ]);
  const before = await fs.readFile(f.transcriptPath);
  const observation = await observeNativeTranscript(f.api, f.state);
  assert.equal(observation.status, "OBSERVED");
  assert.deepEqual(observation.messages.map(record => record.id), ["first", "new-branch", "system", "tools", "update"]);
  assert.deepEqual(observation.entries.filter(entry => entry.type === "user" && !entry.isMeta).map(entry => entry.message.content[0].text),
    ["Build the feature.", "Use persistent storage."]);
  assert.equal(observation.lastExternalUser.uuid, "update");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], { agentId: "main", sessionKey: f.state.sessionKey, readConsistency: "latest",
    storePath: f.api.config.session.store });
  assert.deepEqual(await fs.readFile(f.transcriptPath), before, "The host transcript remains byte-identical.");
  assert.equal(observation.externalUsersDigest, (await observeNativeTranscript(f.api, f.state)).externalUsersDigest);
});

test("assembled prompts and RC feedback never become independent user requirements", async t => {
  const f = await fixture(t, [header, message("human", null, "user", "Actual request."),
    message("reply", "human", "assistant", "[runtime-corrector:feedback] Fix this."),
    message("retry", "reply", "user", "Synthetic retry.", { provenance: { kind: "internal_system" } }),
  ]);
  f.state.prompt = "Synthetic unpersisted prompt plus RC feedback.";
  const observed = await observeNativeTranscript(f.api, f.state);
  assert.equal(observed.lastExternalUser.message.content[0].text, "Actual request.");
  assert.equal(observed.entries.some(entry => JSON.stringify(entry).includes("unpersisted")), false);
  const imported = nativeTranscriptObservation([{ role: "user", content: "Legacy user request." },
    { role: "user", content: "Cross-session handoff.", provenance: { kind: "inter_session" } },
    { role: "user", content: "Policy blocked the run.", idempotencyKey: "hook-block:before_agent_run:user:fixture",
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "host-policy", blockedAt: 1 } } },
    { type: "user", isMeta: true, message: { role: "user", content: "Explicit metadata." } }]);
  assert.equal(imported.lastExternalUser.message.content[0].text, "Legacy user request.");
});

test("session replacement, mismatched header and malformed evidence fail closed", async t => {
  const f = await fixture(t, [header, message("human", null, "user", "Request.")]);
  f.entry.sessionId = "replacement";
  assert.equal((await observeNativeTranscript(f.api, f.state)).reason, "HOST_SESSION_REPLACED");
  f.entry.sessionId = "host-session";
  await fs.writeFile(f.transcriptPath, JSON.stringify({ ...header, id: "foreign-session" }) + "\n");
  assert.equal((await observeNativeTranscript(f.api, f.state)).reason, "HOST_TRANSCRIPT_SESSION_MISMATCH");
  await fs.writeFile(f.transcriptPath, JSON.stringify(header) + "\n{partial");
  assert.equal((await observeNativeTranscript(f.api, f.state)).reason, "HOST_TRANSCRIPT_INCOMPLETE_OR_MALFORMED");
});

test("reset during reading and oversized source are never projected", async t => {
  const f = await fixture(t, [header, message("human", null, "user", "Request.")]);
  let reads = 0;
  f.api.runtime.agent.session.getSessionEntry = () => ++reads === 1 ? f.entry : { ...f.entry, sessionId: "replacement" };
  assert.equal((await observeNativeTranscript(f.api, f.state)).reason, "HOST_SESSION_CHANGED_DURING_READ");
  f.api.runtime.agent.session.getSessionEntry = () => f.entry;
  assert.equal((await observeNativeTranscript(f.api, f.state, { maxBytes: 2 })).reason, "HOST_TRANSCRIPT_READ_LIMIT");
  assert.equal((await observeNativeTranscript({ runtime: { agent: {} } }, f.state)).reason, "HOST_PUBLIC_SESSION_READER_UNAVAILABLE");
});

test("zero-history evidence uses the complete unbranched native first turn and excludes imported or RC-owned input", async t => {
  const initial = [header, message("human", null, "user", "First business requirement."),
    message("tool", "human", "assistant", [{ type: "toolCall", id: "write", name: "write", arguments: {} }])];
  const f = await fixture(t, initial);
  assert.equal((await observeNativeTranscript(f.api, f.state)).initialTurnEvidence.kind, "VERIFIED_FIRST_NATIVE_TURN");
  for (const rows of [
    [header, message("rc", null, "user", "[runtime-corrector:stop-reference] prior continuation")],
    [header, message("foreign", null, "user", "Imported input.", { provenance: { kind: "inter_session" } })],
    [header, message("blocked", null, "user", "Blocked input.", { __openclaw: { beforeAgentRunBlocked: {} } })],
    [...initial, { type: "compaction", id: "compacted", parentId: "tool", summary: "Earlier history omitted" }],
    [header, message("abandoned", null, "assistant", "Earlier model execution."), ...initial.slice(1)],
  ]) {
    await fs.writeFile(f.transcriptPath, rows.map(JSON.stringify).join("\n") + "\n");
    assert.equal((await observeNativeTranscript(f.api, f.state)).initialTurnEvidence, null);
  }
});
