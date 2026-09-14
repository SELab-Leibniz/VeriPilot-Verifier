import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import test, { before, after } from "node:test";
import { buildPlugin } from "../lib/plugin-builder.mjs";
import { normalizeMessages, readOpenClawTranscript, persistTranscript } from "../lib/openclaw/transcript.mjs";
import { workerIdentityPath, privateJson } from "../lib/openclaw/controller-store.mjs";
import { changedFiles, selectedSkillRead } from "../lib/openclaw/tools.mjs";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { ensureTask, findTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let output, pluginRoot, entry, createRuntime;
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-test-"));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: root, outputRoot: output });
  entry = (await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/entry.mjs")))).default;
  createRuntime = (await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs")))).createOpenClawRuntime;
});
after(async () => { await fs.rm(output, { recursive: true, force: true }); });
async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function api(projectRoot, runner = async () => ({ payloads: [{ text: '{"ok":true}' }], meta: {} })) {
  const hooks = new Map(), warnings = [];
  const value = { id: "runtime-corrector", rootDir: pluginRoot, hooks, warnings, config: {}, pluginConfig: {},
    runtime: { version: "2026.7.1-2", agent: { runEmbeddedAgent: runner, resolveAgentWorkspaceDir: () => projectRoot } },
    logger: { info() {}, warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
    on: (name, handler, options) => hooks.set(name, { handler, options }),
    registerAgentToolResultMiddleware: (handler, options) => { value.middleware = { handler, options }; },
    registerTool: (factory) => { value.toolFactory = factory; } };
  value.registerAgentHarness = (harness) => { value.harness = harness; };
  return value;
}
const objectSchema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

test("OpenClaw artifact loads the native entry, retains skills and rejects another runtime", async (t) => {
  const project = await workspace(t);
  const host = api(project);
  entry.register(host);
  assert.equal(host.hooks.get("before_agent_finalize").options.timeoutMs, 540000);
  assert.equal(host.middleware.options.runtimes[0], "openclaw");
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, "openclaw.plugin.json")));
  const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json")));
  assert.equal(manifest.id, "runtime-corrector");
  assert.equal(pkg.peerDependencies.openclaw, "2026.7.1-2");
  assert.equal(pkg.openclaw.compat.pluginApi, "2026.7.1");
  for (const item of ["hooks/hooks.json", ".claude-plugin", ".cac-plugin", "lib/hosts/claude.mjs", "lib/hosts/codeagent.mjs"]) {
    await assert.rejects(fs.access(path.join(pluginRoot, item)));
  }
  for (const skill of ["runtime-corrector-init", "runtime-corrector-control", "runtime-corrector-workflow", "semantic-review"]) {
    const text = await fs.readFile(path.join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT|CODEAGENT3_PLUGIN_ROOT/u);
  }
  host.runtime.version = "2026.7.1";
  assert.throws(() => entry.register(host), /requires OpenClaw 2026\.7\.1-2/u);
  host.runtime.version = "2026.8.1";
  assert.throws(() => entry.register(host), /requires OpenClaw/u);
  const tool = host.toolFactory({ workspaceDir: project });
  const help = await tool.execute("help", { command: "help" });
  assert.match(help.content[0].text, /Runtime Corrector|runtime-corrector/u);
  assert.equal(host.toolFactory({ workspaceDir: project, sandboxed: true }), null);
  await assert.rejects(tool.execute("toggle", { command: "stage", subject: "requirements" }), /explicit enabled/u);
  const controls = await fs.readFile(path.join(pluginRoot, "skills/runtime-corrector-control/SKILL.md"), "utf8");
  assert.match(controls, /"enabled":false/u);
  assert.match(controls, /"format":"json"/u);
});

test("native entry supports synchronous ESM loading on the target Node runtime", { skip: Number(process.versions.node.split(".")[0]) < 22 }, () => {
  const loaded = createRequire(import.meta.url)(path.join(pluginRoot, "lib/openclaw/entry.mjs"));
  assert.equal(loaded.default.id, "runtime-corrector");
});

test("OpenClaw validates incompatible CLI reviewer settings before starting work", async (t) => {
  const project = await workspace(t);
  await fs.mkdir(path.join(project, ".runtime-corrector"));
  await fs.writeFile(path.join(project, ".runtime-corrector/config.yaml"),
    "version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\nstopCorrection:\n  enabled: true\nreviewerRuntime:\n  executable: codeagentcli\n  argsPrefix: []\n");
  const host = api(project, () => assert.fail("must not launch a native worker"));
  const runtime = createRuntime(host, { pluginRoot });
  await assert.rejects(runtime.beginSupervised({ sessionId: "invalid", workspaceDir: project }, new AbortController().signal),
    { code: "OPENCLAW_REVIEWER_CONFIG" });
  const { loadConfig } = await import(pathToFileURL(path.join(pluginRoot, "lib/runtime-corrector.mjs")));
  await assert.rejects(loadConfig({ cwd: project, pluginRoot }), /Remove the entire reviewerRuntime block/u);
});

