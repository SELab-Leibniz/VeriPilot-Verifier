import { isolatedNativeReviewHost } from "./lib/native-review-host.mjs";
// Frozen fixture -> production OpenClaw factory -> production item collector.
// No Gateway, original business project/session, business execution or oracle injection.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createOpenClawReviewerFactory } from "../../lib/openclaw/reviewer.mjs";
import { canUseStopTaskReview } from "../../lib/runtime-v2/stop-task-review.mjs";
import { collectReviewItems } from "../../lib/runtime-v2/review-collector.mjs";
import { ensureTask, taskDirectory } from "../../lib/runtime-v2/task-store.mjs";
import { applyGroundTruthDelta, freezeGroundTruth, currentGroundTruthPath } from "../../lib/runtime-v2/ground-truth-ledger.mjs";
import { STOP_REVIEW_SCHEMA } from "../../lib/runtime-v2/reviewer.mjs";
import { IMPL_REVIEW_SCHEMA } from "../../lib/runtime-v2/impl-review.mjs";
import { prepareHostFeedback, HOST_FEEDBACK_MAX_BYTES } from "../../lib/runtime-v2/feedback-delivery.mjs";
import { METRIC_CATALOG, METRIC_CATALOG_VERSION } from "../../lib/runtime-v2/metrics.mjs";

const repository = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const experiment = path.join(repository, ".runtime-correction/review-module-lab-20261024-02/prompt-accuracy-20261024-01");
const hash = value => createHash("sha256").update(value).digest("hex");
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const within = (root, file) => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const defaults = ["K01", "K04", "K07", "K08", "K09", "F08", "F07"];
const supportedCases = [...defaults, "K02", "K05"];
const args = process.argv.slice(2), live = args.includes("--live");
const destination = args.find(value => !value.startsWith("--"));
if (args.some(value => value.startsWith("--") && value !== "--live" && !value.startsWith("--cases="))) throw new Error("Unknown diagnostic option.");
const caseIds = args.find(value => value.startsWith("--cases="))?.slice(8).split(",") ?? defaults;
if (!caseIds.length || new Set(caseIds).size !== caseIds.length || caseIds.some(id => !supportedCases.includes(id))) throw new Error("Unsupported or duplicate fixture case.");
const outputParent = path.join(repository, ".runtime-correction");
const output = destination ? path.resolve(destination.includes("/") || destination.includes("\\") ? repository : outputParent, destination)
  : path.join(outputParent, `stop-integration-${new Date().toISOString().replace(/[^0-9TZ]/gu, "")}-${randomUUID().slice(0, 8)}`);
if (path.dirname(output) !== outputParent || !/^stop-integration-[a-zA-Z0-9-]+$/u.test(path.basename(output))) throw new Error("Output must be a new repository .runtime-correction/stop-integration-* directory.");

async function manifest(root, skipRuntime = false) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (skipRuntime && entry.name === ".runtime-correction") continue;
      assert(!entry.isSymbolicLink(), "Fixture/business symlinks are not permitted.");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file);
        entries.push([path.relative(root, file).replaceAll("\\", "/"), { sha256: hash(bytes), lines: bytes.toString("utf8").split("\n").length }]);
      }
    }
  }
  await walk(root);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

