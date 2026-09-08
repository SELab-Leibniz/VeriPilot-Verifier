import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startRoleReviewer } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";
import { invokeSemanticReviewFork, runSemanticReview } from "../lib/semantic-review.mjs";

const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
const reviewer = { effort: "low", session: "detached", timeoutMs: 2000 };
const literal = '空 格 "JSON" \\windows\\path $HOME ; & \n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer runtime 空 格-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "agent entry.cjs");
  const capture = path.join(root, "capture.jsonl");
  await fs.writeFile(entry, `
const fs = require("node:fs");
const file = process.env.CAPTURE;
let count = 0;
try { count = fs.readFileSync(file, "utf8").trim().split("\\n").length; } catch {}
fs.appendFileSync(file, JSON.stringify({ args: process.argv.slice(2), marker: process.env.MARKER, cwd: process.cwd() }) + "\\n");
const envelope = { session_id: "own-session" };
if (process.env.MODE === "v1") envelope.structured_output = { summary: "ok", findings: [], edits: [] };
else if (count % 3 === 0) envelope.result = "please remind me";
else envelope.structured_output = { ok: count % 3 === 1 ? "invalid" : true };
process.stdout.write(JSON.stringify(envelope));
`);
  return { root, entry, capture, env: { ...process.env, CAPTURE: capture, MARKER: "original", RUNTIME_CORRECTOR_AGENT_EXECUTABLE: undefined, RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: path.join(root, "not-the-selected-cli") } };
}

test("v2 initial/reminder/repair/follow-up freeze launcher and preserve literal prefix exactly once", async (t) => {
  const f = await fixture(t);
  const task = await ensureTask({ projectRoot: f.root, sessionId: "parent" });
  const runtime = { executable: process.execPath, argsPrefix: [f.entry, literal] };
  const handle = await startRoleReviewer({ projectRoot: f.root, sessionCwd: f.root, taskId: task.taskId, parentSessionId: "parent", role: "stop-reviewer", reviewer, schema, request: {}, reviewerRuntime: runtime, env: f.env });
  t.after(() => handle.close());
  runtime.executable = "changed-program";
  runtime.argsPrefix[0] = "changed-entry";
  f.env.RUNTIME_CORRECTOR_AGENT_EXECUTABLE = "changed-env-program";
  f.env.MARKER = "changed";
  assert.deepEqual(await handle.followUp({ prompt: "follow-up" }), { ok: true });
  const calls = (await fs.readFile(f.capture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.args[0], literal);
    assert.equal(call.args.filter((arg) => arg === literal).length, 1);
    assert.equal(call.marker, "original");
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "Read,Grep");
  }
  for (const call of calls.slice(1)) assert.ok(call.args.includes("--no-session-persistence"));
});

test("v1 launches Node plus absolute entry with literal prefix and unchanged fork contract", async (t) => {
  const f = await fixture(t);
  const result = await invokeSemanticReviewFork({ cwd: f.root, sessionId: "parent", prompt: "review", env: { ...f.env, MODE: "v1" }, reviewerRuntime: { executable: process.execPath, argsPrefix: [f.entry, literal] } });
  assert.equal(result.review.summary, "ok");
  const call = JSON.parse((await fs.readFile(f.capture, "utf8")).trim());
  assert.deepEqual(call.args.slice(0, 2), [literal, "review"]);
  for (const flag of ["--fork-session", "--no-session-persistence", "--print"]) assert.ok(call.args.includes(flag));
});

test("v1 uses artifact runtime while fresh v2 artifact uses separate runtime ownership", async (t) => {
  const f = await fixture(t);
  const artifactRoot = path.join(f.root, "artifact");
  const sessionCwd = path.join(f.root, "session");
  await fs.mkdir(artifactRoot); await fs.mkdir(sessionCwd);
  const prepared = { projectRoot: artifactRoot, result: { metadata: { roundId: "ownership", artifactFiles: [] } }, reviewContext: { reviewerRuntime: { executable: "artifact-agent", argsPrefix: [] } } };
  let legacy;
  await runSemanticReview({ input: { session_id: "parent", cwd: sessionCwd }, prepared, invokeFork: async (options) => { legacy = options; return { review: { summary: "ok", findings: [], edits: [] } }; } });
  assert.equal(legacy.reviewerRuntime.executable, "artifact-agent");
  let target;
  const result = await runSemanticReview({ input: { session_id: "parent", cwd: sessionCwd }, prepared,
    runtimeV2Context: { taskId: "runtime-task", reviewerExecution: reviewer },
    runtimeV2ExecutionContext: { projectRoot: f.root, sessionCwd, taskId: "runtime-task", pluginRoot: "/runtime/plugin", reviewerRuntime: { executable: "runtime-agent", argsPrefix: [] }, env: { TEST_KEY: "must-not-persist" } },
    runtimeV2ReviewerFactory: async (options) => {
      target = options;
      const request = await fs.readFile(options.request.semanticReviewRequestPath, "utf8");
      assert.ok(!request.includes("must-not-persist"));
      return { result: { summary: "ok", findings: [], edits: [] }, close: async () => {} };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(target.projectRoot, f.root);
  assert.equal(target.sessionCwd, sessionCwd);
  assert.equal(target.taskId, "runtime-task");
  assert.equal(target.pluginRoot, "/runtime/plugin");
  assert.equal(target.reviewerRuntime.executable, "runtime-agent");
  assert.equal(target.env.TEST_KEY, "must-not-persist");
});
