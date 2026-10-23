import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReviewerContextGuard, REVIEWER_CONTEXT_LIMITS } from "../lib/openclaw/reviewer-context.mjs";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { createOpenClawRuntime } from "../lib/openclaw/runtime.mjs";
import { registerReviewerProgress } from "../lib/openclaw/reviewer-progress.mjs";
import { STOP_CLASSIFICATION_SCHEMA, STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson } from "../lib/runtime-v2/utils.mjs";
import { matchesEvidence } from "../lib/openclaw/evidence.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";

const result = text => ({ content: [{ type: "text", text }] });
const output = (value = { summary: "Controlled result", stopClassification: "TASK_COMPLETE", findings: [], metricObjectJudgements: [] }) => ({ payloads: [{ text: JSON.stringify(value) }], meta: {} });

test("cumulative transport bytes count repeated reads and survive compaction/follow-ups", () => {
  const controller = new AbortController();
  const guard = createReviewerContextGuard({ controller, limits: { maxBytes: 400, maxResultBytes: 200 } });
  guard.prompt("system and first prompt");
  const event = { result: result("same evidence ".repeat(6)) };
  guard.observe("read:result", event);
  const once = guard.state.usedBytes;
  guard.configure({}, "fixture", "model"); // Reconfiguration must not reset retrieval accounting.
  guard.prompt("follow-up");
  guard.observe("read:result", event);
  assert(guard.state.usedBytes > once * 1.5);
  assert.throws(() => guard.observe("read:result", event), { code: "REVIEWER_CONTEXT_BUDGET" });
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.code, "REVIEWER_CONTEXT_BUDGET");
  assert.doesNotMatch(controller.signal.reason.message, /same evidence/);
});

test("known context/output metadata only tightens the byte allowance and leaves native config unchanged", () => {
  assert.equal(REVIEWER_CONTEXT_LIMITS.maxBytes, 128 * 1024);
  const config = { agents: { defaults: { contextTokens: 48000, compaction: { mode: "safeguard" } } },
    models: { providers: { fixture: { models: [{ id: "model", contextWindow: 128000, maxTokens: 20000 }] } } } };
  const original = structuredClone(config);
  const guard = createReviewerContextGuard({ controller: new AbortController() });
  assert.equal(guard.state.maxBytes, 131072);
  guard.configure(config, "fixture", "model");
  assert.equal(guard.state.maxBytes, 48000 - 20000 - REVIEWER_CONTEXT_LIMITS.systemReserve);
  assert.deepEqual(config, original);
  guard.configure({}, "unknown", "model");
  assert.equal(guard.state.maxBytes, 19808, "an unknown follow-up cannot expand the initial allowance");
});

test("single huge results and too many tiny calls terminate without echoing payloads", () => {
  const guard = createReviewerContextGuard({ controller: new AbortController(), limits: { maxToolCalls: 2 } });
  guard.observe("read", { path: "same.txt" });
  guard.observe("read", { path: "same.txt" });
  assert.throws(() => guard.observe("read", { path: "same.txt" }), { code: "REVIEWER_CONTEXT_BUDGET" });
  const large = createReviewerContextGuard({ controller: new AbortController() });
  assert.throws(() => large.observe("read:result", { result: result("PRIVATE_ORIGINAL".repeat(4000)) }), error => {
    assert.equal(error.code, "REVIEWER_CONTEXT_BUDGET");
    assert(error.message.length < 300);
    assert.doesNotMatch(error.message, /PRIVATE_ORIGINAL/);
    return true;
  });
});

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
  return { root, factory, input, calls: () => calls };
}

async function read(runtime, text, id = "read-1", file = "same-evidence.txt") {
  const args = { path: file };
  const blocked = await runtime.beforeTool({ toolName: "read", params: args, toolCallId: id }, {});
  if (blocked?.block) return { blocked };
  return runtime.toolResult({ toolName: "read", args: blocked?.params ?? args, toolCallId: id, result: result(text) }, {});
}