async function configuredModel() {
  // This function is reached only by explicit --live. Neither raw file is saved.
  const files = [path.join(os.homedir(), ".openclaw/openclaw.json"), path.join(os.homedir(), ".openclaw/agents/main/agent/models.json")];
  const contents = await Promise.all(files.map(file => fs.readFile(file)));
  let config, cache;
  try { [config, cache] = contents.map(bytes => JSON.parse(bytes.toString("utf8"))); }
  catch { throw Object.assign(new Error("Existing authorized model configuration is not valid JSON."), { code: "MODEL_CONFIG_INVALID" }); }
  const configured = config.agents?.defaults?.model;
  const primary = typeof configured === "string" ? configured : configured?.primary;
  const slash = primary?.indexOf("/");
  if (!(slash > 0)) throw new Error("Existing primary model must have a provider/model identity.");
  const providerId = primary.slice(0, slash), modelId = primary.slice(slash + 1);
  const original = config.models?.providers?.[providerId], cached = cache.providers?.[providerId];
  const provider = { ...cached, ...original, apiKey: original?.apiKey ?? cached?.apiKey,
    headers: original?.headers ?? cached?.headers, models: original?.models ?? cached?.models };
  const model = provider.models?.find(item => item.id === modelId || item.id === primary);
  if (!provider.api || !provider.baseUrl || !model) throw new Error("Existing selected provider/model is unavailable.");
  const resolve = value => typeof value === "string" ? value.replace(/\$\{([^}]+)\}/gu, (_match, name) => process.env[name] ?? "") : value;
  const secrets = [resolve(provider.apiKey), ...Object.entries(provider.headers ?? {}).filter(([name]) => /auth|key|token/iu.test(name)).map(([, value]) => resolve(value))]
    .filter(value => typeof value === "string" && value.length >= 12);
  const perRun = structuredClone(config);
  perRun.models = { ...perRun.models, providers: { ...perRun.models?.providers, [providerId]: provider } };
  return { config: perRun, providerId, modelId, secrets,
    identity: { primary, providerId, modelId, api: provider.api, contextWindow: model.contextWindow,
      contextTokens: config.agents?.defaults?.contextTokens ?? null, maxTokens: model.maxTokens ?? null },
    unchanged: async () => (await Promise.all(files.map(file => fs.readFile(file)))).every((bytes, index) => bytes.equals(contents[index])) };
}

async function checkedCitations(citations, judgement) {
  for (const citation of citations) {
    const bytes = await fs.readFile(citation.snapshotPath);
    assert.equal(hash(bytes), citation.contentHash);
    const lines = bytes.toString("utf8").split("\n");
    assert(citation.start >= 1 && citation.end >= citation.start && citation.end <= lines.length);
    assert.equal(lines.slice(citation.start - 1, citation.end).join("\n"), citation.exactQuote);
    if (!citation.frozen) assert.equal(hash(await fs.readFile(citation.path)), citation.contentHash);
  }
  if (["PASS", "DEVIATION"].includes(judgement?.judgement)) assert(citations.some(citation => citation.usedBy?.includes(judgement.objectId)));
  return true;
}

let authorized = null, report = null;
const redact = value => {
  let text = String(value ?? "");
  for (const secret of authorized?.secrets ?? []) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/giu, "Bearer [REDACTED]").slice(0, 1500);
};

