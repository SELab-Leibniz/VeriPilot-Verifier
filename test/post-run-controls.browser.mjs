// Runs the released control page in a real browser against the production RPC handlers.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPostRunControls } from "../lib/openclaw/post-run-controls.mjs";
import { createSessionRuntimeStatus } from "../lib/openclaw/session-runtime-status.mjs";
import { registerSessionRuntimeControls } from "../lib/openclaw/session-runtime-controls.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RC_PLAYWRIGHT ?? "playwright");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-session-console-browser-")));
const methods = new Map(), routes = [], errors = [], stops = [];
const states = new Map(["alpha", "beta"].map(name => [name, {
  agentId: "main", sessionId: name, sessionKey: "agent:main:" + name, projectRoot: root,
  nativeRunId: "run-" + name, projectScope: { fingerprint: "scope", projectEnabled: true, sessionEnabled: true },
}]));
const sessionRuntime = createSessionRuntimeStatus({ states, pausedScopes: new Map(), dispatcher: () => null,
  stopJobs: state => state.sessionId === "alpha" ? [{}] : [],
  resolveScope: async identity => ({ identity, projectRoot: root, projectEnabled: true, sessionEnabled: true, enabled: true }),
  terminate: async ({ identity, state }) => stops.push([identity.sessionId, state.nativeRunId]),
});
for (const state of states.values()) sessionRuntime.track(state);
sessionRuntime.reviewStarted(states.get("alpha"), "review-a", { role: "stop-reviewer" });
sessionRuntime.reviewStarted(states.get("beta"), "review-b", { role: "artifact-reviewer" });
await sessionRuntime.flush();

const api = { config: {}, logger: { warn() {} }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
  registerHttpRoute: route => routes.push(route) };
const runtime = { sessionRuntime, postRunReady: Promise.resolve() };
registerPostRunControls(api, runtime, { compatibility: async () => ({ browserClient: "test-client.mjs", version: "test" }) });
registerSessionRuntimeControls(api, runtime);
methods.set("sessions.list", ({ respond }) => respond(true, { sessions: [...states.values()].map(state => ({
  key: state.sessionKey, sessionId: state.sessionId, displayName: state.sessionId,
})) }));
methods.set("runtime-corrector.session.get", ({ params, respond }) => respond(true, { projectRoot: root, identity: states.get(params.sessionId) }));

const client = [
  "export class t { constructor(options) { this.options = options; } start() { this.options.onHello(); } stop() {}",
  "async request(method, params) { const response = await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });",
  "const result = await response.json(); if (!result.ok) throw new Error(result.error.message); return result.value; } }",
].join("\n");
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/assets/test-client.mjs") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(client);
      return;
    }
    if (req.url === "/rpc") {
      let body = "";
      for await (const part of req) body += part;
      const { method, params } = JSON.parse(body);
      await methods.get(method)({ params, client: { connect: { role: "operator", scopes: ["operator.admin"] } },
        respond: (ok, value, error) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok, value, error })); } });
      return;
    }
    await routes[0].handler(req, res);
  } catch (cause) { res.statusCode = 500; res.end(cause.message); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.RC_BROWSER_EXECUTABLE ? { executablePath: process.env.RC_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 420, height: 850 } });
  page.on("pageerror", error => errors.push(error.message));
  const value = name => JSON.stringify(["agent:main:" + name, name]);
  await page.goto("http://127.0.0.1:" + server.address().port + "/plugins/runtime-corrector?sessionKey=agent:main:alpha&sessionId=alpha");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#phase").textContent.includes("建议本轮结束后再发送"));
  assert.match(await page.locator("#activities").innerText(), /终审/u);
  assert.equal(await page.getByRole("button").count(), 1);
  await page.locator("#sessions").selectOption(value("beta"));
  await page.waitForFunction(() => document.querySelector("#phase").textContent.includes("评审产物"));
  assert.doesNotMatch(await page.locator("#phase").innerText(), /再发送/u);
  await page.locator("#sessions").selectOption(value("alpha"));
  await page.getByRole("button", { name: "停止本轮纠偏" }).click();
  await page.waitForFunction(() => document.querySelector("#stop-receipt").textContent === "该轮纠偏已停止");
  assert.deepEqual(stops, [["alpha", "run-alpha"]]);
  assert.equal((await sessionRuntime.get(states.get("beta"))).running, true);
  assert.deepEqual(errors, []);
  console.log("RC console browser assertions passed");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await sessionRuntime.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
