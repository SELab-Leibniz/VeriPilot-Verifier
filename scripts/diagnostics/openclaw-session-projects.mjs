// Real Gateway probe. All config, sessions, projects and ports are isolated.
// Supply RC_TEST_MODEL_KEY and a provider descriptor, never print credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../../lib/plugin-builder.mjs";
const exec = promisify(execFile);
const [hostRoot, providerFile, destination, portValue] = process.argv.slice(2);
const contractOnly = process.env.RC_PROJECT_CONTRACT_ONLY === "1";
if (!hostRoot || !providerFile || !destination || !portValue || !contractOnly && !process.env.RC_TEST_MODEL_KEY) throw new Error("Required: host package, provider JSON, new output directory, port, RC_TEST_MODEL_KEY.");
const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, "package.json")));
const native = pkg.version === "2026.10.3";
if (!native && pkg.version !== "2026.7.1-2") throw new Error("Only verified host releases may run this probe.");
const root = path.resolve(destination), port = Number(portValue);
await fs.mkdir(root, { mode: 0o700 });
const defaultDir = path.join(root, "default"), stateDir = path.join(root, "host-state"), homeDir = path.join(root, "home");
for (const dir of [defaultDir, stateDir, homeDir]) await fs.mkdir(dir);
const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve(new URL("../..", import.meta.url).pathname), outputRoot: path.join(root, "plugin") });
const descriptor = JSON.parse(await fs.readFile(providerFile));
const model = `test/${descriptor.model.id}`;
const provider = { baseUrl: descriptor.baseUrl, api: descriptor.api, authHeader: descriptor.authHeader,
  apiKey: "${RC_TEST_MODEL_KEY}", agentRuntime: { id: "openclaw" }, models: [descriptor.model] };
if (contractOnly) { provider.baseUrl = "http://127.0.0.1:1/no-model"; provider.apiKey = "contract-only-unused"; }
const token = randomUUID();
const config = { gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: "${RC_PROJECT_GATEWAY_TOKEN}" } },
  agents: { defaults: { workspace: defaultDir, skipBootstrap: true, timeoutSeconds: 300, thinkingDefault: "off", model: { primary: model }, models: { [model]: {} }, sandbox: { mode: "off" } } },
  models: { providers: { test: provider } }, tools: { allow: ["read", "write", "runtime_corrector"], exec: { security: "deny", ask: "always" } },
  plugins: { allow: ["runtime-corrector"], load: { paths: [pluginRoot] }, entries: { "runtime-corrector": { enabled: true,
    hooks: { allowConversationAccess: true, allowPromptInjection: true }, config: { reviewerModel: model } } } },
  logging: { level: "debug", consoleLevel: "error", file: path.join(root, "gateway.jsonl") } };
const configFile = path.join(root, "openclaw.json");
await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
const env = { ...process.env, OPENCLAW_HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configFile,
  RC_PROJECT_GATEWAY_TOKEN: token, OPENCLAW_NO_RESPAWN: "1" };
