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
async function lifecycle(t, { failures = 0, deviation = false, review, compatibility, waitMode = "assessment", waitTimeoutMs, hookTimeoutMs = 2000 } = {}) {
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
  waitMode: ${waitMode}
${waitTimeoutMs ? `  waitTimeoutMs: ${waitTimeoutMs}\n` : ""}  assessmentTimeoutMs: 11000
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
      const verdict = await review?.();
      await pause(50);
      result = { summary: "Done", stopClassification: "TASK_COMPLETE", findings: [],
        metricObjectJudgements: Object.values(request.population?.metrics ?? {}).flat().map(object => ({
          objectId: object.objectId, judgement: (verdict ?? deviation) ? "DEVIATION" : "PASS", reason: "Current source", evidence: ["draft.md:1"] })) };
    }
    return { result, sessionId: "review", close: async () => {} };
  };
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  const warnings = [];
  const state = {}, hostAbort = new AbortController(), api = { id: "runtime-corrector", pluginConfig: { hookTimeoutMs }, config: {}, logger: { warn(message) { warnings.push(message); } },
    runtime: { agent: { session: { getSessionEntry: async () => ({ sessionId: "host", sessionFile: transcript }),
      resolveStorePath: () => path.join(root, "sessions.json"), resolveSessionFilePath: () => transcript,
      runWithWorkAdmission: async (params, run) => run(params.signal) }, runEmbeddedAgent() {} } } };
  const runtime = createRuntime(api, { pluginRoot, sharedState: state, reviewerFactory: factory, nativeHooks: true, compatibility });
  const ctx = { agentId: "main", sessionId: "host", sessionKey: params.sessionKey, runId: params.runId, workspaceDir: root, trigger: "user", abortSignal: hostAbort.signal };
  await runtime.prompt({ prompt: "Write a draft." }, ctx);
  await runtime.beforeTool({ toolName: "write", toolCallId: "w", params: { path: "draft.md" } }, ctx);
  assert(await findTask({ projectRoot: root, sessionId: "host" }), JSON.stringify(warnings));
  calls = 0; fail = failures;
  return { api, runtime, ctx, warnings, state: state.states.get("main:host"), root, hostAbort, calls: () => calls,
    chain: () => [...state.stopWaitChains.values()].at(-1),
    restart: () => createRuntime(api, { pluginRoot, sharedState: {}, reviewerFactory: factory, nativeHooks: true }) };
}
test("native reply preserves payload and finishes RC terminal work in its independent window", async t => {
  const f = await lifecycle(t), payload = { text: "Delivered.", mediaUrl: "fixture://media" }, original = structuredClone(payload);
  const response = await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload }, f.ctx);
  assert.equal(response.payload.mediaUrl, original.mediaUrl);
  assert(response.payload.text.startsWith(original.text));
  assert.match(response.payload.text, /RC 正在验收/u);
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
    await f.runtime.beforeModelResolve({}, { ...f.ctx, runId: args.idempotencyKey });
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

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("a queued business turn waits before replacing the old run, while UI status never enters model history", async t => {
  const started = deferred(), finish = deferred(), events = [];
  const f = await lifecycle(t, { review: async () => { started.resolve(); await finish.promise; },
    compatibility: async () => ({ emitAgentEvent: event => events.push(event) }) });
  const source = path.join(f.root, "native.jsonl"), original = await fs.readFile(source, "utf8");
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Original delivery." } }, f.ctx);
  await started.promise;
  const oldController = f.state.reviewController;
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  const prompt = f.runtime.prompt({ prompt: "Next business task" }, { ...f.ctx, runId: "next-run" });
  await pause(30);
  assert.equal(passed, false);
  assert.equal(f.state.nativeRunId, f.ctx.runId);
  assert.equal(oldController.signal.aborted, false);
  assert(events.some(event => event.stream === "tool" && event.runId === "next-run"
    && event.data.partialResult?.views[0].text.includes("后续任务暂缓")));
  assert(!events.some(event => event.stream === "assistant"));
  finish.resolve();
  await Promise.all([next, prompt]);
  const [record] = await f.runtime.waitForNativeReviews();
  assert.equal(record.reviewStatus, "PASS");
  assert.equal(f.state.nativeRunId, "next-run");
  assert.equal(await fs.readFile(source, "utf8"), original, "status is UI-only, not a host user/assistant message");
});

