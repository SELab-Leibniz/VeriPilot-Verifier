import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as reviewers from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";

const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
const baseReviewer = { effort: "low", session: "fork", timeoutMs: 2000, model: "ambient-model" };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-handoff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "agent.cjs");
  const capture = path.join(root, "capture.jsonl");
  await fs.writeFile(entry, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const requestPath = args[0].match(/Read the request at (.*)\\.\\n/)?.[1];
const request = requestPath ? JSON.parse(fs.readFileSync(requestPath, "utf8")) : {};
const frozen = {};
for (const [key, file] of Object.entries({ transcript: request.transcript?.path, groundTruth: request.groundTruthPath, skill: request.skillGroundTruthPath })) if (file) frozen[key] = JSON.parse(fs.readFileSync(file, "utf8"));
const record = { args, request, frozen, cwd: process.cwd(), role: process.env.RUNTIME_CORRECTOR_INTERNAL_ROLE, provider: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN, originExists: request.originDirectory ? fs.existsSync(request.originDirectory) : null };
fs.appendFileSync(process.env.CAPTURE, JSON.stringify(record) + "\\n");
const count = fs.readFileSync(process.env.CAPTURE, "utf8").trim().split("\\n").length;
if (request.fail) process.stdout.write("invalid output");
else if (count > 1 && process.env.REVIEW_FAILURE === "repair") process.stdout.write(JSON.stringify({ session_id: "review-session", structured_output: { ok: "invalid" } }));
else if (count > 1 && process.env.REVIEW_FAILURE === "reminder") process.stdout.write(JSON.stringify({ session_id: "review-session", result: "not-json" }));
else process.stdout.write(JSON.stringify({ session_id: process.env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID, structured_output: { ok: true } }));
`);
  const task = await ensureTask({ projectRoot: root, sessionId: "parent" });
  const env = { ...process.env, RUNTIME_CORRECTOR_AGENT_EXECUTABLE: undefined, RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: "missing-cli", CAPTURE: capture, KEY_A: "test-secret-A", KEY_B: "test-secret-B", ANTHROPIC_BASE_URL: "https://ambient.invalid", ANTHROPIC_AUTH_TOKEN: "ambient-token" };
  const options = { projectRoot: root, sessionCwd: root, taskId: task.taskId, parentSessionId: "parent", pluginRoot: root, reviewerRuntime: { executable: process.execPath, argsPrefix: [entry] }, env, schema, request: {}, reviewer: baseReviewer };
  return { root, options, capture, calls: async () => (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse) };
}

function independent(key, endpoint = key) {
  return { ...baseReviewer, session: "independent", provider: { baseUrl: `https://${endpoint}.invalid`, apiKeyEnv: key, model: `model-${key}` } };
}

test("handoff always creates target identity and selects target provider, including same-provider independent roles", async (t) => {
  for (const key of ["KEY_A", "KEY_B"]) {
    const f = await fixture(t);
    const origin = await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor", reviewer: independent("KEY_A") });
    const target = await reviewers.handoffRoleReviewer({ ...f.options, originHandle: origin, role: "stop-reviewer", reviewer: independent(key), request: { originDirectory: origin.requestDirectory } });
    t.after(() => target.close());
    assert.notEqual(target.lease.runId, origin.lease.runId);
    assert.equal(target.lease.role, "stop-reviewer");
    assert.notEqual(target.requestDirectory, origin.requestDirectory);
    const calls = await f.calls();
    assert.equal(calls.length, 2, "handoff must not repeat GT extraction");
    assert.equal(calls[1].provider, `https://${key}.invalid`);
    assert.equal(calls[1].token, key === "KEY_A" ? "test-secret-A" : "test-secret-B");
    assert.equal(calls[1].originExists, false);
    assert.ok(!calls[1].args.includes("--resume"));
    assert.equal(calls[1].args[calls[1].args.indexOf("--model") + 1], `model-${key}`);
    await assert.rejects(origin.followUp({ prompt: "must not run" }), /closed/i);
    const request = await fs.readFile(path.join(target.requestDirectory, "request.json"), "utf8");
    assert.ok(!request.includes("test-secret"));
    const journal = await fs.readFile(path.join(f.root, ".runtime-correction", "tasks", f.options.taskId, "journal", "events.jsonl"), "utf8");
    assert.ok(!journal.includes("test-secret"));
  }
});

