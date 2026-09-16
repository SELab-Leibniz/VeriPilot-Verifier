// Isolated Gateway acceptance harness. Credentials stay in the child environment;
// neither the generated config nor the plugin/report contains a provider key.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/u, "")] = process.argv[i + 1];
for (const name of Object.keys(flags)) if (!["env-file", "openclaw-root", "plugin", "project-config", "port", "root"].includes(name)) throw new Error(`Unknown option: ${name}`);
const host = flags["openclaw-root"] ?? "/opt/homebrew/lib/node_modules/openclaw";
if (JSON.parse(await fs.readFile(path.join(host, "package.json"))).version !== "2026.7.1-2") throw new Error("Wrong host version.");
const root = flags.root ? path.resolve(flags.root) : await fs.mkdtemp(path.join(os.tmpdir(), "rc-openclaw7-"));
if (flags.root && (await fs.readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error; })).length) throw new Error("Use a new empty acceptance root; existing profiles are never overwritten.");
await fs.mkdir(root, { recursive: true, mode: 0o700 });
await fs.chmod(root, 0o700);
const selected = {};
for (const line of (await fs.readFile(flags["env-file"] ?? path.join(os.homedir(), ".openclaw/.env"), "utf8")).split(/\r?\n/u)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
  if (match) selected[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/u, "$2");
}
if (!selected.ANTHROPIC_AUTH_TOKEN) throw new Error("Authorized model credential unavailable.");
const port = Number(flags.port ?? 19877);
const workspace = path.join(root, "workspace"), token = randomUUID();
await fs.mkdir(workspace, { recursive: true });
if (flags["project-config"]) await fs.cp(path.resolve(flags["project-config"]), path.join(workspace, ".runtime-corrector"), { recursive: true });
const model = (id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const provider = { baseUrl: "https://ark.cn-beijing.volces.com/api/coding", api: "anthropic-messages",
  apiKey: "${RC_ACCEPTANCE_API_KEY}", authHeader: true };
const config = { gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: "${RC_ACCEPTANCE_GATEWAY_TOKEN}" } },
  agents: { defaults: { workspace, skipBootstrap: true, timeoutSeconds: 1800, sandbox: { mode: "off" },
    model: { primary: "work/ark-code-latest" }, models: { "work/ark-code-latest": {}, "review/glm-5.3": {} } } },
  models: { providers: { work: { ...provider, agentRuntime: { id: "runtime-corrector-supervised" }, models: [model("ark-code-latest")] },
    review: { ...provider, models: [model("glm-5.3")] } } },
  tools: { allow: ["read", "write", "edit"] },
  plugins: { allow: ["runtime-corrector"], entries: { "runtime-corrector": { enabled: true,
    hooks: { allowConversationAccess: true, allowPromptInjection: true },
    config: { reviewerModel: "review/glm-5.3", reviewerTimeoutMs: 240000, hookTimeoutMs: 540000, supervisedExecution: true } } } },
  logging: { level: "info", consoleLevel: "info", file: path.join(root, "gateway.jsonl") } };
const configPath = path.join(root, "openclaw.json");
await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
await fs.writeFile(path.join(root, "gateway-token"), token, { mode: 0o600 });
const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath,
  RC_ACCEPTANCE_API_KEY: selected.ANTHROPIC_AUTH_TOKEN, RC_ACCEPTANCE_GATEWAY_TOKEN: token,
  OPENCLAW_NO_RESPAWN: "1" };
const cli = path.join(host, "openclaw.mjs");
function command(args, { inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let output = "";
    if (!inherit) for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("exit", (code) => code ? reject(new Error(output.replaceAll(selected.ANTHROPIC_AUTH_TOKEN, "<redacted>").replaceAll(token, "<gateway-token>"))) : resolve(output));
  });
}
await command(["plugins", "install", "--force", path.resolve(flags.plugin ?? "dist/runtime-corrector-openclaw")]);
console.log(JSON.stringify({ event: "ISOLATED_INSTALLED", root, port, workspace }));
const gateway = spawn(process.execPath, [cli, "gateway", "run", "--port", String(port), "--bind", "loopback"], { env, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", (data) => process.stdout.write(String(data).replaceAll(selected.ANTHROPIC_AUTH_TOKEN, "<redacted>").replaceAll(token, "<gateway-token>")));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => gateway.kill(signal));
gateway.on("exit", (code) => { process.exitCode = code ?? 0; });