test("transcripts preserve real users, tool pairing and only the active native branch", async (t) => {
  const project = await workspace(t);
  const records = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Implement the task" } },
    { type: "message", id: "old", parentId: "u1", message: { role: "user", content: "Abandoned branch" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "a.js" } }] } },
    { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "OK" }] } },
  ];
  const file = path.join(project, "native.jsonl");
  await fs.writeFile(file, records.map(JSON.stringify).join("\n") + '\n{"partial":');
  const entries = await readOpenClawTranscript(file);
  assert.deepEqual(entries.map((item) => item.uuid), ["u1", "a1", "t1"]);
  assert.equal(entries[1].message.content[0].type, "tool_use");
  assert.equal(entries[2].isMeta, true);
  assert.equal(entries[2].message.content[0].tool_use_id, "call");
  assert.equal(normalizeMessages([{ role: "user", content: "internal", provenance: { kind: "inter_session" } }])[0].isMeta, true);
  const state = { projectRoot: project, sessionId: "s", entries: [] };
  await persistTranscript(state, { messages: [], prompt: "Implement a.js", realUser: true, runId: "run" });
  await persistTranscript(state, { messages: [], prompt: "[runtime-corrector:feedback] Fix", realUser: false, runId: "run" });
  assert.equal(state.entries.length, 1);
  assert.match(await fs.readFile(state.transcriptPath, "utf8"), /Implement a.js/u);
});

test("native snapshots and restarts preserve source ids, including repeated user text", async (t) => {
  const project = await workspace(t);
  let state = { projectRoot: project, agentId: "main", sessionId: "s", entries: [] };
  await persistTranscript(state, { messages: [], prompt: "Do it", realUser: true, runId: "one" });
  const firstId = state.entries[0].uuid;
  const native = [{ id: "native-1", message: { role: "user", content: "Do it", timestamp: 1 } }];
  await persistTranscript(state, { messages: native, prompt: "Do it", realUser: true, runId: "two" });
  const secondId = state.entries[1].uuid;
  assert.notEqual(firstId, secondId);
  native.push({ id: "native-2", message: { role: "user", content: "Do it", timestamp: 2 } });
  state = { projectRoot: project, agentId: "main", sessionId: "s", entries: [] };
  await persistTranscript(state, { messages: native });
  assert.deepEqual(state.entries.map((item) => item.uuid), [firstId, secondId]);
  await persistTranscript(state, { messages: native.slice(1) });
  assert.equal(state.entries[0].uuid, secondId);
});

test("patch tool mapping includes all affected files and rejects paths outside the workspace", () => {
  const cwd = path.resolve(os.tmpdir(), "tool-project");
  const patch = "*** Begin Patch\n*** Update File: a.js\n@@\n-x\n+y\n*** Move to: b.js\n*** Add File: c.js\n+c\n*** Delete File: ../outside.js\n*** End Patch";
  assert.deepEqual(changedFiles("functions.apply_patch", { input: patch }, cwd), ["a.js", "b.js", "c.js"].map((name) => path.join(cwd, name)));
  assert.deepEqual(changedFiles("write", { path: "../outside.js" }, cwd), []);
  assert.deepEqual(changedFiles("write", { path: ".runtime-correction/private.json" }, cwd), []);
  assert.deepEqual(changedFiles("write", { path: "a.js" }, cwd, path.join(cwd, "src")), [path.join(cwd, "src/a.js")]);
});

test("Skill boundaries require an actual read inside a discovered skill root", async (t) => {
  const project = await workspace(t);
  await fs.mkdir(path.join(project, "skills/example"), { recursive: true });
  await fs.writeFile(path.join(project, "skills/example/SKILL.md"), "# Example");
  await fs.writeFile(path.join(project, "SKILL.md"), "# Unregistered");
  assert.equal(await selectedSkillRead("read", { path: "skills/example/SKILL.md" }, { projectRoot: project }, pluginRoot), "example");
  assert.equal(await selectedSkillRead("read", { path: "SKILL.md" }, { projectRoot: project }, pluginRoot), null);
});

