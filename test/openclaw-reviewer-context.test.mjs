import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { createOpenClawRuntime } from "../lib/openclaw/runtime.mjs";
import { registerReviewerProgress } from "../lib/openclaw/reviewer-progress.mjs";
import { STOP_CLASSIFICATION_SCHEMA, STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson } from "../lib/runtime-v2/utils.mjs";
import { matchesEvidence } from "../lib/openclaw/evidence.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { REVIEWER_NATIVE_TOOL_DENY } from "../lib/reviewer-tools.mjs";


const result = text => ({ content: [{ type: "text", text }] });
const output = () => ({ payloads: [{ text: JSON.stringify({ summary: "Controlled result", stopClassification: "TASK_COMPLETE", findings: [], metricObjectJudgements: [] }) }], meta: {} });

async function fixture(t, runner, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-native-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "business-session" });
  const file = path.join(root, "app.mjs");
  await fs.writeFile(file, "export const actual = 1;\n");
  const groundTruth = { version: 1, claims: ["R1", "R2"].map(claimId => ({ claimId, revisionId: `${claimId}@1`, category: "requirements", text: `Review ${claimId}.` })) };
  const groundTruthPath = path.join(taskDirectory(root, task.taskId), "ground-truth/current.json");
  await atomicWriteJson(groundTruthPath, groundTruth);
  const population = { metrics: { M01: ["R1", "R2"].map(sourceId => ({ objectId: `M01:${sourceId}`, sourceId, sourceRevisionId: `${sourceId}@1`, metricId: "M01", description: `Review ${sourceId}.` })) } };
  let toolFactory, calls = 0, runtime;
  const api = { rootDir: path.resolve("."), config: { agents: { defaults: { model: { primary: "fixture/model" } } } },
    logger: { warn() {}, error() {}, info() {} }, registerTool: factory => { toolFactory = factory; },
    runtime: { agent: { runEmbeddedAgent: async params => { calls++; return runner({ params, runtime, tool: toolFactory({ sessionId: params.sessionId }), file }); } } } };
  registerReviewerProgress(api);
  runtime = createOpenClawRuntime(api, { pluginRoot: path.resolve("."), nativeHooks: true,
    projectScopes: { resolve: async () => { throw new Error("An internal budget must never resolve a business scope."); } } });
  const factory = createOpenClawReviewerFactory(api, options);
  const input = { projectRoot: root, taskId: task.taskId, role: "stop-reviewer", schema: STOP_REVIEW_SCHEMA,
    reviewer: { timeoutMs: 5000, formatRepairAttempts: 2 },
    request: { groundTruthPath, population, sourceManifest: [{ path: file }],
      reviewScope: { kind: "metric", boundedBasis: true, objectIds: ["M01:R1", "M01:R2"], sourceIds: ["R1", "R2"] } },
    evidence: { groundTruth, population, snapshot: { entries: [], digest: "controlled" } } };
  return { root, factory, input, api, calls: () => calls };
}

async function read(runtime, text, id = "read-1", file = "same-evidence.txt") {
  const args = { path: file };
  const blocked = await runtime.beforeTool({ toolName: "read", params: args, toolCallId: id }, {});
  if (blocked?.block) return { blocked };
  return runtime.toolResult({ toolName: "read", args: blocked?.params ?? args, toolCallId: id, result: result(text) }, {});
}

