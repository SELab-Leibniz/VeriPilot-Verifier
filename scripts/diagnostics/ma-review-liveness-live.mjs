// Real installed OpenClaw + unmodified MA renderer, in fresh isolated profiles.
// A loopback proxy paces a real reviewer response over six minutes. Private
// model work stays active while MA waits. No installed settings are changed.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isolatedHost, pause, files } from "./lib/isolated-openclaw.mjs";
import { maRendererObserver } from "./lib/ma-renderer-observer.mjs";

const [matrixRoot, output, mode = "all"] = process.argv.slice(2);
if (!matrixRoot || !output || !["smoke", "all", "candidate"].includes(mode)) throw new Error("MA root, fresh output directory, [smoke|all|candidate] required");
const destination = path.resolve(output), hostRoot = path.join(matrixRoot, "resources/openclaw");
const baselineRef = process.env.RC_LIVENESS_BASE_REF ?? "af7aeaf";
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.mkdir(destination, { recursive: false });
const report = { startedAt: new Date().toISOString(), mode, baselineRef, desktopAutomation: false, installedFilesModified: false,
  boundary: "Installed MA transport functions plus renderer in headless Chromium; stubbed Electron/window and storage; real Gateway with MA caps/subscriptions and existing remote model", cases: [] };
const save = (name, value) => fs.writeFile(path.join(destination, name), JSON.stringify(value, null, 2) + "\n");
const mark = (phase, detail = {}) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), phase, ...detail }) + "\n");
const fallback = async (channel, ...args) => {
  if (channel === "gateway:status") return { state: "running", warmupStatus: "ready" };
  if (channel === "gateway:rpc") return { success: true, result: { agents: [{ id: "main", name: "main", isDefault: true }], sessions: [], models: [] } };
  if (/getVersion|version:get/u.test(channel)) return "1.10.1";
  if (/settings.*getAll/u.test(channel)) return { setupComplete: false, language: "zh", theme: "light" };
  if (/get-env/u.test(channel)) return "blue";
  return { success: true, data: [], items: [] };
};

if (mode === "smoke") {
  const observer = await maRendererObserver({ matrixRoot, invoke: fallback, onLog: row => mark("renderer-log", row) });
  try {
    await observer.begin("agent:main:rc-liveness-smoke", "smoke-run", "Smoke only");
    observer.deliver({ event: "session.tool", payload: { runId: "smoke-run", sessionKey: "agent:main:rc-liveness-smoke", stream: "tool", seq: 1,
      data: { name: "runtime-corrector.review", toolCallId: "runtime-corrector:smoke-run:private", phase: "update" } } });
    const state = await observer.snapshot("agent:main:rc-liveness-smoke");
    assert.equal(state.status, "delta"); assert.equal(state.error, null);
    assert(state.toolProgress.some(item => item.name === "runtime-corrector.review"));
    await save("summary.json", { ...report, status: "PASS", renderer: observer.renderer, rendererSha256: observer.rendererSha256, state });
    mark("smoke passed", { version: observer.version, state });
  } finally { await observer.close(); }
  process.exit(0);
}

