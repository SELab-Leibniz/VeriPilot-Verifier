import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runStopTaskReview } from "../lib/runtime-v2/stop-task-review.mjs";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { runOpenClawStopTask } from "../lib/openclaw/stop-task-runtime.mjs";
import { IMPL_REVIEW_SCHEMA } from "../lib/runtime-v2/impl-review.mjs";
import { validateJsonSchema } from "../lib/json-schema-validator.mjs";
import { taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { ModelRuntime } from "../lib/review-task/sdk.mjs";
import { METRIC_CATALOG } from "../lib/runtime-v2/metrics.mjs";
import { withTestReviewProof } from "./helpers/review-proof.mjs";

async function fixture(t) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-task-compat-runs/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "case-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "compat-task", directory = taskDirectory(root, taskId);
  const groundTruthPath = path.join(directory, "ground-truth/current.json");
  const claim = { claimId: "R1", revisionId: "R1@1", text: "Preserve the supplied value in the current source implementation.",
    category: "requirements", status: "ACTIVE", severity: "HARD", authority: "USER_EXPLICIT", verificationTarget: "IMPLEMENTATION",
    applicability: "CURRENT_TASK", source: { ref: "user:1", kind: "USER_MESSAGE", subject: "MAIN_TASK" } };
  const truth = { taskId, version: 1, claims: [claim], digest: sha256([claim]) };
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  await fs.writeFile(path.join(directory, "task.json"), JSON.stringify({ taskId, groundTruth: { version: 1, digest: truth.digest }, correctionEpoch: { id: 1 }, control: { generation: 1 } }));
  const source = path.join(root, "Main.ets");
  await fs.writeFile(source, "export function preserve(value: string): string { return value; }\n");
  const object = { objectId: "M12:R1", sourceId: "R1", sourceRevisionId: "R1@1", metricId: "M12", description: claim.text,
    verificationTarget: "IMPLEMENTATION", applicability: "CURRENT_TASK", hard: true, authority: "USER_EXPLICIT" };
  const population = { taskId, version: 1, groundTruthVersion: 1, metrics: { M12: [object] } };
  const input = { projectRoot: root, taskId, role: "implementation-reviewer", reviewer: { timeoutMs: 3000 },
    request: { population, groundTruthPath, sourceManifest: [{ path: source, sha256: sha256(await fs.readFile(source)) }],
      reviewScope: { objectIds: [object.objectId], sourceIds: [object.sourceId] }, instructions: ["Judge only the supplied source obligation."] },
    evidence: { groundTruth: truth }, deadlineAt: Date.now() + 30000 };
  return { root, source, input };
}

async function decision(options, verdict = "PASS") {
  const file = "project/Main.ets", bytes = await fs.readFile(path.join(options.root, file));
  await fs.mkdir(path.join(options.outputDir, "frozen-source/project"), { recursive: true });
  await fs.writeFile(path.join(options.outputDir, "frozen-source", file), bytes);
  return { taskId: options.task.id, scope: options.task.scope, completed: true, verdict,
    reason: verdict === "PASS" ? "The source returns the supplied value unchanged." : "The source contradicts this assigned behavior.",
    refs: [{ path: file, start: 1, end: 1, sha256: sha256(bytes) }] };
}

test("implementation task reports satisfy IMPL schema without Stop-only fields", async t => {
  const f = await fixture(t);
  for (const verdict of ["PASS", "DEVIATION"]) {
    const handle = await runStopTaskReview(f.input, { runTask: options => decision(options, verdict) });
    assert.deepEqual(validateJsonSchema(handle.result, IMPL_REVIEW_SCHEMA), []);
    assert.equal(handle.result.metricObjectJudgements[0].judgement, verdict);
    for (const field of ["stopClassification", "stage", "fileAssessments"]) assert.equal(Object.hasOwn(handle.result, field), false);
  }
});