test("native reviewers own read-only sessions, repair JSON, and transfer frozen evidence before cleanup", async (t) => {
  const project = await workspace(t);
  const task = await ensureTask({ projectRoot: project, sessionId: "parent" });
  const calls = [];
  const registry = new Set();
  const host = api(project, async (params) => {
    calls.push(params);
    assert.equal(registry.has(params.sessionId), true);
    assert.deepEqual(params.toolsAllow, ["read"]);
    assert.equal(params.disableMessageTool, true);
    return { payloads: [{ text: calls.length === 1 ? '{"ok":"invalid"}' : '{"ok":true}' }], meta: { agentMeta: { usage: { input: 12, output: 4 } } } };
  });
  const factory = createOpenClawReviewerFactory(host, { provider: "test", model: "test-model", internalSessions: registry });
  const input = { projectRoot: project, sessionCwd: project, taskId: task.taskId, parentSessionId: "parent", role: "ground-truth-extractor",
    reviewer: { timeoutMs: 5000, session: "fork" }, request: { requirement: "Frozen task" }, schema: objectSchema,
    evidence: { snapshot: { entries: [{ type: "user", message: { content: "Frozen evidence" } }] } } };
  const first = await factory(input);
  assert.deepEqual(first.result, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, calls[1].sessionId);
  assert.notEqual(first.sessionId, "parent");
  await first.followUp({ prompt: "Check once more." });
  const second = await factory.handoff({ ...input, originHandle: first, role: "stop-reviewer",
    onPrepared: async (prepared) => {
      await fs.access(prepared.request.transcript.path);
      await assert.rejects(fs.access(first.requestDirectory));
    } });
  assert.notEqual(first.sessionId, second.sessionId);
  await assert.rejects(first.followUp({ prompt: "closed" }), /closed/u);
  await second.close();
  assert.equal(registry.size, 0);
  await assert.rejects(fs.access(second.requestDirectory));
  assert.equal(calls[0].config.models, undefined);
});

test("native independent provider is per run and secrets are absent from evidence and journal", async (t) => {
  const project = await workspace(t);
  const task = await ensureTask({ projectRoot: project, sessionId: "parent" });
  const secret = "test-private-api-key-value";
  const originalConfig = { models: { providers: { parent: { apiKey: "parent-secret" } } } };
  const host = api(project, async (params) => {
    assert.equal(params.provider, "runtime-corrector-independent");
    assert.equal(params.config.models.providers[params.provider].apiKey, secret);
    assert.equal(params.config.models.providers[params.provider].baseUrl, "https://example.invalid/api");
    return { payloads: [{ text: '{"ok":true}' }], meta: {} };
  });
  host.config = originalConfig;
  const factory = createOpenClawReviewerFactory(host, { env: { REVIEW_TEST_KEY: secret } });
  const handle = await factory({ projectRoot: project, taskId: task.taskId, role: "ground-truth-extractor",
    reviewer: { session: "independent", provider: { baseUrl: "https://example.invalid/api", apiKeyEnv: "REVIEW_TEST_KEY", model: "test" } },
    request: { text: "Review" }, schema: objectSchema });
  assert.equal(originalConfig.models.providers["runtime-corrector-independent"], undefined);
  assert.doesNotMatch(await fs.readFile(path.join(handle.requestDirectory, "request.json"), "utf8"), /test-private-api-key/u);
  await handle.close();
  const journal = await fs.readFile(path.join(taskDirectory(project, task.taskId), "journal/events.jsonl"), "utf8");
  assert.doesNotMatch(journal, /test-private-api-key|parent-secret/u);
});

test("native reviewer deadlines abort work and release the internal lease", async (t) => {
  const project = await workspace(t);
  const task = await ensureTask({ projectRoot: project, sessionId: "parent" });
  let signal;
  const host = api(project, async (params) => {
    signal = params.abortSignal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.access(path.dirname(params.sessionFile));
    throw signal.reason;
  });
  const registry = new Set();
  const factory = createOpenClawReviewerFactory(host, { provider: "test", model: "test", internalSessions: registry });
  await assert.rejects(factory({ projectRoot: project, taskId: task.taskId, role: "ground-truth-extractor",
    reviewer: { timeoutMs: 60 }, request: {}, schema: objectSchema }), /deadline/u);
  assert.equal(signal.aborted, true);
  assert.equal(registry.size, 0);
  assert.equal((await fs.readdir(path.join(project, ".runtime-correction/internal-runs"))).length, 0);
});

test("native reviews reject nested factories and handoffs across module reloads and cap JSON repair", async (t) => {
  const project = await workspace(t);
  const task = await ensureTask({ projectRoot: project, sessionId: "parent" });
  const input = { projectRoot: project, taskId: task.taskId, role: "stop-reviewer",
    request: {}, schema: objectSchema, reviewer: { timeoutMs: 5000 } };
  let calls = 0, closedOrigin = false, nested;
  const host = api(project, async () => {
    calls++;
    assert.ok(calls <= 2, "a reviewer must not recursively launch another native run");
    await assert.rejects(nested(input), { code: "SKIPPED_INTERNAL" });
    await assert.rejects(nested.handoff({ ...input,
      originHandle: { close: async () => { closedOrigin = true; } } }), { code: "SKIPPED_INTERNAL" });
    return { payloads: [{ text: "invalid JSON" }] };
  });
  const options = { provider: "test", model: "test" };
  const factory = createOpenClawReviewerFactory(host, options);
  // A freshly loaded copy must share the guard without sharing factory state.
  const reloaded = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/reviewer.mjs")));
  nested = reloaded.createOpenClawReviewerFactory(host, options);
  await assert.rejects(factory(input), /JSON/u);
  assert.equal(calls, 2, "one initial assessment and at most one schema repair");
  assert.equal(closedOrigin, false, "reject recursion before touching the source session");
  assert.deepEqual(await fs.readdir(path.join(project, ".runtime-correction/internal-runs")), []);
});

