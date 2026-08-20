import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { journalReviewerEnvelope, reviewerEnvelopeSummary } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";
// A downstream consumer accounting must read exactly what the corrector
// journals; the vendored contract helper locks the journal shape.
import { summarizeCriticOverhead } from "./helpers/critic-contract.mjs";

test("journaled reviewer envelopes feed summarizeCriticOverhead (V08)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envelope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "s1" });

  const envelope = {
    total_cost_usd: 0.25,
    num_turns: 7,
    duration_ms: 12000,
    session_id: "sess-abc",
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 },
    result: "THIS PAYLOAD MUST NOT BE JOURNALED",
  };
  await journalReviewerEnvelope({ projectRoot: root, taskId: task.taskId, role: "stop-reviewer", phase: "first", envelope });
  await journalReviewerEnvelope({ projectRoot: root, taskId: task.taskId, role: "implementation-reviewer", phase: "follow-up", envelope: { ...envelope, total_cost_usd: 0.75, num_turns: 3, duration_ms: 8000 } });
  // A null envelope (CLI produced none) is skipped, never journaled as junk.
  await journalReviewerEnvelope({ projectRoot: root, taskId: task.taskId, role: "stop-reviewer", phase: "first", envelope: null });

  const journal = await fs.readFile(
    path.join(root, ".runtime-correction", "tasks", task.taskId, "journal", "events.jsonl"),
    "utf8",
  );
  assert.ok(!journal.includes("MUST NOT BE JOURNALED"), "result payload stays out of the journal");

  const totals = summarizeCriticOverhead(root);
  assert.ok(totals, "overhead is recorded, not null");
  assert.equal(totals.invocations, 2);
  assert.equal(totals.costUsd, 1.0);
  assert.equal(totals.turns, 10);
  assert.equal(totals.wallClockMs, 20000);
  assert.equal(totals.inputTokens, 2000);
  assert.equal(totals.outputTokens, 400);
});

test("reviewerEnvelopeSummary reduces to spend fields only", () => {
  assert.equal(reviewerEnvelopeSummary(null), null);
  const summary = reviewerEnvelopeSummary({ total_cost_usd: 1, num_turns: 2, duration_ms: 3, session_id: "x", usage: { input_tokens: 4, output_tokens: 5 }, result: "payload", structured_output: {} });
  assert.deepEqual(Object.keys(summary).sort(), ["duration_ms", "num_turns", "session_id", "total_cost_usd", "usage"]);
});
