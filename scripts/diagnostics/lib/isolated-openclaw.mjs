import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "../../../lib/plugin-builder.mjs";

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function files(root) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await files(target)); else if (entry.isFile()) found.push(target);
  }
  return found;
}
export async function json(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
export async function runtimeState(projectRoot) {
  const tasks = [], journals = [], records = [], evaluations = [];
  for (const file of await files(path.join(projectRoot, ".runtime-correction"))) {
    const portable = file.replaceAll("\\", "/");
    if (portable.endsWith("/task.json")) tasks.push(await json(file));
    else if (portable.endsWith("/journal/events.jsonl")) for (const row of (await fs.readFile(file, "utf8")).split("\n").filter(Boolean)) journals.push(JSON.parse(row));
    else if (/\/native-(?:runs|followups|stop-reviews)\/.+\.json$/u.test(portable)) records.push({ file: portable, ...await json(file) });
    else if (/\/evaluations\/stop-.+\.json$/u.test(portable)) evaluations.push({ file: portable, ...await json(file) });
  }
  return { tasks, journals, records, evaluations };
}
export async function isolatedHost({ hostRoot, providerFile, destination, port, resume = false, platformAdapters = {}, workspaceSkillSources = [], extraPlugins = [], preparePlugin, hookTimeoutMs = 600000, clientCaps = ["tool-events"], subscribeSessionEvents = false, tools = ["read", "write", "edit", "exec", "runtime_corrector"] }) {
  if (!process.env.RC_TEST_MODEL_KEY) throw new Error("RC_TEST_MODEL_KEY required");
  if (!resume) await fs.mkdir(destination, { mode: 0o700 });
  const root = await fs.realpath(destination), pkg = await json(path.join(hostRoot, "package.json"));
  if (!["2026.7.1-2", "2026.10.3"].includes(pkg.version)) throw new Error("Unverified host release");
  const stateDir = path.join(root, "host-state"), homeDir = path.join(root, "home"), defaultDir = path.join(root, "default");
  for (const dir of [stateDir, homeDir, defaultDir]) await fs.mkdir(dir, { recursive: resume });
  const sourceRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot, outputRoot: path.join(root, "plugin") });
  await preparePlugin?.(pluginRoot);
  // The native host snapshots plugin resources at admission. Prepare test
  // adapters before Gateway startup so the loaded plugin can actually see them.
  for (const [name, adapter] of Object.entries(platformAdapters)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error("Invalid experiment platform name");
    await fs.writeFile(path.join(pluginRoot, "config/platforms", `${name}.json`), JSON.stringify(adapter, null, 2));
  }
  // Native skill discovery must see the actual files before Gateway startup.
  for (const directory of workspaceSkillSources) {
    const name = path.basename(directory);
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error("Invalid experiment skill name");
    await fs.access(path.join(directory, "SKILL.md"));
    await fs.cp(directory, path.join(defaultDir, "skills", name), { recursive: true });
  }
  const descriptor = await json(providerFile), model = `test/${descriptor.model.id}`, token = randomUUID();
  const provider = { baseUrl: descriptor.baseUrl, api: descriptor.api, authHeader: descriptor.authHeader,
    apiKey: "${RC_TEST_MODEL_KEY}", agentRuntime: { id: "openclaw" }, models: [descriptor.model] };
  const config = { gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: "${RC_EXPERIMENT_GATEWAY_TOKEN}" } },
    agents: { defaults: { workspace: defaultDir, skipBootstrap: true, timeoutSeconds: 1200, thinkingDefault: "off",
      model: { primary: model }, models: { [model]: {} }, sandbox: { mode: "off" } } }, models: { providers: { test: provider } },
    tools: { allow: tools, exec: { security: "full", ask: "off" } },
    plugins: { allow: ["runtime-corrector", ...extraPlugins.map(p => p.id)], load: { paths: [pluginRoot, ...extraPlugins.map(p => p.path)] }, entries: { ...Object.fromEntries(extraPlugins.map(p => [p.id, { enabled: true }])), "runtime-corrector": { enabled: true,
      hooks: { allowConversationAccess: true, allowPromptInjection: true }, config: { reviewerModel: model, hookTimeoutMs } } } },
    logging: { level: "debug", consoleLevel: "error", file: path.join(root, "gateway.jsonl") } };
  const configFile = path.join(root, "openclaw.json");
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  const env = { ...process.env, OPENCLAW_HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configFile,
    RC_EXPERIMENT_GATEWAY_TOKEN: token, OPENCLAW_NO_RESPAWN: "1" };
  for (const key of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "RC_EXPERIMENT_GATEWAY_TOKEN"]) process.env[key] = env[key];
  const redact = value => String(value).replaceAll(process.env.RC_TEST_MODEL_KEY, "<model-key>").replaceAll(token, "<gateway-token>");
  const save = (name, value) => fs.writeFile(path.join(root, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
  const dist = path.join(hostRoot, "dist"); let clientFile;
  for (const file of (await fs.readdir(dist)).filter(name => /^client-[^.]+\.(?:mjs|js)$/u.test(name))) {
    if ((await fs.readFile(path.join(dist, file), "utf8")).includes("var GatewayClient = class")) { clientFile = file; break; }
  }
  if (!clientFile) throw new Error("Verified host Gateway client unavailable");
  const exported = await import(pathToFileURL(path.join(dist, clientFile))), GatewayClient = exported.GatewayClient ?? exported.t;
  const wire = await fs.open(path.join(root, "wire.jsonl"), "a"), log = await fs.open(path.join(root, "console.log"), "a");
  const events = [], pending = new Map(); let gateway, client, generation = 0, closed = false;
  async function start() {
    generation++;
    gateway = spawn(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "gateway", "run", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", chunk => { void log.appendFile(redact(chunk)).catch(() => {}); });
    await new Promise((resolve, reject) => {
      let connectionError;
      const timer = setTimeout(() => reject(new Error(`Gateway readiness timeout${connectionError ? `: ${connectionError}` : ""}`)), 60000);
      gateway.once("error", error => { clearTimeout(timer); reject(new Error(`Gateway process start failed: ${error.code ?? error.name}`)); });
      // Retain SDK CLI authentication. MA's empty caps + session subscription
      // select its real event route without impersonating a browser login.
      client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, clientName: "cli", mode: "cli", caps: clientCaps,
        scopes: ["operator.admin", "operator.read", "operator.write"], env,
        onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { connectionError = redact(error.message); }, onEvent(event) {
          const row = { at: Date.now(), generation, ...event }; events.push(row); void wire.appendFile(redact(JSON.stringify(row)) + "\n").catch(() => {});
          if (event.event === "chat" && ["final", "error", "aborted"].includes(event.payload?.state)) pending.get(event.payload.runId)?.(event.payload);
        } }); client.start();
    });
    if (subscribeSessionEvents) await client.request("sessions.subscribe", {});
    await save("process.json", { observerPid: process.pid, gatewayPid: gateway.pid, port, generation });
  }
  async function stop() {
    await client?.stopAndWait?.({ timeoutMs: 2000 }); client?.stop();
    if (gateway && gateway.exitCode === null) {
      gateway.kill("SIGTERM");
      await new Promise(resolve => { const timer = setTimeout(() => { gateway.kill("SIGKILL"); resolve(); }, 5000);
        gateway.once("exit", () => { clearTimeout(timer); resolve(); }); });
    }
  }
  async function send(sessionKey, message, timeoutMs = 1200000) {
    const runId = randomUUID(), startedAt = Date.now(), params = { sessionKey, message, idempotencyKey: runId };
    let timer;
    const terminal = new Promise((resolve, reject) => {
      timer = setTimeout(() => { pending.delete(runId); reject(new Error("Business turn observer deadline")); }, timeoutMs);
      pending.set(runId, resolve);
    });
    try {
      await client.request("chat.send", params);
      const outcome = await terminal;
      if (outcome.state !== "final") throw new Error(`Host turn ${outcome.state}: ${redact(outcome.errorMessage ?? "")}`);
      return { runId, startedAt, terminalAt: Date.now(), params, outcome };
    } finally { clearTimeout(timer); pending.delete(runId); }
  }
  const request = (method, params) => client.request(method, params);
  const status = async key => {
    const sent = await send(key, "/rc-project status", 30000), blocks = sent.outcome.message?.content;
    return JSON.parse(typeof blocks === "string" ? blocks : (blocks ?? []).filter(x => x.type === "text").map(x => x.text).join("\n"));
  };
  const close = async () => { if (closed) return; closed = true;
    for (const resolve of pending.values()) resolve({ state: "aborted", errorMessage: "Isolated observer closed" });
    await stop(); await wire.close(); await log.close(); };
  try { await start(); } catch (error) { await close(); throw error; }
  return { root, hostRoot, pluginRoot, stateDir, defaultDir, config, configFile, version: pkg.version, model, events, redact, save,
    get health() { return { alive: Boolean(gateway?.pid && gateway.exitCode === null && gateway.signalCode === null),
      pid: gateway?.pid ?? null, exitCode: gateway?.exitCode ?? null, signal: gateway?.signalCode ?? null, generation }; },
    request, send, status, restart: async () => { await stop(); await start(); }, close };
}
