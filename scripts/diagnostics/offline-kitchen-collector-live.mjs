// Real configured native reviewers against isolated copies of the offline app.
// No Gateway, installed-plugin replacement, business repair or credential export.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildPlugin } from "../../lib/plugin-builder.mjs";

const [destination, mode = "probe"] = process.argv.slice(2);
if (!destination || !["probe", "live", "repair-check"].includes(mode)) throw new Error("new-output-directory [probe|live|repair-check] required");
const repairCheck = mode === "repair-check", reviewerTimeoutMs = repairCheck ? 180_000 : 90_000;
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const hostRoot = process.env.RC_KITCHEN_HOST_ROOT ?? "C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw";
const hostVersion = JSON.parse(await fs.readFile(path.join(hostRoot, "package.json"), "utf8")).version;
if (hostVersion !== "2026.7.1-2") throw new Error("This diagnostic requires the verified OpenClaw 2026.7.1-2 native runtime.");
const home = os.homedir(), sourceConfig = JSON.parse(await fs.readFile(path.join(home, ".openclaw/openclaw.json"), "utf8"));
const sourceRef = typeof sourceConfig.agents?.defaults?.model === "string" ? sourceConfig.agents.defaults.model : sourceConfig.agents?.defaults?.model?.primary;
const split = sourceRef.indexOf("/"), providerId = sourceRef.slice(0, split), modelId = sourceRef.slice(split + 1);
const configured = sourceConfig.models?.providers?.[providerId];
const cached = JSON.parse(await fs.readFile(path.join(home, ".openclaw/agents/main/agent/models.json"), "utf8")).providers?.[providerId] ?? {};
const configuredKey = configured.apiKey ?? cached.apiKey;
const environmentName = typeof configuredKey === "string" && /^\$\{([^}]+)\}$/u.exec(configuredKey)?.[1];
const key = environmentName ? process.env[environmentName] : configuredKey;
if (!key || !configured?.baseUrl || !configured?.api) throw new Error("The existing configured native provider is not usable.");
const secrets = [key, process.env.ANTHROPIC_AUTH_TOKEN].filter(Boolean);
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), String(value));
await fs.mkdir(destination, { mode: 0o700 });
const root = await fs.realpath(destination), project = path.join(root, "kitchen");
await fs.mkdir(project);
await fs.copyFile(path.join(sourceRoot, "examples/openclaw-offline-kitchen/app/kitchen.py"), path.join(project, "kitchen.py"));
const contract = await fs.readFile(path.join(sourceRoot, "examples/openclaw-offline-kitchen/skills/build-offline-kitchen/references/requirements.md"), "utf8");
await fs.writeFile(path.join(project, "requirements.md"), contract);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (file, value) => fs.writeFile(path.join(root, file), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
const report = { schemaVersion: 1, mode, status: "RUNNING", startedAt: new Date().toISOString(), sourceRoot, hostRoot,
  model: sourceRef, hostVersion, realModel: true, gatewayUsed: false, installedConfigurationModified: false, calls: [], rounds: [] };
const originalState = { config: process.env.OPENCLAW_CONFIG_PATH, state: process.env.OPENCLAW_STATE_DIR, home: process.env.OPENCLAW_HOME };
const stateDir = path.join(root, "host-state"); await fs.mkdir(stateDir);
const model = { ...configured.models.find(item => item.id === modelId), reasoning: false, maxTokens: 8192 };
const config = { agents: { defaults: { workspace: project, skipBootstrap: true, timeoutSeconds: reviewerTimeoutMs / 1000,
  model: { primary: sourceRef }, models: { [sourceRef]: {} }, sandbox: { mode: "off" } } },
  models: { providers: { [providerId]: { ...configured, apiKey: "${RC_KITCHEN_MODEL_KEY}", models: [model] } } },
  plugins: { enabled: false }, tools: { allow: ["read"] }, logging: { level: "error", consoleLevel: "error" } };
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = path.join(root, "host-home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.RC_KITCHEN_MODEL_KEY = key;
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
config.models.providers[providerId].apiKey = key;
const abort = new AbortController();
const absoluteDeadline = Date.now() + (mode === "probe" ? 85_000 : repairCheck ? 180_000 : 600_000);
const timer = setTimeout(() => abort.abort(Object.assign(new Error("Isolated native experiment deadline expired."), { code: "EXPERIMENT_DEADLINE" })), absoluteDeadline - Date.now());
try {
  const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot, outputRoot: path.join(root, "plugin") });
  const load = file => import(pathToFileURL(path.join(pluginRoot, "lib", file)));
  const { createPluginRuntime } = await import(pathToFileURL(path.join(hostRoot, "dist/plugins/runtime/index.js")));
  const native = createPluginRuntime();
  const { createOpenClawReviewerFactory } = await load("openclaw/reviewer.mjs");
  const { collectReviewItems } = await load("runtime-v2/review-collector.mjs");
  const { STOP_REVIEW_SCHEMA } = await load("runtime-v2/reviewer.mjs");
  const { IMPL_REVIEW_SCHEMA } = await load("runtime-v2/impl-review.mjs");
  const { ensureTask, taskDirectory } = await load("runtime-v2/task-store.mjs");
  const { applyGroundTruthDelta, freezeGroundTruth } = await load("runtime-v2/ground-truth-ledger.mjs");
  const { prepareHostFeedback } = await load("runtime-v2/feedback-delivery.mjs");
  const task = await ensureTask({ projectRoot: project, sessionId: "isolated-native-kitchen" });
  const requirements = contract.split(/\n(?=R\d+ )/u).map(block => /^(R\d+) ([\s\S]*)$/u.exec(block)).filter(Boolean);
  if (requirements.length !== 6) throw new Error("The frozen kitchen contract must contain all six complete obligations.");
  await applyGroundTruthDelta({ projectRoot: project, taskId: task.taskId, delta: { operations: requirements.map(match => ({
    operation: "ADD", category: "requirements", text: `${match[1]} ${match[2].trim()}`, authority: "USER_EXPLICIT", severity: "HARD",
    verificationTarget: match[1] === "R06" ? "PROCESS" : "IMPLEMENTATION", source: { ref: "user:isolated-kitchen-contract" },
  })) } });
  const { current: groundTruth } = await freezeGroundTruth({ projectRoot: project, taskId: task.taskId });
  const truth = groundTruth ?? JSON.parse(await fs.readFile(path.join(taskDirectory(project, task.taskId), "ground-truth/current.json"), "utf8"));
  const groundTruthPath = path.join(taskDirectory(project, task.taskId), "ground-truth/current.json");
  const factory = createOpenClawReviewerFactory({ config, runtime: { version: hostVersion, agent: native.agent } }, {
    reviewerModel: sourceRef, reviewerTimeoutMs, deadlineAt: absoluteDeadline, abortSignal: abort.signal,
    runEmbeddedAgent: async params => {
      const call = { ordinal: report.calls.length + 1, sessionId: params.sessionId, runId: params.runId, startedAt: new Date().toISOString() };
      report.calls.push(call); console.log(JSON.stringify({ phase: "native-review-start", ordinal: call.ordinal }));
      const result = await native.agent.runEmbeddedAgent(params);
      call.finishedAt = new Date().toISOString(); call.stopReason = result.meta?.stopReason ?? null;
      call.errorKind = result.meta?.error?.kind ?? null; call.usage = result.meta?.agentMeta?.usage ?? null;
      call.toolNames = await fs.readFile(params.sessionFile, "utf8").then(text => text.trim().split("\n").flatMap(line => {
        try { return (JSON.parse(line).message?.content ?? []).filter(item => item.type === "toolCall").map(item => item.name); } catch { return []; }
      })).catch(() => []);
      await save("report.json", report); return result;
    },
  });
  const reviewer = { session: "detached", effort: "low", timeoutMs: reviewerTimeoutMs,
    ...(repairCheck ? {} : { formatRepairAttempts: 0 }) };
  report.formatRepairSetting = repairCheck ? "production-default" : 0;
  if (mode === "probe") {
    const handle = await factory({ projectRoot: project, sessionCwd: project, taskId: task.taskId, role: "stop-reviewer", reviewer,
      schema: STOP_REVIEW_SCHEMA, request: { population: { metrics: {} }, groundTruthPath,
        reviewScope: { kind: "classification", objectIds: [], sourceIds: [] },
        hook: { lastAssistantMessage: "The offline kitchen app is complete." },
        instructions: ["Classify this attempted completion as TASK_COMPLETE. Return empty metricObjectJudgements and findings, stage null, and a concise summary. This transport probe does not establish any application PASS."] },
      evidence: { groundTruth: truth, population: { metrics: {} } }, deadlineAt: absoluteDeadline });
    report.probe = handle.result; await handle.close(); report.status = "TRANSPORT_VERIFIED";
  } else {
    const file = path.join(project, "kitchen.py"), correct = await fs.readFile(file, "utf8");
    const broken = correct.replace("pantry[ing] = pantry.get(ing, 0) - need", "pantry[ing] = pantry.get(ing, 0)  # controlled missing debit");
    if (broken === correct) throw new Error("Controlled cooking debit mutation did not match the seed.");
    await fs.writeFile(file, broken);
    report.controlledBusinessFault = { mutation: "cook returns success without deducting required stock", sourceSha256: hash(broken), observerAuthoredBusinessFix: false };
    for (const role of repairCheck ? ["implementation-reviewer"] : ["stop-reviewer", "implementation-reviewer"]) {
      const claims = truth.claims.filter(claim => repairCheck ? claim.text.startsWith("R04 ") : !claim.text.startsWith("R06 "));
      if (repairCheck && claims.length !== 1) throw new Error("The repair check must own exactly the frozen R04 obligation.");
      const objects = claims.map(claim => ({ objectId: `M12:${claim.claimId}`, metricId: "M12", sourceId: claim.claimId,
        sourceRevisionId: claim.revisionId, description: claim.text, hard: true, evidenceRequired: true, verificationTarget: "IMPLEMENTATION" }));
      const population = { taskId: task.taskId, version: 1, groundTruthVersion: truth.version, digest: hash(JSON.stringify(objects)), metrics: { M12: objects } };
      let attempted = 0;
      const isolated = async options => {
        attempted++;
        if (role === "stop-reviewer" && attempted === 3) throw Object.assign(new Error("Controlled per-item context overflow; no model failure was fabricated."), { code: "CONTEXT_OVERFLOW" });
        return factory(options);
      };
      const handle = await collectReviewItems({ projectRoot: project, sessionCwd: project, taskId: task.taskId,
        role, reviewerFactory: isolated, reviewer, schema: role === "stop-reviewer" ? STOP_REVIEW_SCHEMA : IMPL_REVIEW_SCHEMA,
        classification: role === "stop-reviewer" ? { stopClassification: "TASK_COMPLETE", stage: null } : null,
        request: { groundTruthPath, population, sourceManifest: [{ path: "kitchen.py", sha256: hash(broken), size: Buffer.byteLength(broken) }],
          instructions: ["Read the original kitchen.py and check only your assigned obligation. Diagnose the actual production mechanism and consequence with line references. Do not infer PASS from the reference implementation's history."] },
        evidence: { groundTruth: truth, population }, deadlineAt: absoluteDeadline, abortSignal: abort.signal });
      const feedback = await prepareHostFeedback({ projectRoot: project, taskId: task.taskId, text: handle.result.summary,
        review: { ...handle.result, collection: handle.collection }, citations: handle.sourceCitations });
      report.rounds.push({ role, attempted, collection: handle.collection, result: handle.result, feedback,
        feedbackBytes: Buffer.byteLength(feedback), sourceCitations: handle.sourceCitations });
      await save("report.json", report); await handle.close();
      if (abort.signal.aborted || Date.now() >= absoluteDeadline) break;
    }
    report.scope = repairCheck
      ? "One R04 implementation obligation with production-default format repair; no artificial reviewer overflow, no business repair and no whole-application PASS claim."
      : "R01-R05 source obligations only; R06 process verification is frozen but not claimed as checked in this direct native-collector experiment.";
    if (repairCheck) {
      const round = report.rounds[0], rows = round?.result.metricObjectJudgements ?? [];
      report.status = report.rounds.length === 1 && round.role === "implementation-reviewer"
        && round.collection.complete && round.collection.totalObjects === 1 && round.collection.reviewedObjects === 1
        && !round.collection.failures.length && rows.length === 1 && rows[0].judgement === "DEVIATION"
        ? "R04_DEVIATION_CONFIRMED" : "UNVERIFIED";
      if (report.status === "UNVERIFIED") process.exitCode = 1;
    } else report.status = report.rounds.some(round => round.collection.reviewedObjects > 0) ? "COMPLETED_WITH_OBSERVATIONS" : "UNVERIFIED";
  }
} catch (error) {
  report.status = "UNVERIFIED"; report.error = { code: error.code ?? error.name, message: redact(error.message) };
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  report.sanitizedFiles = [];
  const sanitize = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await sanitize(file);
      else if (entry.isFile() && /\.(?:json|jsonl|log|txt|ndjson)$/u.test(entry.name)) {
        const text = await fs.readFile(file, "utf8"), cleaned = redact(text);
        if (cleaned !== text) { await fs.writeFile(file, cleaned, { mode: 0o600 }); report.sanitizedFiles.push(path.relative(root, file)); }
      }
    }
  };
  await sanitize(stateDir); await sanitize(process.env.OPENCLAW_HOME);
  report.finishedAt = new Date().toISOString(); await save("report.json", report);
  for (const [name, value] of [["OPENCLAW_CONFIG_PATH", originalState.config], ["OPENCLAW_STATE_DIR", originalState.state], ["OPENCLAW_HOME", originalState.home]]) {
    if (value == null) delete process.env[name]; else process.env[name] = value;
  }
  delete process.env.RC_KITCHEN_MODEL_KEY;
  console.log(JSON.stringify({ status: report.status, calls: report.calls.length, report: path.join(root, "report.json") }));
}
