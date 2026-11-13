// Optional real-browser check. RC_PLAYWRIGHT points to an installed Playwright package.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostRunDispatcher } from "../lib/openclaw/post-run-dispatch.mjs";
import { registerPostRunControls } from "../lib/openclaw/post-run-controls.mjs";
import { ensureTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';

const require = createRequire(import.meta.url), { chromium } = require(process.env.RC_PLAYWRIGHT ?? "playwright");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-dispatch-browser-"));
const sent = [], userRuns = new Set();
let reviewAction = async () => ({ reviewStatus: "PASS" });
const manager = createPostRunDispatcher({ directoryFor: () => root, validate: async () => true,
  waitTerminal: async (_record, runId) => userRuns.has(runId) ? null : { status: "ok" },
  review: (...args) => reviewAction(...args), sendUser: async (_record, task) => {
    sent.push(task); userRuns.add(task.runId); return { runId: task.runId };
  } });
const methods = new Map(), routes = [], errors = [];
const approvalModes = new Map();
for (const action of ['get', 'set']) methods.set(`runtime-corrector.approvals.${action}`, async ({ params, respond }) => {
  if (action === 'set') approvalModes.set(params.sessionKey, params.mode);
  respond(true, { available: true, mode: approvalModes.get(params.sessionKey) ?? 'normal', pending: [] });
});
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
  await page.locator('#approval-mode:enabled').waitFor();
  assert.equal(await page.locator('#approval-mode').inputValue(), 'normal');
  await page.locator('#approval-mode').selectOption('unattended');
  await page.waitForFunction(() => document.getElementById('approval-status').textContent.includes('自动授权'));
  assert.equal(approvalModes.get('agent:main:alpha'), 'unattended');
  await page.locator("#pending").fill("alpha edited draft");
  await page.getByRole("button", { name: "agent:main:beta", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "beta next task");
  await page.locator('#approval-mode:enabled').waitFor();
  assert.equal(await page.locator('#approval-mode').inputValue(), 'normal');
  await page.getByRole("button", { name: "agent:main:alpha", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "alpha edited draft");
  await page.waitForFunction(() => document.getElementById('approval-mode').value === 'unattended');
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
  // A slow successful save must not discard a newer draft made before switching.
  await page.locator("#search").fill("");
  await page.waitForFunction(() => document.querySelectorAll(".session").length === 2);
  let releaseSave, saved;
  const holdSave = new Promise(resolve => { releaseSave = resolve; }), savedOnServer = new Promise(resolve => { saved = resolve; });
  await page.route("**/rpc", async route => {
    if (route.request().postDataJSON().method === "runtime-corrector.dispatch.edit") {
      const response = await route.fetch(); saved(); await holdSave; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator("#pending").fill("beta saved text"); await page.locator("#save").click(); await savedOnServer;
  await page.locator("#pending").fill("beta newer unsaved draft");
  await page.getByRole("button", { name: "agent:main:alpha", exact: false }).click();
  releaseSave();
  await page.waitForResponse(response => response.url().endsWith("/rpc") && response.request().postDataJSON().method === "runtime-corrector.dispatch.edit");
  await page.getByRole("button", { name: "agent:main:beta", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "beta newer unsaved draft");
  await page.unroute("**/rpc");
  // Persist the retained draft, then drive the two displayed rows through a full cycle.
  await page.locator("#save").click();
  await page.waitForFunction(() => document.getElementById("save").disabled);
  await page.locator("#new-task").fill("beta second task");
  await page.getByRole("button", { name: "加入待办", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("more").hidden);
  let releaseReview, reviewing;
  const reviewGate = new Promise(resolve => { releaseReview = resolve; }), reviewStarted = new Promise(resolve => { reviewing = resolve; });
  reviewAction = async record => { reviewing(); await reviewGate;
    await manager.correction(record, "beta-repair", Date.now() + 10000, "beta-stop"); return { reviewStatus: "DEVIATION" }; };
  await manager.candidate(identity("beta"), { runId: "run-beta", text: "done", reviewBudgetMs: 20000 }); await reviewStarted;
  await page.waitForFunction(() => document.getElementById("phase").textContent === "任务完成情况审查中。");
  assert.equal(sent.length, 0);
  releaseReview(); await manager.drain();
  await page.waitForFunction(() => document.getElementById("phase").textContent === "等待启动纠偏任务");
  await manager.started(identity("beta"), "beta-repair", 20000);
  await page.waitForFunction(() => document.getElementById("phase").textContent === "纠偏任务执行中");
  assert.equal(sent.length, 0);
  await manager.candidate(identity("beta"), { runId: "beta-repair", text: "fixed", needsReview: false, reviewBudgetMs: 10000 }); await manager.drain();
  await page.waitForFunction(() => document.getElementById("pending").value === "beta second task");
  assert.deepEqual(sent.map(task => task.text), ["beta newer unsaved draft"]);
  await manager.started(identity("beta"), sent[0].runId);
  await page.waitForFunction(() => document.getElementById("phase").textContent === "任务执行中");
  userRuns.delete(sent[0].runId);
  await manager.candidate(identity("beta"), { runId: sent[0].runId, text: "done", needsReview: false, reviewBudgetMs: 10000 }); await manager.drain();
  await page.waitForFunction(() => document.getElementById("pending").value === "");
  assert.deepEqual(sent.map(task => task.text), ["beta newer unsaved draft", "beta second task"]);
  await manager.started(identity("beta"), sent[1].runId); userRuns.delete(sent[1].runId);
  await manager.candidate(identity("beta"), { runId: sent[1].runId, text: "done", needsReview: false, reviewBudgetMs: 10000 }); await manager.drain();
  await page.waitForFunction(() => document.getElementById("phase").textContent === "会话空闲");
  assert.match(await page.locator('#task-target').innerText(), /agent:main:beta/u);
  assert.match(await page.locator('#history').innerText(), /beta newer unsaved draft/u);
  assert.match(await page.locator('#history').innerText(), /执行已结束/u);
  assert.match(await page.locator('body').innerText(), /不是 MA 的全部历史聊天/u);
  const betaTask = await ensureTask({ projectRoot: root, sessionId: 'beta' });
  await withTaskState({ projectRoot: root, taskId: betaTask.taskId }, state => {
    state.groundTruth.version = 2; state.groundTruth.pendingUserCursor = 'insertion-user';
  });
  await page.waitForFunction(() => document.getElementById('requirements-status').textContent.includes('有新的用户输入待对齐'));
  await withTaskState({ projectRoot: root, taskId: betaTask.taskId }, state => { state.groundTruth.pendingUserCursor = null; });
  await page.waitForFunction(() => document.getElementById('requirements-status').textContent.includes('当前没有登记的待对齐输入'));
  reviewAction = async () => ({ reviewStatus: 'UNVERIFIED', reasonCode: 'STOP_STAGE_METRICS_UNDECLARED', reviewSummary: {
    groundTruthVersion: 2, status: 'UNVERIFIED', reviewedObjectCount: 0,
    scopeSelection: { fullObjectCount: 4, selectedObjectCount: 0, reasonCode: 'STOP_STAGE_METRICS_UNDECLARED', metrics: {
      M12: { enabled: true, available: 2, selected: 0, objects: [
        { objectId: 'M12:quick', description: '实现快速排序', selected: false },
        { objectId: 'M12:insertion', description: '实现插入排序', selected: false },
      ] },
      M16: { enabled: true, available: 2, selected: 0, objects: [
        { objectId: 'M16:quick', description: '快速排序生产实现', selected: false },
        { objectId: 'M16:insertion', description: '插入排序生产实现', selected: false },
      ] },
    } },
  } });
  await manager.started(identity('beta'), 'scope-review');
  await manager.candidate(identity('beta'), { runId: 'scope-review', text: 'done', reviewBudgetMs: 10000 }); await manager.drain();
  await page.waitForFunction(() => !document.getElementById('review-summary').hidden);
  assert.match(await page.locator('#review-basis').innerText(), /基线 v2.*0 \/ 原始 4 项/u);
  await page.getByText('M12：原始 2 项，选中 0 项', { exact: true }).click();
  assert.match(await page.locator('#review-objects').innerText(), /范围外.*M12:insertion.*实现插入排序/u);
  await withTaskState({ projectRoot: root, taskId: betaTask.taskId }, state => { state.groundTruth.pendingUserCursor = 'later-input'; });
  await page.waitForFunction(() => document.getElementById('requirements-status').textContent.includes('有新的用户输入待对齐'));
  assert.equal(await page.locator('#review-objects details[data-metric="M12"]').evaluate(element => element.open), true);
  await withTaskState({ projectRoot: root, taskId: betaTask.taskId }, state => { state.groundTruth.pendingUserCursor = null; });
  await page.waitForFunction(() => document.getElementById('requirements-status').textContent.includes('当前没有登记的待对齐输入'));
  assert.match(await page.locator('#reason').innerText(), /没有声明指标/u);
  assert.equal(manager.snapshot(identity("alpha")).pending.length, 1);
  await page.screenshot({ path: path.resolve(".runtime-correction/post-run-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.resolve(".runtime-correction/post-run-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await manager.close(identity("beta"), "SESSION_RESET");
  await page.waitForFunction(() => document.getElementById("phase").textContent === "会话已关闭");
  assert.equal(await page.locator("#new-task").evaluate(element => element.readOnly), true);
  assert.equal(await page.getByRole("button", { name: "加入待办", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "agent:main:alpha", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("pending").value === "alpha edited draft");
  assert.equal(await page.getByRole("button", { name: "加入待办", exact: true }).isEnabled(), true);
  // Simulate an applied add whose acknowledgement is lost, then retry in the UI.
  let loseAcknowledgement = true;
  await page.route("**/rpc", async route => {
    if (route.request().postDataJSON().method === "runtime-corrector.dispatch.add" && loseAcknowledgement) {
      loseAcknowledgement = false; await route.fetch();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Test: acknowledgement lost" } }) });
    } else await route.continue();
  });
  await page.locator("#new-task").fill("alpha retry task"); await page.getByRole("button", { name: "加入待办", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("error").textContent.includes("acknowledgement lost"));
  assert.equal(await page.locator("#new-task").inputValue(), "alpha retry task");
  await page.getByRole("button", { name: "加入待办", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("new-task").value === "");
  assert.equal(manager.snapshot(identity("alpha")).pending.filter(task => task.text === "alpha retry task").length, 1);
  await page.unroute("**/rpc");
  // Exercise the real 100-record boundary and a deep link outside page one.
  for (let i = 0; i < 101; i++) await manager.register(identity(`extra-${String(i).padStart(3, "0")}`));
  await page.locator("#search").fill("extra-");
  await page.waitForFunction(() => document.querySelectorAll(".session").length === 100);
  assert.equal(await page.locator("#next").isEnabled(), true);
  await page.locator("#next").click();
  await page.waitForFunction(() => document.querySelectorAll(".session").length === 1);
  assert.match(await page.locator(".session").textContent(), /extra-000/u);
  assert.equal(await page.locator("#next").isDisabled(), true); assert.equal(await page.locator("#previous").isEnabled(), true);
  await page.locator("#search").fill("extra-000");
  await page.waitForFunction(() => document.getElementById("page").textContent.includes("第 1 页") && document.querySelectorAll(".session").length === 1);
  await page.locator(".session").click();
  await page.waitForFunction(() => document.getElementById("identity").textContent.includes("extra-000"));
  assert.equal(await page.locator("#pending").inputValue(), "");
  await page.goto(`http://127.0.0.1:${server.address().port}/plugins/runtime-corrector/?session=agent:main:alpha`);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.getElementById("pending").value === "changed in another tab");
  assert.match(await page.locator("#identity").textContent(), /alpha/u);
  assert.deepEqual(errors, []);
  console.log("PASS browser: session isolation, retained in-flight drafts, stale edits, target and task history, review-scope objects, closed controls, 103-session pagination/search/deep link, responsive layout");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await manager.dispose(); await fs.rm(root, { recursive: true, force: true });
}