test("native review scope suppresses incomplete hook identities without suppressing a concurrent main task", async (t) => {
  const { project, runtime, ctx, calls, host } = await correctionFixture(t);
  let releaseReview, startedReview;
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
  const started = new Promise((resolve) => { startedReview = resolve; });
  t.after(() => releaseReview());
  const before = { toolName: "write", toolCallId: "shared-call", params: { path: "draft.txt" } };
  const nativeHost = api(project, async (params) => {
    startedReview(params);
    await reviewGate;
    const incomplete = { sessionId: params.sessionId, workspaceDir: project, trigger: "user" };
    assert.equal(await runtime.sessionStart({}, incomplete), undefined);
    assert.equal(await runtime.prompt({ prompt: "Review the task", messages: [] }, incomplete), undefined);
    assert.equal(await runtime.beforeTool(before, incomplete), undefined);
    assert.equal(await runtime.beforeTool({ ...before, toolCallId: "late-internal" }, incomplete), undefined);
    assert.equal(await runtime.toolResult({ toolName: "write", toolCallId: "shared-call", args: before.params,
      result: { content: [] } }, { runtime: "openclaw" }), undefined);
    assert.equal(await runtime.finalize({ lastAssistantMessage: "Review done" }, incomplete), undefined);
    assert.equal(await runtime.compact({}, incomplete), undefined);
    assert.equal(await runtime.sessionEnd({}, incomplete), undefined);
    return { payloads: [{ text: '{"ok":true}' }] };
  });
  const factory = createOpenClawReviewerFactory(nativeHost, { provider: "test", model: "test" });
  const reviewing = factory({ projectRoot: project, taskId: "review-scope-test", role: "stop-reviewer",
    request: {}, schema: objectSchema, reviewer: { timeoutMs: 5000 } });
  const params = await started;
  await runtime.prompt({ prompt: "Create result.txt with the verified content.", messages: [] }, ctx);
  await runtime.beforeTool(before, ctx);
  assert.ok(await findTask({ projectRoot: project, sessionId: ctx.sessionId }));
  const count = calls.length;
  assert.ok(count > 0, "a concurrent main task must still receive review");
  releaseReview();
  const handle = await reviewing;
  await handle.close();
  assert.equal(calls.length, count);
  assert.equal(await findTask({ projectRoot: project, sessionId: params.sessionId }), null);
  assert.deepEqual(host.warnings, []);
  // A late native result can arrive outside the async scope, with only a call
  // binding left. The binding must retain its internal origin after cleanup.
  assert.equal(await runtime.toolResult({ toolName: "write", toolCallId: "late-internal", args: before.params,
    result: { content: [] } }, { runtime: "openclaw" }), undefined);
  assert.equal(calls.length, count);
  assert.equal(await findTask({ projectRoot: project, sessionId: params.sessionId }), null);
  const decision = await runtime.finalize({ lastAssistantMessage: "Done" }, ctx);
  assert.equal(decision?.action, "revise", "main-task final verification remains active");
});