test("Stop deadline releases a hung backend and ignores its late PASS/commit even when cancellation cleanup hangs", async t => {
  const params = await basic(t), manager = createNativeStopReviews(), started = deferred(), finish = deferred();
  let commit, reviewSignal;
  await manager.schedule({ ...params, budgetMs: 100, onCancel: () => new Promise(() => {}),
    run: async input => { commit = input.commit; reviewSignal = input.signal; started.resolve(); await finish.promise; return { reviewStatus: "PASS" }; } });
  await started.promise;
  const [job] = manager.pending(params);
  const result = await job.released;
  assert.equal(result.reviewStatus, "UNVERIFIED");
  assert.equal(result.reasonCode, "REVIEW_DEADLINE_EXPIRED");
  assert.equal(reviewSignal.aborted, true);
  assert.equal(manager.pending(params).length, 0);
  await assert.rejects(commit({ reviewStatus: "PASS" }), { code: "RC_STOP_REVIEW_STALE" });
  finish.resolve();
  assert.equal((await manager.wait())[0].reviewStatus, "UNVERIFIED");
  await pause(10);
  const base = path.join(params.projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const sub = (await fs.readdir(base))[0], file = path.join(base, sub, (await fs.readdir(path.join(base, sub)))[0]);
  assert.equal(JSON.parse(await fs.readFile(file)).reviewStatus, "UNVERIFIED");
});

test("reset releases waiting tasks immediately and another session is never held by the gate", async t => {
  const started = deferred(), finish = deferred();
  const f = await lifecycle(t, { review: async () => { started.resolve(); await finish.promise; } });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await started.promise;
  await f.runtime.beforeDispatch({ sessionKey: "agent:main:another-session" }, {});
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  await pause(10);
  assert.equal(passed, false);
  await f.runtime.reset({}, f.ctx);
  await next;
  assert.equal((await f.runtime.waitForNativeReviews())[0].reviewStatus, "CANCELLED");
  assert.equal(f.hostAbort.signal.aborted, false);
  finish.resolve();
  await f.runtime.waitForNativeReviews({ drain: true });
});

test("a cancelled incoming task does not replace or cancel the pending review", async t => {
  const started = deferred(), finish = deferred();
  const f = await lifecycle(t, { review: async () => { started.resolve(); await finish.promise; } });
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await started.promise;
  const abort = new AbortController();
  const next = f.runtime.prompt({}, { ...f.ctx, runId: "cancelled-next", abortSignal: abort.signal });
  await pause(10); abort.abort(); await next;
  assert.equal(f.state.nativeRunId, f.ctx.runId);
  assert.equal(f.state.reviewController.signal.aborted, false);
  finish.resolve();
  assert.equal((await f.runtime.waitForNativeReviews())[0].reviewStatus, "PASS");
});

test("incoming model admission releases at its Hook budget and fences an uncooperative review", async t => {
  const started = deferred(), finish = deferred(), events = [];
  const f = await lifecycle(t, { review: async () => { started.resolve(); await finish.promise; },
    compatibility: async () => ({ emitAgentEvent: event => events.push(event) }) });
  f.api.config.plugins = { entries: { "runtime-corrector": { hooks: { timeouts: { before_model_resolve: 1100 } } } } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await started.promise;
  await f.runtime.beforeModelResolve({}, { ...f.ctx, runId: "next-after-expiry" });
  assert.equal((await f.runtime.waitForNativeReviews())[0].reviewStatus, "UNVERIFIED");
  assert(events.some(event => event.runId === "next-after-expiry" && event.data.meta?.includes("RC 验收超时")));
  assert(!events.some(event => event.stream === "assistant"));
  finish.resolve();
  await f.runtime.waitForNativeReviews({ drain: true });
  const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.notEqual(task.verification?.status, "PASS");
});

test("new business waits for the deviation feedback admission receipt, not only the assessment", async t => {
  const admitted = deferred(), dispatching = deferred();
  const f = await lifecycle(t, { deviation: true });
  f.api.runtime.subagent = { run: async args => {
    dispatching.resolve(); await admitted.promise;
    return { runId: args.idempotencyKey };
  } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await dispatching.promise;
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  await pause(30);
  assert.equal(passed, false, "committing an assessment must not release a pending dispatch");
  admitted.resolve(); await next;
  const [record] = await f.runtime.waitForNativeReviews();
  assert.equal(record.reviewStatus, "DEVIATION");
  assert.equal(record.followupStatus, "ADMITTED");
});

test("a crashed review releases admission as UNVERIFIED without waiting for its deadline", async t => {
  const params = await basic(t), manager = createNativeStopReviews();
  await manager.schedule({ ...params, run: async () => { throw Object.assign(new Error("Checker unavailable"), { code: "CHECKER_DOWN" }); } });
  const [record] = await manager.wait();
  assert.equal(record.reviewStatus, "UNVERIFIED");
  assert.equal(record.reasonCode, "CHECKER_DOWN");
  assert.equal(manager.pending(params).length, 0);
});

test("until_pass holds the next task during correction execution and recheck, then releases only the new PASS", async t => {
  const rechecking = deferred(), finish = deferred();
  let reviews = 0, childRunId;
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass", hookTimeoutMs: 20000, waitTimeoutMs: 20000, review: async () => {
    if (++reviews === 1) return true;
    rechecking.resolve(); await finish.promise; return false;
  } });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  assert.equal((await f.runtime.waitForNativeReviews())[0].reviewStatus, "DEVIATION");
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  const child = { ...f.ctx, runId: childRunId };
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  await pause(20);
  assert.equal(passed, false, "feedback admission and active correction are not a PASS");
  assert.equal(f.chain().record.phase, "CORRECTING");
  await f.runtime.agentEnd({ runId: childRunId, success: true,
    messages: [{ role: "assistant", content: "Corrected delivery." }] }, child);
  await rechecking.promise;
  assert.equal(passed, false, JSON.stringify({ chain: f.chain().record, warnings: f.warnings }));
  assert.equal(f.chain().record.phase, "REVIEWING");
  finish.resolve(); await next;
  assert.equal(f.chain().record.reviewStatus, "PASS");
  assert.equal(f.chain().record.runId, childRunId);
  const records = await f.runtime.waitForNativeReviews({ drain: true });
  assert.equal(records.find(record => record.runId === childRunId).reviewStatus, "PASS");
  assert.equal(f.hostAbort.signal.aborted, false);
});

