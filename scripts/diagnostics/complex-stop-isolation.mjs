// Read-only capture of the authorized complex case; every write stays in a new directory.
// Preflight establishes transport bounds, never a simulated business PASS.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const [destination, mode = "preflight", previousLiveReport] = process.argv.slice(2);
if (!destination || !["preflight", "hook-probe", "live", "f1-final", "material"].includes(mode) || (mode === "material" && !previousLiveReport))
  throw new Error("new-output-directory [preflight|hook-probe|live|f1-final|material previous-live-report] required");
const finalF1 = mode === "f1-final", itemTimeoutMs = finalF1 ? 120000 : 90000;
const nativeWindowMs = finalF1 ? 150000 : 240000, maximumGenerations = finalF1 ? 1 : 3;
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const original = "C:/Users/user/workspace/program_workspace/RC-Exp/ma-vk-rc-r0";
const expectedTaskId = "oc-scope-8627bb2c-8379-40d8-8841-b1e95ce65014";
const sessionKey = "agent:main:session-1792735054175-1jhwwf";
const sessionDirectory = path.join(os.homedir(), ".openclaw/agents/main/sessions");
const hostConfigFile = path.join(os.homedir(), ".openclaw/openclaw.json");
const modelsFile = path.join(os.homedir(), ".openclaw/agents/main/agent/models.json");
const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const bytes = value => Buffer.byteLength(json(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const started = Date.now(), preparationDeadline = started + 60_000;
const assertPreparation = () => { if (Date.now() >= preparationDeadline) throw Object.assign(new Error("Preparation exceeded 60 seconds."), { code: "PREFLIGHT_DEADLINE" }); };
await fs.mkdir(destination, { mode: 0o700 });
const root = await fs.realpath(destination);
if (inside(original, root) || inside(sourceRoot, root)) throw new Error("Output must be a new directory outside both original project and tool source.");
const project = path.join(root, "project"), capture = path.join(root, "capture");
await fs.mkdir(project); await fs.mkdir(capture);
const save = (file, value) => fs.writeFile(path.join(root, file), typeof value === "string" ? value : json(value), { mode: 0o600 });
const report = { schemaVersion: 1, mode, status: "RUNNING", startedAt: new Date(started).toISOString(), originalProject: original,
  isolatedProject: project, modelCalls: 0, hostConfigurationModified: false, mainSessionModified: false,
  gatewayUsed: false, nativeGuardHooksActive: false, businessStatus: "UNVERIFIED", calls: [], rounds: [], stale: [] };
report.coreCommit = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
report.preflightCoreCommit = report.coreCommit;
let previousLive, previousOriginals;
if (mode === "material") {
  previousLive = JSON.parse(await fs.readFile(path.resolve(previousLiveReport), "utf8"));
  if (previousLive.mode !== "live" || (previousLive.priorModelCalls ?? 0) !== 0 || previousLive.priorLive
    || previousLive.originalProject !== original || !Number.isInteger(previousLive.modelCalls) || previousLive.modelCalls >= 3
    || !previousLive.coreSnapshot?.commit || !previousLive.originalState?.unchanged
    || !Number.isFinite(Date.parse(previousLive.nativeDeadlineAt)))
    throw new Error("Material scope may link only one fresh live run and must retain its original deadline and remaining three-generation budget.");
  report.coreCommit = previousLive.coreSnapshot.commit;
  report.priorLive = { path: path.resolve(previousLiveReport), sha256: hash(await fs.readFile(path.resolve(previousLiveReport))),
    status: previousLive.status, classificationResult: previousLive.classificationResult ?? null, calls: previousLive.modelCalls };
  report.classificationStatus = "PRIOR_PRODUCTION_COMPLETION_SCOPE_FAILED";
  report.materialScopeOnly = true;
  previousOriginals = new Map(JSON.parse(await fs.readFile(path.join(path.dirname(path.resolve(previousLiveReport)), "original-state-hashes.json"), "utf8"))
    .map(entry => [entry.path, entry]));
}
report.formatRepairSetting = "production-default; all repair calls count against the three-call experiment ceiling";
if (finalF1) report.formatRepairSetting = "DIAGNOSTIC_OVERRIDE_ZERO; production defaults to three repairs; this final experiment permits one generation only";
report.diagnosticLimits = { itemTimeoutMs, nativeWindowMs, maximumGenerations };
report.productionDifferences = [
  "Direct detached native harness, not the Gateway Stop lifecycle; the main session is never resumed.",
  "The latest committed production verify_only path uses caller-selected TASK_COMPLETE without a classifier generation. The fixture exemption and isolated source-path explanation are additional diagnostic instructions.",
  "Only Stop review material is exercised; dynamic Ground Truth, document, Skill and implementation corrections are disabled in the isolated fixture.",
  "The frozen population denominator remains complete; only representative item groups receive real model review.",
  "Execution-mode classifier and findings-only collection are outside this verify_only experiment; the legacy classifier navigation check is offline only.",
  "Business text sources are copied; dependencies, binaries, screenshots, credentials and historical runtime collections are excluded.",
  "An in-process public before_tool_call hook forwards only private reviewer events through the production internal observer. It applies the committed read paging policy without loading the full Gateway lifecycle. Result middleware remains inactive; result-byte guard accounting is replay only.",
  `The diagnostic caps linked native generations, including format repair, at ${maximumGenerations} and shares one fixed native deadline.`,
];
if (finalF1) report.productionDifferences.push("This final one-generation experiment uses production's 120-second item cap but deliberately disables format repair (production default: three), inside a separate fixed 150-second native window.");
const protectedFiles = new Map(), copied = [], exclusions = [];
const blocked = /^(?:\.git|node_modules|oh_modules|\.hvigor|build|\.idea|\.env(?:\..*)?|local\.properties|auth-profiles\.json|openclaw\.json|.*(?:credentials|secret|api[-_]?key|keystore|\.p12|\.pfx).*)$/iu;
const sourceExtensions = /\.(?:ets|ts|js|mjs|cjs|json5?|ya?ml|md|txt|xml|csv|css|html|svg|toml)$/iu;
const noCopyDirectories = new Set([".runtime-correction", "screenshots", "verify_screenshots", ".autopilot"]);
let secrets = [];
function assertNoSecret(content, label) {
  const text = content.toString("utf8");
  if (secrets.some(secret => secret.length >= 12 && text.includes(secret)) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)
    || /\b(?:sk-ant-api\d+-|sk-proj-)[A-Za-z0-9_-]{20,}/u.test(text)) throw Object.assign(new Error(`Sensitive content in ${label}; capture refused.`), { code: "SECRET_CAPTURE_REFUSED" });
}
async function stableRead(file, label, { copyTo = null, sensitive = false } = {}) {
  assertPreparation();
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Not an original regular file: ${label}`);
  const contents = await fs.readFile(file), after = await fs.lstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) report.stale.push(label);
  const entry = { path: file, label, bytes: contents.length, sha256: hash(contents) };
  if (previousOriginals) {
    const previous = previousOriginals.get(file);
    if (previous && previous.sha256 !== entry.sha256) report.stale.push(`prior-freeze-changed:${label}`);
    if (!previous && label.startsWith("source/")) report.stale.push(`prior-freeze-added:${label}`);
  }
  protectedFiles.set(file, entry);
  if (copyTo) {
    if (!sensitive) assertNoSecret(contents, label);
    await fs.mkdir(path.dirname(copyTo), { recursive: true }); await fs.writeFile(copyTo, contents, { mode: 0o600 });
    copied.push({ ...entry, copy: path.relative(root, copyTo) });
  }
  return contents;
}
async function regularFiles(directory, skip = () => false) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (skip(entry, file)) continue;
    if (entry.isSymbolicLink()) { exclusions.push({ path: file, reason: "symlink" }); continue; }
    if (entry.isDirectory()) result.push(...await regularFiles(file, skip));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
function partition(population) {
  const groups = new Map();
  for (const object of Object.values(population.metrics).flat()) {
    const key = JSON.stringify([object.sourceId ?? object.objectId, object.verificationTarget ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(object);
  }
  return [...groups.values()].flatMap(objects => Array.from({ length: Math.ceil(objects.length / 4) }, (_, i) => objects.slice(i * 4, i * 4 + 4)));
}
const subset = (population, owned) => { const ids = new Set(owned.map(x => x.objectId)); return { ...population,
  metrics: Object.fromEntries(Object.entries(population.metrics).map(([m, rows]) => [m, rows.filter(row => ids.has(row.objectId))])) }; };
async function recordsFromIndex(file) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  return value.kind === "records" ? value.records : (await Promise.all(value.pages.map(page => recordsFromIndex(page.path)))).flat();
}
async function originalFromIndex(descriptor) {
  const metadata = JSON.parse(await fs.readFile(descriptor.path, "utf8"));
  const records = await recordsFromIndex(descriptor.path), parts = [];
  for (const part of records.sort((a, b) => a.offset - b.offset)) {
    const content = await fs.readFile(part.path);
    if (part.bytes !== content.length || part.sha256 !== hash(content)) throw new Error("Paged original bytes changed.");
    parts.push(content);
  }
  const content = Buffer.concat(parts);
  if (content.length !== metadata.sourceBytes || hash(content) !== metadata.sourceSha256) throw new Error("Paged original reconstruction failed.");
  return JSON.parse(content);
}
async function folderStats(directory) {
  let count = 0, size = 0, max = 0;
  const files = await regularFiles(directory);
  for (let index = 0; index < files.length; index += 32) for (const stat of await Promise.all(files.slice(index, index + 32).map(file => fs.stat(file)))) {
    count++; size += stat.size; max = Math.max(max, stat.size);
  }
  return { files: count, bytes: size, maxFileBytes: max };
}
let task, truth, population, snapshot, baseRequest, items, sourceManifest, configuredHost, configuredModel, configuredKey;
let pluginRoot, load, prepareReviewerRequest, readTranscriptSnapshot, latestAssistantText, processToolEvidence,
  compileRuntimeV2Config, activeNativeTranscriptRecords, nativeTranscriptObservation;
try {
  // One committed archive owns BOTH preflight and native review implementation.
  const coreArchive = path.join(root, "core-snapshot.tar"), coreRoot = path.join(root, "core-snapshot");
  await promisify(execFile)("git", ["archive", "--format=tar", "--output", coreArchive, report.coreCommit,
    "lib", "config", "docs", "packaging", "package.json", "skills", "templates", "commands", "hooks", "scripts"], { cwd: sourceRoot });
  await fs.mkdir(coreRoot); await promisify(execFile)("tar", ["-xf", coreArchive, "-C", coreRoot]);
  report.coreSnapshot = { commit: report.coreCommit, archiveSha256: hash(await fs.readFile(coreArchive)), files: (await regularFiles(coreRoot)).length };
  report.preflightCoreCommit = report.coreCommit;
  const { buildPlugin } = await import(pathToFileURL(path.join(coreRoot, "lib/plugin-builder.mjs")));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: coreRoot, outputRoot: path.join(root, "plugin") });
  load = file => import(pathToFileURL(path.join(pluginRoot, "lib", file)));
  const modules = await Promise.allSettled([load("runtime-v2/reviewer-evidence.mjs"), load("runtime-v2/transcript.mjs"),
    load("runtime-v2/config.mjs"), load("openclaw/native-transcript.mjs")]);
  const loadFailure = modules.find(result => result.status === "rejected");
  if (loadFailure) throw loadFailure.reason;
  ({ prepareReviewerRequest } = modules[0].value);
  ({ readTranscriptSnapshot, latestAssistantText, processToolEvidence } = modules[1].value);
  ({ compileRuntimeV2Config } = modules[2].value);
  ({ activeNativeTranscriptRecords, nativeTranscriptObservation } = modules[3].value);
  // Credentials remain only in memory. Their files are hashed, never copied.
  const configBytes = await stableRead(hostConfigFile, "host-config", { sensitive: true });
  configuredHost = JSON.parse(configBytes);
  const modelBytes = await stableRead(modelsFile, "host-model-cache", { sensitive: true });
  const cachedModels = JSON.parse(modelBytes);
  const providerSources = [...Object.values(configuredHost.models?.providers ?? {}), ...Object.values(cachedModels.providers ?? {})];
  const authenticationHeaders = providerSources.flatMap(value => [value.headers, ...(value.models ?? []).map(model => model.headers)])
    .filter(value => value && typeof value === "object")
    .flatMap(value => Object.entries(value).filter(([name, value]) => /auth|api[-_]?key|token|secret|cookie/iu.test(name) && typeof value === "string" && value));
  const sensitiveValues = [...providerSources.map(value => value.apiKey), ...authenticationHeaders.map(([, value]) => value)]
    .filter(value => typeof value === "string" && value);
  secrets = [...new Set(sensitiveValues.flatMap(value => {
    const env = /^\$\{([^}]+)\}$/u.exec(value)?.[1];
    return [value, ...(env && process.env[env] ? [process.env[env]] : [])];
  }).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))];
  report.credentials = { authenticationHeadersConfigured: authenticationHeaders.length > 0,
    authenticationHeaderCount: authenticationHeaders.length, headerValuesPersisted: false,
    persistedProviderFields: ["baseUrl", "api", "apiKeyEnvironmentReference", "models"] };
  const modelRef = "custom/deepseek-v4-flash", provider = configuredHost.models?.providers?.custom;
  configuredModel = provider?.models?.find(item => item.id === "deepseek-v4-flash");
  const rawKey = provider?.apiKey ?? cachedModels.providers?.custom?.apiKey;
  const envName = typeof rawKey === "string" && /^\$\{([^}]+)\}$/u.exec(rawKey)?.[1];
  configuredKey = envName ? process.env[envName] : rawKey;
  if (configuredKey) secrets.push(configuredKey);
  report.model = { ref: modelRef, configured: !!configuredModel, endpointSha256: provider?.baseUrl ? hash(provider.baseUrl) : null };
  const sessionStoreFile = path.join(sessionDirectory, "sessions.json");
  const sessionStore = JSON.parse(await stableRead(sessionStoreFile, "host-session-store", { sensitive: true }));
  const session = sessionStore[sessionKey];
  if (!session?.sessionId || !session.sessionFile) throw new Error("The original main session is no longer current.");
  report.session = { key: sessionKey, id: session.sessionId };
  const indexFiles = await regularFiles(path.join(original, ".runtime-correction/session-index"));
  let index;
  for (const file of indexFiles) {
    const body = await stableRead(file, `session-index/${path.basename(file)}`, { copyTo: path.join(capture, "session-index", path.basename(file)) });
    const value = JSON.parse(body); if (value.sessionId === session.sessionId) index = value;
  }
  if (index?.taskId !== expectedTaskId) throw new Error("The authorized frozen task is no longer current; refusing stale task selection.");
  const relativeTask = path.join(".runtime-correction/tasks", index.taskId), taskRoot = path.join(original, relativeTask);
  for (const relative of ["task.json", "ground-truth/current.json", "metrics/population.json"]) {
    const body = await stableRead(path.join(taskRoot, relative), relative, { copyTo: path.join(project, relativeTask, relative) });
    if (relative === "task.json") task = JSON.parse(body);
    if (relative === "ground-truth/current.json") truth = JSON.parse(body);
    if (relative === "metrics/population.json") population = JSON.parse(body);
  }
  if (task.rootSessionId !== session.sessionId || truth.taskId !== task.taskId || population.taskId !== task.taskId
    || population.groundTruthVersion !== truth.version || task.groundTruth.digest !== truth.digest) throw new Error("Frozen identities are inconsistent.");
  // Preserve the exact original native transcript and derive only its current active branch.
  const raw = await stableRead(session.sessionFile, "main-native-transcript", { copyTo: path.join(capture, "native-transcript.jsonl") });
  const nativeRecords = raw.toString("utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const observation = nativeTranscriptObservation(activeNativeTranscriptRecords(nativeRecords), { source: "isolated-native-capture" });
  const normalizedFile = path.join(capture, "transcript.jsonl");
  await fs.writeFile(normalizedFile, observation.entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  snapshot = await readTranscriptSnapshot(normalizedFile);
  report.transcript = { rawBytes: raw.length, normalizedBytes: snapshot.bytes, entries: snapshot.entries.length,
    digest: snapshot.digest, genuineUsers: snapshot.entries.filter(entry => entry.type === "user" && !entry.isMeta).length };
  const sourceFiles = await regularFiles(original, entry => blocked.test(entry.name) || (entry.isDirectory() && noCopyDirectories.has(entry.name)));
  sourceManifest = [];
  for (const file of sourceFiles) {
    const relative = path.relative(original, file);
    if (relative === path.join(".runtime-corrector", "config.yaml") || !sourceExtensions.test(file)) continue;
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) { exclusions.push({ path: relative, reason: "text-file-over-2MiB" }); continue; }
    const body = await stableRead(file, `source/${relative}`, { copyTo: path.join(project, relative) });
    if (body.includes(0)) throw new Error(`Unexpected binary source ${relative}`);
    sourceManifest.push({ path: relative, size: body.length, sha256: hash(body) });
  }
  const originalPolicy = path.join(original, ".runtime-corrector/config.yaml");
  await stableRead(originalPolicy, "original-project-policy", { copyTo: path.join(capture, "original-config.yaml") });
  if (previousOriginals) for (const previous of previousOriginals.values())
    if (previous.label.startsWith("source/") && !protectedFiles.has(previous.path)) report.stale.push(`prior-freeze-removed:${previous.label}`);
  if (report.stale.length) throw Object.assign(new Error("The original source changed during capture or no longer matches the linked freeze."), { code: "STALE_CAPTURE" });
  const policy = { version: 2, locale: "zh", artifacts: [], workflow: { edges: [] }, dynamicGroundTruth: { enabled: false, panel: { size: 0 } },
    skillCorrection: { enabled: false }, artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
    implementationCorrection: { enabled: false }, stopCorrection: { enabled: true, assessmentTimeoutMs: nativeWindowMs },
    reviewers: { defaults: { model: modelRef, session: "detached", effort: "low", timeoutMs: itemTimeoutMs,
      ...(finalF1 ? { formatRepairAttempts: 0 } : {}) } } };
  await fs.mkdir(path.join(project, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(project, ".runtime-corrector/config.json"), json(policy), { mode: 0o600 });
  const compiled = compileRuntimeV2Config(policy, { policyRoot: path.join(project, ".runtime-corrector") });
  if (compiled.dynamicGroundTruth.enabled || compiled.skillCorrection.enabled || compiled.artifactCorrection.groundTruthReviewEnabled
    || compiled.implementationCorrection.enabled || !compiled.stopCorrection.enabled) throw new Error("Stop-only policy did not compile.");
  report.stopOnlyPolicy = policy;
  items = partition(population);
  const commonCategories = new Set(["goals", "inScope", "outOfScope", "constraints", "executionContext", "evidenceObligations", "decisions",
    "rejectedAlternatives", "developmentStandards", "workflowSteps", "experienceRules", "capabilityChecklist", "milestones", "openQuestions"]);
  report.population = { claims: truth.claims.length, objects: Object.values(population.metrics).flat().length, items: items.length,
    groundTruthVersion: truth.version, groundTruthDigest: truth.digest, populationVersion: population.version, populationDigest: population.digest,
    commonClaims: truth.claims.filter(claim => commonCategories.has(claim.category)).length,
    commonClaimsBytes: Buffer.byteLength(JSON.stringify(truth.claims.filter(claim => commonCategories.has(claim.category)))),
    commonClaimsPrettyBytes: Buffer.byteLength(JSON.stringify(truth.claims.filter(claim => commonCategories.has(claim.category)), null, 2)) };
  report.capture = { files: copied.length, bytes: copied.reduce((n, row) => n + row.bytes, 0), sourceFiles: sourceManifest.length,
    sourceBytes: sourceManifest.reduce((n, row) => n + row.size, 0), exactOriginals: true, exclusions,
    excludedDirectories: [".git", "node_modules", "oh_modules", ".hvigor", "build", ".idea", ...noCopyDirectories],
    excludedSensitiveNames: [".env*", "local.properties", "auth-profiles.json", "openclaw.json", "credentials", "secret", "api-key", "keystore", "p12", "pfx"],
    normalizedDerivedBytes: snapshot.bytes, totalFrozenMaterialBytes: copied.reduce((n, row) => n + row.bytes, 0) + snapshot.bytes,
    captureMs: Date.now() - started };
  const groundTruthPath = path.join(project, relativeTask, "ground-truth/current.json");
  baseRequest = { schemaVersion: "runtime-corrector.complex-stop-isolation.v1", projectRoot: project, taskId: task.taskId,
    assessmentMode: "verify_only", groundTruthPath, population, hook: { hookEventName: "Stop", stopHookActive: false,
      lastAssistantMessage: latestAssistantText(snapshot) }, sourceManifest, processToolEvidence: processToolEvidence(snapshot),
    instructions: ["This is an authorized read-only verification of the frozen current complex project. Never repair or change business sources.",
      "The user explicitly authorized this diagnostic fixture to disable dynamic Ground Truth, document, Skill and implementation correction in the isolated runner. These fixture-only settings are not business-source modifications or task violations. Review the unchanged frozen business evidence; do not report the authorized fixture configuration as a defect.",
      `Read only isolated evidence below ${project}. Historical absolute paths in the transcript name the original project; use their same relative paths beneath this isolated root.`,
      "Preserve complete conditions, exceptions, common constraints and the fixed population denominator. Unchecked obligations remain UNVERIFIED."] };
  const localInput = owned => ({ ...baseRequest, population: subset(population, owned),
    reviewScope: { boundedBasis: true, objectIds: owned.map(o => o.objectId), sourceIds: [...new Set(owned.map(o => o.sourceId))] },
    fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: null } });
  const evidence = owned => ({ groundTruth: truth, population: subset(population, owned) });
  const results = [], preflightStarted = Date.now();
  async function preflightItem(index) {
    const owned = items[index];
    assertPreparation();
    const directory = path.join(root, "preflight", `item-${String(index + 1).padStart(4, "0")}`);
    const input = localInput(owned);
    // Common full transcript is intentionally measured separately below.
    delete input.processToolEvidence;
    const prepared = await prepareReviewerRequest({ requestDirectory: directory, request: input, evidence: evidence(owned), deadlineAt: preparationDeadline });
    const disclosed = JSON.parse(await fs.readFile(prepared.groundTruthPath, "utf8"));
    const recovered = prepared.reviewSources.requiredGroundTruthBasis ? await originalFromIndex(prepared.reviewSources.requiredGroundTruthBasis) : disclosed;
    const requiredIds = new Set([...owned.map(o => o.sourceId), ...truth.claims.filter(c => commonCategories.has(c.category)).map(c => c.claimId)]);
    for (const claim of truth.claims.filter(c => requiredIds.has(c.claimId)))
      if (!same(recovered.claims.find(c => c.claimId === claim.claimId), claim)) throw new Error("A scoped complete claim changed or disappeared.");
    const originalTruth = await originalFromIndex(prepared.reviewSources.originalGroundTruth);
    if (!same(originalTruth, truth)) throw new Error("Canonical Ground Truth paging is not byte-exact JSON.");
    const recoveredPopulation = prepared.reviewSources.requiredPopulationBasis ? await originalFromIndex(prepared.reviewSources.requiredPopulationBasis) : prepared.population;
    if (!same(recoveredPopulation, input.population)) throw new Error("Object descriptions, conditions or frozen population metadata changed.");
    const stats = await folderStats(path.join(directory, "review-scope"));
    const requestBytes = bytes(prepared);
    if (requestBytes > 24 * 1024 || stats.maxFileBytes > 16 * 1024) throw new Error("A transport bound was exceeded.");
    await fs.writeFile(path.join(directory, "request.json"), json(prepared), { mode: 0o600 });
    results[index] = { index, objectIds: owned.map(o => o.objectId), sourceIds: input.reviewScope.sourceIds,
      objectBytes: Buffer.byteLength(JSON.stringify(owned)), requestBytes, sourcePages: stats, claimsPreserved: recovered.claims.length };
  }
  for (let index = 0; index < items.length; index += 4) {
    const batch = await Promise.allSettled(Array.from({ length: Math.min(4, items.length - index) }, (_, offset) => preflightItem(index + offset)));
    const failures = batch.filter(result => result.status === "rejected");
    if (failures.length) throw failures[0].reason;
  }
  report.preflight = { complete: true, modelCalls: 0, allItemsScope: "GT, population and source-manifest only; shared transcript measured separately", items: results,
    requestMaxBytes: Math.max(...results.map(r => r.requestBytes)), pageMaxBytes: Math.max(...results.map(r => r.sourcePages.maxFileBytes)),
    elapsedMs: Date.now() - preflightStarted, reviewScopeTooLarge: 0, exactClaimsAndPopulationPreserved: true, fullDenominator: report.population.objects };
  const smallestImplementation = results.filter(value => items[value.index].length === 1 && items[value.index][0].verificationTarget === "IMPLEMENTATION")
    .sort((a, b) => Buffer.byteLength(items[a.index][0].description ?? "") - Buffer.byteLength(items[b.index][0].description ?? "")
      || a.objectIds[0].localeCompare(b.objectIds[0]))[0];
  const f1 = results.find(value => value.sourceIds.includes("f1"));
  if (!smallestImplementation || !f1 || smallestImplementation.index === f1.index) throw new Error("The two requested representative groups are unavailable.");
  report.representatives = [];
  for (const picked of finalF1 ? [f1] : [smallestImplementation, f1]) {
    const owned = items[picked.index], directory = path.join(root, "full-snapshot-preflight", `item-${picked.index + 1}`);
    const prepared = await prepareReviewerRequest({ requestDirectory: directory, request: localInput(owned),
      evidence: { ...evidence(owned), snapshot }, deadlineAt: preparationDeadline });
    const transcriptIndex = JSON.parse(await fs.readFile(prepared.transcript.path, "utf8"));
    const entries = await recordsFromIndex(transcriptIndex.entryIndex.path);
    if (entries.length !== snapshot.entries.length) throw new Error("Full snapshot lost transcript entries.");
    for (let start = 0; start < entries.length; start += 32) {
      const recovered = await Promise.all(entries.slice(start, start + 32).map(row => originalFromIndex(row.source)));
      for (const [offset, entry] of recovered.entries()) if (!same(entry, snapshot.entries[start + offset])) throw new Error("Full snapshot original changed.");
    }
    const stats = await folderStats(path.join(directory, "review-scope"));
    if (bytes(prepared) > 24 * 1024 || stats.maxFileBytes > 16 * 1024) throw new Error("Full snapshot transport bounds exceeded.");
    report.representatives.push({ index: picked.index, reason: picked.index === smallestImplementation.index ? "smallest-single-implementation-object" : "f1-metric-group",
      objectIds: picked.objectIds, requestBytes: bytes(prepared), sourcePages: stats, exactTranscriptEntries: entries.length });
    await fs.writeFile(path.join(directory, "request.json"), json(prepared), { mode: 0o600 });
  }
  const emptyPopulation = { ...population, metrics: Object.fromEntries(Object.keys(population.metrics).map(metric => [metric, []])) };
  const classifierRequest = { ...baseRequest, population: emptyPopulation, processToolEvidence: [],
    reviewScope: { kind: "classification", boundedBasis: true, objectIds: [], sourceIds: [] },
    instructions: ["Classify the stopping situation from genuine user requirements and the latest assistant response. Completion selects the assessment scope; it does not establish PASS. Return no metric judgements, file assessments or findings.",
      "This is user-requested read-only verification of CURRENT output. Use TASK_COMPLETE or the requested STAGE_COMPLETE scope; awaiting permission to modify does not prevent verification.",
      "Return exactly one instance matching the schema. Do not echo the JSON Schema or produce an example before the actual result."] };
  const classifierEvidence = { groundTruth: truth, population: emptyPopulation, snapshot };
  const classifierDirectory = path.join(root, "classification-preflight");
  const classifier = await prepareReviewerRequest({ requestDirectory: classifierDirectory, request: classifierRequest, evidence: classifierEvidence, deadlineAt: preparationDeadline });
  const classifierIndex = JSON.parse(await fs.readFile(classifier.transcript.path, "utf8"));
  const classifierEntries = await recordsFromIndex(classifierIndex.entryIndex.path), tools = await recordsFromIndex(classifierIndex.toolIndex.path);
  const latestAssistantIndex = snapshot.entries.findLastIndex(entry => entry.type === "assistant" && !entry.isMeta
    && (entry.message?.content ?? []).some(block => block.type === "text" && block.text?.trim()));
  if (tools.length || classifierEntries.some(row => row.index !== latestAssistantIndex && !(snapshot.entries[row.index].type === "user" && !snapshot.entries[row.index].isMeta))) throw new Error("Classifier disclosed tool history.");
  report.classifier = { modelCalls: 0, livePath: "SKIPPED_CALLER_SELECTED_VERIFY_ONLY", offlineNavigationCheckOnly: true,
    requestBytes: bytes(classifier), sourceEntries: snapshot.entries.length, disclosedEntries: classifierEntries.length,
    toolPairs: tools.length, toolsHistoryExcluded: true, sourcePages: await folderStats(path.join(classifierDirectory, "review-scope")) };
  if (report.classifier.requestBytes > 24 * 1024 || report.classifier.sourcePages.maxFileBytes > 16 * 1024) throw new Error("Classifier transport bound exceeded.");
  await save("classification-preflight/request.json", classifier);
  report.capture.preparationMs = Date.now() - started;
  report.capture.generatedDisclosureBytes = report.preflight.items.reduce((n, row) => n + row.sourcePages.bytes, 0)
    + report.representatives.reduce((n, row) => n + row.sourcePages.bytes, 0) + report.classifier.sourcePages.bytes;
  report.status = "PREFLIGHT_VERIFIED_BUSINESS_UNVERIFIED";
  await save("report.json", report); await save("capture-manifest.json", copied);
  console.log(JSON.stringify({ phase: "preflight-complete", population: report.population, requestMaxBytes: report.preflight.requestMaxBytes,
    pageMaxBytes: report.preflight.pageMaxBytes, capture: report.capture, classifier: report.classifier, representatives: report.representatives }));
  if (["hook-probe", "live", "f1-final", "material"].includes(mode)) {
    if (!configuredModel || !configuredKey || !provider?.baseUrl || !provider?.api) throw new Error("The existing deepseek-v4-flash provider is unavailable.");
    if (previousLive && (previousLive.population.groundTruthDigest !== truth.digest || previousLive.population.populationDigest !== population.digest
      || previousLive.session.id !== report.session.id || previousLive.transcript.digest !== snapshot.digest)) throw new Error("Independent material test no longer matches its prior frozen capture.");
    const liveStarted = Date.now(), priorCalls = previousLive?.modelCalls ?? 0;
    const deadlineAt = previousLive ? Date.parse(previousLive.nativeDeadlineAt) : liveStarted + nativeWindowMs;
    if (deadlineAt - liveStarted < 15000) throw new Error("No native time remains in the prior experiment window.");
    report.nativeDeadlineAt = new Date(deadlineAt).toISOString(); report.priorModelCalls = priorCalls;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("Complex Stop experiment reached its fixed deadline.")), deadlineAt - liveStarted);
    const hostRoot = process.env.RC_KITCHEN_HOST_ROOT ?? "C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw";
    const hostVersion = JSON.parse(await fs.readFile(path.join(hostRoot, "package.json"), "utf8")).version;
    const originalEnvironment = Object.fromEntries(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH", "RC_COMPLEX_STOP_KEY"].map(name => [name, process.env[name]]));
    const stateDir = path.join(root, "host-state"); await fs.mkdir(stateDir);
    const nativeConfig = { agents: { defaults: { workspace: project, skipBootstrap: true, timeoutSeconds: itemTimeoutMs / 1000, model: { primary: modelRef }, models: { [modelRef]: {} }, sandbox: { mode: "off" } } },
      models: { providers: { custom: { ...provider, apiKey: "${RC_COMPLEX_STOP_KEY}", models: [{ ...configuredModel, reasoning: false, maxTokens: 4096 }] } } },
      plugins: { enabled: false }, tools: { allow: ["read"], fs: { workspaceOnly: true } }, logging: { level: "error", consoleLevel: "error" } };
    report.liveFilesystem = { workspaceOnly: true, hostCapabilityVerified: true, readScopeViolations: [] };
    process.env.OPENCLAW_STATE_DIR = stateDir; process.env.OPENCLAW_HOME = path.join(root, "host-home");
    process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json"); process.env.RC_COMPLEX_STOP_KEY = configuredKey;
    const persistedConfig = structuredClone(nativeConfig);
    const modelDiskFields = ["id", "name", "api", "reasoning", "input", "cost", "contextWindow", "maxTokens", "compat"];
    persistedConfig.models.providers.custom = { baseUrl: provider.baseUrl, api: provider.api, apiKey: "${RC_COMPLEX_STOP_KEY}",
      models: nativeConfig.models.providers.custom.models.map(model => Object.fromEntries(modelDiskFields.filter(key => Object.hasOwn(model, key)).map(key => [key, model[key]]))) };
    await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, json(persistedConfig), { mode: 0o600 });
    nativeConfig.models.providers.custom.apiKey = configuredKey;
    let restoreNativeHook;
    try {
      const { createPluginRuntime } = await import(pathToFileURL(path.join(hostRoot, "dist/plugins/runtime/index.js")));
      const native = createPluginRuntime();
      const { createOpenClawReviewerFactory } = await load("openclaw/reviewer.mjs");
      const { createReviewerContextGuard } = await load("openclaw/reviewer-context.mjs");
      const { isInternalExecution, observeInternalTool } = await load("openclaw/internal-context.mjs");
      const { STOP_REVIEW_SCHEMA } = await load("runtime-v2/reviewer.mjs");
      const { collectReviewItems } = await load("runtime-v2/review-collector.mjs");
      const { prepareHostFeedback } = await load("runtime-v2/feedback-delivery.mjs");
      const sdk = file => import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk", file)));
      const hookApi = await sdk("plugin-runtime.js");
      const previousHookRegistry = hookApi.getGlobalPluginRegistry();
      const beforeEvents = [], actualToolArguments = new Map();
      const hookRegistry = Object.fromEntries(("plugins tools hooks typedHooks channels channelSetups providers modelCatalogProviders cliBackends textTransforms embeddingProviders speechProviders realtimeTranscriptionProviders realtimeVoiceProviders mediaUnderstandingProviders transcriptSourceProviders imageGenerationProviders videoGenerationProviders musicGenerationProviders webFetchProviders webSearchProviders migrationProviders codexAppServerExtensionFactories agentToolResultMiddlewares memoryEmbeddingProviders agentHarnesses gatewayMethodDescriptors coreGatewayMethodNames httpRoutes hostedMediaResolvers cliRegistrars reloads nodeHostCommands nodeInvokePolicies securityAuditCollectors services gatewayDiscoveryServices commands interactiveHandlers sessionExtensions trustedToolPolicies toolMetadata controlUiDescriptors runtimeLifecycles agentEventSubscriptions sessionSchedulerJobs sessionActions conversationBindingResolvedHandlers diagnostics").split(" ").map(name => [name, []]));
      hookRegistry.gatewayHandlers = {};
      hookRegistry.plugins.push({ id: "rc-isolated-read-policy", name: "Isolated reviewer read policy", status: "loaded" });
      hookRegistry.typedHooks.push({ pluginId: "rc-isolated-read-policy", hookName: "before_tool_call", priority: 100000, timeoutMs: 10000,
        handler: async (event, ctx) => {
          if (!isInternalExecution()) return;
          const proposed = structuredClone(event.params);
          try {
            const decision = await observeInternalTool(event.toolName, event.params);
            const actual = decision?.params ?? event.params;
            if (event.toolCallId) actualToolArguments.set(event.toolCallId, structuredClone(actual));
            beforeEvents.push({ toolCallId: event.toolCallId ?? null, toolName: event.toolName, sessionId: ctx.sessionId ?? null,
              proposed, actual: structuredClone(actual), changed: !same(proposed, actual) });
            return decision;
          } catch (error) {
            if (error.code === "REVIEWER_CONTEXT_BUDGET") return { block: true, blockReason: error.message };
            throw error;
          }
        } });
      hookApi.initializeGlobalHookRunner(hookRegistry);
      restoreNativeHook = () => previousHookRegistry ? hookApi.initializeGlobalHookRunner(previousHookRegistry) : hookApi.resetGlobalHookRunner();
      report.nativeReadPolicyHook = { active: true, publicApi: "plugin-runtime.initializeGlobalHookRunner + before_tool_call.params",
        forwarding: "Production observeInternalTool only; full runtime.beforeTool lifecycle and result middleware are not registered.", resultGuardLive: false };
      // No-model transport sentinel uses the host's real read implementation.
      const { createOpenClawCodingTools } = await sdk("agent-harness.js");
      const sentinel = path.join(project, "native-read-policy-sentinel.txt");
      await fs.writeFile(sentinel, Array.from({ length: 140 }, (_, index) => `NATIVE_SENTINEL_${String(index + 1).padStart(3, "0")}`).join("\n") + "\n");
      const sentinelCases = [];
      const probeFactory = createOpenClawReviewerFactory({ config: nativeConfig, runtime: { version: hostVersion, agent: native.agent } }, {
        reviewerModel: modelRef, reviewerTimeoutMs: 10000, deadlineAt,
        runEmbeddedAgent: async params => {
          const generated = path.join(path.dirname(params.sessionFile), "generated-read-policy-sentinel.txt");
          await fs.copyFile(sentinel, generated);
          const tools = createOpenClawCodingTools({ config: nativeConfig, workspaceDir: project, cwd: project,
            sessionId: params.sessionId, sessionKey: params.sessionKey, runId: params.runId, oneShotCliRun: true,
            runtimeToolAllowlist: ["read"], disableMessageTool: true, emitBeforeToolCallDiagnostics: false });
          const read = tools.find(tool => tool.name === "read");
          if (!read) throw new Error("Native no-model read tool is unavailable.");
          for (const [name, args, last, absent] of [
            ["missing-limit", { path: sentinel }, "NATIVE_SENTINEL_080", "NATIVE_SENTINEL_081"],
            ["explicit-range", { path: sentinel, offset: 15, limit: 7 }, "NATIVE_SENTINEL_021", "NATIVE_SENTINEL_022"],
            ["generated-page-exempt", { path: generated }, "NATIVE_SENTINEL_140", null],
          ]) {
            const result = await read.execute(`no-model-${name}`, args, params.abortSignal);
            const text = (result.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
            if (!text.includes(last) || absent && text.includes(absent)) throw new Error(`Native read paging sentinel failed: ${name}`);
            sentinelCases.push({ name, proposed: args, expectedLastMarker: last, excludedNextMarker: absent,
              returnedBytes: Buffer.byteLength(text), verified: true });
          }
          const compact = { schema: "NO_MODEL_COMPACT_UTF8_PAGE", condition: "完整保留条件、例外和Unicode🌻", payload: "" };
          compact.payload = "x".repeat(16 * 1024 - Buffer.byteLength(JSON.stringify(compact)));
          const compactOriginal = JSON.stringify(compact), compactFile = path.join(path.dirname(params.sessionFile), "generated-compact-page-sentinel.json");
          if (Buffer.byteLength(compactOriginal) !== 16 * 1024 || compactOriginal.includes("\n")) throw new Error("Compact probe must be one exact 16KiB UTF-8 line.");
          await fs.writeFile(compactFile, compactOriginal);
          const compactRead = await read.execute("no-model-compact-page-exact", { path: compactFile }, params.abortSignal);
          const compactReturned = (compactRead.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
          if (compactReturned !== compactOriginal || !same(JSON.parse(compactReturned), compact)) throw new Error("Native read did not return the complete 16KiB single-line compact JSON unchanged.");
          sentinelCases.push({ name: "compact-single-line-16KiB-exact", bytes: Buffer.byteLength(compactReturned), utf8ByteExact: true,
            semanticDeepEqual: true, sourceSha256: hash(compactOriginal), returnedSha256: hash(compactReturned), verified: true });
          return { payloads: [{ text: JSON.stringify({ summary: "NO_MODEL_TRANSPORT_SENTINEL_ONLY; no business judgement.",
            stopClassification: "TASK_COMPLETE", stage: null, findings: [], metricObjectJudgements: [], fileAssessments: [] }) }], meta: {} };
        },
      });
      const probe = await probeFactory({ projectRoot: project, sessionCwd: project, taskId: "native-read-policy-probe", role: "stop-reviewer",
        reviewer: { session: "detached", timeoutMs: 10000 }, schema: STOP_REVIEW_SCHEMA,
        request: { projectRoot: project, population: { metrics: {} }, reviewScope: { boundedBasis: true, objectIds: [], sourceIds: [] } },
        evidence: { groundTruth: { taskId: "native-read-policy-probe", version: 1, claims: [] }, population: { metrics: {} } }, deadlineAt });
      await probe.close(); await fs.unlink(sentinel);
      report.readPolicyProbe = { modelGenerations: 0, businessStatus: "UNVERIFIED", actualNativeRead: true, cases: sentinelCases,
        hookEvents: beforeEvents.splice(0), coreCommit: report.coreCommit };
      await save("read-policy-probe.json", report.readPolicyProbe);
      console.log(JSON.stringify({ phase: "no-model-native-read-policy-probe", verified: true, cases: sentinelCases.length }));
      if (mode === "hook-probe") {
        report.status = "NATIVE_READ_POLICY_PROBE_VERIFIED_BUSINESS_UNVERIFIED";
      } else {
      const cursors = new Map(), guards = new Map();
      const factory = createOpenClawReviewerFactory({ config: nativeConfig, runtime: { version: hostVersion, agent: native.agent } }, {
        reviewerModel: modelRef, reviewerTimeoutMs: itemTimeoutMs, deadlineAt, abortSignal: abort.signal,
        runEmbeddedAgent: async params => {
          if (priorCalls + report.modelCalls >= maximumGenerations) throw Object.assign(new Error(`At most ${maximumGenerations} native generations are authorized across this experiment.`), { code: "EXPERIMENT_CALL_LIMIT" });
          const call = { ordinal: ++report.modelCalls, startedAt: new Date().toISOString(), sessionId: params.sessionId,
            knownPromptBytes: Buffer.byteLength(`${params.extraSystemPrompt}\n${params.prompt}`) };
          const eventCursor = beforeEvents.length;
          report.calls.push(call); console.log(JSON.stringify({ phase: "native-call-start", ordinal: call.ordinal }));
          try {
            const result = await native.agent.runEmbeddedAgent(params);
            call.stopReason = result.meta?.stopReason ?? null; call.errorKind = result.meta?.error?.kind ?? null;
            call.usage = result.meta?.agentMeta?.usage ?? null;
            return result;
          } finally {
            call.finishedAt = new Date().toISOString();
            const raw = await fs.readFile(params.sessionFile, "utf8").catch(() => "");
            const cleaned = secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), raw);
            await save(`native-call-${call.ordinal}.jsonl`, cleaned);
            const lines = cleaned.trim().split("\n"), cursor = cursors.get(params.sessionId) ?? 0;
            const messages = lines.slice(cursor).flatMap(line => { try { const message = JSON.parse(line).message; return message ? [message] : []; } catch { return []; } });
            cursors.set(params.sessionId, lines.length);
            let guard = guards.get(params.sessionId);
            if (!guard) { guard = createReviewerContextGuard({ controller: new AbortController() }); guard.configure(nativeConfig, "custom", "deepseek-v4-flash"); guards.set(params.sessionId, guard); }
            call.beforeToolEvents = beforeEvents.slice(eventCursor);
            call.readPolicyObserved = messages.flatMap(message => (message.content ?? []).filter(block => block.type === "toolCall" && block.name === "read"))
              .every(block => actualToolArguments.has(block.id));
            call.reads = messages.flatMap(message => (message.content ?? []).filter(block => block.type === "toolCall")
              .map(block => ({ name: block.name, proposedArguments: block.arguments, arguments: actualToolArguments.get(block.id) ?? block.arguments })));
            for (const read of call.reads) {
              const name = read.name?.toLowerCase(), requested = read.arguments?.path ?? read.arguments?.file_path ?? read.arguments?.filePath;
              if (name === "rc_progress") continue;
              if (name !== "read" || typeof requested !== "string") {
                report.liveFilesystem.readScopeViolations.push({ ordinal: call.ordinal, name, requested: requested ?? null }); continue;
              }
              const selected = path.resolve(project, requested);
              const resolved = await fs.realpath(selected).catch(() => selected);
              if (!inside(project, selected) || !inside(project, resolved))
                report.liveFilesystem.readScopeViolations.push({ ordinal: call.ordinal, name, requested });
            }
            try {
              guard.prompt(" ".repeat(call.knownPromptBytes));
              for (const message of messages) {
                for (const block of message.content ?? []) if (block.type === "toolCall") guard.observe(block.name, actualToolArguments.get(block.id) ?? block.arguments);
                if (message.role === "toolResult") guard.observe("read:result", { result: { content: message.content, details: message.details, isError: message.isError } });
              }
              call.guardReplay = { withinLimit: true, ...guard.state };
            } catch (error) { call.guardReplay = { withinLimit: false, code: error.code, ...guard.state }; }
            await save("report.json", report);
            if (report.liveFilesystem.readScopeViolations.length) throw Object.assign(new Error("A native read attempted to leave the isolated project."), { code: "ISOLATION_READ_SCOPE_VIOLATION" });
            if (!call.readPolicyObserved) throw Object.assign(new Error("Native read arguments were not observed by the active before_tool_call hook."), { code: "NATIVE_READ_POLICY_UNOBSERVED", reviewerRuntimeFailure: true });
            if (!call.guardReplay.withinLimit) throw Object.assign(new Error("Recorded native retrieval exceeds the production guard; unchecked objects remain UNVERIFIED."), { code: "REVIEWER_CONTEXT_BUDGET", reviewerRuntimeFailure: true });
          }
        },
      });
      const reviewer = { model: modelRef, session: "detached", effort: "low", timeoutMs: itemTimeoutMs,
        ...(finalF1 ? { formatRepairAttempts: 0 } : {}) };
      let assessmentClassification;
      if (mode === "material") {
        assessmentClassification = { stopClassification: "TASK_COMPLETE", stage: null };
        report.fixedMaterialScope = assessmentClassification;
        baseRequest.instructions.push("This is an INDEPENDENT MATERIAL SCOPE sample. TASK_COMPLETE is fixed solely to select sampled metric material. The prior production classifier did not establish a completion scope; do not claim that classification succeeded or that the whole project passed.");
      } else {
        assessmentClassification = { stopClassification: "TASK_COMPLETE", stage: null };
        report.assessmentScope = { source: "CALLER_SELECTED_VERIFY_ONLY", ...assessmentClassification, establishesBusinessPass: false };
        report.classificationStatus = "SKIPPED_CALLER_SELECTED_VERIFY_ONLY";
      }
      for (const selected of report.representatives) {
        if (deadlineAt - Date.now() < 15000 || abort.signal.aborted || priorCalls + report.modelCalls >= maximumGenerations) break;
        const owned = items[selected.index], localPopulation = subset(population, owned);
        const handle = await collectReviewItems({ projectRoot: project, sessionCwd: project, taskId: task.taskId, role: "stop-reviewer",
          reviewerFactory: factory, reviewer, schema: STOP_REVIEW_SCHEMA, request: { ...baseRequest, population: localPopulation },
          evidence: { groundTruth: truth, population: localPopulation, snapshot }, classification: assessmentClassification,
          deadlineAt, abortSignal: abort.signal });
        const feedback = await prepareHostFeedback({ projectRoot: project, taskId: task.taskId, text: handle.result.summary,
          review: { ...handle.result, collection: handle.collection }, citations: handle.sourceCitations });
        report.rounds.push({ representativeIndex: selected.index, objectIds: selected.objectIds, collection: handle.collection,
          result: handle.result, feedback, feedbackBytes: Buffer.byteLength(feedback), sourceCitations: handle.sourceCitations });
        await handle.close(); await save("report.json", report);
      }
      report.live = { elapsedMs: Date.now() - liveStarted, maxCalls: maximumGenerations, linkedNativeCalls: priorCalls + report.modelCalls, checkedObjects: report.rounds.reduce((n, round) => n + round.collection.reviewedObjects, 0),
        totalObjects: report.population.objects, entireTaskStatus: "UNVERIFIED", guardReplayOnly: true,
        limitation: "Direct native harness has an active before-tool paging hook. Tool-result byte guard is trajectory replay only; no Gateway lifecycle, end-to-end app run or business repair." };
      report.status = mode === "material" ? "CLASSIFIER_FAILED_INDEPENDENT_MATERIAL_SCOPE_WHOLE_TASK_UNVERIFIED" : "LIMITED_REAL_STOP_OBSERVED_WHOLE_TASK_UNVERIFIED";
      }
    } finally {
      clearTimeout(timer);
      restoreNativeHook?.();
      for (const [name, value] of Object.entries(originalEnvironment)) { if (value == null) delete process.env[name]; else process.env[name] = value; }
      for (const directory of [stateDir, path.join(root, "host-home")]) for (const file of await regularFiles(directory).catch(() => [])) {
        if (!/\.(?:json|jsonl|log|txt|ndjson)$/u.test(file)) continue;
        const text = await fs.readFile(file, "utf8"), cleaned = secrets.reduce((value, secret) => value.replaceAll(secret, "<redacted>"), text);
        if (cleaned !== text) await fs.writeFile(file, cleaned, { mode: 0o600 });
      }
    }
  }
} catch (error) {
  report.status = "UNVERIFIED"; report.error = { code: error.code ?? error.name, message: secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), error.message) };
  process.exitCode = 1;
} finally {
  const after = [];
  for (const entry of protectedFiles.values()) {
    let current; try { current = hash(await fs.readFile(entry.path)); } catch { current = "MISSING"; }
    after.push({ ...entry, sha256After: current, unchanged: current === entry.sha256 });
    if (current !== entry.sha256) report.stale.push(entry.label);
  }
  report.stale = [...new Set(report.stale)];
  report.originalState = { unchanged: report.stale.length === 0, files: after.length,
    beforeDigest: hash(JSON.stringify(after.map(row => [row.label, row.sha256]))),
    afterDigest: hash(JSON.stringify(after.map(row => [row.label, row.sha256After]))) };
  if (report.stale.length) { report.status = "STALE_BUSINESS_UNVERIFIED"; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - started;
  await save("original-state-hashes.json", after); await save("capture-manifest.json", copied); await save("report.json", report);
  await save("report.md", `# Isolated complex Stop verification\n\nStatus: ${report.status}. Business task: UNVERIFIED.\n\n`
    + `Frozen population: ${report.population?.claims ?? "?"} claims, ${report.population?.objects ?? "?"} objects, ${report.population?.items ?? "?"} items.\n\n`
    + `Preflight: ${report.preflight?.items.length ?? 0} GT/population items; ${report.representatives?.length ?? 0} full-transcript representatives. Maximum request ${report.preflight?.requestMaxBytes ?? "?"} bytes; maximum page ${report.preflight?.pageMaxBytes ?? "?"} bytes. No model call establishes preflight business PASS.\n\n`
    + `Real model calls: ${report.modelCalls}. Current whole-task result remains UNVERIFIED. Native paging before-hook: ${report.nativeReadPolicyHook?.active === true ? "active" : "inactive"}; result-byte guard: trajectory replay only. Full Gateway lifecycle: inactive.\n\n`
    + `Original selected project, main session and host state hashes unchanged: ${report.originalState.unchanged}. Protected files: ${after.length}. Stale labels: ${report.stale.join(", ") || "none"}.\n\n`
    + `Capture ${report.capture?.bytes ?? "?"} bytes; elapsed ${report.elapsedMs} ms. See report.json for every denominator, representative result and limitation.\n`);
  console.log(JSON.stringify({ status: report.status, calls: report.modelCalls, unchanged: report.originalState.unchanged,
    report: path.join(root, "report.json"), error: report.error ?? null }));
}