test("late callbacks remain internal while timed out native sessions finish cleanup", async (t) => {
  const project = await workspace(t);
  const host = api(project);
  const sharedState = {};
  const runtime = createRuntime(host, { pluginRoot, sharedState });
  const registry = new Set();
  let releaseLate, finishLate, startedReview;
  const activeReviewRuns = new Set();
  const lateGate = new Promise((resolve) => { releaseLate = resolve; });
  const lateFinished = new Promise((resolve) => { finishLate = resolve; });
  const started = new Promise((resolve) => { startedReview = resolve; });
  t.after(() => releaseLate());
  host.runtime.agent.runEmbeddedAgent = async (params) => {
    startedReview(params);
    await lateGate;
    try {
      const incomplete = { sessionId: params.sessionId, workspaceDir: project, trigger: "user" };
      await runtime.prompt({ prompt: "Late reviewer response", messages: [] }, incomplete);
      await runtime.finalize({ lastAssistantMessage: "Late assessment" }, incomplete);
      return { payloads: [{ text: '{"ok":true}' }] };
    } finally { finishLate(); }
  };
  const factory = createOpenClawReviewerFactory(host, { provider: "test", model: "test", internalSessions: registry,
    onRunStart: (id) => activeReviewRuns.add(id), onRunEnd: (id) => activeReviewRuns.delete(id) });
  const reviewing = assert.rejects(factory({ projectRoot: project, taskId: "late-review-test", role: "stop-reviewer",
    request: {}, schema: objectSchema, reviewer: { timeoutMs: 100 } }), /deadline/u);
  const params = await started;
  await reviewing;
  assert.equal(params.abortSignal.aborted, true);
  assert.equal(activeReviewRuns.size, 0, "late cleanup must not renew the current round's liveness");
  assert.equal(registry.size, 1, "keep the identity until the native run settles");
  assert.equal((await fs.readdir(path.join(project, ".runtime-correction/internal-runs"))).length, 1);
  releaseLate();
  await lateFinished;
  for (let i = 0; i < 100 && registry.size; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(registry.size, 0);
  assert.equal(sharedState.states.size, 0, "late hooks must not create developer state after cleanup");
  assert.deepEqual(host.warnings, []);
});

test("cross-role handoff renews the role timeout but preserves the enclosing deadline", async (t) => {
  const project = await workspace(t);
  const calls = [];
  const host = api(project, async (params) => {
    calls.push(params);
    return { payloads: [{ text: '{"ok":true}' }] };
  });
  const deadlineAt = Date.now() + 3000;
  const factory = createOpenClawReviewerFactory(host, { provider: "test", model: "test", deadlineAt });
  const input = { projectRoot: project, taskId: "handoff-budgets", role: "ground-truth-extractor",
    request: {}, schema: objectSchema, reviewer: { timeoutMs: 200 } };
  const first = await factory(input);
  const second = await factory.handoff({ ...input, originHandle: first, role: "stop-reviewer", reviewer: { timeoutMs: 10000 } });
  assert.ok(calls[0].timeoutMs <= 200);
  assert.ok(calls[1].timeoutMs > 1000, "Stop must not inherit the extractor's 200 ms role timeout");
  assert.ok(calls[1].timeoutMs <= 3000, "the shared hook deadline must still bound the handoff");
  await second.close();
});

test("nested reviewer followups cannot abort their owner and independent later followups still work", async (t) => {
  const project = await workspace(t);
  const task = await ensureTask({ projectRoot: project, sessionId: "parent" });
  let handle, calls = 0;
  const host = api(project, async (params) => {
    calls++;
    if (handle) {
      await assert.rejects(handle.followUp({ prompt: "Recursively review this review" }), { code: "SKIPPED_INTERNAL" });
      assert.equal(params.abortSignal.aborted, false);
    }
    return { payloads: [{ text: '{"ok":true}' }] };
  });
  const factory = createOpenClawReviewerFactory(host, { provider: "test", model: "test" });
  handle = await factory({ projectRoot: project, taskId: task.taskId, role: "stop-reviewer",
    request: {}, schema: objectSchema, reviewer: { timeoutMs: 5000 } });
  assert.deepEqual(await handle.followUp({ prompt: "Check the current evidence" }), { ok: true });
  assert.deepEqual(await handle.followUp({ prompt: "Resolve the remaining question" }), { ok: true });
  assert.equal(calls, 3);
  await handle.close();
});

test("native reviewers repair revision ids instead of silently losing blocking findings", async (t) => {
  const project = await workspace(t);
  const task = await ensureTask({ projectRoot: project, sessionId: "domain" });
  const groundTruthPath = path.join(project, "ground-truth.json");
  await fs.writeFile(groundTruthPath, JSON.stringify({ claims: [{ claimId: "requirement-1", revisionId: "requirement-1@1" }] }));
  let calls = 0;
  const host = api(project, async (params) => {
    calls++;
    if (calls === 2) assert.match(params.prompt, /unknown claimId.*requirement-1@1/u);
    return { payloads: [{ text: JSON.stringify({ findings: [{ violatedGroundTruthIds: [calls === 1 ? "requirement-1@1" : "requirement-1"] }] }) }] };
  });
  const factory = createOpenClawReviewerFactory(host, { provider: "test", model: "active" });
  host.config.agents = { defaults: { model: { primary: "other/default" } } };
  const handle = await factory({ projectRoot: project, taskId: task.taskId, role: "stop-reviewer", request: { groundTruthPath },
    schema: { type: "object", required: ["findings"], properties: { findings: { type: "array" } } } });
  assert.equal(calls, 2);
  assert.deepEqual(handle.result.findings[0].violatedGroundTruthIds, ["requirement-1"]);
  await handle.close();
});

async function correctionFixture(t, { shadow = false, brokenPopulation = false } = {}) {
  const project = await workspace(t);
  await fs.mkdir(path.join(project, ".runtime-corrector"));
  await fs.writeFile(path.join(project, ".runtime-corrector/config.yaml"), `version: 2
shadowMode: ${shadow}
artifacts:
  - name: requirements
    stage: requirements
    format: markdown
    patterns: [spec/requirements.md]
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 2
    adjudicator: true
skillCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 2
evidenceRoots: [evidence]
`);
  const calls = [];
  const factory = async (input) => {
    calls.push(input);
    const { request, schema, role } = input;
    let result;
    if (schema.properties.operations) {
      result = { summary: "Task requirements", taskClassification: "CONTINUATION",
        operations: role === "onboarding-extractor" ? [{ operation: "ADD", category: "requirements",
          text: "Create result.txt with the verified content.", authority: "USER_EXPLICIT", severity: "HARD",
          source: { ref: request.sourceCatalog.find((item) => item.kind === "USER_MESSAGE").ref, subject: "MAIN_TASK", kind: "USER_MESSAGE" } }]
          : role === "onboarding-adjudicator" ? request.majorityOperations : [] };
    } else if (schema.properties.stopClassification) {
      const groundTruth = JSON.parse(await fs.readFile(request.groundTruthPath, "utf8"));
      result = { summary: "Result not verified.", stopClassification: brokenPopulation ? "TASK_COMPLETE" : "INTERMEDIATE",
        metricObjectJudgements: brokenPopulation ? [] : Object.values(request.population?.metrics ?? {}).flat().map((object) => ({
          objectId: object.objectId, judgement: "DEVIATION", reason: "Required result.txt is missing.", evidence: ["result.txt does not exist"],
        })),
        findings: [{ deviationKey: "missing-result", rootCauseId: "OTHER", severity: "blocker",
          reason: "The required result.txt is missing.", actualEvidence: ["result.txt does not exist"],
          expectedConstraint: "Create result.txt", violatedGroundTruthIds: groundTruth.claims.map((claim) => claim.claimId) }] };
    } else throw new Error(`Unexpected role ${role}`);
    return { result, sessionId: "review", requestDirectory: project, close: async () => {} };
  };
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  const host = api(project);
  const runtime = createRuntime(host, { pluginRoot, reviewerFactory: factory });
  const ctx = { sessionId: "main", agentId: "main", sessionKey: "agent:main:main", runId: "run-1", workspaceDir: project, trigger: "user" };
  return { project, host, runtime, ctx, calls };
}

test("invalid population judgements use the original bounded infrastructure budget", async (t) => {
  const { runtime, ctx, project } = await correctionFixture(t, { brokenPopulation: true });
  const state = await runtime.beginSupervised({ ...ctx, prompt: "Create result.txt with the verified content." }, new AbortController().signal);
  const worker = runtime.bindWorker("broken-review-worker", state);
  await runtime.beforeTool({ toolName: "write", toolCallId: "initial-write", params: { path: "result.txt" } }, { ...ctx, sessionId: "broken-review-worker" });
  for (let i = 0; i < 3; i++) {
    const decision = await runtime.assessSupervised(state, { text: "Done.", assessmentId: `broken-${i}` });
    assert.equal(decision.status, "UNVERIFIED", JSON.stringify(decision));
    assert.equal(decision.decision, i < 2 ? "block" : "allow");
  }
  const task = await findTask({ projectRoot: project, sessionId: ctx.sessionId });
  assert.equal(task.stop.correctionAttempts, 0);
  assert.equal(task.stop.infrastructureFailures, 3);
  assert.equal(task.status, "STOPPED_UNVERIFIED");
  worker.close();
});

test("a fresh runtime recognizes persisted workers and rejects their late hooks after restart", async (t) => {
  const { runtime, ctx, project, calls } = await correctionFixture(t);
  const sessionId = "prior-process-worker";
  await privateJson(workerIdentityPath(project, sessionId), { workerSessionId: sessionId,
    parentSessionId: ctx.sessionId, generation: "prior-generation" });
  assert.equal(runtime.isWorker(sessionId, project), true);
  assert.equal(runtime.isWorker("unregistered-worker", project), false);
  const stale = { ...ctx, sessionId, sessionKey: "agent:main:rc-worker:prior", runId: "late-run" };
  await runtime.beforeTool({ toolName: "write", toolCallId: "late-write", params: { path: "late.txt" } }, stale);
  await runtime.finalize({ lastAssistantMessage: "Done." }, stale);
  assert.equal(calls.length, 0);
  assert.equal(await findTask({ projectRoot: project, sessionId }), null);
});

test("supervised completion unwraps the original Stop decision and keeps the root task budget", async (t) => {
  const { runtime, ctx, calls, project } = await correctionFixture(t);
  const state = await runtime.beginSupervised({ ...ctx, provider: "test", modelId: "test", prompt: "Create result.txt with the verified content." }, new AbortController().signal);
  const worker = runtime.bindWorker("controlled-worker", state);
  const childCtx = { ...ctx, sessionId: "controlled-worker", runId: "child-run" };
  await runtime.beforeTool({ toolName: "write", toolCallId: "controlled-write", params: { path: "result.txt" } }, childCtx);
  const before = calls.length;
  assert.equal(await runtime.finalize({ lastAssistantMessage: "完成了。" }, childCtx), undefined);
  assert.equal(calls.length, before, "native worker finalize must not assess completion");
  const decision = await runtime.assessSupervised(state, { text: "完成了。", assessmentId: "controlled-assessment", stopHookActive: false });
  assert.equal(decision.decision, "block");
  assert.equal(decision.correctionAttempt, 1);
  assert.equal(decision.review.stopClassification, "INTERMEDIATE");
  assert.equal((await findTask({ projectRoot: project, sessionId: ctx.sessionId })).stop.correctionAttempts, 1);
  assert.equal(await findTask({ projectRoot: project, sessionId: childCtx.sessionId }), null);
  worker.close();
  await runtime.beforeTool({ toolName: "write", toolCallId: "late-worker", params: {} }, childCtx);
  assert.equal(await findTask({ projectRoot: project, sessionId: childCtx.sessionId }), null);
});

test("native lifecycle preserves frozen baseline, terminal budget, deduplication and session isolation", async (t) => {
  const { project, runtime, ctx, calls, host } = await correctionFixture(t);
  await runtime.prompt({ prompt: "Create result.txt with the verified content.", messages: [] }, ctx);
  assert.equal(calls.length, 0);
  assert.equal(await findTask({ projectRoot: project, sessionId: "main" }), null);
  const before = { toolName: "write", toolCallId: "write-1", params: { path: "draft.txt", content: "Draft" } };
  await runtime.beforeTool(before, ctx);
  assert.equal(host.warnings.length, 0, host.warnings.join("\n"));
  const task = await findTask({ projectRoot: project, sessionId: "main" });
  assert.ok(task);
  const count = calls.length;
  await runtime.beforeTool(before, ctx);
  assert.equal(calls.length, count);
  const gt = await fs.readFile(path.join(taskDirectory(project, task.taskId), "ground-truth/current.json"), "utf8");
  assert.match(gt, /Create result.txt/u);
  const final = { sessionId: "main", stopHookActive: false, lastAssistantMessage: "完成了。" };
  const first = await runtime.finalize(final, ctx);
  assert.equal(first?.action, "revise", host.warnings.join("\n"));
  const reply = { kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "完成", mediaUrl: "local://test" } };
  assert.match((await runtime.reply(reply)).payload.text, /验收尚未通过/u);
  assert.equal((await runtime.reply(reply)).payload.mediaUrl, "local://test");
  assert.equal(await runtime.reply({ ...reply, runId: "unrelated" }), undefined);
  await runtime.prompt({ prompt: "Automatically revise the result", messages: [] }, ctx);
  const second = await runtime.finalize(final, ctx);
  assert.equal(second?.action, "revise");
  assert.equal(await runtime.finalize(final, ctx), undefined);
  const after = await findTask({ projectRoot: project, sessionId: "main" });
  assert.equal(after.stop.correctionAttempts, 2);
  assert.equal(after.status, "STOPPED_UNVERIFIED");
  assert.match((await runtime.reply(reply)).payload.text, /runtime-corrector:feedback/u);
  assert.equal(await fs.readFile(path.join(taskDirectory(project, task.taskId), "ground-truth/current.json"), "utf8"), gt);
  await runtime.beforeTool({ ...before, toolCallId: "internal-read" }, { ...ctx, sessionId: "internal", sessionKey: "agent:main:runtime-corrector:internal" });
  assert.equal(await findTask({ projectRoot: project, sessionId: "internal" }), null);
  await runtime.prompt({ prompt: "Hello", messages: [] }, { ...ctx, sessionId: "other", runId: "run-other" });
  assert.equal(await findTask({ projectRoot: project, sessionId: "other" }), null);
});

