import { correctionFixtureRuntime } from "./support/openclaw-project-scope.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { buildPlugin } from "../lib/plugin-builder.mjs";
let output, pluginRoot, createRuntime, findTask, readReport;
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-budget-build-"));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: output });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs"))));
  createRuntime = correctionFixtureRuntime(createRuntime);
  ({ findTask } = await import(pathToFileURL(path.join(pluginRoot, "lib/runtime-v2/task-store.mjs"))));
  ({ readReport } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/report.mjs"))));
});
after(() => fs.rm(output, { recursive: true, force: true }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function basic(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-budget-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return { projectRoot, sessionId: "host", sessionKey: "agent:main:budget", runId: "business-run",
    signal: new AbortController().signal, budgetMs: 10000 };
}
test("terminal registration returns before slow reviews and coalesces duplicate hooks", async t => {
  const params = await basic(t), manager = createNativeStopReviews();
  let finish, started = 0, markStarted;
  const ready = new Promise(resolve => { markStarted = resolve; });
  const run = async () => { started++; markStarted(); await new Promise(resolve => { finish = resolve; }); return { reviewStatus: "PASS" }; };
  const record = await manager.schedule({ ...params, run });
  assert.equal(record.status, "PENDING");
  assert.equal(started, 0);
  await manager.schedule({ ...params, run });
  await Promise.race([ready, manager.wait().then(results => {
    if (!started) assert.fail(`review settled before starting: ${JSON.stringify(results)}`);
  })]);
  assert.equal(started, 1);
  finish(); const results = await manager.wait();
  assert.equal(results[0].status, "SETTLED"); assert.equal(results[0].reviewStatus, "PASS");
  await createNativeStopReviews().schedule({ ...params, run });
  assert.equal(started, 1, "persisted terminal checkpoint must not replay model work");
});
test("two sequential native reviewer roles each retain configured time beyond a short Hook window", async t => {
  const params = await basic(t), manager = createNativeStopReviews(), timeouts = [];
  const api = { config: { agents: { defaults: { model: { primary: "test/test" } } } }, runtime: { agent: {
    runEmbeddedAgent: async input => { timeouts.push(input.runTimeoutOverrideMs); await pause(1200); return { payloads: [{ text: '{"ok":true}' }], meta: {} }; },
  } } };
  const factory = createOpenClawReviewerFactory(api, {});
  await manager.schedule({ ...params, run: async ({ deadlineAt }) => {
    for (const role of ["stop-reviewer", "implementation-reviewer"]) {
      const handle = await factory({ projectRoot: params.projectRoot, taskId: "task", role,
        reviewer: { timeoutMs: 4000 }, deadlineAt,
        schema: { type: "object", required: ["ok"], additionalProperties: false, properties: { ok: { type: "boolean" } } }, request: { instructions: ["fixture"] } });
      assert.equal(handle.result.ok, true); await handle.close();
    }
    return { reviewStatus: "PASS" };
  } });
  assert.equal((await manager.wait())[0].reviewStatus, "PASS");
  assert.equal(timeouts.length, 2); assert(timeouts.every(value => value >= 3900), JSON.stringify(timeouts));
});
test("cancellation before model admission never performs work or becomes PASS", async t => {
  const params = await basic(t), controller = new AbortController(), manager = createNativeStopReviews();
  let calls = 0;
  await manager.schedule({ ...params, signal: controller.signal, run: async () => { calls++; return { reviewStatus: "PASS" }; } });
  controller.abort("reset"); const results = await manager.wait();
  assert.equal(calls, 0); assert.equal(results[0].reviewStatus, "CANCELLED");
});
test("an abandoned durable receipt becomes unverified without replay", async t => {
  const params = await basic(t), controller = new AbortController(), manager = createNativeStopReviews();
  await manager.schedule({ ...params, signal: controller.signal, run: async () => ({ reviewStatus: "PASS" }) });
  controller.abort(); await manager.wait();
  const base = path.join(params.projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
  const record = JSON.parse(await fs.readFile(file)); record.status = "RUNNING"; await fs.writeFile(file, JSON.stringify(record));
  let calls = 0;
  const loaded = await createNativeStopReviews().schedule({ ...params, run: async () => { calls++; } });
  assert.equal(loaded.reviewStatus, "UNVERIFIED"); assert.equal(loaded.reasonCode, "REVIEW_OWNER_LOST"); assert.equal(calls, 0);
});

test("recovery retains a committed assessment without replaying uncertain continuation work", async t => {
  const params = await basic(t), manager = createNativeStopReviews();
  await manager.schedule({ ...params, run: async ({ commit }) => {
    await commit({ reviewStatus: "DEVIATION", evaluationId: "committed-evaluation" });
    throw Object.assign(new Error("Dispatch lost"), { code: "DISPATCH_UNKNOWN" });
  } });
  const [record] = await manager.wait();
  assert.equal(record.reviewStatus, "DEVIATION"); assert.equal(record.evaluationId, "committed-evaluation");
  const base = path.join(params.projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
  await fs.writeFile(file, JSON.stringify({ ...record, status: "RUNNING" }));
  const restored = await createNativeStopReviews().schedule({ ...params, run() { assert.fail("No replay after owner loss"); } });
  assert.equal(restored.reviewStatus, "DEVIATION"); assert.equal(restored.reasonCode, "REVIEW_OWNER_LOST");
  assert.equal(restored.evaluationId, "committed-evaluation");
});
async function lifecycle(t, { failures = 0, deviation = false } = {}) {
  const params = await basic(t), root = params.projectRoot;
  await fs.mkdir(path.join(root, ".runtime-corrector"));
  await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), `version: 2
artifacts:
  - name: draft
    stage: proposal
    patterns: [draft.md]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
stopCorrection:
  enabled: true
  assessmentTimeoutMs: 11000
implementationCorrection:
  enabled: false
reviewers:
  defaults:
    timeoutMs: 5000
`);
  await fs.writeFile(path.join(root, "draft.md"), "A delivered draft.\n");
  const transcript = path.join(root, "native.jsonl");
  await fs.writeFile(transcript, [{ type: "session", id: "host" }, { type: "message", id: "u", parentId: null,
    message: { role: "user", content: "Write a draft." } }].map(JSON.stringify).join("\n"));
  let calls = 0, fail = 0;
  const factory = async ({ request, schema }) => {
    calls++;
    if (fail-- > 0) throw new Error("transient checker failure");
    let result;
    if (schema.properties.operations) result = { summary: "No change", taskClassification: "CONTINUATION", operations:
      deviation && request.currentGroundTruth?.version === 0 ? [{ operation: "ADD", category: "requirements", text: "Deliver a draft with verified acceptance.",
        authority: "USER_EXPLICIT", severity: "HARD", source: { ref: request.sourceCatalog.find(s => s.kind === "USER_MESSAGE").ref,
          subject: "MAIN_TASK", kind: "USER_MESSAGE" } }] : [] };
    else {
      await pause(50);
      result = { summary: "Done", stopClassification: "TASK_COMPLETE", findings: [],
        metricObjectJudgements: Object.values(request.population?.metrics ?? {}).flat().map(object => ({
          objectId: object.objectId, judgement: deviation ? "DEVIATION" : "PASS", reason: "Current source", evidence: ["draft.md:1"] })) };
    }
    return { result, sessionId: "review", close: async () => {} };
  };
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  const warnings = [];
  const state = {}, hostAbort = new AbortController(), api = { id: "runtime-corrector", pluginConfig: { hookTimeoutMs: 2000 }, config: {}, logger: { warn(message) { warnings.push(message); } },
    runtime: { agent: { session: { getSessionEntry: async () => ({ sessionId: "host", sessionFile: transcript }),
      resolveStorePath: () => path.join(root, "sessions.json"), resolveSessionFilePath: () => transcript,
      runWithWorkAdmission: async (params, run) => run(params.signal) }, runEmbeddedAgent() {} } } };
  const runtime = createRuntime(api, { pluginRoot, sharedState: state, reviewerFactory: factory, nativeHooks: true });
  const ctx = { agentId: "main", sessionId: "host", sessionKey: params.sessionKey, runId: params.runId, workspaceDir: root, trigger: "user", abortSignal: hostAbort.signal };
  await runtime.prompt({ prompt: "Write a draft." }, ctx);
  await runtime.beforeTool({ toolName: "write", toolCallId: "w", params: { path: "draft.md" } }, ctx);
  assert(await findTask({ projectRoot: root, sessionId: "host" }), JSON.stringify(warnings));
  calls = 0; fail = failures;
  return { api, runtime, ctx, warnings, state: state.states.get("main:host"), root, hostAbort, calls: () => calls,
    restart: () => createRuntime(api, { pluginRoot, sharedState: {}, reviewerFactory: factory, nativeHooks: true }) };
}
test("native reply preserves payload and finishes RC terminal work in its independent window", async t => {
  const f = await lifecycle(t), payload = { text: "Delivered.", mediaUrl: "fixture://media" }, original = structuredClone(payload);
  assert.equal(await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload }, f.ctx), undefined);
  assert.deepEqual(payload, original); assert.equal(f.calls(), 0);
  const records = await f.runtime.waitForNativeReviews();
  assert.equal(records[0].budgetMs, 11000);
  assert.equal(records[0].reviewStatus, "PASS", JSON.stringify(records));
  assert.equal(f.hostAbort.signal.aborted, false);
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.ok(task.verification.rulesDigest, "Native Stop must retain the project policy binding");
  assert.ok(task.verification.evidence?.fingerprints[path.join(f.root, "draft.md")], "Native Stop must retain its observed source fingerprints");
  const binding = { workspaceDir: f.root, sessionId: "host", sessionKey: f.ctx.sessionKey };
  assert.equal((await readReport(binding)).verification, "PASS", "The report must recognize a fresh native acceptance");
  await fs.writeFile(path.join(f.root, "draft.md"), "Changed after review.\n");
  assert.equal((await readReport(binding)).verification, "STALE", "A later source edit must invalidate acceptance");
});
test("a fresh Gateway rediscovers modified artifacts from the active native transcript before accepting an exec-only continuation", async t => {
  const f = await lifecycle(t);
  await fs.appendFile(path.join(f.root, "native.jsonl"), "\n" + [
    { type: "message", id: "written", parentId: "u", message: { role: "assistant", content: [
      { type: "toolCall", id: "prior-write", name: "write", arguments: { path: "draft.md", content: "A delivered draft.\n" } } ] } },
    { type: "message", id: "write-result", parentId: "written", message: { role: "toolResult", toolCallId: "prior-write", toolName: "write",
      content: [{ type: "text", text: "Wrote draft.md" }], isError: false } },
  ].map(JSON.stringify).join("\n"));
  const runtime = f.restart(), ctx = { ...f.ctx, runId: "after-gateway-restart" };
  await runtime.beforeTool({ toolName: "exec", toolCallId: "check", params: { command: "validate draft.md" } }, ctx);
  await runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "Delivered." } }, ctx);
  const receipts = await runtime.waitForNativeReviews();
  assert.equal(receipts[0].reviewStatus, "PASS", JSON.stringify(receipts));
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.ok(task.verification.evidence.fingerprints[path.join(f.root, "draft.md")]);
  const binding = { workspaceDir: f.root, sessionId: "host", sessionKey: ctx.sessionKey };
  assert.equal((await readReport(binding)).verification, "PASS");
  await fs.writeFile(path.join(f.root, "draft.md"), "Changed after the restart's review.\n");
  assert.equal((await readReport(binding)).verification, "STALE");
});