test("bounded Stop defaults business reads to honest 80-line pages and leaves explicit ranges and generated basis intact", async t => {
  const observed = [];
  const f = await fixture(t, async ({ params, runtime, file }) => {
    assert.match(params.extraSystemPrompt, /defaults the read to 80 lines/u);
    assert.match(params.extraSystemPrompt, /never proof that the complete file has been read/u);
    const body = (await fs.readFile(file, "utf8")).split("\n");
    for (const [index, args] of [{ path: file }, { file_path: file, offset: 81 }, { path: file, offset: 161, limit: 120 }].entries()) {
      const original = structuredClone(args);
      const decision = await runtime.beforeTool({ toolName: "read", params: args, toolCallId: `page-${index}` }, {});
      const actual = decision?.params ?? args;
      assert.deepEqual(args, original, "the caller's proposed read remains unchanged for the audit trail");
      assert.equal(actual.limit, index === 2 ? 120 : 80);
      assert.equal(actual.offset, args.offset);
      assert.equal(Boolean(decision), index !== 2, "explicit bounded ranges retain their native parameters");
      const start = (actual.offset ?? 1) - 1, text = body.slice(start, start + actual.limit).join("\n");
      if (index === 0) { assert.match(text, /LINE_80$/u); assert.doesNotMatch(text, /LINE_81/u); }
      await runtime.toolResult({ toolName: "read", args: actual, toolCallId: `page-${index}`, result: result(text) }, {});
    }
    const generated = path.join(path.dirname(params.sessionFile), "request.json");
    assert.equal(await runtime.beforeTool({ toolName: "read", params: { path: generated }, toolCallId: "basis" }, {}), undefined);
    await runtime.toolResult({ toolName: "read", args: { path: generated }, toolCallId: "basis",
      result: result(await fs.readFile(generated, "utf8")) }, {});
    return output();
  }, { observeTool: (name, args) => { if (name === "read") observed.push(structuredClone(args)); } });
  await fs.writeFile(path.join(f.root, "app.mjs"), Array.from({ length: 280 }, (_, index) => `LINE_${index + 1}`).join("\n"));
  const handle = await f.factory(f.input);
  assert.equal(handle.reviewEvidence.unstable, false);
  assert.deepEqual(handle.reviewEvidence.reads.map(row => row.input), [
    { offset: null, limit: 80 }, { offset: 81, limit: 80 }, { offset: 161, limit: 120 },
  ], "the evidence ledger records the native read's actual ranges");
  assert.deepEqual(observed.map(args => args.limit ?? null), [80, 80, 120, null]);
  await handle.close();
});

test("ordinary reviewers and Stop classification keep their native read parameters", async t => {
  const f = await fixture(t, async ({ runtime, file }) => {
    const args = { path: file };
    assert.equal(await runtime.beforeTool({ toolName: "read", params: args, toolCallId: "ordinary" }, {}), undefined);
    assert.deepEqual(args, { path: file });
    await runtime.toolResult({ toolName: "read", args, toolCallId: "ordinary", result: result(await fs.readFile(file, "utf8")) }, {});
    return output();
  });
  for (const mode of ["ordinary", "unmarked", "classification"]) {
    const input = structuredClone(f.input);
    if (mode === "ordinary") input.role = "implementation-reviewer";
    if (mode === "unmarked") input.request.reviewScope.boundedBasis = false;
    if (mode === "classification") { input.schema = STOP_CLASSIFICATION_SCHEMA; input.request.reviewScope.kind = "classification"; }
    const handle = await f.factory(input);
    await handle.close();
  }
});