test("until_pass deadline releases a correction with no active reviewer and reports non-PASS", async t => {
  let childRunId;
  const events = [], f = await lifecycle(t, { deviation: true, waitMode: "until_pass", waitTimeoutMs: 20000,
    compatibility: async () => ({ emitAgentEvent: event => events.push(event) }) });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await f.runtime.waitForNativeReviews();
  assert(childRunId);
  await f.runtime.prompt({ prompt: "RC feedback" }, { ...f.ctx, runId: childRunId });
  f.api.config.plugins = { entries: { "runtime-corrector": { hooks: { timeouts: { reply_dispatch: 1100 } } } } };
  await f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {});
  assert.equal(f.chain().record.reviewStatus, "UNVERIFIED");
  assert.equal(f.chain().record.reasonCode, "STOP_WAIT_DEADLINE_EXPIRED");
  await pause(10);
  assert.equal(events.length, 0, "no live dispatch run exists yet; never renew a finished correction run");
  assert.equal(f.hostAbort.signal.aborted, false);
  await f.runtime.agentEnd({ runId: childRunId, success: true, messages: [] }, { ...f.ctx, runId: childRunId });
  assert.equal((await f.runtime.waitForNativeReviews()).length, 1, "a timed-out child cannot restart the same wait chain");
});

test("reset during correction releases until_pass even after the original review has settled", async t => {
  let childRunId;
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass" });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await f.runtime.waitForNativeReviews();
  const child = { ...f.ctx, runId: childRunId };
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  let passed = false;
  const next = f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {}).then(() => { passed = true; });
  await pause(20); assert.equal(passed, false);
  await f.runtime.reset({}, child); await next;
  assert.equal(f.chain().record.reviewStatus, "CANCELLED");
  assert.equal(f.hostAbort.signal.aborted, false);
});

test("late correction tools after wait expiry cannot replace or cancel the next business review", async t => {
  let childRunId, reviews = 0;
  const started = deferred(), finish = deferred();
  const f = await lifecycle(t, { deviation: true, waitMode: "until_pass", waitTimeoutMs: 20000, hookTimeoutMs: 20000, review: async () => {
    if (++reviews === 1) return true;
    started.resolve(); await finish.promise; return false;
  } });
  f.api.runtime.subagent = { run: async args => { childRunId = args.idempotencyKey; return { runId: childRunId }; } };
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  await f.runtime.waitForNativeReviews();
  const child = { ...f.ctx, runId: childRunId };
  await f.runtime.prompt({ prompt: "RC feedback" }, child);
  f.chain().expire();
  await f.runtime.beforeDispatch({ sessionKey: f.ctx.sessionKey }, {});
  const next = { ...f.ctx, runId: "new-business" };
  await f.runtime.prompt({ prompt: "Next task" }, next);
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "new-write", params: { path: "draft.md" } }, next);
  await f.runtime.reply({ kind: "final", runId: next.runId, sessionKey: next.sessionKey, payload: { text: "New delivery." } }, next);
  await started.promise;
  const controller = f.state.reviewController;
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "late-child-write", params: { path: "draft.md" } }, child);
  assert.equal(f.state.nativeRunId, next.runId);
  assert.equal(f.state.reviewController, controller);
  assert.equal(controller.signal.aborted, false);
  finish.resolve();
  const records = await f.runtime.waitForNativeReviews({ drain: true });
  assert.equal(records.find(record => record.runId === next.runId).reviewStatus, "PASS");
});
