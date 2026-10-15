import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessages } from "../lib/openclaw/transcript.mjs";
import { processToolEvidence } from "../lib/runtime-v2/transcript.mjs";

const call = (id, name = "Read") => ({ type: "tool_use", id, name, input: { file_path: "contract.md" } });
const entry = (type, uuid, content, extra = {}) => ({ type, uuid, message: { content }, ...extra });
const result = (id, extra = {}) => ({ type: "tool_result", tool_use_id: id, content: "Complete content.", ...extra });

test("native read result precedes edit invocation; filesystem observations and admissions create no actions", () => {
  const snapshot = { entries: normalizeMessages([
    { id: "u", message: { role: "user", content: "Read the contract." } },
    { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "contract.md" } }] } },
    { id: "r1", message: { role: "toolResult", toolCallId: "read", content: "Complete contract." } },
    { id: "a2", message: { role: "assistant", content: [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "worker.py" } }] } },
    { id: "r2", message: { role: "toolResult", toolCallId: "edit", content: "Edited." } },
    { id: "admission", message: { role: "assistant", content: "I may have edited before reading." } },
  ]) };
  snapshot.entries.push(entry("user", "observer", "worker.py hash changed."));
  const [read, edit, ...others] = processToolEvidence(snapshot);
  assert.equal(read.toolUseId, "read");
  assert.equal(read.resultEntry, "r1");
  assert.equal(read.status, "RETURNED");
  assert(read.resultIndex < edit.invocationIndex);
  assert.equal(others.length, 0);
});

test("parallel calls share their invocation position; result order never invents sequential invocation", () => {
  const evidence = processToolEvidence({ entries: [
    entry("assistant", "a", [call("read"), call("write", "Write")]),
    entry("user", "r1", [result("write")], { isMeta: true }),
    entry("user", "r2", [result("read")], { isMeta: true }),
  ] });
  assert.equal(evidence[0].invocationIndex, evidence[1].invocationIndex);
  assert(evidence[0].resultIndex > evidence[1].invocationIndex);
  assert(evidence[1].resultIndex > evidence[0].invocationIndex);
});

test("pending, failed, reused and out-of-order identities cannot become successful completion receipts", () => {
  for (const entries of [
    [entry("assistant", "a", [call("x"), call("x")])],
    [entry("assistant", "a", [call("x")]), entry("user", "r", [result("x"), result("x")])],
    [entry("user", "r", [result("x")]), entry("assistant", "a", [call("x")])],
  ]) assert.equal(processToolEvidence({ entries })[0].status, "AMBIGUOUS");
  assert.equal(processToolEvidence({ entries: [entry("assistant", "a", [call("x")])] })[0].status, "PENDING");
  assert.equal(processToolEvidence({ entries: [entry("assistant", "a", [call("x")]),
    entry("user", "r", [result("x", { is_error: true })])] })[0].status, "ERROR");
});

test("only the supplied snapshot contributes evidence; internal calls and orphan results grant no attribution", () => {
  const snapshot = { entries: [entry("assistant", "reviewer", [call("internal")], { isMeta: true }),
    entry("user", "foreign-result", [result("other-session")])] };
  assert.deepEqual(processToolEvidence(snapshot), []);
  assert.deepEqual(processToolEvidence(null), []);
});