test("bounded Stop aborts cumulative repeated reads, keeps checked progress, and bypasses native fail-open wrapping", async t => {
  let signal, lastResult, blocked;
  const f = await fixture(t, async ({ params, runtime, tool, file }) => {
    signal = params.abortSignal;
    await tool.execute("save", { action: "save", item: { objectId: "M01:R1", state: "COMPLETED", judgement: "PASS",
      reason: "Checked the actual source.", refs: [{ path: file, start: 1, end: 1 }], unresolved: [] } });
    for (let index = 0; index < 8 && !signal.aborted; index++) lastResult = await read(runtime, "REPEATED_SOURCE ".repeat(1700), `read-${index}`);
    blocked = await runtime.beforeTool({ toolName: "read", params: { path: "after-abort.txt" } }, {});
    return output();
  });
  let error;
  try { await f.factory(f.input); } catch (failure) { error = failure; }
  assert.equal(error?.code, "REVIEWER_CONTEXT_BUDGET");
  assert.equal(signal.aborted, true);
  assert.equal(f.calls(), 1, "context exhaustion must not start a format repair");
  assert.equal(lastResult.result.isError, true);
  assert(JSON.stringify(lastResult).length < 600);
  assert.doesNotMatch(JSON.stringify(lastResult), /REPEATED_SOURCE/);
  assert.equal(blocked.block, true);
  assert.equal(error.partialReview.recoveredObjects, 1);
  assert.deepEqual(error.partialReview.unreviewedObjectIds, ["M01:R2"]);
  assert.equal(error.partialReview.finalClassification, null);
});

test("one oversized Stop read aborts while ordinary roles and unmarked scopes keep existing behavior", async t => {
  let signal, delivered;
  const f = await fixture(t, async ({ params, runtime }) => {
    signal = params.abortSignal;
    delivered = await read(runtime, "LARGE_PRIVATE_SOURCE ".repeat(3000));
    return output();
  });
  await assert.rejects(f.factory(f.input), { code: "REVIEWER_CONTEXT_BUDGET" });
  assert.equal(signal.aborted, true);
  assert.doesNotMatch(JSON.stringify(delivered), /LARGE_PRIVATE_SOURCE/);
  const baseline = structuredClone(f.input);
  baseline.role = "ground-truth-extractor";
  baseline.request.reviewScope.kind = "baseline";
  await assert.rejects(f.factory(baseline), { code: "REVIEWER_CONTEXT_BUDGET" });
  assert.equal(signal.aborted, true);
  assert.doesNotMatch(JSON.stringify(delivered), /LARGE_PRIVATE_SOURCE/);
  for (const scope of [null, { boundedBasis: false }, { boundedBasis: true }]) {
    const ordinary = structuredClone(f.input);
    ordinary.request.reviewScope = scope;
    if (scope?.boundedBasis) ordinary.role = "implementation-reviewer";
    const handle = await f.factory(ordinary);
    assert.equal(handle.reviewEvidence, undefined);
    assert.equal(signal.aborted, false);
    assert.equal(delivered, undefined, "the regular result remains untouched");
    await handle.close();
  }
  const ordinaryBaseline = structuredClone(baseline);
  ordinaryBaseline.request.reviewScope.boundedBasis = false;
  const handle = await f.factory(ordinaryBaseline);
  assert.equal(signal.aborted, false);
  await handle.close();
});

test("classification has a compact prompt, empty schemas, and no progress capability", async t => {
  const f = await fixture(t, async ({ params, tool }) => {
    assert.deepEqual(params.toolsAllow, ["read"]);
    assert.equal(tool, null);
    assert.match(params.extraSystemPrompt, /Classify only the stopping situation/);
    assert.doesNotMatch(params.extraSystemPrompt, /violatedGroundTruthIds|rc_progress|Every metric judgement/);
    assert(params.extraSystemPrompt.length < 4000);
    return output();
  });
  const input = structuredClone(f.input);
  input.schema = STOP_CLASSIFICATION_SCHEMA;
  input.request.reviewScope.kind = "classification";
  const handle = await f.factory(input);
  await handle.close();
});