const redact = text => {
  let value = String(text).replaceAll(token, "<gateway-token>");
  if (process.env.RC_TEST_MODEL_KEY) value = value.replaceAll(process.env.RC_TEST_MODEL_KEY, "<redacted>");
  return value;
};
// SDK module initialization also consults the environment; isolate it before
// importing a host module, not only in the spawned Gateway process.
for (const key of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "RC_PROJECT_GATEWAY_TOKEN"]) process.env[key] = env[key];
const dist = path.join(hostRoot, "dist"), files = await fs.readdir(dist);
let clientFile;
for (const name of files.filter(name => /^client-[^.]+\.(?:mjs|js)$/u.test(name))) {
  if ((await fs.readFile(path.join(dist, name), "utf8")).includes("var GatewayClient = class")) { clientFile = name; break; }
}
if (!clientFile) throw new Error("Probe Gateway client not found.");
const exports = await import(pathToFileURL(path.join(dist, clientFile)));
const GatewayClient = exports.GatewayClient ?? exports.t;
const gateway = spawn(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "gateway", "run", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
const log = await fs.open(path.join(root, "console.log"), "a"), wire = await fs.open(path.join(root, "wire.jsonl"), "a");
for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", data => { void log.appendFile(redact(data)); });
let client;
const events = [], pending = new Map(), result = { probe: contractOnly ? "host-contract-only-no-model-or-business-files" : "real-model-and-business-files",
  hostVersion: pkg.version, mode: native ? "native" : "legacy", defaultDir, sessions: [], errors: [] };
async function send(sessionKey, message) {
  const runId = randomUUID();
  const terminal = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(runId); reject(new Error("Host turn timeout")); }, contractOnly ? 30000 : 240000);
    pending.set(runId, value => { clearTimeout(timer); resolve(value); });
  });
  await client.request("chat.send", { sessionKey, message, idempotencyKey: runId });
  const value = await terminal;
  if (value.state !== "final") throw new Error(`Host turn ${value.state}: ${redact(value.errorMessage ?? "")}`);
  return value;
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway readiness timeout")), 60000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, clientName: "cli", mode: "cli", caps: ["tool-events"], scopes: ["operator.admin", "operator.read", "operator.write"], env,
      onHelloOk() { clearTimeout(timer); resolve(); },
      onConnectError() {}, onEvent(event) {
        events.push(event); void wire.appendFile(redact(JSON.stringify(event)) + "\n");
        if (event.event === "chat" && ["final", "error", "aborted"].includes(event.payload?.state)) pending.get(event.payload.runId)?.(event.payload);
      } });
    client.start();
  });
  const policy = `version: 2\nartifacts:\n  - name: draft\n    stage: drafting\n    patterns: [draft.md]\n    rules:\n      enabled: false\n    review:\n      enabled: false\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: []\n  panel:\n    size: 1\n    adjudicator: false\nstopCorrection:\n  enabled: false\nimplementationCorrection:\n  enabled: false\nreviewers:\n  defaults:\n    timeoutMs: 90000\n    model: ${model}\n`;
  for (const name of ["A", "B", "off", ...(native ? ["tree"] : [])]) {
    const directory = path.join(root, name); await fs.mkdir(directory);
    if (name !== "off") { await fs.mkdir(path.join(directory, ".runtime-corrector")); await fs.writeFile(path.join(directory, ".runtime-corrector/config.yaml"), policy); }
    if (name === "tree") {
      await exec("git", ["init", "--quiet"], { cwd: directory });
      await exec("git", ["add", ".runtime-corrector/config.yaml"], { cwd: directory });
      await exec("git", ["-c", "user.name=RC Probe", "-c", "user.email=probe@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: directory });
    }
    const key = `agent:main:rc-project-${name.toLowerCase()}`;
    const created = await client.request("sessions.create", { key, model, label: `RC project ${name}`, emitCommandHooks: false,
      ...(native ? { cwd: directory, ...(name === "tree" ? { worktree: true, worktreeName: "rc-probe" } : {}) } : {}) });
    await fs.writeFile(path.join(root, `${name}-created.json`), redact(JSON.stringify(created, null, 2)));
    if (!native) await send(key, `/rc-project bind ${directory}`);
    const before = events.length;
    const file = native ? "draft.md" : path.join(directory, "draft.md"), stamp = `SESSION_${name}_ONLY`;
    if (!contractOnly) await send(key, `请用 write 工具将 ${stamp} 加一个换行写入 ${file}，再用 read 工具读取确认，然后直接回复完成。只改这个文件，不要运行命令、初始化项目或改纠偏配置。`);
    const status = await send(key, "/rc-project status");
    const content = status.message?.content;
    const text = typeof content === "string" ? content : (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
    const parsed = JSON.parse(text);
    const actualRoot = parsed.projectRoot;
    if (!actualRoot || parsed.source !== (native ? "host" : "rc") || parsed.enabled !== (name !== "off")) throw new Error(`Wrong scope status for ${name}`);
    const actual = contractOnly ? null : await fs.readFile(path.join(actualRoot, "draft.md"), "utf8");
    if (!contractOnly && actual !== stamp + "\n") throw new Error(`Wrong file contents for ${name}`);
    let tasks = [];
    try { tasks = await fs.readdir(path.join(actualRoot, ".runtime-correction/tasks")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (name === "off" && tasks.length) throw new Error("Unconfigured project created tasks");
    if (!contractOnly && name !== "off" && !tasks.length) throw new Error(`Enabled project ${name} did not create a Session task`);
    const taskStates = await Promise.all(tasks.map(async taskId => JSON.parse(await fs.readFile(path.join(actualRoot, ".runtime-correction/tasks", taskId, "task.json")))));
    if (!contractOnly && name !== "off" && !taskStates.some(task => task.groundTruth?.version > 0 && task.onboarding?.status === "COMPLETED")) {
      throw new Error(`Project ${name} wrote its file but did not establish a valid requirement baseline`);
    }
    const reviewerRuns = [];
    const reviewerRoot = path.join(actualRoot, ".runtime-correction/openclaw/native-runs");
    for (const group of await fs.readdir(reviewerRoot).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      for (const filename of await fs.readdir(path.join(reviewerRoot, group))) if (filename.endsWith(".json")) {
        const run = JSON.parse(await fs.readFile(path.join(reviewerRoot, group, filename)));
        if (!tasks.includes(run.taskId)) throw new Error(`Reviewer record belongs to another task in ${name}`);
        reviewerRuns.push({ taskId: run.taskId, sessionId: run.sessionId, runId: run.runId, role: run.role, status: run.status });
      }
    }
    if (name === "off" && reviewerRuns.length) throw new Error("Unconfigured project dispatched a Reviewer");
    const sessionEvents = events.slice(before);
    result.sessions.push({ name, key, sessionId: created.sessionId ?? created.session?.sessionId, requestedDirectory: directory,
      actualRoot, source: parsed.source, enabled: parsed.enabled, fileContents: actual, taskIds: tasks,
      taskStates: taskStates.map(task => ({ taskId: task.taskId, rootSessionId: task.rootSessionId, sessionIds: task.sessionIds,
        groundTruthVersion: task.groundTruth?.version, onboardingStatus: task.onboarding?.status, correctionAttempts: task.stop?.correctionAttempts })),
      reviewerRuns,
      observedPrivateReviewerEventsDuringTurn: sessionEvents.filter(e => JSON.stringify(e.payload?.sessionKey ?? "").includes(":runtime-corrector:")).length,
      worktreeDifferentFromOrigin: name === "tree" ? actualRoot !== directory : undefined });
    if (native && name === "A") {
      const denied = await send(key, `/rc-project bind ${path.join(root, "B")}`);
      await fs.writeFile(path.join(root, "native-bind-denied.json"), redact(JSON.stringify(denied, null, 2)));
    }
  }
  if ((await fs.readdir(defaultDir)).includes(".runtime-correction")) throw new Error("Host default workspace polluted");
  result.status = "PASS";
} catch (error) { result.status = "FAIL"; result.errors.push(redact(error.message)); }
finally {
  client?.stop(); gateway.kill("SIGTERM");
  await new Promise(resolve => { const timer = setTimeout(() => { gateway.kill("SIGKILL"); resolve(); }, 5000); gateway.once("exit", () => { clearTimeout(timer); resolve(); }); });
  await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(result, null, 2));
  await log.close(); await wire.close();
}
process.stdout.write(JSON.stringify({ status: result.status, hostVersion: pkg.version, output: root, errors: result.errors }) + "\n");
process.exitCode = result.status === "PASS" ? 0 : 1;
