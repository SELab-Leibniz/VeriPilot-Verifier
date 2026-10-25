import { isolatedNativeReviewHost } from "./lib/native-review-host.mjs";
// One production Stop-item smoke test from an already frozen local capture.
// Default is material/route preflight. No original project/session or business execution.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createOpenClawReviewerFactory } from "../../lib/openclaw/reviewer.mjs";
import { canUseStopTaskReview } from "../../lib/runtime-v2/stop-task-review.mjs";
import { collectReviewItems } from "../../lib/runtime-v2/review-collector.mjs";
import { ensureTask, taskDirectory, withTaskState } from "../../lib/runtime-v2/task-store.mjs";
import { currentGroundTruthPath, freezeGroundTruth } from "../../lib/runtime-v2/ground-truth-ledger.mjs";
import { STOP_REVIEW_SCHEMA } from "../../lib/runtime-v2/reviewer.mjs";
import { reviewScopeClaims } from "../../lib/runtime-v2/review-scope.mjs";
import { prepareHostFeedback, HOST_FEEDBACK_MAX_BYTES } from "../../lib/runtime-v2/feedback-delivery.mjs";
import { atomicWriteJson } from "../../lib/runtime-v2/utils.mjs";

const repository = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const lab = path.join(repository, ".runtime-correction/review-module-lab-20261024-02");
const frozen = path.join(lab, "complex-preflight-01"), workspace = path.join(frozen, "workspace");
const hash = value => createHash("sha256").update(value).digest("hex");
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const within = (root, file) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const args = process.argv.slice(2), live = args.includes("--live"), name = args.find(value => !value.startsWith("--"))
  ?? `stop-integration-complex-${Date.now()}`;
if (args.some(value => value.startsWith("--") && value !== "--live") || !/^stop-integration-complex-[A-Za-z0-9-]+$/u.test(name))
  throw new Error("Usage: node stop-task-complex.mjs [stop-integration-complex-NEW] [--live]");
const outputParent = path.join(repository, ".runtime-correction"), output = path.join(outputParent, name);
const parentCapMs = 120000;
let modelSettings = null;
const publicError = error => {
  let text = String(error.message ?? error);
  for (const secret of modelSettings?.secrets ?? []) text = text.replaceAll(secret, "[REDACTED]");
  return { code: error.code ?? "COMPLEX_DIAGNOSTIC_FAILED", message: text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/giu, "Bearer [REDACTED]").slice(0, 1500) };
};

async function modelConfiguration() {
  const files = [path.join(os.homedir(), ".openclaw/openclaw.json"), path.join(os.homedir(), ".openclaw/agents/main/agent/models.json")];
  const bytes = await Promise.all(files.map(file => fs.readFile(file)));
  let config, cached;
  try { [config, cached] = bytes.map(value => JSON.parse(value.toString("utf8"))); }
  catch { throw new Error("Authorized model configuration is invalid JSON."); }
  const selected = config.agents?.defaults?.model;
  const primary = typeof selected === "string" ? selected : selected?.primary, slash = primary?.indexOf("/");
  if (!(slash > 0)) throw new Error("Existing primary model needs provider/model identity.");
  const providerId = primary.slice(0, slash), modelId = primary.slice(slash + 1);
  const configured = config.models?.providers?.[providerId], fallback = cached.providers?.[providerId];
  const provider = { ...fallback, ...configured, apiKey: configured?.apiKey ?? fallback?.apiKey,
    headers: configured?.headers ?? fallback?.headers, models: configured?.models ?? fallback?.models };
  const definition = provider.models?.find(value => value.id === modelId || value.id === primary);
  if (!definition || !provider.api || !provider.baseUrl) throw new Error("Existing provider/model is unavailable.");
  const resolve = value => typeof value === "string" ? value.replace(/\$\{([^}]+)\}/gu, (_match, key) => process.env[key] ?? "") : value;
  const secrets = [resolve(provider.apiKey), ...Object.entries(provider.headers ?? {}).filter(([key]) => /auth|key|token/iu.test(key)).map(([, value]) => resolve(value))]
    .filter(value => typeof value === "string" && value.length >= 12);
  const local = structuredClone(config);
  local.models = { ...local.models, providers: { ...local.models?.providers, [providerId]: provider } };
  return { config: local, providerId, modelId, secrets,
    identity: { providerId, modelId, api: provider.api, contextWindow: definition.contextWindow, maxTokens: definition.maxTokens },
    unchanged: async () => (await Promise.all(files.map(file => fs.readFile(file)))).every((value, index) => value.equals(bytes[index])) };
}