test("compatible ambient fork resumes source session without re-forking, with target model and frozen evidence", async (t) => {
  const f = await fixture(t);
  const origin = await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor" });
  const snapshot = { entries: [{ type: "user", message: { content: "frozen user input" } }], digest: "source-digest", lastEntryKey: "cursor-1" };
  const groundTruth = { version: 7, claims: [{ text: "frozen requirement" }] };
  const target = await reviewers.handoffRoleReviewer({ ...f.options, originHandle: origin, role: "skill-reviewer", reviewer: { ...baseReviewer, model: "target-model" }, request: { groundTruthPath: "/mutable/current.json", skillGroundTruthPath: "/mutable/skill.json" }, evidence: { snapshot, groundTruth, skillGroundTruth: { constraints: ["must test"] }, population: { objects: [] } } });
  t.after(() => target.close());
  snapshot.entries[0].message.content = "changed later";
  groundTruth.claims[0].text = "changed later";
  const call = (await f.calls())[1];
  assert.equal(call.args[call.args.indexOf("--resume") + 1], origin.sessionId);
  assert.ok(call.args.includes("--no-session-persistence"));
  assert.ok(!call.args.includes("--fork-session"));
  assert.equal(call.args[call.args.indexOf("--model") + 1], "target-model");
  assert.equal(call.request.transcript.digest, "source-digest");
  assert.equal(call.request.transcript.cursor, "cursor-1");
  assert.deepEqual(call.frozen.transcript.entries[0].message.content, "frozen user input");
  assert.equal(call.frozen.groundTruth.claims[0].text, "frozen requirement");
  assert.ok(call.request.groundTruthPath.startsWith(target.requestDirectory));
  await origin.close(); await origin.close();
  assert.equal(JSON.parse(await fs.readFile(call.request.groundTruthPath, "utf8")).version, 7);
});

test("non-ambient source and missing target key fork original parent using original ambient environment", async (t) => {
  const f = await fixture(t);
  const origin = await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor", reviewer: independent("KEY_A") });
  const target = await reviewers.handoffRoleReviewer({ ...f.options, originHandle: origin, role: "stop-reviewer", reviewer: independent("MISSING_KEY") });
  t.after(() => target.close());
  const call = (await f.calls())[1];
  assert.equal(call.args[call.args.indexOf("--resume") + 1], "parent");
  assert.ok(call.args.includes("--fork-session"));
  assert.equal(call.provider, "https://ambient.invalid");
  assert.equal(call.token, "ambient-token");
  assert.deepEqual(target.providerDegradation, {
    reason: "PROVIDER_API_KEY_UNSET", apiKeyEnv: "MISSING_KEY",
  });
});

test("incompatible runtime, owner, cwd, parent, or plugin cannot resume source reviewer session", async (t) => {
  for (const field of ["reviewerRuntime", "projectRoot", "taskId", "sessionCwd", "parentSessionId", "pluginRoot"]) {
    const f = await fixture(t);
    const origin = await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor" });
    const elsewhere = path.join(f.root, "elsewhere");
    await fs.mkdir(elsewhere);
    const override = field === "reviewerRuntime" ? { ...f.options.reviewerRuntime, argsPrefix: [...f.options.reviewerRuntime.argsPrefix, "--different"] } : elsewhere;
    let captured;
    const target = await reviewers.handoffRoleReviewer({ ...f.options, [field]: override, originHandle: origin, role: "stop-reviewer", reviewerFactory: async (options) => { captured = options; return { close: async () => {} }; } });
    await target.close();
    assert.equal(captured.continuationSessionId ?? null, null, field);
    await assert.rejects(fs.access(origin.requestDirectory));
  }
});