test("a terminal review that cannot read its native transcript never inherits an earlier run's PASS", async t => {
  const f = await lifecycle(t);
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  assert.equal((await f.runtime.waitForNativeReviews())[0].reviewStatus, "PASS");
  const original = await findTask({ projectRoot: f.root, sessionId: "host" });
  const ctx = { ...f.ctx, runId: "unreadable-native-run" };
  await f.runtime.beforeTool({ toolName: "exec", toolCallId: "check", params: { command: "validate draft.md" } }, ctx);
  await fs.appendFile(path.join(f.root, "native.jsonl"), '\n{"torn":');
  await f.runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "Delivered." } }, ctx);
  const receipts = await f.runtime.waitForNativeReviews();
  assert.equal(receipts.find(record => record.runId === ctx.runId).reviewStatus, "UNVERIFIED");
  assert.equal(receipts.find(record => record.runId === ctx.runId).evaluationId, null);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "host" })).verification.assessmentId,
    original.verification.assessmentId, "An unavailable check cannot create or replace a verified assessment");
});
test("transient checker faults retry RC review without spending business corrections", async t => {
  const f = await lifecycle(t, { failures: 2 });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const records = await f.runtime.waitForNativeReviews();
  assert.equal(records[0].reviewStatus, "PASS", JSON.stringify(records));
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.stop.correctionAttempts, 0);
  assert.equal(task.stop.infrastructureTotalFailures, 2);
});
test("reset invalidates a queued native Stop without cancelling host settings", async t => {
  const f = await lifecycle(t);
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await f.runtime.reset({}, f.ctx);
  const records = await f.runtime.waitForNativeReviews();
  assert.equal(records[0].reviewStatus, "CANCELLED");
  assert.equal(f.hostAbort.signal.aborted, false);
});

