// Optional real-browser check. RC_PLAYWRIGHT points to an installed Playwright package.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostRunDispatcher } from "../lib/openclaw/post-run-dispatch.mjs";
import { registerPostRunControls } from "../lib/openclaw/post-run-controls.mjs";

const require = createRequire(import.meta.url), { chromium } = require(process.env.RC_PLAYWRIGHT ?? "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-dispatch-browser-"));
const manager = createPostRunDispatcher({ directoryFor: () => root, validate: async () => true,
  waitTerminal: async () => ({ status: "ok" }), review: async () => {}, sendUser: async () => {} });
const methods = new Map(), routes = [], errors = [];
registerPostRunControls({ config: {}, logger: { warn() {} }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
  registerHttpRoute: route => routes.push(route) }, { postRuns: manager, postRunReady: Promise.resolve(), validatePostSession: async () => true },
  { compatibility: async () => ({ browserClient: "fixture-client.mjs", version: "test" }) });
const identity = name => ({ agentId: "main", sessionKey: `agent:main:${name}`, sessionId: name, projectRoot: root, scopeFingerprint: "scope" });
for (const name of ["alpha", "beta"]) {
  await manager.started(identity(name), `run-${name}`);
  await manager.defer(identity(name), { text: `${name} next task` });
}
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/assets/fixture-client.mjs") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(`export class t { constructor(options) { this.options = options; } start() { this.options.onHello(); } stop() {} async request(method, params) {
        const response = await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method, params }) }); const result = await response.json();
        if (!result.ok) throw new Error(result.error.message); return result.value;
      } }`); return;
    }
    if (req.url === "/rpc") {
      let body = ""; for await (const part of req) body += part;
      const { method, params } = JSON.parse(body);
      await methods.get(method)({ params, client: { connect: { role: "operator", scopes: ["operator.admin"] } },
        respond: (ok, value, error) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok, value, error })); } });
      return;
    }
    await routes[0].handler(req, res);
  } catch (e) { res.statusCode = 500; res.end(e.message); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.RC_BROWSER_EXECUTABLE ? { executablePath: process.env.RC_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/plugins/runtime-corrector/?session=agent:main:alpha`);
  await page.locator("#connect").click();
  await page.locator("#pending").filter({ hasText: "" }).waitFor();
  await page.waitForFunction(() => document.getElementById("pending").value === "alpha next task");
  await page.locator("#pending").fill("alpha edited draft");
  await page.getByRole("button", { name: "agent:main:beta", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "beta next task");
  await page.getByRole("button", { name: "agent:main:alpha", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "alpha edited draft");
  const alpha = manager.snapshot(identity("alpha")), task = alpha.pending[0];
  await manager.mutate(alpha, { id: task.id, revision: task.revision, text: "changed in another tab" });
  await page.waitForFunction(() => document.getElementById("queue-note").textContent.includes("其他页面"));
  await page.locator("#save").click();
  await page.waitForFunction(() => !document.getElementById("error").hidden);
  assert.equal(manager.snapshot(identity("alpha")).pending[0].text, "changed in another tab");
  assert.equal(await page.locator("#pending").inputValue(), "alpha edited draft");
  await page.getByRole("button", { name: "agent:main:beta", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "beta next task");
  await page.locator("#remove").click();
  await page.waitForFunction(() => document.getElementById("pending").value === "");
  assert.equal(manager.snapshot(identity("beta")).phase, "RUNNING");
  await page.locator("#new-task").fill("beta added work");
  await page.getByRole("button", { name: "加入待办", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "beta added work");
  await page.locator("#search").fill("alpha");
  await page.waitForFunction(() => document.querySelectorAll(".session").length === 1);
  assert.match(await page.locator(".session").textContent(), /alpha/u);
  await page.screenshot({ path: path.resolve(".runtime-correction/post-run-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.resolve(".runtime-correction/post-run-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS browser: switching sessions, retained drafts, stale edit rejection, deletion, addition, global search, responsive layout");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await manager.dispose(); await fs.rm(root, { recursive: true, force: true });
}
