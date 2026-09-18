// Opt-in live acceptance: synthetic history, isolated Gateway, real configured GLM.
// Never changes the user's Gateway, sessions, task files, or model configuration.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ensureTask, findTask, withTaskState } from "../../lib/runtime-v2/task-store.mjs";

const host = process.env.RC_COMPACTION_HOST ?? "/opt/homebrew/lib/node_modules/openclaw";
assert.equal(JSON.parse(await fs.readFile(path.join(host, "package.json"))).version, "2026.7.1-2");
const source = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw/openclaw.json")));
const selected = {};
for (const line of (await fs.readFile(path.join(os.homedir(), ".openclaw/.env"), "utf8")).split(/\r?\n/u)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
  if (match) selected[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/u, "$2");
}
const sourceProvider = source.models.providers.review;
const reference = /^\$\{([^}]+)\}$/u.exec(sourceProvider.apiKey ?? "");
assert.ok(reference, "Acceptance requires an environment reference, never a literal credential.");
const credential = selected[reference[1]] ?? process.env[reference[1]];
assert.ok(credential, "Configured credential unavailable.");
const modelId = (source.plugins?.entries?.["runtime-corrector"]?.config?.reviewerModel ?? "review/glm-5.3-flash").split("/").slice(1).join("/");
const model = `review/${modelId}`;
const modelSpec = sourceProvider.models.find((item) => item.id === modelId);
assert.ok(modelSpec, "Configured GLM model unavailable.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-openclaw8-compaction-"));
await fs.chmod(root, 0o700);
const workspace = path.join(root, "workspace"), token = randomUUID();
await fs.mkdir(workspace);
const listener = net.createServer();
await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const configPath = path.join(root, "openclaw.json");
const config = {
  gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: "${RC_COMPACTION_GATEWAY_TOKEN}" } },
  agents: { defaults: { workspace, skipBootstrap: true, timeoutSeconds: 600, sandbox: { mode: "off" },
    model: { primary: model }, models: { [model]: {} },
    // Lower only the fixture's retention threshold to exercise a real summary cheaply.
    compaction: { keepRecentTokens: 1024, recentTurnsPreserve: 2, timeoutSeconds: 300,
      memoryFlush: { enabled: false } } } },
  models: { providers: { review: { baseUrl: sourceProvider.baseUrl, api: sourceProvider.api,
    authHeader: sourceProvider.authHeader, apiKey: "${RC_COMPACTION_API_KEY}",
    agentRuntime: { id: "runtime-corrector-supervised" }, models: [modelSpec] } } },
  tools: { allow: ["read"] },
  plugins: { allow: ["runtime-corrector"], entries: { "runtime-corrector": { enabled: true,
    hooks: { allowConversationAccess: true, allowPromptInjection: true },
    config: { reviewerModel: model, reviewerTimeoutMs: 600000, hookTimeoutMs: 600000, supervisedExecution: true } } } },
  logging: { level: "info", consoleLevel: "error", file: path.join(root, "gateway.jsonl") },
};
await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath,
  RC_COMPACTION_API_KEY: credential, RC_COMPACTION_GATEWAY_TOKEN: token, OPENCLAW_NO_RESPAWN: "1" };
// SDK transcript helpers must use this isolated profile as well.
for (const key of ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "RC_COMPACTION_API_KEY", "RC_COMPACTION_GATEWAY_TOKEN", "OPENCLAW_NO_RESPAWN"]) process.env[key] = env[key];
const redact = (value) => String(value).replaceAll(credential, "<redacted>").replaceAll(token, "<gateway-token>");
const cli = path.join(host, "openclaw.mjs");
function command(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut || code) reject(new Error(redact(`CLI ${args.slice(0, 3).join(" ")}: ${timedOut ? "timeout" : code}\n${output}`)));
      else resolve(output);
    });
  });
}
function jsonOutput(output) {
  const start = output.indexOf("{");
  assert.ok(start >= 0, redact(output));
  return JSON.parse(output.slice(start));
}
const rpc = async (method, params, timeout = 30000) => jsonOutput(await command([
  "gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", String(timeout),
], timeout + 10000));
const pluginVersion = JSON.parse(await fs.readFile(path.resolve("dist/runtime-corrector-openclaw/openclaw.plugin.json"))).version;
const report = { host: "2026.7.1-2", plugin: pluginVersion, model, root, port,
  syntheticHistory: true, retentionTokens: 1024, originalSessionTouched: false, checks: {} };