test("handoff preparation and parsing failures clean source and target owned resources", async (t) => {
  for (const failure of ["prepare", "parse", "spawn"]) {
    const f = await fixture(t);
    const origin = await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor" });
    const evidence = failure === "prepare" ? { groundTruth: { bad: 1n } } : {};
    await assert.rejects(reviewers.handoffRoleReviewer({ ...f.options, originHandle: origin, role: "stop-reviewer", evidence, request: { fail: failure === "parse" }, ...(failure === "spawn" ? { reviewerRuntime: { executable: path.join(f.root, "missing") } } : {}) }));
    assert.deepEqual(await fs.readdir(path.join(f.root, ".runtime-correction", ".internal-requests")), []);
    assert.deepEqual(await fs.readdir(path.join(f.root, ".runtime-correction", "internal-runs")), []);
  }
});

test("detached targets start fresh with ambient credentials and retain target identity", async (t) => {
  const f = await fixture(t);
  const origin = await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor", reviewer: independent("KEY_A") });
  const target = await reviewers.handoffRoleReviewer({ ...f.options, originHandle: origin, role: "stop-reviewer", reviewer: { ...baseReviewer, session: "detached" } });
  t.after(() => target.close());
  const call = (await f.calls())[1];
  assert.equal(call.role, "stop-reviewer");
  assert.equal(call.provider, "https://ambient.invalid");
  assert.equal(call.token, "ambient-token");
  assert.ok(!call.args.includes("--resume"));
  assert.ok(!call.args.includes("--fork-session"));
});

test("handoff retains the source absolute deadline and passes resolved plans to its factory", async (t) => {
  const f = await fixture(t);
  const deadlineAt = Date.now() + 30_000;
  const origin = await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor", deadlineAt });
  let captured;
  await reviewers.handoffRoleReviewer({
    ...f.options, originHandle: origin, role: "stop-reviewer", deadlineAt: deadlineAt + 30_000,
    reviewerFactory: async (options) => { captured = options; return { close: async () => {} }; },
  });
  assert.equal(captured.deadlineAt, deadlineAt);
  assert.equal(captured.continuationSessionId, origin.sessionId);
  assert.deepEqual(captured.resolvedLaunchPlan, f.options.reviewerRuntime);
  assert.equal(captured.resolvedSessionPlan.session, "fork");
  await assert.rejects(fs.access(origin.requestDirectory), { code: "ENOENT" });
});

test("handoff snapshots requests, evidence, and reviewer settings before resolver awaits", async (t) => {
  const f = await fixture(t);
  const request = { message: "original" };
  const evidence = { groundTruth: { claims: [{ text: "original" }] } };
  const reviewer = independent("KEY_A");
  const pending = reviewers.handoffRoleReviewer({ ...f.options, role: "stop-reviewer", request, evidence, reviewer });
  request.message = "mutated";
  evidence.groundTruth.claims[0].text = "mutated";
  reviewer.provider.model = "mutated-model";
  reviewer.provider.baseUrl = "https://mutated.invalid";
  const target = await pending;
  t.after(() => target.close());
  const call = (await f.calls())[0];
  assert.equal(call.request.message, "original");
  assert.equal(call.frozen.groundTruth.claims[0].text, "original");
  assert.equal(call.provider, "https://KEY_A.invalid");
  assert.equal(call.args[call.args.indexOf("--model") + 1], "model-KEY_A");
});

test("direct startup callback failure releases all resources without launching", async (t) => {
  const f = await fixture(t);
  const failure = new Error("prepared callback failed");
  await assert.rejects(reviewers.startRoleReviewer({
    ...f.options, role: "stop-reviewer", evidence: { groundTruth: { version: 4 } },
    onPrepared: async ({ requestDirectory }) => {
      assert.equal(JSON.parse(await fs.readFile(path.join(requestDirectory, "ground-truth.json"), "utf8")).version, 4);
      throw failure;
    },
  }), (error) => error === failure);
  await assert.rejects(fs.access(f.capture), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(f.root, ".runtime-correction", ".internal-requests")), []);
  assert.deepEqual(await fs.readdir(path.join(f.root, ".runtime-correction", "internal-runs")), []);
});