async function main() {
  await fs.mkdir(outputParent, { recursive: true });
  assert.equal(await fs.realpath(outputParent), outputParent);
  await fs.mkdir(output, { mode: 0o700 });
  assert(within(lab, await fs.realpath(frozen)));
  const codeFiles = ["lib/openclaw/reviewer.mjs", "lib/openclaw/stop-task-runtime.mjs", "lib/runtime-v2/stop-task-review.mjs",
    "lib/runtime-v2/review-collector.mjs", "lib/review-task/review-task.mjs", "lib/review-task/history-memory.mjs",
    "lib/review-task/prompts.json", "lib/review-task/prompt-profile.mjs", "lib/review-task/package-lock.json", "scripts/diagnostics/stop-task-complex.mjs"];
  const codeIdentity = Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, hash(await fs.readFile(path.join(repository, file)))])));
  await save(path.join(output, "code-identity.json"), codeIdentity);
  const originalReport = await read(path.join(frozen, "report.json"));
  const observed = new Map();
  const original = async (relative, expected = null) => {
    const file = path.resolve(workspace, relative);
    assert(within(workspace, file));
    const bytes = await fs.readFile(file);
    if (expected) assert.equal(hash(bytes), expected, `Frozen source differs: ${relative}`);
    observed.set(file, hash(bytes)); return bytes;
  };
  const reportHash = relative => originalReport.provenance.find(value => value.destination?.replaceAll("\\", "/").endsWith(`/${relative}`))?.sha256;
  const requiredFiles = ["provenance/ground-truth.full.original.json", "provenance/population.full.original.json"];
  const [truthBytes, populationBytes] = await Promise.all(requiredFiles.map(relative => {
    const expected = reportHash(relative); assert(expected, `Frozen provenance has no hash for ${relative}`); return original(relative, expected);
  }));
  const fullTruth = JSON.parse(truthBytes), originalPopulation = JSON.parse(populationBytes);
  const exactBasis = await original("provenance/required-basis.original.json", originalReport.exactBasisSha256);
  const basis = JSON.parse(exactBasis), basisClaimIds = new Set(basis.claims.map(value => value.claimId));
  assert.equal(basis.claims.filter(value => value.claimId === "f1").length, 1);
  assert.equal(basis.claims.filter(value => value.claimId !== "f1").length, 79);
  for (const claim of basis.claims) assert.deepEqual(claim, fullTruth.claims.find(value => value.claimId === claim.claimId && value.revisionId === claim.revisionId));
  const selected = reviewScopeClaims(fullTruth, { sourceIds: ["f1"] });
  assert.equal(selected.length, 80, "Current scope selection must retain the complete original f1+79 basis.");
  assert.deepEqual(selected.map(value => value.claimId).sort(), [...basisClaimIds].sort());
  const object = originalPopulation.metrics.M01.find(value => value.sourceId === "f1");
  assert(object && object.objectId === "M01:f1" && object.applicability === "CURRENT_TASK");
  const sourceManifest = await read(path.join(workspace, "provenance/source-manifest.json"));
  const originalSources = originalReport.provenance.filter(value => value.destination?.replaceAll("\\", "/").includes("/workspace/source/"));
  assert.equal(sourceManifest.length, originalSources.length, "Frozen source manifest omitted an original capture entry.");
  for (const source of sourceManifest) assert.equal(source.sha256,
    originalSources.find(value => value.destination.replaceAll("\\", "/").endsWith(`/${source.path}`))?.sha256);
  const projectRoot = path.join(output, "project"); await fs.mkdir(projectRoot);
  for (const source of sourceManifest) {
    assert(source.path.startsWith("source/"));
    const bytes = await original(source.path, source.sha256), destination = path.resolve(projectRoot, source.path);
    assert(within(path.join(projectRoot, "source"), destination));
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: "wx" });
  }
  const sessionId = `stop-complex-${randomUUID()}`, task = await ensureTask({ projectRoot, sessionId });
  // Preserve every original claim/revision/condition/authority, including the
  // original f1 AGENT_INFERRED/SOFT status. Only this copy's task identity differs.
  const current = { ...fullTruth, taskId: task.taskId };
  const groundTruthPath = currentGroundTruthPath(projectRoot, task.taskId);
  await atomicWriteJson(groundTruthPath, current);
  await withTaskState({ projectRoot, taskId: task.taskId }, state => { state.groundTruth = { ...state.groundTruth,
    version: current.version, digest: current.digest, frozenAtVersion: current.frozenAtVersion ?? null }; });
  const { current: truth } = await freezeGroundTruth({ projectRoot, taskId: task.taskId, reason: "ISOLATED_COMPLEX_STOP_CAPTURE" });
  assert.deepEqual(truth.claims, fullTruth.claims);
  const metrics = { M01: [structuredClone(object)] };
  const population = { ...originalPopulation, taskId: task.taskId, metrics,
    digest: hash(JSON.stringify(metrics)), metricCatalog: { M01: originalPopulation.metricCatalog.M01 } };
  const classification = { stopClassification: "TASK_COMPLETE", stage: null };
  const request = { schemaVersion: "runtime-corrector.complex-stop-stage.v1", projectRoot, taskId: task.taskId,
    population, groundTruthPath, fixedStopClassification: classification,
    reviewScope: { boundedBasis: true, objectIds: [object.objectId], sourceIds: [object.sourceId] },
    instructions: [
      "Review only original M01:f1 requirement-decomposition coverage, not implementation quality or runtime acceptance. The complete original requirement is unchanged.",
      "Read every mandatory basis part, including all 79 unchanged original common conditions and exceptions. Do not waive obligations, promote SOFT/inferred claims to authoritative HARD claims, or invent evidence. Preserve dependency/applicability uncertainty.",
      "The original candidate decomposition and design are under source/openspec/; source/app-requirements.md is the original requirement basis, not candidate proof. Inspect actual candidate meaning, including equivalent expression across documents. Do not replace decomposition coverage with production-source behavior.",
      "This is one frozen object, not the complete metric or project. The full original canonical baseline is retained for unresolved dependencies. Navigation does not prove absence or compliance.",
      "Only read-only inspection is authorized. Do not run the app, verifier, build, commands or contact the original project/session. Missing runtime/process proof is not automatically a defect in M01 decomposition coverage.",
    ] };
  const input = { projectRoot, sessionCwd: projectRoot, taskId: task.taskId, parentSessionId: sessionId, role: "stop-reviewer",
    reviewer: { session: "detached", timeoutMs: parentCapMs }, schema: structuredClone(STOP_REVIEW_SCHEMA),
    request, evidence: { groundTruth: truth, population, snapshot: { entries: [] } } };
  const plugin = await read(path.join(repository, "packaging/hosts/openclaw/openclaw.plugin.json"));
  const report = { schemaVersion: "runtime-corrector.complex-stop-task-smoke.v1", mode: live ? "LIVE_PRODUCTION_FACTORY_COLLECTOR" : "OFFLINE_PREFLIGHT",
    status: "RUNNING", output, pluginVersion: plugin.version, parentCapMs, singleObject: object,
    originalAuthorityPreserved: true, commonConditions: 79, totalSelectedClaims: 80, fullCanonicalClaims: truth.claims.length,
    exactMandatoryBasisBytes: exactBasis.length, exactMandatoryBasisSha256: hash(exactBasis),
    originalMandatoryBasisParts: originalReport.provenance.filter(value => /required-basis-part-\d+\.original\.txt$/u.test(value.destination?.replaceAll("\\", "/") ?? "")).length,
    copiedSourceFiles: sourceManifest.length,
    copiedSourceBytes: sourceManifest.reduce((total, source) => total + source.bytes, 0), preparedCallerRequestBytes: Buffer.byteLength(JSON.stringify(request)),
    routeEligible: canUseStopTaskReview(input), initialPromptBytes: null, maxEstimatedContextTokens: null,
    originalProjectReadOrWritten: false, originalSessionReadOrWritten: false, gatewayUsed: false, businessExecution: false,
    fullStopOrchestrator: false, wholeProjectPassClaimed: false, completed: null, verdict: null };
  assert(report.routeEligible, "Original object's target/applicability is unsupported; do not rewrite it to force routing.");
  await save(path.join(output, "prepared-stage.json"), { taskId: task.taskId, sessionId, request, retainedBasisClaimIds: [...basisClaimIds],
    note: "Original full canonical and original object metadata retained. Only source tree is copied as business files; old provenance/process indexes are not duplicated into candidate evidence." });
  const gtBefore = hash(await fs.readFile(groundTruthPath));
  if (live) {
    modelSettings = await modelConfiguration(); report.model = modelSettings.identity;
    let fallbackCalls = 0;
    const host = await isolatedNativeReviewHost({ config: modelSettings.config, directory: path.join(output, 'host') });
    const api = host.api;
    const deadlineAt = Date.now() + parentCapMs;
    const factory = createOpenClawReviewerFactory(api, { stopReviewEngine: "task", provider: modelSettings.providerId, model: modelSettings.modelId,
      reviewerTimeoutMs: parentCapMs, deadlineAt, runEmbeddedAgent: params => {
        if (!params.toolsAllow?.includes('submit_review')) { fallbackCalls++; throw new Error('Legacy JSON fallback is forbidden in this task diagnostic'); }
        return host.runEmbeddedAgent(params);
      }, compatibility: host.compatibility });
    report.factoryIdentity = factory.reviewCacheIdentity(input.reviewer);
    let handle;
    try {
      handle = await collectReviewItems({ ...input, reviewerFactory: factory, classification, deadlineAt });
      const row = handle.result.metricObjectJudgements.find(value => value.objectId === object.objectId);
      const citations = await handle.getSourceCitations(handle.result);
      for (const citation of citations) {
        const bytes = await fs.readFile(citation.snapshotPath), lines = bytes.toString("utf8").split("\n");
        assert.equal(hash(bytes), citation.contentHash); assert(citation.start >= 1 && citation.end <= lines.length && citation.end >= citation.start);
        assert.equal(lines.slice(citation.start - 1, citation.end).join("\n"), citation.exactQuote);
      }
      report.completed = handle.collection.complete && handle.collection.completedItems === 1;
      report.verdict = row?.judgement ?? null; report.diagnosis = row?.reason ?? null; report.citationIntegrity = true;
      const review = { ...handle.result, collection: handle.collection };
      const feedback = await prepareHostFeedback({ projectRoot, taskId: task.taskId, text: `Single complex M01 object: ${report.verdict}.`, review, citations, locale: "zh-CN" });
      report.feedbackBytes = Buffer.byteLength(feedback); assert(report.feedbackBytes <= HOST_FEEDBACK_MAX_BYTES);
      await fs.writeFile(path.join(output, "feedback.txt"), feedback, { flag: "wx" });
      await save(path.join(output, "collection-result.json"), { result: handle.result, collection: handle.collection, citations });
    } catch (error) { report.error = publicError(error); report.completed = false; }
    finally { await handle?.close?.(); host.close(); }
    report.nativeFallbackCalls = fallbackCalls; assert.equal(fallbackCalls, 0);
    const runs = path.join(taskDirectory(projectRoot, task.taskId), "review-task-runs");
    report.workerRuns = [];
    for (const name of await fs.readdir(runs).catch(() => [])) {
      const root = path.join(runs, name, "review");
      const worker = await read(path.join(root, "result.json")).catch(() => null);
      const events = await fs.readFile(path.join(root, "events.jsonl"), "utf8").then(text => text.trim().split("\n").filter(Boolean).map(JSON.parse)).catch(() => []);
      const promptBytes = await fs.stat(path.join(root, "prompt.txt")).then(value => value.size).catch(() => null);
      report.initialPromptBytes ??= promptBytes;
      const estimates = events.filter(value => value.type === "context_check").map(value => value.estimatedTokens).filter(Number.isFinite);
      if (estimates.length) report.maxEstimatedContextTokens = Math.max(report.maxEstimatedContextTokens ?? 0, ...estimates);
      report.workerRuns.push({ path: root, completed: worker?.completed ?? false, verdict: worker?.verdict ?? null,
        metrics: worker?.metrics ?? null, initialPromptBytes: promptBytes, contextEstimateMethod: "Worker context_check estimator; not an exact tokenizer or HTTP payload capture.",
        assistantReplies: events.filter(value => value.type === "assistant").length });
    }
    report.modelConfigurationUnchanged = await modelSettings.unchanged();
  }
  const protectedFiles = [...observed];
  report.frozenCaptureUnchanged = (await Promise.all(protectedFiles.map(async ([file, digest]) => hash(await fs.readFile(file)) === digest))).every(Boolean);
  report.copiedBusinessSourcesUnchanged = (await Promise.all(sourceManifest.map(async source => hash(await fs.readFile(path.join(projectRoot, source.path))) === source.sha256))).every(Boolean);
  report.groundTruthUnchanged = hash(await fs.readFile(groundTruthPath)) === gtBefore;
  report.codeUnchanged = (await Promise.all(codeFiles.map(async file => codeIdentity[file] === hash(await fs.readFile(path.join(repository, file)))))).every(Boolean);
  report.credentialValueFindings = [];
  if (modelSettings?.secrets.length) {
    const scan = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        assert(!entry.isSymbolicLink());
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else if (entry.isFile()) {
          const bytes = await fs.readFile(file);
          if (modelSettings.secrets.some(secret => bytes.includes(Buffer.from(secret)))) report.credentialValueFindings.push(path.relative(output, file));
        }
      }
    };
    await scan(output);
  }
  report.protectedInputs = report.frozenCaptureUnchanged && report.copiedBusinessSourcesUnchanged && report.groundTruthUnchanged && report.codeUnchanged
    && report.modelConfigurationUnchanged !== false && report.credentialValueFindings.length === 0;
  report.status = !report.protectedInputs ? "PROTECTION_FAILED" : !live ? "PREFLIGHT_PASS" : report.completed ? "COMPLETE_PENDING_SEMANTIC_REVIEW" : "INCOMPLETE";
  report.limitations = ["One original soft/inferred M01 object; not a HARD implementation gate or full project PASS.",
    "No complete Stop/Gateway lifecycle, business correction loop, disabled arm or end-to-end application execution.",
    "Preflight has no measured actual prompt/model context; those fields are populated only after explicit live execution.",
    "Context estimates are worker health margins, not exact tokens or captured HTTP request bytes. No budget increase."];
  await save(path.join(output, "report.json"), report);
  console.log(JSON.stringify({ status: report.status, output, commonConditions: 79, sourceFiles: sourceManifest.length, completed: report.completed, verdict: report.verdict }));
  if (!report.protectedInputs || live && !report.completed) process.exitCode = 1;
}

await main().catch(async error => {
  const result = { status: "PREPARATION_FAILED", error: publicError(error), output };
  await save(path.join(output, "failure.json"), result).catch(() => {});
  console.error(JSON.stringify(result)); process.exitCode = 1;
});