async function main() {
  await fs.mkdir(outputParent, { recursive: true });
  assert.equal(await fs.realpath(outputParent), outputParent);
  await fs.mkdir(output, { mode: 0o700 });
  const freeze = await read(path.join(experiment, "freeze.json"));
  const packageIdentity = await read(path.join(repository, "packaging/hosts/openclaw/openclaw.plugin.json"));
  const codeFiles = ["lib/openclaw/reviewer.mjs", "lib/openclaw/stop-task-runtime.mjs", "lib/runtime-v2/stop-task-review.mjs",
    "lib/runtime-v2/review-collector.mjs", "lib/review-task/review-task.mjs", "lib/review-task/history-memory.mjs",
    "lib/review-task/prompts.json", "lib/review-task/prompt-profile.mjs", "lib/review-task/source-tools.mjs", "lib/review-task/observation-journal.mjs", "lib/openclaw/task-tools.mjs",
    "lib/review-task/package.json", "lib/review-task/package-lock.json", "scripts/diagnostics/stop-task-integration.mjs"];
  const code = Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, hash(await fs.readFile(path.join(repository, file)))])));
  await save(path.join(output, "code-identity.json"), code);
  report = { schemaVersion: "runtime-corrector.stop-task-integration.v1", mode: live ? "LIVE_PRODUCTION_FACTORY_COLLECTOR" : "OFFLINE_PREFLIGHT",
    startedAt: new Date().toISOString(), status: "RUNNING", output, caseIds, pluginVersion: packageIdentity.version,
    commit: (await promisify(execFile)("git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
    providerConfigurationRead: false, originalProjectReadOrWritten: false, originalSessionReadOrWritten: false, businessExecution: false,
    gatewayUsed: false, installedHostApiVersion: "2026.10.3", productionFactoryAndCollector: live, fullStopOrchestrator: false,
    injectedReviewWorker: false, nativeFallbackForbidden: true, wholeProjectPassClaimed: false,
    disabledControlRun: false, wholeBusinessImprovementProven: false, rows: [] };
  if (live) { authorized = await configuredModel(); report.providerConfigurationRead = true; report.model = authorized.identity; }
  for (const caseId of caseIds) {
    const caseDirectory = path.join(output, caseId), projectRoot = path.join(caseDirectory, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    const fixtureRoot = path.join(experiment, "fixtures", caseId.startsWith("K") ? "kitchen" : "flower", caseId);
    assert(within(experiment, fixtureRoot));
    const workspace = path.join(fixtureRoot, "workspace"), taskFile = path.join(fixtureRoot, "task.json"), oracleFile = path.join(fixtureRoot, "oracle.json");
    const fixtureTask = await read(taskFile), oracle = await read(oracleFile), files = await manifest(workspace);
    const identity = { inputFingerprint: hash(JSON.stringify(files)), taskSha256: hash(await fs.readFile(taskFile)), oracleSha256: hash(await fs.readFile(oracleFile)) };
    assert.deepEqual(identity, freeze.cases[caseId], "Committed fixture identity changed.");
    for (const [file, metadata] of files) {
      const bytes = await fs.readFile(path.join(workspace, file));
      assert.equal(hash(bytes), metadata.sha256);
      const destination = path.join(projectRoot, file);
      assert(within(projectRoot, destination));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: "wx" });
    }
    assert(!files.some(([file]) => /(?:^|\/)oracle(?:[-.]|$)/u.test(file)), "Oracle must stay outside the model project.");
    const sessionId = `stop-integration-${caseId}-${randomUUID()}`;
    const task = await ensureTask({ projectRoot, sessionId });
    const sourceCatalog = [{ ref: `fixture:${caseId}:task`, kind: "MATERIAL" }];
    const operation = (claimId, category, text, ref, verificationTarget = "ARTIFACT") => ({ operation: "ADD", claimId, category, text,
      authority: "MATERIAL_DERIVED", severity: "HARD", applicability: "CURRENT_TASK", verificationTarget,
      source: { ref, subject: "MAIN_TASK", kind: "MATERIAL" } });
    const target = fixtureTask.metricId === "M12" ? "IMPLEMENTATION" : "ARTIFACT";
    const operations = [operation(caseId, "requirements", fixtureTask.requirement, sourceCatalog[0].ref, target)], basisRecords = [];
    for (const [index, file] of fixtureTask.basisFiles.entries()) {
      const bytes = await fs.readFile(path.join(workspace, file));
      const text = bytes.toString("utf8"), ref = `fixture:${caseId}:${file}`, claimId = `${caseId}-basis-${index + 1}`;
      sourceCatalog.push({ ref, kind: "MATERIAL" });
      operations.push(operation(claimId, "constraints", `Complete original basis ${file}; retain its conditions and exceptions.\n[BEGIN ORIGINAL UTF-8]\n${text}\n[END ORIGINAL UTF-8]`, ref));
      basisRecords.push({ file, claimId, sha256: hash(bytes), bytes: bytes.length });
    }
    const applied = await applyGroundTruthDelta({ projectRoot, taskId: task.taskId, sourceCatalog, evidenceCapture: "full",
      hookEventId: `fixture-${caseId}`, delta: { operations } });
    assert.equal(applied.accepted.length, operations.length);
    const { current: groundTruth } = await freezeGroundTruth({ projectRoot, taskId: task.taskId, reason: "ISOLATED_REVIEW_STAGE_FIXTURE" });
    for (const basis of basisRecords) {
      const original = (await fs.readFile(path.join(workspace, basis.file))).toString("utf8");
      assert(groundTruth.claims.find(claim => claim.claimId === basis.claimId)?.text.includes(original), "Complete basis text was not retained.");
      basis.losslessBody = true;
    }
    const object = { objectId: `${fixtureTask.metricId}:${caseId}`, metricId: fixtureTask.metricId, sourceId: caseId,
      sourceRevisionId: `${caseId}@1`, description: fixtureTask.requirement, authority: "MATERIAL_DERIVED", hard: true,
      evidenceRequired: true, verificationTarget: target, applicability: "CURRENT_TASK" };
    const metrics = { [fixtureTask.metricId]: [object] };
    const population = { schemaVersion: "runtime-corrector.metric-population.v2", catalogVersion: METRIC_CATALOG_VERSION,
      taskId: task.taskId, version: 1, groundTruthVersion: groundTruth.version, digest: hash(JSON.stringify(metrics)), metrics,
      metricCatalog: { [fixtureTask.metricId]: METRIC_CATALOG[fixtureTask.metricId] } };
    const implementation = fixtureTask.scope === "SOURCE_IMPLEMENTATION";
    const role = implementation ? "implementation-reviewer" : "stop-reviewer";
    const sourcePaths = implementation ? files.filter(([file]) => file.startsWith("implementation/") || fixtureTask.targetFiles.includes(file)) : [];
    const sourceManifest = sourcePaths.map(([file, metadata]) => ({ path: file, sha256: metadata.sha256 }));
    const classification = { stopClassification: "TASK_COMPLETE", stage: null };
    const request = { schemaVersion: "runtime-corrector.stop-task-integration-request.v1", projectRoot, taskId: task.taskId,
      population, groundTruthPath: currentGroundTruthPath(projectRoot, task.taskId), fixedStopClassification: classification,
      artifactCandidates: ["M01", "M02", "M03", "M04", "M05", "M06", "M07"].includes(fixtureTask.metricId) ? [{ artifactId: `fixture:${caseId}:candidate`,
        metricIds: [fixtureTask.metricId], files: fixtureTask.targetFiles.map(file => {
          const metadata = files.find(([name]) => name === file)?.[1];
          assert(metadata, "Declared fixture candidate must exist in the frozen business input.");
          return { path: file, sha256: metadata.sha256 };
        }), declaration: { configPath: null, configSha256: null, digest: identity.taskSha256 } }] : [],
      reviewScope: { objectIds: [object.objectId], sourceIds: [caseId], boundedBasis: true },
      instructions: [fixtureTask.requirement, fixtureTask.metricDefinition ?? fixtureTask.metricName,
        `Frozen fixture proof question: ${JSON.stringify({ scope: fixtureTask.scope, phase: fixtureTask.phase, basisAnchors: fixtureTask.basisAnchors ?? [], targetFiles: fixtureTask.targetFiles })}`,
        "Read the complete preserved basis. Only the assigned selected obligation is scored, not every other requirement in the original files. Retain all applicable common constraints and exceptions.",
        "Input roles: complete original basis files are authoritative; current decomposition/acceptance documents are candidate artifacts; source proves only statically decidable implementation; self-reports are not actual runtime evidence. Consult any original basis/input-roles.json for the full frozen role declarations.",
        "This project is an isolated review-stage copy. Never execute the app, build, verifier or commands, modify files, read outside the project, contact the original session or infer full-project PASS."].filter(Boolean),
      ...(implementation ? { sourceManifest, sourceRoot: projectRoot } : {}) };
    const input = { projectRoot, sessionCwd: projectRoot, taskId: task.taskId, parentSessionId: sessionId, role,
      reviewer: { session: "detached", timeoutMs: 120000 }, schema: structuredClone(implementation ? IMPL_REVIEW_SCHEMA : STOP_REVIEW_SCHEMA),
      request, evidence: { groundTruth, population, snapshot: { entries: [] } } };
    const expected = oracle.expectedVerdict ?? oracle.expected;
    const row = { caseId, role, metricId: fixtureTask.metricId, scope: fixtureTask.scope, expectedVerdict: expected,
      singleFrozenObjectOnly: true, projectRoot, taskId: task.taskId, sessionId, fixtureIdentity: identity, basis: basisRecords,
      sourceManifestFiles: sourceManifest.length, routeEligible: canUseStopTaskReview(input), preflight: true };
    assert(row.routeEligible, "The production route would fall back to the forbidden native reviewer.");
    await save(path.join(caseDirectory, "fixture-stage.json"), { ...row, sourceFiles: files, fixtureTask, request });
    const groundTruthBefore = hash(await fs.readFile(request.groundTruthPath));
    if (live) {
      let nativeFallbackCalls = 0, starts = 0, ends = 0, telemetryWrites = Promise.resolve();
      const telemetry = event => { telemetryWrites = telemetryWrites.then(() => fs.appendFile(path.join(caseDirectory, "host-callbacks.jsonl"), JSON.stringify(event) + "\n")); return telemetryWrites; };
      const host = await isolatedNativeReviewHost({ config: authorized.config, directory: path.join(caseDirectory, 'host') });
      const api = host.api;
      const factory = createOpenClawReviewerFactory(api, { stopReviewEngine: "task", provider: authorized.providerId, model: authorized.modelId,
        reviewerTimeoutMs: 120000, runEmbeddedAgent: params => {
          if (!params.toolsAllow?.includes('submit_review')) { nativeFallbackCalls++; throw new Error('Legacy JSON fallback is forbidden in this task diagnostic'); }
          return host.runEmbeddedAgent(params);
        }, compatibility: host.compatibility,
        onRunStart: (runId, value) => { starts++; return telemetry({ type: "start", runId, ...value }); },
        onRunEnd: (runId, value) => { ends++; return telemetry({ type: "end", runId, ...value }); },
        onTool: value => telemetry({ type: "tool", ...value }) });
      row.engineSelection = { requested: "task", factoryReviewItemSize: factory.reviewItemSize,
        cacheIdentity: factory.reviewCacheIdentity(input.reviewer) };
      let handle;
      try {
        handle = await collectReviewItems({ ...input, reviewerFactory: factory,
          ...(implementation ? {} : { classification }), deadlineAt: Date.now() + 125000 });
        const judgement = handle.result.metricObjectJudgements.find(item => item.objectId === object.objectId);
        const citations = await handle.getSourceCitations(handle.result);
        row.completed = handle.collection.complete && handle.collection.completedItems === 1;
        row.verdict = judgement?.judgement ?? null;
        row.reason = judgement?.reason ?? null;
        row.preliminaryLabelMatches = row.completed && row.verdict === expected;
        row.citationIntegrity = await checkedCitations(citations, judgement);
        const review = { ...handle.result, collection: handle.collection };
        const feedback = await prepareHostFeedback({ projectRoot, taskId: task.taskId, text: `Single-object Review: ${row.verdict ?? "UNVERIFIED"}.`, review, citations, locale: "zh-CN" });
        await fs.writeFile(path.join(caseDirectory, "feedback.txt"), feedback, { flag: "wx" });
        row.feedbackBytes = Buffer.byteLength(feedback);
        assert(row.feedbackBytes <= HOST_FEEDBACK_MAX_BYTES);
        row.collection = handle.collection;
        await save(path.join(caseDirectory, "collection-result.json"), { result: handle.result, collection: handle.collection, citations });
      } catch (error) { row.error = { code: error.code ?? "REVIEW_FAILED", message: redact(error.message) }; row.completed = false; }
      finally { await handle?.close?.(); host.close(); }
      await new Promise(resolve => setImmediate(resolve)); await telemetryWrites;
      row.factoryCallbacks = { starts, ends, nativeFallbackCalls };
      assert.equal(nativeFallbackCalls, 0);
      const runs = path.join(taskDirectory(projectRoot, task.taskId), "review-task-runs");
      const names = await fs.readdir(runs).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      row.workerRuns = [];
      for (const name of names) {
        const workerRoot = path.join(runs, name, "review"), workerInput = await read(path.join(workerRoot, "input.json")).catch(() => null);
        const result = await read(path.join(workerRoot, "result.json")).catch(() => null);
        const events = await fs.readFile(path.join(workerRoot, "events.jsonl"), "utf8").then(text => text.trim().split("\n").filter(Boolean).map(JSON.parse)).catch(() => []);
        row.workerRuns.push({ path: workerRoot, model: workerInput?.model ?? null, scope: workerInput?.task?.scope ?? null,
          completed: result?.completed ?? false, verdict: result?.verdict ?? null, metrics: result?.metrics ?? null,
          requestOptionEvents: events.filter(event => event.type === "request_options").length,
          assistantResponses: events.filter(event => event.type === "assistant").length,
          submitEvents: events.filter(event => event.type === "decision_saved").length,
          successfulModelReplies: events.filter(event => event.type === "assistant" && !["error", "aborted"].includes(event.stopReason)).length,
          tokenUsage: events.filter(event => event.type === "assistant").reduce((total, event) => ({
            noncachedInput: total.noncachedInput + (event.usage?.input ?? 0), cacheRead: total.cacheRead + (event.usage?.cacheRead ?? 0),
            cacheWrite: total.cacheWrite + (event.usage?.cacheWrite ?? 0), output: total.output + (event.usage?.output ?? 0),
          }), { noncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }) });
      }
      row.actualTaskEngineRuns = names.length;
      row.preflight = false;
    }
    row.businessFilesUnchanged = JSON.stringify(await manifest(projectRoot, true)) === JSON.stringify(files);
    row.groundTruthUnchanged = hash(await fs.readFile(request.groundTruthPath)) === groundTruthBefore;
    row.originalFixtureUnchanged = JSON.stringify(await manifest(workspace)) === JSON.stringify(files)
      && hash(await fs.readFile(taskFile)) === identity.taskSha256 && hash(await fs.readFile(oracleFile)) === identity.oracleSha256;
    assert(row.businessFilesUnchanged && row.groundTruthUnchanged && row.originalFixtureUnchanged);
    await save(path.join(caseDirectory, "report.json"), row);
    report.rows.push(row);
    console.log(JSON.stringify({ caseId, preflight: row.preflight, completed: row.completed ?? null, verdict: row.verdict ?? null, preliminaryLabelMatches: row.preliminaryLabelMatches ?? null }));
  }
  report.providerConfigurationUnchanged = authorized ? await authorized.unchanged() : null;
  report.codeUnchanged = (await Promise.all(codeFiles.map(async file => code[file] === hash(await fs.readFile(path.join(repository, file)))))).every(Boolean);
  const credentialFindings = [];
  if (authorized?.secrets.length) {
    for (const [file] of await manifest(output)) {
      const bytes = await fs.readFile(path.join(output, file));
      if (authorized.secrets.some(secret => bytes.includes(Buffer.from(secret)))) credentialFindings.push(file);
    }
  }
  report.credentialValueFindings = credentialFindings;
  report.protectedInputs = report.rows.every(row => row.businessFilesUnchanged && row.groundTruthUnchanged && row.originalFixtureUnchanged)
    && report.providerConfigurationUnchanged !== false && report.codeUnchanged && credentialFindings.length === 0;
  report.completedCases = live ? report.rows.filter(row => row.completed).length : null;
  report.preliminaryLabelMatches = live ? report.rows.filter(row => row.preliminaryLabelMatches).length : null;
  report.executionCounts = { factoryRunStarts: report.rows.reduce((sum, row) => sum + (row.factoryCallbacks?.starts ?? 0), 0),
    workerTasks: report.rows.reduce((sum, row) => sum + (row.actualTaskEngineRuns ?? 0), 0),
    savedWorkerDecisions: report.rows.flatMap(row => row.workerRuns ?? []).reduce((sum, run) => sum + run.submitEvents, 0),
    successfulModelReplies: report.rows.flatMap(row => row.workerRuns ?? []).reduce((sum, run) => sum + run.successfulModelReplies, 0),
    nativeFallbackCalls: report.rows.reduce((sum, row) => sum + (row.factoryCallbacks?.nativeFallbackCalls ?? 0), 0),
    note: "Reply/request-option telemetry is not a wire capture of exact HTTP dispatches; offline values are zero." };
  report.status = !report.protectedInputs ? "PROTECTION_FAILED" : !live ? "PREFLIGHT_PASS"
    : report.completedCases === caseIds.length ? "COMPLETE_PENDING_INDEPENDENT_SEMANTIC_REVIEW" : "INCOMPLETE";
  report.limitations = ["Production factory and item collector only; not the complete Stop/Gateway lifecycle or a business correction loop.",
    "Each fixture supplies one frozen object, not the metric's full denominator or a project PASS.",
    "Expected-label agreement is preliminary; independently check the diagnosis and evidence.",
    "No disabled execution arm or overall correction-benefit measurement is claimed."];
  await save(path.join(output, "report.json"), report);
  console.log(JSON.stringify({ status: report.status, output, cases: caseIds.length, completedCases: report.completedCases, preliminaryLabelMatches: report.preliminaryLabelMatches }));
  if (!report.protectedInputs || live && report.completedCases !== caseIds.length) process.exitCode = 1;
}

await main().catch(async error => {
  const failure = { status: "HARNESS_FAILED", code: error.code ?? "DIAGNOSTIC_FAILED", message: redact(error.message), output };
  await save(path.join(output, "failure.json"), failure).catch(() => {});
  console.error(JSON.stringify(failure)); process.exitCode = 1;
});
