// One real-model task through an isolated, installed Gateway. The observer
// never edits the application after setup and never substitutes model output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isolatedHost, runtimeState, pause, files } from "./lib/isolated-openclaw.mjs";

const [hostRoot, output] = process.argv.slice(2);
if (!hostRoot || !output) throw new Error("hostRoot fresh-output-directory required");
const destination = path.resolve(output), execute = promisify(execFile);
assert(!destination.replaceAll("\\", "/").split("/").includes(".runtime-correction"),
  "Keep the trial project outside .runtime-correction: RC excludes its private files from authoritative sources");
await fs.mkdir(destination, { recursive: false });
const config = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw/openclaw.json"), "utf8"));
const reference = typeof config.agents.defaults.model === "string" ? config.agents.defaults.model : config.agents.defaults.model.primary;
const slash = reference.indexOf("/"), providerId = reference.slice(0, slash), modelId = reference.slice(slash + 1);
const provider = config.models.providers[providerId], model = provider.models.find(item => item.id === modelId);
assert.equal(provider.api, "openai-completions", "Use the current verified provider protocol");
const optional = async file => JSON.parse(await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; }));
const profiles = await optional(path.join(os.homedir(), ".openclaw/agents/main/agent/auth-profiles.json"));
const cache = await optional(path.join(os.homedir(), ".openclaw/agents/main/agent/models.json"));
const profile = profiles.profiles?.[`${providerId}:default`] ?? Object.values(profiles.profiles ?? {}).find(item => item.provider === providerId);
const configured = provider.apiKey ?? profile?.key ?? profile?.token ?? profile?.apiKey ?? cache.providers?.[providerId]?.apiKey;
const environment = typeof configured === "string" && /^\$\{([^}]+)\}$/u.exec(configured);
const key = environment ? process.env[environment[1]] : configured;
assert(typeof key === "string" && key.length > 0 && !key.startsWith("${"), "Existing model credential unavailable");
const redact = value => String(value).replaceAll(key, "<model-key>");
let writes = Promise.resolve();
const save = (name, data) => {
  const value = redact(typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\n";
  writes = writes.catch(() => {}).then(() => fs.writeFile(path.join(destination, name), value));
  return writes;
};
const timeline = [], requests = [], controllers = new Set();
const report = { status: "RUNNING", startedAt: Date.now(), model: reference, realModel: true, installedHostModified: false,
  observerEditsAfterSetup: false, waitMode: "until_pass (default)", cases: 1,
  modelSettings: { maxTokens: model.maxTokens, reasoning: model.reasoning },
  hookTimeoutMs: config.plugins?.entries?.["runtime-corrector"]?.config?.hookTimeoutMs ?? 1200000 };
async function mark(phase, detail = {}) {
  const row = { at: Date.now(), phase, ...detail }; timeline.push(row);
  process.stdout.write(JSON.stringify(row) + "\n"); await save("timeline.json", timeline);
}
const textOf = value => typeof value === "string" ? value : (value ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
const statusText = /RC 正在验收|后续任务暂缓|后续任务继续等待|RC 验收通过|RC 等待修正与复验超时/u;
const proxy = http.createServer(async (req, res) => {
  const controller = new AbortController(); controllers.add(controller);
  const timer = setTimeout(() => controller.abort(new Error("Real model request deadline")), 300000);
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  let row;
  try {
    let raw = "";
    for await (const bytes of req) { raw += bytes; if (raw.length > 4 * 1024 * 1024) throw new Error("Request too large"); }
    if (requests.length >= 64) throw new Error("Real-model request budget reached");
    const body = JSON.parse(raw), messages = body.messages ?? [];
    const system = messages.filter(item => item.role === "system").map(item => textOf(item.content)).join("\n");
    const role = system.match(/You are the isolated ([a-z-]+)/u)?.[1] ?? "business";
    const users = messages.filter(item => item.role === "user").map(item => textOf(item.content));
    const user = users.at(-1) ?? "";
    const kind = role !== "business" ? "review" : users.some(value => value.includes("RC_SIMPLE_NEXT_TASK")) ? "next"
      : user.includes("[runtime-corrector:stop-feedback]") ? "correction" : "initial";
    row = { index: requests.length + 1, at: Date.now(), role, kind, model: body.model,
      waitStatusInModelInput: role === "business" && statusText.test(JSON.stringify(messages)),
      requestedMaxTokens: body.max_tokens ?? body.max_completion_tokens, reasoningEffort: body.reasoning_effort, thinking: body.thinking?.type,
      requestSha256: createHash("sha256").update(raw).digest("hex") };
    requests.push(row); await save("model-requests.json", requests);
    assert(!row.waitStatusInModelInput, "Wait status entered business model context");
    row.forwardedAt = Date.now();
    const upstream = await fetch(`${provider.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: raw, signal: controller.signal,
    });
    row.httpStatus = upstream.status;
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    if (!upstream.ok) res.end(redact(await upstream.text()));
    else {
      let buffered = "";
      const decoder = new TextDecoder();
      for await (const bytes of upstream.body) {
        if (res.destroyed) break;
        res.write(bytes);
        buffered += decoder.decode(bytes, { stream: true });
        const lines = buffered.split("\n"); buffered = lines.pop();
        for (const line of lines) if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
          try {
            const frame = JSON.parse(line.slice(6));
            const finish = frame.choices?.find(choice => choice.finish_reason)?.finish_reason;
            if (finish) row.finishReason = finish;
            if (frame.usage) row.usage = frame.usage;
          } catch { /* Preserve the response bytes; metadata observation is advisory. */ }
        }
      }
      res.end();
    }
    row.completedAt = Date.now();
  } catch (error) {
    if (row) row.error = redact(error.message);
    if (!res.destroyed) { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: redact(error.message) } })); }
  } finally { clearTimeout(timer); controllers.delete(controller); await save("model-requests.json", requests); }
});
proxy.requestTimeout = 0;
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
const freePort = async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};
const descriptor = path.join(destination, "provider.json");
await fs.writeFile(descriptor, JSON.stringify({ api: provider.api, authHeader: true,
  baseUrl: `http://127.0.0.1:${proxy.address().port}/v1`, model: { id: model.id, name: model.name ?? model.id,
    input: model.input ?? ["text"], contextWindow: model.contextWindow, compat: model.compat, reasoning: model.reasoning, maxTokens: model.maxTokens } }));
process.env.RC_TEST_MODEL_KEY = "isolated-real-model-proxy";
let h;
try {
  await mark("starting isolated real host", { model: reference });
  h = await isolatedHost({ hostRoot, providerFile: descriptor, destination: path.join(destination, "host"), port: await freePort(),
    hookTimeoutMs: report.hookTimeoutMs, tools: ["read", "write", "edit", "exec"] });
  report.hostVersion = h.version;
  const project = path.join(h.root, "project"); report.projectRoot = project;
  await fs.mkdir(path.join(project, ".runtime-corrector"), { recursive: true });
  await fs.mkdir(path.join(project, "spec"));
  await fs.writeFile(path.join(project, "hello.mjs"), 'console.log("BROKEN");\n');
  await fs.writeFile(path.join(project, "spec/requirements.md"), "# Formal acceptance\nR01 Running node hello.mjs in this directory must exit 0, write exactly READY plus one newline to stdout, and leave stderr empty.\n");
  await fs.writeFile(path.join(project, "AGENTS.md"), "Work only on hello.mjs in this project. Preserve spec/requirements.md, AGENTS.md, .runtime-corrector, and host files. Use built-in Node only; no packages or network. The first delivery is deliberately read-only; after RC feedback the user has authorized fixing hello.mjs and retesting.\n");
  await fs.writeFile(path.join(project, ".runtime-corrector/config.yaml"), `version: 2
artifacts:
  - name: hello
    stage: proposal
    patterns: [hello.mjs]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: true
  materialRoots: [spec/requirements.md]
  panel:
    size: 1
    adjudicator: false
artifactCorrection:
  groundTruthReviewEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 2
  assessmentTimeoutMs: 1200000
  waitTimeoutMs: 1800000
reviewers:
  defaults:
    effort: low
    formatRepairAttempts: 1
`);
  const protectedFiles = ["spec/requirements.md", "AGENTS.md", ".runtime-corrector/config.yaml"];
  const digest = async relative => createHash("sha256").update(await fs.readFile(path.join(project, relative))).digest("hex");
  const hashes = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await digest(file)])));
  const acceptance = async () => {
    const result = await execute(process.execPath, ["hello.mjs"], { cwd: project, timeout: 10000, windowsHide: true });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, pass: result.stdout === "READY\n" && result.stderr === "" };
  };
  const sessionKey = `agent:main:rc-simple-live-${randomUUID()}`; report.sessionKey = sessionKey;
  const created = await h.request("sessions.create", { key: sessionKey, model: h.model, label: "RC simple real-model validation", emitCommandHooks: false });
  report.sessionId = created.sessionId;
  await h.send(sessionKey, `/rc-project bind ${project}`, 30000);
  const scope = await h.status(sessionKey); assert.equal(scope.enabled, true); assert.equal(await fs.realpath(scope.projectRoot), project);
  report.initialAcceptance = await acceptance(); assert.equal(report.initialAcceptance.pass, false);
  const prompt = `RC_SIMPLE_INITIAL_TASK\n项目：${project}\n正式要求见 spec/requirements.md，R01：运行 node hello.mjs，退出0，stdout严格为READY加换行，stderr为空。\n故障注入顺序：首次只读要求和程序，运行并如实交付验收报告，不改文件；这不是R01的豁免。收到RC未通过反馈后，已授权修正hello.mjs、运行复验并交付，无须确认。工具用上述项目绝对路径或workdir。`;
  await save("task-prompt.txt", prompt); await save("manifest.json", { ...report, protectedHashes: hashes });
  await mark("initial business task submitted", { project, sessionKey });
  const initial = await h.send(sessionKey, prompt, 1800000); report.initialRunId = initial.runId;
  await save("initial-terminal.json", initial);
  report.firstDeliveryAcceptance = await acceptance();
  await save("first-delivery.mjs", await fs.readFile(path.join(project, "hello.mjs"), "utf8"));
  assert.equal(report.firstDeliveryAcceptance.pass, false, "Invalid trial: business repaired before RC feedback");
  await mark("first delivery is unverified and intentionally still BROKEN", { runId: initial.runId, acceptance: report.firstDeliveryAcceptance });
  let snapshot;
  const admissionDeadline = Date.now() + 60000;
  while (Date.now() < admissionDeadline) {
    snapshot = await runtimeState(project);
    if (snapshot.records.some(row => row.runId === initial.runId && row.file.includes("/native-stop-reviews/"))) break;
    await pause(500);
  }
  assert(snapshot.records.some(row => row.runId === initial.runId && row.file.includes("/native-stop-reviews/")), "No actual native Stop checkpoint");
  let nextResult, nextError;
  const next = h.send(sessionKey, "RC_SIMPLE_NEXT_TASK\n上一任务处理结束后，这个后续任务只回复 NEXT_TASK_OK。不要读写文件或调用工具。", 1800000)
    .then(value => { nextResult = value; return value; }, error => { nextError = error; });
  await mark("next task queued during Stop review");
  let previous = "";
  const deadline = Date.now() + 1800000;
  while (Date.now() < deadline) {
    if (nextError) throw nextError;
    snapshot = await runtimeState(project);
    const stops = snapshot.records.filter(row => row.file.includes("/native-stop-reviews/"));
    const followups = snapshot.records.filter(row => row.file.includes("/native-followups/"));
    const current = { stops: stops.map(row => ({ runId: row.runId, status: row.status, verdict: row.reviewStatus, reason: row.reasonCode })),
      followups: followups.map(row => ({ runId: row.runId, status: row.status, observed: Boolean(row.modelObservedAt), finished: Boolean(row.finishedAt), verdict: row.reviewStatus })) };
    if (JSON.stringify(current) !== previous) { previous = JSON.stringify(current); await mark("RC lifecycle", current); }
    const original = stops.find(row => row.runId === initial.runId);
    const passed = stops.find(row => row.runId !== initial.runId && row.reviewStatus === "PASS" && row.assessmentCompletedAt);
    const nextModel = requests.find(row => row.kind === "next" && row.forwardedAt);
    if (nextModel) assert(passed && passed.assessmentCompletedAt <= nextModel.forwardedAt, "Next task entered the real model before corrective PASS");
    if (original?.status === "SETTLED") assert.equal(original.reviewStatus, "DEVIATION", "Initial defective delivery did not produce a valid deviation");
    if (nextResult && passed?.status === "SETTLED" && followups.some(row => row.runId === passed.runId && row.finishedAt && row.modelObservedAt)) {
      report.finalRunId = passed.runId; report.finalEvaluationId = passed.evaluationId; report.passCommittedAt = passed.assessmentCompletedAt;
      report.nextRunId = nextResult.runId; report.nextModelStartedAt = nextModel.forwardedAt;
      report.correctionAttempts = followups.length;
      break;
    }
    if (original?.status === "SETTLED" && !followups.length && !["DEVIATION"].includes(original.reviewStatus)) throw new Error(`Native Stop ended ${original.reviewStatus}`);
    await pause(1000);
  }
  assert(report.finalRunId && nextResult, "Simple real-model correction chain did not reach PASS before deadline");
  await next; await save("next-terminal.json", nextResult);
  report.finalAcceptance = await acceptance(); assert.equal(report.finalAcceptance.pass, true);
  for (const [file, hash] of Object.entries(hashes)) assert.equal(await digest(file), hash, `Protected file changed: ${file}`);
  assert(requests.some(row => row.kind === "correction"), "No real corrective business model call");
  assert(!requests.some(row => row.waitStatusInModelInput), "UI wait text leaked into a real business model call");
  const nativeFiles = (await files(path.join(h.stateDir, "agents"))).filter(file => file.endsWith(".jsonl"));
  const transcript = (await Promise.all(nativeFiles.map(file => fs.readFile(file, "utf8")))).join("\n");
  assert(!statusText.test(transcript), "Wait status entered the canonical model transcript");
  report.waitNotices = h.events.filter(event => event.event === "agent" && event.payload?.stream === "assistant"
    && /后续任务暂缓|后续任务继续等待|RC 验收通过/u.test(event.payload.data?.text ?? "")).length;
  assert(report.waitNotices > 0, "No visible lifecycle status was emitted");
  report.protectedFilesUnchanged = true; report.mainModelHistoryClean = true; report.modelRequests = requests.length;
  report.status = "PASS"; report.completedAt = Date.now();
  await save("runtime-state.json", snapshot); await mark("real task passed and next task was released", report);
} catch (error) {
  report.status = "FAIL"; report.error = redact(error.stack ?? error); report.completedAt = Date.now();
  if (report.projectRoot) await save("runtime-state.json", await runtimeState(report.projectRoot));
  await mark("real task validation failed", { error: report.error }); process.exitCode = 1;
} finally {
  await save("result.json", report); await save("model-requests.json", requests);
  for (const controller of controllers) controller.abort();
  await h?.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
}