const progress = (event) => console.log(JSON.stringify({ event, root }));
let gateway;
try {
  await command(["plugins", "install", "--force", path.resolve("dist/runtime-corrector-openclaw")], 120000);
  progress("ISOLATED_PLUGIN_INSTALLED");
  gateway = spawn(process.execPath, [cli, "gateway", "run", "--port", String(port), "--bind", "loopback"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let gatewayOutput = "";
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", (data) => { gatewayOutput += redact(data); });
  gateway.once("error", (error) => { gatewayOutput += redact(error.message); });
  let ready = false;
  for (let attempt = 0; attempt < 20 && !ready; attempt++) {
    try { ready = (await rpc("health", {}, 3000)).ok === true; } catch { /* bounded startup retry */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, gatewayOutput);
  const installed = JSON.parse(await fs.readFile(path.join(root, "extensions/runtime-corrector/openclaw.plugin.json")));
  assert.equal(installed.version, report.plugin);
  const key = "agent:main:compaction-acceptance";
  const created = await rpc("sessions.create", { key, model, label: "Synthetic compaction acceptance", emitCommandHooks: false });
  assert.ok(created.sessionId);
  const sessionId = created.sessionId;
  report.sessionId = sessionId;
  const transcriptPath = created.entry?.sessionFile ?? path.join(root, "agents/main/sessions", `${sessionId}.jsonl`);
  const sdk = await import(pathToFileURL(path.join(host, "dist/plugin-sdk/agent-harness.js")));
  const append = async (role, text) => sdk.appendSessionTranscriptMessage({ config, transcriptPath, sessionId, cwd: workspace,
    message: { role, content: [{ type: "text", text }], timestamp: Date.now(),
      ...(role === "user" ? {} : { api: sourceProvider.api, provider: "review", model: modelId, stopReason: "stop",
        usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) } });
  // Synthetic fixture messages are not submissions or approvals from a real user.
  await append("user", "This is a synthetic compaction test. Remember these authoritative facts for the later recall question: project codename CEDAR-4872; approved color indigo; maximum batch size 17. Do not use tools or modify any files. Keep these facts through summaries.");
  await append("assistant", "I will retain the agreed reference facts and answer later recall questions without tools.");
  for (let turn = 1; turn <= 20; turn++) {
    await append("user", `Synthetic historical discussion ${turn}. ` + Array.from({ length: 28 }, (_, index) =>
      `Observation ${turn}.${index}: the display has a stable header and a readable footer; this is background detail, with no change to the agreed reference facts.`).join(" "));
    await append("assistant", `Background discussion ${turn} noted; it adds no requirements and leaves the original reference facts unchanged.`);
  }
  await append("user", "We have finished the background discussion. Keep the initial reference facts available for a future recall question.");
  await append("assistant", "Ready for the recall question.");
  const task = await ensureTask({ projectRoot: workspace, sessionId });
  await withTaskState({ projectRoot: workspace, taskId: task.taskId }, (state) => {
    state.correctionEpoch = { id: 3, reason: "SYNTHETIC_ACCEPTANCE_FIXTURE", startedAt: new Date().toISOString() };
    state.stop = { epochId: 3, correctionAttempts: 1, lastAssessmentId: "synthetic-prior-assessment" };
    state.deviations = { "synthetic-deviation": { status: "open", reason: "Fixture preservation marker" } };
  });
  const stableState = (state) => Object.fromEntries(["taskId", "groundTruth", "correctionEpoch", "stop", "deviations"].map((name) => [name, state[name]]));
  const beforeTask = stableState(await findTask({ projectRoot: workspace, sessionId }));
  const beforeEntries = (await fs.readFile(transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
  report.fixtureMessages = beforeEntries.filter((entry) => entry.type === "message").length;
  progress("REAL_COMPACTION_STARTED");
  const compact = jsonOutput(await command(["sessions", "compact", key, "--json", "--timeout", "330000"], 340000));
  report.compaction = compact;
  assert.equal(compact.ok, true);
  assert.equal(compact.compacted, true, JSON.stringify(compact));
  const compactedEntries = (await fs.readFile(transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
  const summary = compactedEntries.findLast((entry) => entry.type === "compaction");
  assert.ok(summary?.summary, "Native compaction entry must contain an actual model-generated summary.");
  for (const fact of ["CEDAR-4872", "indigo", "17"]) assert.ok(summary.summary.includes(fact), `Summary lost ${fact}`);
  report.checks.realSummaryContainsOldFacts = true;
  report.summary = summary.summary;
  report.checks.nativeHistoryPreserved = beforeEntries.every((entry) => !entry.id || compactedEntries.some((after) => after.id === entry.id));
  assert.equal(report.checks.nativeHistoryPreserved, true);
  assert.deepEqual(stableState(await findTask({ projectRoot: workspace, sessionId })), beforeTask);
  report.checks.correctionStatePreserved = true;
  progress("SUMMARY_AND_CORRECTION_STATE_PASSED");
  const sent = await rpc("chat.send", { sessionKey: key, message: "Recall the initial project codename, approved color, and maximum batch size. Answer those three values only. Do not use tools.", idempotencyKey: randomUUID() });
  assert.ok(sent.runId);
  let completion;
  for (let attempt = 0; attempt < 14; attempt++) {
    completion = await rpc("agent.wait", { runId: sent.runId, timeoutMs: 45000 }, 50000);
    if (completion.status !== "timeout") break;
    progress("WAITING_FOR_CONTINUATION");
  }
  report.completion = completion;
  assert.equal(completion.status, "ok", JSON.stringify(completion));
  const afterEntries = (await fs.readFile(transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
  const answer = afterEntries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant" && !compactedEntries.some((old) => old.id === entry.id))
    .map((entry) => entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
  report.answer = answer;
  for (const fact of ["CEDAR-4872", "indigo", "17"]) assert.ok(answer.includes(fact), `Continuation lost ${fact}: ${answer}`);
  report.checks.continuationRecallsOldFacts = true;
  report.session = await rpc("sessions.describe", { key });
  assert.equal(report.session.session.agentRuntime.id, "runtime-corrector-supervised");
  // Reproduce the original failure's persisted token pressure in another synthetic
  // session. A normal chat.send must compact automatically before starting a run.
  const autoKey = "agent:main:auto-compaction-acceptance";
  const autoCreated = await rpc("sessions.create", { key: autoKey, model, emitCommandHooks: false });
  const autoPath = autoCreated.entry?.sessionFile ?? path.join(root, "agents/main/sessions", `${autoCreated.sessionId}.jsonl`);
  for (const entry of beforeEntries.filter((item) => item.type === "message")) {
    await sdk.appendSessionTranscriptMessage({ config, transcriptPath: autoPath,
      sessionId: autoCreated.sessionId, cwd: workspace, message: entry.message });
  }
  const sessionStore = await import(pathToFileURL(path.join(host, "dist/plugin-sdk/session-store-runtime.js")));
  await sessionStore.updateSessionStoreEntry({ storePath: path.join(root, "agents/main/sessions/sessions.json"),
    sessionKey: autoKey, update: () => ({ totalTokens: 187422, totalTokensFresh: true, contextTokens: 128000 }) });
  report.autoPressure = { syntheticPersistedTokens: 187422, modelContextTokens: 128000 };
  progress("AUTO_COMPACTION_STARTED");
  const autoSent = await rpc("chat.send", { sessionKey: autoKey,
    message: "Recall the initial project codename, approved color, and maximum batch size. Answer those three values only. Do not use tools.",
    idempotencyKey: randomUUID() });
  let autoCompletion;
  for (let attempt = 0; attempt < 14; attempt++) {
    autoCompletion = await rpc("agent.wait", { runId: autoSent.runId, timeoutMs: 45000 }, 50000);
    if (autoCompletion.status !== "timeout") break;
    progress("WAITING_FOR_AUTO_COMPACTION");
  }
  assert.equal(autoCompletion.status, "ok", JSON.stringify(autoCompletion));
  const autoEntries = (await fs.readFile(autoPath, "utf8")).trim().split("\n").map(JSON.parse);
  const autoSummary = autoEntries.findLast((entry) => entry.type === "compaction");
  assert.ok(autoSummary?.summary, "Normal chat must generate a native automatic compaction entry.");
  const autoAnswer = autoEntries.findLast((entry) => entry.type === "message" && entry.message?.role === "assistant")
    ?.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  for (const fact of ["CEDAR-4872", "indigo", "17"]) {
    assert.ok(autoSummary.summary.includes(fact), `Automatic summary lost ${fact}`);
    assert.ok(autoAnswer?.includes(fact), `Automatic continuation lost ${fact}: ${autoAnswer}`);
  }
  report.autoSession = await rpc("sessions.describe", { key: autoKey });
  assert.ok(report.autoSession.session.totalTokens < 128000);
  assert.equal(report.autoSession.session.agentRuntime.id, "runtime-corrector-supervised");
  report.autoAnswer = autoAnswer;
  report.checks.automaticCompactionAndContinuation = true;
  report.passed = true;
  progress("ACCEPTANCE_PASSED");
} catch (error) {
  report.passed = false;
  report.error = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => { gateway.kill("SIGKILL"); resolve(); }, 10000);
      gateway.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await fs.writeFile(path.join(root, "report.json"), redact(JSON.stringify(report, null, 2)), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, report: path.join(root, "report.json"), error: report.error }));
}