for (const shadow of [false, true]) test(`evidence feedback uses native tool results and respects shadowMode=${shadow}`, async (t) => {
  const { project, runtime, ctx } = await correctionFixture(t, { shadow });
  await fs.mkdir(path.join(project, "evidence"));
  await fs.writeFile(path.join(project, "evidence/one.txt"), "same capture");
  await fs.writeFile(path.join(project, "evidence/two.txt"), "same capture");
  await runtime.prompt({ prompt: "Create result.txt with the verified content.", messages: [] }, ctx);
  await runtime.beforeTool({ toolName: "exec", toolCallId: "exec-1", params: { command: "capture" } }, ctx);
  const event = { toolName: "exec", toolCallId: "exec-1", args: { command: "capture" }, result: { content: [{ type: "text", text: "Original tool output" }] } };
  // Exact OpenClaw 2026.7.1-2 native middleware context omits session identity.
  const result = await runtime.toolResult(event, { runtime: "openclaw" });
  if (shadow) {
    assert.equal(result, undefined);
    assert.equal(await runtime.finalize({ sessionId: "main", lastAssistantMessage: "完成了。" }, ctx), undefined);
    assert.equal(await runtime.reply({ kind: "final", runId: ctx.runId, payload: { text: "完成" } }), undefined);
  } else {
    assert.equal(result.result.content[0].text, "Original tool output");
    assert.match(result.result.content.at(-1).text, /证据完整性/u);
    assert.deepEqual(await runtime.toolResult(event, ctx), result);
  }
});

