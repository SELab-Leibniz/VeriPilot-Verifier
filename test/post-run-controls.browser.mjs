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
import { nativeStopReviewDirectory } from "../lib/openclaw/native-stop-review.mjs";
import { recordNativeRun } from "../lib/openclaw/native-runs.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RC_PLAYWRIGHT ?? "playwright");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-session-console-browser-")));
const methods = new Map(), routes = [], errors = [], stops = [], refreshes = [];
const states = new Map(["alpha", "beta", "idle", "archived"].map(name => [name, {
  agentId: "main", sessionId: name, sessionKey: "agent:main:" + name, projectRoot: root,
  nativeRunId: name === "idle" ? null : "run-" + name, projectScope: { fingerprint: "scope", projectEnabled: true, sessionEnabled: true },
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
const briefDirectory = path.join(root, ".runtime-correction", "requirement-frame", sha256("alpha").slice(0, 24));
const briefText = "[runtime-corrector:feedback]\nKeep the original filter.";
const historicalBrief = "[runtime-corrector:feedback]\nThe first round reviewed the export.";
await fs.mkdir(briefDirectory, { recursive: true });
await fs.writeFile(path.join(briefDirectory, "deliveries.jsonl"), JSON.stringify({
  runId: "original-alpha", channel: "run_start", at: "2026-11-21T04:40:00.000Z", text: historicalBrief,
}) + "\n" + JSON.stringify({
  runId: "run-alpha", channel: "tool_result", at: "2026-11-21T04:52:00.000Z", text: briefText,
}) + "\n");
const task = await ensureTask({ projectRoot: root, sessionId: "alpha" });
const liveWorkspace = path.join(taskDirectory(root, task.taskId), "workspace-reviews", "live-alpha");
await fs.mkdir(path.join(liveWorkspace, "items"), { recursive: true });
await fs.writeFile(path.join(liveWorkspace, "scope.json"), JSON.stringify({ objectIds: ["saved-live", "remaining-live"] }));
await fs.writeFile(path.join(liveWorkspace, "items", sha256("saved-live") + ".json"), JSON.stringify({
  itemId: "saved-live", result: { objectId: "saved-live", judgement: "UNVERIFIED", reason: "More evidence needed" },
}));
await recordNativeRun(root, { taskId: task.taskId, runId: "private-stop", role: "stop-reviewer", startedAt: 3,
  sessionFile: path.join(liveWorkspace, "host-session.jsonl"),
  stopReviewOwner: { sessionId: "alpha", sessionKey: "agent:main:alpha", runId: "run-alpha", controlRevision: 0 } });
const reviews = nativeStopReviewDirectory(states.get("alpha"));
const evaluations = path.join(taskDirectory(root, task.taskId), "evaluations");
await fs.mkdir(reviews, { recursive: true });
await fs.mkdir(evaluations, { recursive: true });
await fs.writeFile(path.join(reviews, sha256("original-alpha") + ".json"), JSON.stringify({
  sessionKey: "agent:main:alpha", sessionId: "alpha", runId: "original-alpha", status: "SETTLED", reviewStatus: "DEVIATION",
  taskId: task.taskId, evaluationId: "stop-first", createdAt: Date.parse("2026-11-21T04:40:20.000Z"),
  settledAt: Date.parse("2026-11-21T04:40:31.000Z"),
}));
await fs.writeFile(path.join(evaluations, "stop-first.json"), JSON.stringify({
  evaluationId: "stop-first", outcome: { status: "DEVIATION" },
  review: { metricObjectJudgements: [
    { title: "Preserve export", judgement: "PASS" },
    { title: "Apply filter", judgement: "DEVIATION" },
    { title: "Retain stable ordering", judgement: "UNVERIFIED" },
  ] },
}));

const api = { config: {}, logger: { warn() {} }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
  registerHttpRoute: route => routes.push(route) };
const sentInput = "Restore the file filter from the original request.";
let alphaInputMode = "WAIT";
const runtime = { sessionRuntime, postRunReady: Promise.resolve(),
  sessionInputMode: ({ sessionId }) => sessionId === "alpha" ? alphaInputMode : "HOST_DEFAULT",
  readSessionFollowup: async ({ sessionId }, runId) => sessionId === "alpha" && runId === "rc-stop-exact-alpha"
    ? { runId, source: { runId: "run-alpha" }, modelObservedAt: 1, message: sentInput, messageHash: sha256(sentInput) } : null,
  readSessionRepairs: async ({ sessionId }) => sessionId === "alpha"
    ? [{ runId: "rc-stop-exact-alpha", sourceRunId: "run-alpha", startedAt: 1, endedAt: 2, outcome: "NO_DEVIATION_FOUND" }] : [],
};
registerPostRunControls(api, runtime, { compatibility: async () => ({ browserClient: "test-client.mjs", version: "test" }) });
registerSessionRuntimeControls(api, runtime);
methods.set("sessions.list", ({ respond }) => respond(true, { sessions: [...states.values()].filter(state => state.sessionId !== "archived").map(state => ({
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
      if (method === "runtime-corrector.runtime.refresh") refreshes.push(params);
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
  const select = name => page.locator("#sessions").getByRole("link", { name: new RegExp("^" + name + "\\b", "u") }).click();
  await page.goto("http://127.0.0.1:" + server.address().port + "/plugins/runtime-corrector?sessionKey=agent:main:alpha&sessionId=alpha");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#phase").textContent === "RC 正在终审 · 新消息暂不可发送");
  assert.match(await page.locator("#activities").innerText(), /终审/u);
  assert.match(await page.locator("#round-status").innerText(), /终审/u);
  assert.equal(await page.locator("#agent-status").innerText(), "正在运行");
  await page.waitForFunction(() => document.querySelector("#repair-runs").textContent.includes("rc-stop-exact-alpha"));
  assert.match(await page.locator("#repair-runs").innerText(), /已结束 · 无偏差/u);
  assert.equal(await page.locator("#repair-runs pre").innerText(), sentInput);
  assert.match(await page.locator("#review-details").innerText(), /阶段性判定.*无偏差 0 · 有偏差 0 · 未验证 1 · 未审 1/u);
  await page.getByText(/本轮注入简报.*随工具结果/u).click();
  assert.equal(await page.locator("#brief-text").innerText(), briefText);
  const historyId = await page.locator("#round-select option").filter({ hasText: /历史轮.*有偏差/u }).getAttribute("value");
  await page.getByLabel("查看轮次").selectOption(historyId);
  await page.waitForFunction(() => document.querySelector("#outcome").textContent === "有偏差");
  assert.equal(await page.locator("#brief-text").innerText(), historicalBrief);
  assert.match(await page.locator("#review-details").innerText(), /无偏差 1 · 有偏差 1 · 未验证 1 · 未审 0/u);
  assert.match(await page.locator("#review-details").innerText(), /Preserve export/u);
  assert.match(await page.locator("#review-details").innerText(), /Apply filter/u);
  assert.match(await page.locator("#review-details").innerText(), /Retain stable ordering/u);
  assert.match(await page.locator("#phase").innerText(), /正在终审/u);
  assert.equal(await page.locator("#terminate").isVisible(), false);
  assert.match(await page.locator("#repair-status").innerText(), /暂无下一轮修复输入/u);
  await page.getByRole("link", { name: "查看这个会话最近注入的简报" }).click();
  await page.waitForFunction(() => document.querySelector("#outcome").textContent === "终审中");
  assert.equal(await page.getByRole("button").count(), 2);
  alphaInputMode = "HOST_DEFAULT";
  await page.getByRole("button", { name: "刷新状态" }).click();
  await page.waitForFunction(() => document.querySelector("#query-status").textContent.includes("已重新查询状态"));
  assert.equal(await page.locator("#phase").innerText(), "RC 正在终审");
  assert.deepEqual(refreshes.map(target => [target.sessionKey, target.sessionId]), [["agent:main:alpha", "alpha"]]);
  await select("beta");
  await page.waitForFunction(() => document.querySelector("#phase").textContent.includes("评审产物"));
  assert.doesNotMatch(await page.locator("#phase").innerText(), /新消息暂不可发送/u);
  assert.doesNotMatch(await page.locator("#repair-runs").innerText(), /rc-stop-exact-alpha/u);
  assert.equal(await page.locator("#brief").isVisible(), false);
  assert.equal(await page.locator("#brief-status").innerText(), "本轮无注入简报记录");
  await select("idle");
  await page.waitForFunction(() => document.querySelector("#agent-status").textContent.includes("当前无纠偏 Agent"));
  await page.locator("#sessions a[href*='sessionId=archived']").click();
  assert.match(await page.locator("#round-status").innerText(), /历史会话/u);
  assert.equal(await page.locator("#terminate").isVisible(), false);
  await select("alpha");
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