test("a restricted helper in a manifest stays unread while authorized source remains reviewable", async t => {
  const f = await fixture(t), helper = path.join(f.root, "PaySecretUtil.ets");
  await fs.writeFile(helper, "PRIVATE_HELPER_CANARY_MUST_REMAIN_OUTSIDE_REVIEW_INPUT\n");
  f.input.request.sourceManifest.push({ path: helper, sha256: sha256(await fs.readFile(helper)) });
  let calls = 0;
  const handle = await runStopTaskReview(f.input, { runTask: async options => {
    calls++;
    await assert.rejects(fs.readFile(path.join(options.root, "project/PaySecretUtil.ets")), error => error.code === "ENOENT");
    assert.match(await fs.readFile(path.join(options.root, "project/Main.ets"), "utf8"), /return value/u);
    return decision(options);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(validateJsonSchema(handle.result, IMPL_REVIEW_SCHEMA), []);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
  assert.match(await fs.readFile(helper, "utf8"), /PRIVATE_HELPER_CANARY/u);
});

test("host models without pricing register a complete SDK cost shape before a cancelled task", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  const definition = { id: "scripted-cost-check", name: "scripted-cost-check", contextWindow: 32768, maxTokens: 8192 };
  const selection = { provider: "configured", model: definition.id, config: { models: { providers: {
    configured: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline-cost-placeholder", models: [definition] },
  } } } };
  const before = structuredClone(selection);
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  let registered, model, calls = 0;
  t.mock.method(ModelRuntime, "create", async options => {
    calls++;
    const runtime = await originalCreate(options);
    const register = runtime.registerProvider.bind(runtime), getModel = runtime.getModel.bind(runtime);
    runtime.registerProvider = (id, config) => { registered = config; return register(id, config); };
    runtime.getModel = (...args) => { model = getModel(...args); return model; };
    return runtime;
  });
  await assert.rejects(runOpenClawStopTask({ ...f.input, abortSignal: controller.signal }, { selection, env: {}, options: {} }),
    error => error.code === "REVIEW_COLLECTION_CANCELLED");
  assert.equal(calls, 1);
  assert.deepEqual(registered.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(model.cost, registered.models[0].cost);
  assert.deepEqual(selection, before, "SDK normalization must not mutate host configuration.");
});

async function failedDecision(options, reason) {
  await fs.mkdir(options.outputDir, { recursive: true });
  const result = { taskId: options.task.id, scope: options.task.scope, completed: false, verdict: "UNVERIFIED", reason, refs: [] };
  await fs.writeFile(path.join(options.outputDir, "result.json"), JSON.stringify(result));
  return result;
}

async function collectFailedTask(f, reason) {
  const factory = input => runStopTaskReview(input, { runTask: options => failedDecision(options, reason) });
  factory.reviewItemSize = 1;
  return collectReviewItems({ ...f.input, reviewerFactory: factory, schema: IMPL_REVIEW_SCHEMA });
}

test("an incomplete worker keeps its public context cause and saved result path in collector feedback", async t => {
  const f = await fixture(t);
  const handle = await collectFailedTask(f, "CONTEXT_UNSAFE: projected input leaves no output space");
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.collection.failures.length, 1);
  const failure = handle.collection.failures[0];
  assert.equal(failure.code, "REVIEW_ITEM_INCOMPLETE");
  assert.equal(failure.diagnostic.cause, "CONTEXT_UNSAFE");
  const expectedRoot = path.join(taskDirectory(f.root, f.input.taskId), "review-task-runs");
  const relative = path.relative(expectedRoot, failure.diagnostic.resultPath);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.equal(path.basename(failure.diagnostic.resultPath), "result.json");
  assert.match(failure.reason, /CONTEXT_UNSAFE/u);
  assert.ok(failure.reason.includes(failure.diagnostic.resultPath));
  const saved = JSON.parse(await fs.readFile(failure.diagnostic.resultPath, "utf8"));
  assert.equal(saved.completed, false);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  assert.deepEqual(handle.result.findings, [], "A context failure is not a business deviation.");
  const item = JSON.parse(await fs.readFile(handle.collection.items[0].path, "utf8"));
  assert.deepEqual(item.failure.diagnostic, failure.diagnostic, "The durable item retains the same public diagnostic.");
});

test("an unknown incomplete error exposes NO_VALID_SUBMISSION without provider text", async t => {
  const f = await fixture(t), secret = "PRIVATE_PROVIDER_HEADER_CANARY_8291";
  const handle = await collectFailedTask(f, `Unexpected provider response; Authorization: Bearer ${secret}`);
  const failure = handle.collection.failures[0];
  assert.equal(failure.diagnostic.cause, "NO_VALID_SUBMISSION");
  assert.match(failure.reason, /NO_VALID_SUBMISSION/u);
  assert.equal(JSON.stringify({ result: handle.result, failures: handle.collection.failures }).includes(secret), false);
  assert.equal(JSON.stringify(handle.collection.failures).includes("Authorization"), false);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  assert.deepEqual(handle.result.findings, []);
  assert.equal(path.basename(failure.diagnostic.resultPath), "result.json");
});

test("all known single-review metrics remain separate while unknown metric groups retain compatibility", async t => {
  const f = await fixture(t), classification = { stopClassification: "TASK_COMPLETE", stage: null };
  const base = f.input.request.population.metrics.M12[0];
  const metrics = ["M01", "M05", "M02", "M03", "M90", "M91"];
  const rows = metrics.map(metricId => ({ ...base, metricId, objectId: `${metricId}:R1`, verificationTarget: "ARTIFACT" }));
  const population = { ...f.input.request.population, metrics: Object.fromEntries(rows.map(row => [row.metricId, [row]])) };
  const seen = [];
  const factory = async input => {
    const owned = Object.values(input.request.population.metrics).flat();
    seen.push(owned.map(row => row.metricId));
    return withTestReviewProof(input, { result: { summary: "The assigned scope was checked.", ...classification, findings: [], fileAssessments: [],
      metricObjectJudgements: owned.map(row => ({ objectId: row.objectId, judgement: "PASS", reason: "The current file supports this assigned object.", evidence: [`${f.source}#L1-L1`] })) },
      sourceCitations: [], close: async () => {} });
  };
  factory.reviewItemSize = 1;
  factory.singleReviewMetrics = Object.keys(METRIC_CATALOG);
  const input = { ...f.input, role: "stop-reviewer", request: { ...f.input.request, population }, evidence: { ...f.input.evidence, population } };
  const handle = await collectReviewItems({ ...input, reviewerFactory: factory, schema: STOP_REVIEW_SCHEMA, classification });
  assert.deepEqual(seen, [["M01"], ["M05"], ["M02"], ["M03"], ["M90", "M91"]]);
  assert.equal(handle.collection.totalItems, 5);
  assert.equal(handle.collection.totalObjects, 6);
  assert.equal(handle.collection.complete, true);
  assert.equal(handle.result.metricObjectJudgements.length, 6);
});

test("the OpenClaw wrapper relays only a whitelisted cause and this task's result path", async t => {
  for (const name of ["valid", "foreign-path", "unknown-cause"]) await t.test(name, async t => {
    const f = await fixture(t), secret = "PRIVATE_PROVIDER_EXCEPTION_CANARY_5117";
    const localResult = path.join(taskDirectory(f.root, f.input.taskId), "review-task-runs", "worker-check", "review", "result.json");
    await fs.mkdir(path.dirname(localResult), { recursive: true });
    await fs.writeFile(localResult, JSON.stringify({ completed: false, verdict: "UNVERIFIED" }));
    const diagnostic = { cause: name === "unknown-cause" ? secret : "CONTEXT_UNSAFE",
      resultPath: name === "foreign-path" ? path.join(f.root, "foreign-worker/result.json") : localResult };
    const modelId = "scripted-wrapper-check";
    const selection = { provider: "configured", model: modelId, config: { models: { providers: {
      configured: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline-wrapper-placeholder",
        models: [{ id: modelId, contextWindow: 32768, maxTokens: 8192 }] },
    } } } };
    t.mock.method(ModelRuntime, "create", async () => {
      throw Object.assign(new Error(`Unexpected Authorization header: ${secret}`),
        { code: "REVIEW_ITEM_INCOMPLETE", reviewDiagnostic: diagnostic });
    });
    await assert.rejects(runOpenClawStopTask(f.input, { selection, env: {}, options: {} }), error => {
      assert.equal(error.code, "REVIEW_ITEM_INCOMPLETE");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("Authorization"), false);
      if (name === "valid") {
        assert.deepEqual(error.reviewDiagnostic, { cause: "CONTEXT_UNSAFE", resultPath: localResult });
        assert.ok(error.message.includes(localResult));
        assert.match(error.message, /CONTEXT_UNSAFE/u);
      } else {
        assert.equal(error.reviewDiagnostic, undefined);
        assert.equal(error.message.includes(diagnostic.resultPath), false);
      }
      return true;
    });
  });
});