test("ambiguous native tool call ids never attach feedback to another session", async (t) => {
  const { runtime, ctx, calls, host } = await correctionFixture(t);
  const event = { toolName: "read", toolCallId: "collision", params: { path: "file" } };
  await runtime.beforeTool(event, ctx);
  await runtime.beforeTool(event, { ...ctx, sessionId: "other" });
  assert.equal(await runtime.toolResult({ ...event, args: {}, result: { content: [] } }, { runtime: "openclaw" }), undefined);
  assert.match(host.warnings.at(-1), /Ambiguous/u);
  assert.equal(calls.length, 0);
});

test("native tool bindings survive a host plugin registry reload", async (t) => {
  const project = await workspace(t);
  await fs.mkdir(path.join(project, ".runtime-corrector"));
  await fs.writeFile(path.join(project, ".runtime-corrector/config.yaml"), "version: 2\nartifacts:\n  - name: requirements\n    stage: requirements\n    format: markdown\n    patterns: [spec/requirements.md]\ndynamicGroundTruth:\n  enabled: false\nstopCorrection:\n  enabled: false\nskillCorrection:\n  enabled: false\nartifactCorrection:\n  groundTruthReviewEnabled: false\n  stageMetricsEnabled: false\nevidenceRoots: [evidence]\n");
  await fs.mkdir(path.join(project, "evidence"));
  for (const file of ["one.txt", "two.txt"]) await fs.writeFile(path.join(project, "evidence", file), "same capture");
  const first = api(project), second = api(project);
  entry.register(first);
  const ctx = { sessionId: "reload", runId: "reload-run", agentId: "main", workspaceDir: project };
  await first.hooks.get("before_tool_call").handler({ toolName: "write", toolCallId: "reload-tool", params: { path: "unmatched.txt" } }, ctx);
  entry.register(second);
  const result = await second.middleware.handler({ toolName: "write", toolCallId: "reload-tool", args: { path: "unmatched.txt" }, result: { content: [] } }, { runtime: "openclaw" });
  assert.match(result?.result.content.at(-1).text ?? "", /证据完整性/u, [...first.warnings, ...second.warnings].join("\n"));
});