test("ongoing review cancellation cannot return PASS or mutate host cancellation", async t => {
  const f = await lifecycle(t);
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  while (f.calls() === 0) await pause(2);
  await f.runtime.reset({}, f.ctx);
  const records = await f.runtime.waitForNativeReviews();
  assert.equal(records[0].reviewStatus, "CANCELLED");
  assert.equal(f.hostAbort.signal.aborted, false);
});
test("permanent checker faults stop at the existing infrastructure ceiling", async t => {
  const f = await lifecycle(t, { failures: 20 });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const records = await f.runtime.waitForNativeReviews();
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(records[0].reviewStatus, "UNVERIFIED");
  assert.equal(task.stop.infrastructureTotalFailures, 3);
  assert.equal(task.stop.correctionAttempts, 0);
  assert.equal(task.status, "STOPPED_UNVERIFIED");
});

test("admission refusal after one checker failure settles without reusing that failure", async t => {
  const f = await lifecycle(t, { failures: 1 });
  const admit = f.api.runtime.agent.session.runWithWorkAdmission;
  let admissions = 0;
  f.api.runtime.agent.session.runWithWorkAdmission = async (params, run) => {
    if (++admissions === 1) return admit(params, run);
    throw Object.assign(new Error("Admission closed"), { code: "GATEWAY_DRAINING" });
  };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await f.runtime.waitForNativeReviews();
  assert.equal(record.reviewStatus, "UNVERIFIED");
  assert.equal(record.reasonCode, "GATEWAY_DRAINING");
  assert.equal(admissions, 2);
  assert.equal(f.calls(), 1);
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  assert.equal(task.stop.infrastructureTotalFailures, 1);
  assert.equal(task.stop.correctionAttempts, 0);
});