test("onboarding, skill, artifact and implementation reviewers leave cumulative context and compaction to the host", async t => {
  for (const role of ["onboarding-extractor", "onboarding-adjudicator", "skill-reviewer", "artifact-reviewer", "implementation-reviewer"])
    await t.test(role, async t => {
      const text = "REPEATED_ORIGINAL_SOURCE ".repeat(1000);
      assert(Buffer.byteLength(text) * 8 > 128 * 1024);
      let hostConfig, reads = 0;
      const f = await fixture(t, async ({ params, runtime, file, tool }) => {
        assert.deepEqual(params.config.agents.defaults, { ...hostConfig.agents.defaults,
          models: { 'fixture/model': { params: { maxTokens: 32768 } } },
        }, "the host's context, pruning and compaction settings are retained alongside the RC output limit");
        assert.deepEqual(params.config.models, hostConfig.models);
        assert.equal(params.toolsAllow, undefined, "these roles inherit the host tool catalog instead of a private-only runtime allowlist");
        assert.equal(params.disableMessageTool, undefined);
        if (role === "artifact-reviewer") {
          assert.deepEqual(params.skillsSnapshot, { prompt: "", skills: [] });
          assert.match(params.extraSystemPrompt, /No external skill file lookup is required/);
          assert.match(params.extraSystemPrompt, /A brief implementation plan need not restate/);
          assert.match(params.extraSystemPrompt, /A PostToolUse artifact check is not a completion declaration/);
          assert.doesNotMatch(params.extraSystemPrompt, new RegExp(path.resolve("skills/semantic-review/SKILL.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        } else assert.equal(params.skillsSnapshot, undefined);
        assert.deepEqual(params.config.tools, { ...hostConfig.tools,
          deny: [...new Set([...hostConfig.tools.deny, ...REVIEWER_NATIVE_TOOL_DENY])], codeMode: { enabled: false } });
        const agent = params.config.agents.list.find(agent => agent.id === "main");
        assert.equal(agent.params.maxTokens, 32768);
        assert.deepEqual(agent.tools.deny, [...new Set(["exec", ...REVIEWER_NATIVE_TOOL_DENY])]);
        assert.equal(agent.tools.codeMode.enabled, false);
        assert.deepEqual(agent.tools.alsoAllow, ["host-agent-tool", "read", "rc_progress"]);
        assert.deepEqual(params.config.agents.list[1], hostConfig.agents.list[1]);
        assert.equal((await tool.execute("inspect-progress", { action: "get" })).details.role, role);
        for (const name of ["write", "edit", "apply_patch", "exec", "bash", "process", "code_execution", "mcp__files__write_file", "mcp__runtime__execute_code"])
          assert.equal((await runtime.beforeTool({ toolName: name, params: {} }, {})).block, true, `${role} must block ${name} before invocation`);
        assert.equal(await runtime.beforeTool({ toolName: "grep", params: { query: "source" } }, {}), undefined);
        assert.doesNotMatch(params.extraSystemPrompt, /You have only (?:the read tool|read)|Never modify business files, execute commands/u);
        for (let index = 0; index < 8; index++) {
          assert.equal(await read(runtime, text, `${params.runId}-read-${index}`, file), undefined);
          reads++;
        }
        assert.equal(params.abortSignal.aborted, false);
        return output();
      });
      f.input.role = role;
      f.input.pluginRoot = path.resolve(".");
      f.api.config.tools = { profile: "coding", alsoAllow: ["host-global-tool"], deny: ["write"] };
      f.api.config.agents.list = [
        { id: "main", tools: { alsoAllow: ["host-agent-tool"], deny: ["exec"] } },
        { id: "other", tools: { allow: ["read"] } },
      ];
      f.api.config.agents.defaults.contextTokens = 48000;
      f.api.config.agents.defaults.contextPruning = { mode: "cache-ttl", ttl: "5m", keepLastAssistants: 2 };
      f.api.config.agents.defaults.compaction = { mode: "safeguard", reserveTokens: 12000, keepRecentTokens: 6000 };
      f.api.config.models = { providers: { fixture: { models: [{ id: "model", contextWindow: 128000, maxTokens: 20000 }] } } };
      hostConfig = structuredClone(f.api.config);
      await fs.writeFile(path.join(f.root, "app.mjs"), text);
      const handle = await f.factory(f.input);
      try {
        await handle.followUp({ prompt: "Recheck the current sources using the same host-managed context." });
        assert.equal(f.calls(), 2);
        assert.equal(reads, 16);
        assert.deepEqual(f.api.config, hostConfig, "neither the initial review nor its follow-up mutates host configuration");
      } finally { await handle.close(); }
    });
});

test("native cache identity survives new factories and credential rotation but tracks live review configuration", () => {
  let config = { agents: { defaults: { model: { primary: "fixture/model" }, contextTokens: 96000,
    compaction: { mode: "safeguard", reserveTokens: 18000 } } },
    models: { providers: { fixture: { api: "anthropic-messages", baseUrl: "https://example.invalid/v1", apiKey: "first-private-key",
      headers: { Authorization: "Bearer first-private-key" }, models: [{ id: "model", name: "Model", input: ["text"], reasoning: true, contextWindow: 128000, maxTokens: 16384 }] } } } };
  const api = { config: {}, runtime: { version: "2026.7.1-2", config: { current: () => config }, agent: { runEmbeddedAgent: () => assert.fail("identity must not run a model") } } };
  const factory = createOpenClawReviewerFactory(api);
  const identity = factory.reviewCacheIdentity({ effort: "low" });
  assert.match(identity, /^[a-f0-9]{64}$/u);
  assert.equal(createOpenClawReviewerFactory(api).reviewCacheIdentity({ effort: "low" }), identity);
  config.models.providers.fixture.apiKey = "rotated-private-key";
  config.models.providers.fixture.headers.Authorization = "Bearer rotated-private-key";
  assert.equal(factory.reviewCacheIdentity({ effort: "low" }), identity);
  const original = structuredClone(config);
  for (const mutate of [
    value => { value.agents.defaults.model.primary = "fixture/new-model"; },
    value => { value.agents.defaults.contextTokens = 64000; },
    value => { value.agents.defaults.compaction.reserveTokens = 20000; },
    value => { value.models.providers.fixture.baseUrl = "https://other.example.invalid/v1"; },
    value => { value.models.providers.fixture.api = "openai-responses"; },
    value => { value.models.providers.fixture.models[0].contextWindow = 64000; },
    value => { value.models.providers.fixture.models[0].maxTokens = 8192; },
    value => { value.tools = { profile: "coding", deny: ["exec"] }; },
    value => { value.agents.list = [{ id: "main", tools: { deny: ["browser"] } }]; },
  ]) {
    config = structuredClone(original); mutate(config);
    assert.notEqual(factory.reviewCacheIdentity({ effort: "low" }), identity);
  }
  config = structuredClone(original);
  const before = structuredClone(config);
  factory.reviewCacheIdentity({ effort: "low" });
  assert.deepEqual(config, before, "identity calculation must not change host configuration");
  const independent = { session: "independent", provider: { baseUrl: "https://independent.example.invalid/v1", model: "independent-model", apiKeyEnv: "FIXTURE_KEY" } };
  assert.equal(createOpenClawReviewerFactory(api, { env: { FIXTURE_KEY: "first-secret" } }).reviewCacheIdentity(independent),
    createOpenClawReviewerFactory(api, { env: { FIXTURE_KEY: "second-secret" } }).reviewCacheIdentity(independent));
});


test("the plugin has no custom reviewer context guard or budget error handler", async () => {
  await assert.rejects(fs.access(new URL("../lib/openclaw/reviewer-context.mjs", import.meta.url)), { code: "ENOENT" });
  for (const file of ["reviewer.mjs", "runtime.mjs"]) {
    const source = await fs.readFile(new URL(`../lib/openclaw/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /REVIEWER_CONTEXT_BUDGET|createReviewerContextGuard|REVIEWER_CONTEXT_LIMITS/);
  }
});