const sourceConfig = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw/openclaw.json"), "utf8"));
const defaultRef = typeof sourceConfig.agents.defaults.model === "string" ? sourceConfig.agents.defaults.model : sourceConfig.agents.defaults.model.primary;
const slash = defaultRef.indexOf("/"), providerId = defaultRef.slice(0, slash), modelId = defaultRef.slice(slash + 1);
const provider = sourceConfig.models.providers[providerId], descriptorModel = provider.models.find(model => model.id === modelId);
assert.equal(provider.api, "openai-completions", "This bounded probe uses the installed OpenAI-completions provider");
const readOptionalJson = async file => JSON.parse(await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; }));
const profiles = await readOptionalJson(path.join(os.homedir(), ".openclaw/agents/main/agent/auth-profiles.json"));
const cachedModels = await readOptionalJson(path.join(os.homedir(), ".openclaw/agents/main/agent/models.json"));
const profile = profiles.profiles?.[`${providerId}:default`] ?? Object.values(profiles.profiles ?? {}).find(value => value.provider === providerId);
const configuredKey = provider.apiKey ?? profile?.key ?? profile?.token ?? profile?.apiKey ?? cachedModels.providers?.[providerId]?.apiKey;
const envReference = typeof configuredKey === "string" && /^\$\{([^}]+)\}$/u.exec(configuredKey);
const key = envReference ? process.env[envReference[1]] : configuredKey;
assert(typeof key === "string" && key && !key.startsWith("${"), "Existing authorized model credential could not be resolved");
const redact = value => String(value).replaceAll(key, "<model-key>");
const holdMs = 360000, limit = 36, requests = [], controls = new Map(), live = new Set();
const server = http.createServer(async (req, res) => {
  const arm = req.url.split("/")[1], control = controls.get(arm);
  if (!control) { res.writeHead(404); res.end(); return; }
  let raw = "";
  try {
    for await (const chunk of req) { raw += chunk; if (raw.length > 4 * 1024 * 1024) throw new Error("Probe request too large"); }
    if (requests.length >= limit) throw new Error("Bounded model request limit reached");
    const body = JSON.parse(raw), internal = JSON.stringify(body.messages).includes("[runtime-corrector:internal]");
    const row = { at: Date.now(), arm, internal, scenario: control.scenario,
      requestSha256: createHash("sha256").update(raw).digest("hex"),
      model: body.model, streaming: body.stream === true, messageRoles: body.messages?.map(message => message.role),
      containsKeepalive: /runtime-corrector\.progress|lastActivityType|reviewRunId/u.test(JSON.stringify(body.messages)) };
    requests.push(row); await save("model-requests.json", requests);
    const upstreamAbort = new AbortController(); let cancelWait;
    res.on("close", () => { if (!res.writableEnded) { row.cancelledAt = Date.now(); upstreamAbort.abort(); cancelWait?.(); } });
    const paced = internal && control.armed;
    if (paced) { assert.equal(body.stream, true, "Pacing requires SSE transport"); control.armed = false; }
    if (upstreamAbort.signal.aborted) return;
    row.forwardedAt = Date.now();
    const upstream = await fetch(`${provider.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: raw, signal: upstreamAbort.signal,
    });
    row.httpStatus = upstream.status;
    if (!res.headersSent) res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    if (paced) {
      assert.equal(upstream.status, 200);
      const response = await upstream.text(), frames = response.split(/\r?\n\r?\n/u).filter(Boolean).map(frame => `${frame}\n\n`);
      assert(frames.length >= 8, "Real model response needs at least eight SSE frames for a bounded idle gap");
      row.responseSha256 = createHash("sha256").update(response).digest("hex");
      row.pacedFrameCount = frames.length; row.injectedDelayMs = holdMs; row.pacedStartedAt = Date.now();
      control.waitingAt = row.pacedStartedAt;
      mark("paced real reviewer", { arm, scenario: control.scenario, holdMs, frames: frames.length });
      // Preserve every real frame and its order; only change arrival time.
      // This keeps the host's independent 120s model-idle guard meaningful.
      for (let i = 0; i < frames.length; i++) {
        const delay = row.pacedStartedAt + i * holdMs / (frames.length - 1) - Date.now();
        if (delay > 0) await new Promise(resolve => {
          const timer = setTimeout(resolve, delay);
          cancelWait = () => { clearTimeout(timer); resolve(); };
        });
        if (upstreamAbort.signal.aborted || res.destroyed) return;
        res.write(frames[i]); row.deliveredFrames = i + 1;
      }
    } else for await (const chunk of upstream.body) { if (res.destroyed) break; res.write(chunk); }
    res.end(); row.completedAt = Date.now(); await save("model-requests.json", requests);
  } catch (error) {
    if (!res.destroyed) { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: redact(error.message) } })); }
    mark("proxy error", { arm, error: redact(error.message) });
  }
});
server.requestTimeout = 0;
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const proxyPort = server.address().port;
process.env.RC_TEST_MODEL_KEY = "isolated-loopback-liveness-probe";
const freePort = async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};
async function waitFor(check, label, timeoutMs = 900000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(500); }
  throw new Error(`Probe deadline: ${label}`);
}
const policy = `version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: []\n  panel:\n    size: 1\n    adjudicator: false\nskillCorrection:\n  enabled: false\nartifactCorrection:\n  groundTruthReviewEnabled: false\nimplementationCorrection:\n  enabled: false\nstopCorrection:\n  enabled: false\nreviewers:\n  defaults:\n    effort: low\n    timeoutMs: 900000\n    formatRepairAttempts: 1\n`;

async function armTrial(arm) {
  let h, observer, progressTimer;
  const control = { armed: true, scenario: "long-review" }; controls.set(arm, control);
  const result = { arm, expected: arm === "baseline" ? "client timeout abort" : "review completes", startedAt: Date.now() };
  try {
    const descriptorFile = path.join(destination, `${arm}-provider.json`);
    await fs.writeFile(descriptorFile, JSON.stringify({ ...provider, baseUrl: `http://127.0.0.1:${proxyPort}/${arm}/v1`, apiKey: undefined,
      model: { ...descriptorModel, reasoning: false } }));
    h = await isolatedHost({ hostRoot, providerFile: descriptorFile, destination: path.join(destination, arm), port: await freePort(), tools: ["read", "write"],
      clientCaps: [], subscribeSessionEvents: true,
      extraPlugins: [{ id: "register-gateway-method", path: path.join(matrixRoot, "resources/claw-plugin/register-gateway-method") }],
      preparePlugin: arm === "baseline" ? async pluginRoot => {
      for (const file of ["lib/openclaw/review-activity.mjs", "lib/openclaw/reviewer.mjs"]) {
        await fs.writeFile(path.join(pluginRoot, file), execFileSync("git", ["show", `${baselineRef}:${file}`], { windowsHide: true }));
      }
    } : undefined });
    live.add(h);
    const project = path.join(h.root, "project"); await fs.mkdir(path.join(project, ".runtime-corrector"), { recursive: true });
    await fs.writeFile(path.join(project, ".runtime-corrector/config.yaml"), policy);
    await fs.writeFile(path.join(project, "probe.txt"), "READ_ONLY_LIVENESS_FIXTURE\n");
    const key = `agent:main:rc-liveness-${arm}-${randomUUID()}`;
    const created = await h.request("sessions.create", { key, model: h.model, emitCommandHooks: false });
    result.sessionKey = key; result.sessionId = created.sessionId;
    await h.request("sessions-custom.setSessionCwd", { sessionKey: key, cwd: project });
    observer = await maRendererObserver({ matrixRoot, onLog: row => mark(`${arm} renderer`, row), invoke: async (channel, ...args) => {
      if (channel === "gateway:rpc") {
        try { return { success: true, result: await h.request(args[0], args[1] ?? {}) }; }
        catch (error) { return { success: false, error: redact(error.message) }; }
      }
      return fallback(channel, ...args);
    } });
    result.renderer = { version: observer.version, file: observer.renderer, sha256: observer.rendererSha256, transport: observer.transport };
    let index = 0;
    const flush = () => { while (index < h.events.length) observer.deliver(h.events[index++]); };
    progressTimer = setInterval(flush, 25);
    const runId = randomUUID(), prompt = `In ${project}, read probe.txt once, then use the write tool to create result.txt containing exactly RC_LIVENESS_OK. Then reply exactly RC_LIVENESS_OK. This is a client liveness acceptance test. Only result.txt may change. Do not ask questions or call other tools.`;
    await observer.begin(key, runId, prompt);
    const start = Date.now(); await h.request("chat.send", { sessionKey: key, message: prompt, idempotencyKey: runId });
    await waitFor(() => control.waitingAt, `${arm} first native reviewer`, 120000);
    mark("review is waiting", { arm, runId, sessionKey: key });
    let lastMilestone = 0;
    const terminal = await waitFor(async () => {
      if (Date.now() - lastMilestone > 30000) {
        lastMilestone = Date.now(); flush();
        mark("live observer", { arm, elapsedMs: Date.now() - start, ...await observer.snapshot(key) });
      }
      return h.events.find(event => event.event === "chat" && event.payload.runId === runId && ["final", "error", "aborted"].includes(event.payload.state));
    }, `${arm} terminal`, 900000);
    flush(); await pause(500);
    result.durationMs = Date.now() - start; result.terminal = terminal.payload.state; result.client = await observer.snapshot(key);
    const isStatus = event => event.event === "session.tool" && event.payload.stream === "tool"
      && event.payload.data?.name === "runtime-corrector.review" && event.payload.data.phase === "update";
    result.statusEvents = h.events.filter(event => event.payload?.runId === runId && isStatus(event)).map(event => ({ at: event.at, ...event.payload.data }));
    result.clientLogs = observer.logs; result.clientWaitCalls = observer.calls.filter(call => call.method === "agent.wait");
    result.clientAbortCalls = observer.calls.filter(call => call.method === "chat.abort");
    if (arm === "baseline") {
      assert.equal(result.terminal, "aborted");
      assert(result.clientLogs.some(row => row.text.includes("[idle-watchdog] finalizing")));
      assert(result.clientAbortCalls.length > 0);
    } else {
      assert.equal(result.terminal, "final"); assert(result.durationMs > holdMs);
      assert(result.statusEvents.length >= 10); assert.equal(result.clientAbortCalls.length, 0);
      assert(!result.clientLogs.some(row => row.text.includes("[idle-watchdog] finalizing")));
      assert.equal(result.client.error, null);
      const blocks = terminal.payload.message?.content;
      const finalText = typeof blocks === "string" ? blocks : (blocks ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
      // The existing one-time stage notice may prefix the UI buffer. Only
      // newly introduced periodic events must stay out of assistant content.
      assert(finalText.trim().endsWith("RC_LIVENESS_OK"));
      assert(!/runtime-corrector\.progress|lastActivityType|reviewRunId/u.test(finalText));
      result.finalText = finalText;
      const store = JSON.parse(await fs.readFile(path.join(h.stateDir, "agents/main/sessions/sessions.json"), "utf8"));
      const entries = (await fs.readFile(store[key].sessionFile, "utf8")).trim().split(/\r?\n/u).map(JSON.parse);
      const session = await import(pathToFileURL(path.join(hostRoot, "dist/session-manager-BC-U4J87.js")));
      const context = session.n(entries);
      assert(!/runtime-corrector\.progress|lastActivityType|reviewRunId/u.test(JSON.stringify(context.messages)));
      result.context = { messageCount: context.messages.length, containsKeepalive: false };
      assert(requests.filter(row => row.arm === arm && !row.internal).every(row => !row.containsKeepalive));
      // Exercise the exact MA manual-stop path with another native waiting review.
      control.scenario = "manual-stop"; control.armed = true; control.waitingAt = null;
      const cancelKey = `agent:main:rc-liveness-cancel-${randomUUID()}`, cancelRunId = randomUUID();
      await h.request("sessions.create", { key: cancelKey, model: h.model, emitCommandHooks: false });
      await h.request("sessions-custom.setSessionCwd", { sessionKey: cancelKey, cwd: project });
      await observer.begin(cancelKey, cancelRunId, prompt);
      await h.request("chat.send", { sessionKey: cancelKey, message: prompt, idempotencyKey: cancelRunId });
      await waitFor(() => control.waitingAt, "candidate cancel reviewer starts", 120000);
      await pause(32000); flush(); await observer.abort();
      await waitFor(() => h.events.some(event => event.event === "chat" && event.payload.runId === cancelRunId && event.payload.state === "aborted"), "manual abort receipt", 15000);
      await pause(1500);
      const afterAbortAt = Date.now(), before = h.events.filter(event => event.payload?.runId === cancelRunId && isStatus(event)).length;
      await pause(32000);
      const after = h.events.filter(event => event.payload?.runId === cancelRunId && isStatus(event)).length;
      assert.equal(after, before);
      result.manualStop = { passed: true, observedAt: afterAbortAt, statusEventsAfterAbort: after - before, client: await observer.snapshot(cancelKey) };
    }
    result.status = "PASS";
  } catch (error) { result.status = "FAIL"; result.error = redact(error.stack); mark("trial failed", { arm, error: redact(error.message) }); }
  finally {
    clearInterval(progressTimer); await observer?.close();
    if (h) { await h.close(); live.delete(h); }
    result.finishedAt = Date.now(); await save(`${arm}-summary.json`, result);
  }
  return result;
}

try {
  report.cases = await Promise.all((mode === "all" ? ["baseline", "candidate"] : ["candidate"]).map(armTrial));
  report.status = report.cases.every(result => result.status === "PASS") ? "PASS" : "FAIL";
} finally {
  for (const h of live) await h.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // Keep evidence, but never retain resolved model credentials in host caches.
  for (const file of await files(destination)) if (/\.(?:json|jsonl|log|md|yaml)$/u.test(file)) {
    const text = await fs.readFile(file, "utf8"); if (text.includes(key)) await fs.writeFile(file, redact(text));
  }
  report.finishedAt = new Date().toISOString(); await save("summary.json", report); await save("model-requests.json", requests);
}
mark("finished", { status: report.status, output: destination });
process.exitCode = report.status === "PASS" ? 0 : 1;