test("first admission refusal cannot reuse a prior run PASS", async t => {
  const f = await lifecycle(t);
  f.state.nativeAssessment = { outcome: { decision: "allow", status: "PASS" } };
  let admissions = 0;
  f.api.runtime.agent.session.runWithWorkAdmission = async () => {
    admissions++; throw Object.assign(new Error("Forbidden"), { code: "PERMISSION_DENIED" });
  };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await f.runtime.waitForNativeReviews();
  assert.equal(record.reviewStatus, "UNVERIFIED");
  assert.equal(record.reasonCode, "PERMISSION_DENIED");
  assert.equal(admissions, 1);
  assert.equal(f.calls(), 0);
});

test("a continuation starting before admission returns cannot erase the committed previous assessment", async t => {
  const f = await lifecycle(t, { deviation: true });
  let dispatches = 0;
  f.api.runtime.subagent = { run: async args => {
    dispatches++;
    const base = path.join(f.root, ".runtime-correction/openclaw/native-stop-reviews");
    const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
    const committed = JSON.parse(await fs.readFile(file));
    assert.equal(committed.reviewStatus, "DEVIATION");
    assert(committed.evaluationId && committed.assessmentCompletedAt);
    await f.runtime.prompt({ prompt: "Write a draft." }, { ...f.ctx, runId: args.idempotencyKey });
    assert.equal(f.state.nativeAssessment, null, "The new run keeps its own empty assessment");
    return { runId: args.idempotencyKey };
  } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [record] = await f.runtime.waitForNativeReviews();
  assert.equal(dispatches, 1, JSON.stringify({ record, warnings: f.warnings, assessment: f.state.nativeAssessment }));
  assert.equal(record.reviewStatus, "DEVIATION");
  assert(record.evaluationId);
});