test("failed same-role follow-up repair or reminder closes its lease and request", async (t) => {
  for (const failure of ["repair", "reminder"]) {
    const f = await fixture(t);
    const handle = await reviewers.startRoleReviewer({ ...f.options, env: { ...f.options.env, REVIEW_FAILURE: failure }, role: "stop-reviewer" });
    await assert.rejects(handle.followUp({ prompt: "Continue this assessment." }));
    const calls = await f.calls();
    assert.equal(calls.length, 3);
    assert.equal(calls[1].args[calls[1].args.indexOf("--resume") + 1], handle.sessionId);
    await assert.rejects(fs.access(handle.requestDirectory), { code: "ENOENT" });
    await assert.rejects(fs.access(handle.lease.filePath), { code: "ENOENT" });
    await handle.close();
    await assert.rejects(handle.followUp({ prompt: "Must not launch." }), /closed/i);
    assert.equal((await f.calls()).length, 3);
  }
});

test("source cleanup failure cannot replace the original target preparation or factory failure", async (t) => {
  const f = await fixture(t);
  for (const badEvidence of [true, false]) {
    let closes = 0;
    const failure = new Error("target failed");
    const originHandle = { close: async () => { closes += 1; throw new Error("cleanup failed"); } };
    await assert.rejects(reviewers.handoffRoleReviewer({
      ...f.options, role: "stop-reviewer", originHandle,
      evidence: badEvidence ? { groundTruth: { revision: 1n } } : null,
      reviewerFactory: async () => { throw failure; },
    }), (error) => badEvidence ? error instanceof TypeError : error === failure);
    assert.equal(closes, 1);
  }
});

test("a fork-configured source with no parent session cannot provide ambient fork provenance", async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, parentSessionId: null };
  const origin = await reviewers.startRoleReviewer({ ...options, role: "ground-truth-extractor" });
  let captured;
  await reviewers.handoffRoleReviewer({
    ...options, originHandle: origin, role: "stop-reviewer",
    reviewerFactory: async (value) => { captured = value; return { close: async () => {} }; },
  });
  assert.equal(captured.continuationSessionId, null);
});

test("startup and handoff reject unknown runtime keys even when their values are undefined or an environment override is set", async (t) => {
  for (const handoff of [false, true]) {
    for (const override of [false, true]) {
      const f = await fixture(t);
      const origin = handoff ? await reviewers.startRoleReviewer({ ...f.options, role: "ground-truth-extractor" }) : null;
      const options = {
        ...f.options,
        role: "stop-reviewer",
        reviewerRuntime: { ...f.options.reviewerRuntime, unknown: undefined },
        env: { ...f.options.env, ...(override ? { RUNTIME_CORRECTOR_AGENT_EXECUTABLE: process.execPath } : {}) },
      };
      await assert.rejects(handoff
        ? reviewers.handoffRoleReviewer({ ...options, originHandle: origin })
        : reviewers.startRoleReviewer(options), /reviewerRuntime only accepts/u);
      if (origin) {
        await assert.rejects(fs.access(origin.requestDirectory), { code: "ENOENT" });
        assert.equal((await f.calls()).length, 1);
      } else {
        await assert.rejects(fs.access(f.capture), { code: "ENOENT" });
      }
    }
  }
});

test("ambient follow-ups preserve their requested model while independent follow-ups retain the provider model", async (t) => {
  for (const reviewer of [baseReviewer, independent("KEY_A")]) {
    const f = await fixture(t);
    const handle = await reviewers.startRoleReviewer({ ...f.options, role: "stop-reviewer", reviewer });
    t.after(() => handle.close());
    await handle.followUp({ prompt: "Continue.", nextReviewer: { ...baseReviewer, model: "followup-model" } });
    const call = (await f.calls())[1];
    assert.equal(call.args[call.args.indexOf("--model") + 1], reviewer.session === "independent" ? "model-KEY_A" : "followup-model");
    assert.equal(call.provider, reviewer.session === "independent" ? "https://KEY_A.invalid" : "https://ambient.invalid");
  }
});
