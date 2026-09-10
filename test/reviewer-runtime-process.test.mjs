import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as codeAgentHost from "../lib/hosts/codeagent.mjs";
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
const args = process.argv.slice(2);
let count = 0;
try { count = fs.readFileSync(file, "utf8").trim().split("\\n").length; } catch {}
const valueAfter = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const resumedSession = valueAfter("--sessions");
const allocatedSession = "session-" + (process.env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID || process.pid);
const sessionId = resumedSession && !args.includes("--fork-session") ? resumedSession : allocatedSession;
fs.appendFileSync(file, JSON.stringify({
  args,
  marker: process.env.MARKER,
  cwd: process.cwd(),
  provider: process.env.ANTHROPIC_BASE_URL ?? null,
  token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  parentApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  parentOauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}) + "\\n");
const envelope = { session_id: sessionId };
if (process.env.MODE === "unparseable") {
  process.stdout.write("not-json");
  process.exit(0);
}
if (process.env.MODE === "v1") envelope.structured_output = { summary: "ok", findings: [], edits: [] };
else if (process.env.MODE === "valid") envelope.structured_output = { ok: true };
else if (count % 3 === 0) envelope.result = "please remind me";
else envelope.structured_output = { ok: count % 3 === 1 ? "invalid" : true };
if (process.env.SESSION_ECHO === "omit") delete envelope.session_id;
else if (process.env.SESSION_ECHO === "mismatch") envelope.session_id = "different-session";
else if (process.env.SESSION_ECHO === "parent") envelope.session_id = resumedSession;
process.stdout.write(JSON.stringify(envelope));
`);
  return { root, entry, capture, env: { ...process.env, CAPTURE: capture, MARKER: "original", RUNTIME_CORRECTOR_AGENT_EXECUTABLE: undefined, RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT: undefined, RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: path.join(root, "not-the-selected-cli") } };
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

test("CodeAgent v1 uses plural sessions for a parent fork and preserves public arguments", async (t) => {
  const f = await fixture(t);
  const result = await invokeSemanticReviewFork({
    cwd: f.root,
    sessionId: "codeagent-parent",
    prompt: "review",
    env: { ...f.env, MODE: "v1" },
    reviewerRuntime: { executable: process.execPath, argsPrefix: [f.entry, literal] },
    hostAdapter: codeAgentHost,
  });
  assert.equal(result.review.summary, "ok");
  assert.match(result.sessionId, /^session-/u);
  const call = JSON.parse((await fs.readFile(f.capture, "utf8")).trim());
  assert.deepEqual(call.args.slice(0, 2), [literal, "review"]);
  assert.equal(call.args[call.args.indexOf("--sessions") + 1], "codeagent-parent");
  for (const flag of ["--fork-session", "--no-session-persistence", "--print", "--json-schema", "--plugin-dir"]) {
    assert.ok(call.args.includes(flag), flag);
  }
  assert.ok(!call.args.includes("--resume"));
  assert.ok(!call.args.includes("--continue"));
});

test("CodeAgent independent v2 resumes the returned fresh session through retries, repair, and follow-up", async (t) => {
  const f = await fixture(t);
  const task = await ensureTask({ projectRoot: f.root, sessionId: "parent" });
  const gatewayToken = "gateway-token-secret";
  const runtime = {
    executable: process.execPath,
    argsPrefix: [f.entry],
  };
  const independentReviewer = {
    effort: "high",
    session: "independent",
    timeoutMs: 900000,
    maxBudgetUsd: 3.5,
    provider: {
      baseUrl: "https://gateway.example",
      apiKeyEnv: "CODEAGENT_REVIEWER_API_KEY",
      model: "glm-5.3",
    },
  };
  const env = {
    ...f.env,
    ANTHROPIC_API_KEY: "parent-api-key-secret",
    ANTHROPIC_AUTH_TOKEN: "parent-auth-token-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "parent-oauth-token-secret",
    CODEAGENT_REVIEWER_API_KEY: gatewayToken,
  };
  const handle = await startRoleReviewer({
    projectRoot: f.root,
    sessionCwd: f.root,
    taskId: task.taskId,
    parentSessionId: "parent",
    role: "ground-truth-extractor",
    reviewer: independentReviewer,
    schema,
    request: { publicValue: "safe" },
    reviewerRuntime: runtime,
    env,
    hostAdapter: codeAgentHost,
  });
  t.after(() => handle.close());
  assert.match(handle.sessionId, /^session-internal-/u);
  assert.deepEqual(await handle.followUp({ prompt: "repair the ground-truth delta" }), { ok: true });

  const calls = (await fs.readFile(f.capture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 6, "initial reminder/repair and follow-up reminder/repair should all run");
  assert.ok(!calls[0].args.includes("--session-id"));
  assert.ok(!calls[0].args.includes("--sessions"));
  for (const call of calls) {
    assert.ok(!call.args.includes("--resume"));
    assert.ok(!call.args.includes("--continue"));
    assert.equal(call.args[call.args.indexOf("--model") + 1], "glm-5.3");
    assert.equal(call.args[call.args.indexOf("--max-budget-usd") + 1], "3.5");
    assert.equal(call.provider, "https://gateway.example");
    assert.equal(call.token, gatewayToken);
    assert.equal(call.parentApiKey, null);
    assert.equal(call.parentOauth, null);
  }
  for (const call of calls.slice(1)) {
    assert.equal(call.args[call.args.indexOf("--sessions") + 1], handle.sessionId);
    assert.ok(call.args.includes("--no-session-persistence"));
  }
  const request = await fs.readFile(path.join(handle.requestDirectory, "request.json"), "utf8");
  const journal = await fs.readFile(path.join(f.root, ".runtime-correction", "tasks", task.taskId, "journal", "events.jsonl"), "utf8");
  assert.ok(!request.includes(gatewayToken));
  assert.ok(!journal.includes(gatewayToken));
});

test("CodeAgent requires fresh/fork IDs and rejects a mismatched resumed session", async (t) => {
  const makeOptions = async (f, role, selectedReviewer, extraEnv) => {
    const task = await ensureTask({ projectRoot: f.root, sessionId: "parent" });
    return {
      projectRoot: f.root,
      sessionCwd: f.root,
      taskId: task.taskId,
      parentSessionId: "parent",
      role,
      reviewer: selectedReviewer,
      schema,
      request: {},
      reviewerRuntime: { executable: process.execPath, argsPrefix: [f.entry] },
      env: { ...f.env, MODE: "valid", ...extraEnv },
      hostAdapter: codeAgentHost,
    };
  };

  const missingEcho = await fixture(t);
  await assert.rejects(startRoleReviewer(await makeOptions(
    missingEcho, "stop-reviewer", reviewer, { SESSION_ECHO: "omit" },
  )), (error) => error.code === "REVIEWER_SESSION_ID_MISSING");

  const mismatch = await fixture(t);
  await assert.rejects(
    startRoleReviewer({
      ...await makeOptions(mismatch, "stop-reviewer", baseForkReviewer(), { SESSION_ECHO: "mismatch" }),
      continuationSessionId: "known-session",
    }),
    /returned session ID different-session, expected/u,
  );

  const missingFork = await fixture(t);
  await assert.rejects(
    startRoleReviewer(await makeOptions(missingFork, "stop-reviewer", baseForkReviewer(), { SESSION_ECHO: "omit" })),
    (error) => error.code === "REVIEWER_SESSION_ID_MISSING",
  );

  const parentFork = await fixture(t);
  await assert.rejects(
    startRoleReviewer(await makeOptions(parentFork, "stop-reviewer", baseForkReviewer(), { SESSION_ECHO: "parent" })),
    /returned its parent session ID/u,
  );

  const omittedResume = await fixture(t);
  const resumed = await startRoleReviewer({
    ...await makeOptions(omittedResume, "stop-reviewer", baseForkReviewer(), { SESSION_ECHO: "omit" }),
    continuationSessionId: "known-session",
  });
  t.after(() => resumed.close());
  assert.equal(resumed.sessionId, "known-session");

  const unparseable = await fixture(t);
  await assert.rejects(startRoleReviewer(await makeOptions(
    unparseable, "stop-reviewer", reviewer, { MODE: "unparseable" },
  )), /raw output head: not-json/u);
  assert.equal((await fs.readFile(unparseable.capture, "utf8")).trim().split("\n").length, 1);
});

function baseForkReviewer() {
  return { effort: "low", session: "fork", timeoutMs: 2000 };
}

test("parallel CodeAgent fresh reviewers receive distinct host-allocated session IDs", async (t) => {
  const f = await fixture(t);
  const task = await ensureTask({ projectRoot: f.root, sessionId: "parent" });
  const options = {
    projectRoot: f.root,
    sessionCwd: f.root,
    taskId: task.taskId,
    parentSessionId: "parent",
    reviewer: { ...reviewer, timeoutMs: 900000 },
    schema,
    request: {},
    reviewerRuntime: { executable: process.execPath, argsPrefix: [f.entry] },
    env: { ...f.env, MODE: "valid" },
    hostAdapter: codeAgentHost,
  };
  const [first, second] = await Promise.all([
    startRoleReviewer({ ...options, role: "stop-reviewer" }),
    startRoleReviewer({ ...options, role: "artifact-reviewer" }),
  ]);
  t.after(() => Promise.allSettled([first.close(), second.close()]));
  assert.notEqual(first.sessionId, second.sessionId);
  const calls = (await fs.readFile(f.capture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.every((call) => !call.args.includes("--session-id")));
  for (const call of calls) {
    assert.ok(!call.args.includes("--resume"));
    assert.ok(!call.args.includes("--continue"));
  }
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