test("native artifact checks retain deterministic rules, semantic review and unapplied candidate edits", async (t) => {
  const { project, ctx, host } = await correctionFixture(t);
  const configPath = path.join(project, ".runtime-corrector/config.yaml");
  let config = await fs.readFile(configPath, "utf8");
  config = config.replace("dynamicGroundTruth:\n  enabled: true", "dynamicGroundTruth:\n  enabled: false")
    .replace("stopCorrection:\n  enabled: true", "stopCorrection:\n  enabled: false")
    .replace("    patterns: [spec/requirements.md]", "    patterns: [spec/requirements.md]\n    rules:\n      enabled: true\n      file: rules.yaml\n    review:\n      enabled: true\n      criteria: reviewer.md");
  await fs.writeFile(configPath, config);
  await fs.writeFile(path.join(project, ".runtime-corrector/rules.yaml"), "version: 1\nrules:\n  - id: REQUIRE-GOAL\n    type: require-heading\n    heading: Goal\n    severity: error\n");
  await fs.writeFile(path.join(project, ".runtime-corrector/reviewer.md"), "Require a precise goal.");
  await fs.mkdir(path.join(project, "spec"));
  const file = path.join(project, "spec/requirements.md");
  await fs.writeFile(file, "# Draft\n");
  let reviews = 0;
  const runtime = createRuntime(host, { pluginRoot, reviewerFactory: async (input) => {
    reviews++;
    assert.equal(input.role, "artifact-reviewer");
    await fs.access(input.request.semanticReviewRequestPath);
    return { sessionId: "native-artifact", close: async () => {}, result: {
      summary: "Missing goal", findings: [{ ruleId: "AGENT-GOAL", severity: "error", path: "spec/requirements.md", message: "Goal is missing", evidence: ["# Draft"] }],
      edits: [{ target: "spec/requirements.md", operations: [{ type: "replace-line", line: 1, expect: "# Draft", replacement: "# Goal" }] }],
    } };
  } });
  await runtime.prompt({ prompt: "Write requirements", messages: [] }, ctx);
  await runtime.beforeTool({ toolName: "write", toolCallId: "artifact", params: { path: file } }, ctx);
  const result = await runtime.toolResult({ toolName: "write", toolCallId: "artifact", args: { path: file }, result: { content: [{ type: "text", text: "Written" }] } }, { runtime: "openclaw" });
  assert.equal(reviews, 1, host.warnings.join("\n"));
  assert.match(result?.result.content.at(-1).text ?? "", /REQUIRE-GOAL/u);
  assert.match(result?.result.content.at(-1).text ?? "", /AGENT-GOAL/u);
  assert.equal(await fs.readFile(file, "utf8"), "# Draft\n");
});