test("paged common constraints retain canonical finding identities without expanding the local schema", async t => {
  const f = await fixture(t, async ({ params, file }) => {
    const frozen = JSON.parse(await fs.readFile(path.join(path.dirname(params.sessionFile), "frozen-ground-truth.json"), "utf8"));
    assert.deepEqual(frozen.claims, [], "the complete common basis is intentionally deferred to original pages");
    const schema = JSON.parse(params.extraSystemPrompt.split("matching this schema:\n").at(-1));
    assert.deepEqual(schema.properties.findings.items.properties.violatedGroundTruthIds.items.enum, ["R1"]);
    assert.doesNotMatch(params.extraSystemPrompt, /COMMON_179/);
    return output({ summary: "Known hard constraint violated during an intermediate stop.", stopClassification: "INTERMEDIATE", metricObjectJudgements: [],
      findings: [{ deviationKey: "hard-violation", rootCauseId: "OTHER", severity: "error", reason: "Observed the current source violate its assigned original constraint.",
        actualEvidence: [`${file}#L1-L1`], expectedConstraint: "R1", violatedGroundTruthIds: ["R1"] }] });
  });
  f.input.evidence.groundTruth.claims.push(...Array.from({ length: 180 }, (_, index) => ({
    claimId: `COMMON_${index}`, revisionId: `COMMON_${index}@1`, category: "constraints", text: "Protected common original condition. ".repeat(12),
  })));
  await atomicWriteJson(f.input.request.groundTruthPath, f.input.evidence.groundTruth);
  f.input.request.reviewScope.sourceIds = ["R1"];
  f.input.request.reviewScope.objectIds = ["M01:R1"];
  f.input.request.population.metrics.M01 = f.input.request.population.metrics.M01.slice(0, 1);
  f.input.evidence.population = structuredClone(f.input.request.population);
  const handle = await f.factory(f.input);
  assert.equal(handle.result.stopClassification, "INTERMEDIATE");
  assert.deepEqual(handle.result.findings[0].violatedGroundTruthIds, ["R1"]);
  assert.equal(f.calls(), 1);
  await handle.close();
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

test("bounded native review evidence records uncited business reads, excludes its frozen inputs, and invalidates on later changes", async t => {
  let uncited;
  const f = await fixture(t, async ({ params, runtime, file }) => {
    const request = path.join(path.dirname(params.sessionFile), "request.json");
    await read(runtime, await fs.readFile(request, "utf8"), "request", request);
    await read(runtime, await fs.readFile(file, "utf8"), "primary", file);
    await read(runtime, await fs.readFile(uncited, "utf8"), "uncited", uncited);
    return output();
  });
  uncited = path.join(f.root, "uncited.txt");
  await fs.writeFile(uncited, "UNCITED ORIGINAL BODY\n");
  const handle = await f.factory(f.input), evidence = handle.reviewEvidence;
  assert.equal(evidence.unstable, false);
  assert.equal(evidence.files.length, 2);
  assert(evidence.files.includes(uncited));
  assert.equal(evidence.reads.length, 2);
  assert.doesNotMatch(JSON.stringify(evidence), /UNCITED ORIGINAL BODY|\.internal-requests/);
  assert.equal(await matchesEvidence(evidence), true);
  await fs.writeFile(uncited, "Changed externally after a PASS.\n");
  assert.equal(await matchesEvidence(evidence), false, "an uncited read is still a cache dependency");
  await handle.close();
});

test("untracked, missing, directory, failed and secret reads conservatively disable native review reuse", async t => {
  for (const kind of ["missing", "directory", "outside", "secret", "foreign-private", "failed", "pending-read", "unknown-tool", "progress-tool", "changed-during-read"])
    await t.test(kind, async t => {
      const f = await fixture(t, async ({ params, runtime, file }) => {
        await read(runtime, "export const actual = 1;\n", "tracked", file);
        if (["unknown-tool", "progress-tool"].includes(kind)) {
          await runtime.beforeTool({ toolName: kind === "unknown-tool" ? "grep" : "rc_progress", params: { path: file } }, {});
        } else if (kind === "pending-read") {
          await runtime.beforeTool({ toolName: "read", params: { path: file } }, {});
        } else if (kind === "failed" || kind === "changed-during-read") {
          await runtime.beforeTool({ toolName: "read", params: { path: file } }, {});
          if (kind === "changed-during-read") await fs.writeFile(file, "export const actual = 2;\n");
          await runtime.toolResult({ toolName: "read", args: { path: file }, toolCallId: "last", isError: kind === "failed", result: result("Controlled response.") }, {});
        } else {
          const target = { missing: path.join(params.workspaceDir, "absent.txt"), directory: params.workspaceDir,
            outside: path.join(params.workspaceDir, "..", "foreign.txt"), secret: path.join(params.workspaceDir, ".env"),
            "foreign-private": path.join(params.workspaceDir, ".runtime-correction", "other-review", "request.json") }[kind];
          await read(runtime, "Controlled response.", "untracked", target);
        }
        return output();
      });
      const handle = await f.factory(f.input), evidence = handle.reviewEvidence;
      assert.equal(evidence.files.length > 0, true);
      assert.equal(evidence.unstable, true);
      assert.equal(await matchesEvidence(evidence), false);
      assert.doesNotMatch(JSON.stringify(evidence.fingerprints), /\.env|foreign\.txt|other-review/);
      await handle.close();
    });
});

test("retargeting an uncited directory link cannot reuse a native Stop PASS", async t => {
  let alias;
  const f = await fixture(t, async ({ params, runtime, file }) => {
    assert.match(params.extraSystemPrompt, /Program-generated original pages are at most 16 KiB/u);
    assert.match(params.extraSystemPrompt, /bounded offset\/limit ranges, initially at most 80 lines/u);
    await read(runtime, await fs.readFile(file, "utf8"), "artifact", file);
    const policy = await fs.readFile(alias, "utf8");
    await read(runtime, policy, "policy", alias);
    return output({ summary: "Checked the selected policy.", stopClassification: "TASK_COMPLETE", stage: null, findings: [],
      metricObjectJudgements: [{ objectId: "M01:R1", judgement: policy === "ALLOW\n" ? "PASS" : "DEVIATION",
        reason: "The selected policy controls the current artifact.", evidence: [`${file}#L1`] }] });
  });
  const allowed = path.join(f.root, "allowed"), denied = path.join(f.root, "denied"), link = path.join(f.root, "selected");
  await fs.mkdir(allowed); await fs.mkdir(denied);
  await fs.writeFile(path.join(allowed, "policy.txt"), "ALLOW\n"); await fs.writeFile(path.join(denied, "policy.txt"), "DENY\n");
  const type = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(allowed, link, type); alias = path.join(link, "policy.txt");
  f.input.request.population.metrics.M01 = f.input.request.population.metrics.M01.slice(0, 1);
  f.input.evidence.population = structuredClone(f.input.request.population);
  const input = { ...f.input, reviewerFactory: f.factory, classification: { stopClassification: "TASK_COMPLETE", stage: null } };
  const first = await collectReviewItems(input);
  assert.equal(first.result.metricObjectJudgements[0].judgement, "PASS");
  await fs.unlink(link); await fs.symlink(denied, link, type);
  const second = await collectReviewItems(input);
  assert.equal(second.collection.reusedItems, 0); assert.equal(f.calls(), 2);
  assert.equal(second.result.metricObjectJudgements[0].judgement, "DEVIATION");
});

test("an expired bounded native review does not materialize users or read catalog sources", async t => {
  const f = await fixture(t, async () => assert.fail("an expired review cannot launch a native run"));
  const material = path.join(f.root, "material.txt"); await fs.writeFile(material, "Original material.");
  f.input.request.sourceCatalog = [{ kind: "USER_MESSAGE", ref: "transcript:user" }, { kind: "MATERIAL", ref: material }];
  f.input.evidence.snapshot.entries = [{ type: "user", uuid: "user", message: { content: "Original requirement." } }];
  const writeFile = fs.writeFile, readFile = fs.readFile;
  let userWrites = 0, materialReads = 0;
  fs.writeFile = async (file, ...args) => {
    if (String(file).includes(`${path.sep}user-sources${path.sep}`)) userWrites++;
    return writeFile(file, ...args);
  };
  fs.readFile = async (file, ...args) => {
    if (file === material) materialReads++;
    return readFile(file, ...args);
  };
  t.after(() => { fs.writeFile = writeFile; fs.readFile = readFile; });
  await assert.rejects(f.factory({ ...f.input, deadlineAt: Date.now() - 1 }), { code: "REVIEWER_DEADLINE" });
  assert.equal(userWrites, 0); assert.equal(materialReads, 0); assert.equal(f.calls(), 0);
});

test("native finalization checks cancellation after freezing an otherwise small request", async t => {
  const controller = new AbortController();
  const f = await fixture(t, async () => assert.fail("cancelled native finalization cannot launch"), { abortSignal: controller.signal });
  const rename = fs.rename;
  let requestWrites = 0, frozenWrites = 0;
  fs.rename = async (from, to) => {
    const result = await rename(from, to);
    if (path.basename(to) === "frozen-ground-truth.json") { frozenWrites++; controller.abort(); }
    if (path.basename(to) === "request.json") requestWrites++;
    return result;
  };
  t.after(() => { fs.rename = rename; });
  await assert.rejects(f.factory(f.input), { code: "REVIEWER_CANCELLED" });
  assert.equal(frozenWrites, 1); assert.equal(requestWrites, 0); assert.equal(f.calls(), 0);
});

test("bounded Stop repairs annotated evidence references in the same session without dropping a finding", async t => {
  for (const kind of ["metric", "finding", "file", "mixed"]) await t.test(kind, async t => {
    let calls = 0, session;
    const f = await fixture(t, async ({ params, file }) => {
      calls++;
      session ??= params.sessionId;
      assert.equal(params.sessionId, session);
      const schema = JSON.parse(params.extraSystemPrompt.split("matching this schema:\n").at(-1));
      for (const [collection, field] of [["metricObjectJudgements", "evidence"], ["findings", "actualEvidence"], ["fileAssessments", "evidence"]])
        assert.equal(schema.properties[collection].items.properties[field].items.pattern, "^.+(?:#L|:)[1-9][0-9]*(?:-(?:L)?[1-9][0-9]*)?$");
      assert.match(params.extraSystemPrompt, /ONLY kitchen\.py:148-149 or \/absolute\/path\/kitchen\.py#L148-L149/u);
      if (calls === 2) {
        assert.match(params.prompt, /Use ONLY path#Lstart-Lend.*without copied code, labels or commentary/u);
        if (kind === "mixed") {
          assert.match(params.prompt, /Fix ALL evidence\/actualEvidence\/file references together \(3 invalid/u);
          assert.match(params.prompt, /metricObjectJudgements\.evidence.*findings\.actualEvidence.*fileAssessments\.evidence/u);
          assert.equal((params.prompt.match(/\[[0-9]+\]=/gu) ?? []).length, 3, "one short example for each bad reference, capped at three");
        }
      }
      const ref = calls === 1 ? `${file}:1-1: copied code (claim label)` : `${file}#L1-L1`;
      return output({ summary: "A real business deviation remains.", stopClassification: "TASK_COMPLETE",
        metricObjectJudgements: ["metric", "mixed"].includes(kind) ? [{ objectId: "M01:R1", judgement: "DEVIATION", reason: "The source contradicts R1.", evidence: [ref] }] : [],
        findings: ["finding", "mixed"].includes(kind) ? [{ deviationKey: "real-defect", rootCauseId: "OTHER", severity: "error", reason: "The source contradicts R1.", actualEvidence: [ref], expectedConstraint: "R1", violatedGroundTruthIds: ["R1"] }] : [],
        ...(["file", "mixed"].includes(kind) ? { fileAssessments: [{ path: file, status: "DEVIATION", reason: "The source contradicts R1.", evidence: [ref] }] } : {}) });
    });
    const handle = await f.factory(f.input);
    assert.equal(calls, 2);
    const rows = [...handle.result.metricObjectJudgements, ...handle.result.findings, ...(handle.result.fileAssessments ?? [])];
    assert.equal(rows.length, kind === "mixed" ? 3 : 1);
    for (const row of rows) {
      assert.equal(row.reason, "The source contradicts R1.");
      assert.match((row.evidence ?? row.actualEvidence)[0], /#L1-L1$/u);
    }
    assert.equal(f.input.schema.properties.metricObjectJudgements.items.properties.evidence.items.pattern, undefined, "only the private schema clone is tightened");
    await handle.close();
  });
});
