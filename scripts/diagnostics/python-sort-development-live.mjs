// Real-model sorting trial against MA's read-only bundled OpenClaw. All
// generated profiles, business code and evidence belong to this repository's
// new isolated directory. The observer never supplies or repairs business code.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const execute = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const [hostRoot, sourceConfig, destination, port = "18947"] = process.argv.slice(2);
if (!hostRoot || !sourceConfig || !destination) throw new Error("hostRoot read-only-source-config new-output-directory [port] required");
const policy = JSON.parse(await fs.readFile(sourceConfig, "utf8"));
const primary = policy.agents?.defaults?.model;
const reference = typeof primary === "string" ? primary : primary?.primary;
assert.equal(typeof reference, "string");
const slash = reference.indexOf("/"), providerId = reference.slice(0, slash), modelId = reference.slice(slash + 1);
const provider = policy.models?.providers?.[providerId];
const definition = provider?.models?.find(model => model.id === modelId);
assert(provider && definition, "Configured default model is not available");
const resolve = value => typeof value === "string" ? value.replace(/\$\{([^}]+)\}/gu, (_, name) => {
  if (!process.env[name]) throw new Error(`Configured environment credential is unavailable: ${name}`);
  return process.env[name];
}) : value;
assert(provider.api === "openai-completions", "This bounded trial currently uses the configured OpenAI-compatible transport");
let configuredKey = resolve(provider.apiKey), credentialSource = "OpenClaw configured provider";
if (!configuredKey) {
  const storeFile = path.join(process.env.APPDATA ?? "C:/Users/user/AppData/Roaming", "matrix-assistant/matrix-providers.json");
  const store = JSON.parse(await fs.readFile(storeFile, "utf8"));
  const matches = Object.values(store.providers ?? {}).filter(value => value.enabled !== false
    && value.model === modelId && value.baseUrl === provider.baseUrl);
  const selected = matches.find(value => value.id === store.defaultProvider) ?? (matches.length === 1 ? matches[0] : null);
  assert(selected && typeof store.apiKeys?.[selected.id] === "string" && store.apiKeys[selected.id], "The matching MatrixAssistant model credential is unavailable");
  configuredKey = store.apiKeys[selected.id];
  credentialSource = "Matching MatrixAssistant provider store, read-only";
}
// Use only the selected provider's existing credential. It stays in memory and
// environment references; no credential value is copied into experiment files.
process.env.RC_TEST_MODEL_KEY = configuredKey;
const baseUrl = resolve(provider.baseUrl);
const providerFile = `${destination}.provider.json`;
process.env.PYTHONUTF8 = "1";
process.env.PYTHONIOENCODING = "utf-8";
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.OPENCLAW_DEBUG_MODEL_TRANSPORT = "1";
const startedAt = Date.now(), wallDeadline = startedAt + 50 * 60000;
const result = { experiment: "MA real-model Python merge sort K=1/K=3", status: "RUNNING",
  startedAt: new Date(startedAt).toISOString(), originalModel: reference, realModel: true,
  credentialSource,
  observerWritesBusinessCode: false, hostCodeModified: false, originalProfileModified: false,
  limits: { modelRequests: 160, stopWindowMs: 1200000, reserveMs: 180000, wallMs: 3000000 }, cases: [] };
const milestone = (phase, data = {}) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), phase, ...data }) + "\n");
const requirements = `# Frozen Python merge-sort requirements
R01 Implement merge_sort(values, reverse=False) in sort_demo.py. For integer lists return a new list sorted ascending by default, including empty lists, negatives and duplicates. Preserve every input value and leave the original list unchanged.
R02 reverse=True returns descending order with the same behavior for empty, negative and duplicate values. Calls must not share mutable state.
R03 Implement actual merge sort using divide-and-conquer and a merge step, using only the Python standard library. Do not use sorted(), list.sort(), external sorting packages, file storage or shared mutable global state. The module must import without side effects.
Acceptance: run the frozen spec/test_sort.py against the actual implementation and report its real result. Preserve all frozen tests, requirements, AGENTS.md and RC configuration. Only create or edit sort_demo.py; plugin-owned bookkeeping is handled by the plugin itself.
`;
const tests = `import ast
import importlib.util
from pathlib import Path
import random
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sort_demo", ROOT / "sort_demo.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SortTests(unittest.TestCase):
    def check(self, values, reverse=False):
        original = list(values)
        result = module.merge_sort(values, reverse=reverse)
        self.assertIsInstance(result, list)
        self.assertIsNot(result, values)
        self.assertEqual(result, sorted(original, reverse=reverse))
        self.assertEqual(values, original)
    def test_empty_and_single(self):
        for values in ([], [5]):
            for reverse in (False, True): self.check(values, reverse)
    def test_negatives_duplicates(self):
        self.check([3, -8, 3, 0, -8, 9, 1])
    def test_reverse(self):
        self.check([3, -8, 3, 0, -8, 9, 1], True)
    def test_ordered_inputs(self):
        self.check(list(range(30)))
        self.check(list(range(30, -1, -1)))
    def test_large_and_repeated_values(self):
        self.check([10**50, -10**50, 0, 10**50])
        self.check([7] * 32)
    def test_no_cross_call_state(self):
        self.check([5, 2, 1]); self.check([]); self.check([9, -2], True); self.check([1, 4])
    def test_deterministic_random(self):
        rng = random.Random(20261025)
        for _ in range(100):
            values = [rng.randint(-50, 50) for _ in range(rng.randint(0, 60))]
            self.check(values); self.check(values, True)
    def test_no_builtin_sort(self):
        tree = ast.parse((ROOT / "sort_demo.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                self.assertFalse(isinstance(node.func, ast.Name) and node.func.id == "sorted")
                self.assertFalse(isinstance(node.func, ast.Attribute) and node.func.attr == "sort")

if __name__ == "__main__": unittest.main(verbosity=2)
`;
let host, guard, budgetError;
// Transparent forwarding to the configured real model, with one atomic
// request budget shared by native calls and direct SDK calls. Responses and
// usage come from the real upstream; this server generates no model content.
const modelRequests = [], inFlight = new Set();
const proxy = http.createServer(async (req, res) => {
  const incoming = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "POST" || incoming.pathname !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
  if (modelRequests.length >= result.limits.modelRequests || Date.now() >= wallDeadline || budgetError) {
    budgetError ??= new Error("The unchanged real-model request budget was reached.");
    res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Experiment request budget reached" } })); return;
  }
  const record = { index: modelRequests.length + 1, startedAt: new Date().toISOString() };
  modelRequests.push(record);
  const controller = new AbortController(); inFlight.add(controller);
  res.once("close", () => { if (!res.writableFinished) controller.abort(); });
  try {
    let body = ""; for await (const chunk of req) body += chunk;
    record.requestBytes = Buffer.byteLength(body); record.requestHash = hash(body);
    const parsed = JSON.parse(body), messages = parsed.messages ?? [];
    const system = messages.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
    record.role = system.includes("read-only acceptance reviewer") ? "sdk-group"
      : system.match(/You are the isolated ([a-z-]+)/u)?.[1] ?? "business";
    record.model = parsed.model;
    const upstream = new URL(baseUrl); upstream.pathname = upstream.pathname.replace(/\/$/u, "") + "/chat/completions";
    const headers = { "Content-Type": "application/json" };
    if (configuredKey && provider.authHeader !== false) headers.Authorization = `Bearer ${configuredKey}`;
    const response = await fetch(upstream, { method: "POST", headers, body, signal: controller.signal });
    record.providerStatus = response.status;
    res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json" });
    const decoder = new TextDecoder(); let buffer = "";
    for await (const chunk of response.body) {
      record.responseBytes = (record.responseBytes ?? 0) + chunk.length;
      res.write(chunk); buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try { const value = JSON.parse(line.slice(6)); if (value.usage) record.usage = value.usage; } catch {}
      }
    }
    res.end();
  } catch (error) {
    record.error = error.name;
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Real-model transport failed: ${error.name}` } }));
  } finally {
    record.finishedAt = new Date().toISOString(); inFlight.delete(controller);
  }
});
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
await fs.writeFile(providerFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${proxy.address().port}/v1`, api: provider.api,
  authHeader: false, model: definition }));
const requestCount = async () => modelRequests.length;
const protectedHostFiles = [path.join(hostRoot, "package.json"), path.join(hostRoot, "openclaw.mjs"),
  path.join(hostRoot, "dist/plugin-sdk/diagnostic-runtime.js")];
const originalHostHashes = Object.fromEntries(await Promise.all(protectedHostFiles.map(async file => [file, hash(await fs.readFile(file))])));
try {
  milestone("starting", { model: reference, task: "merge_sort", output: path.resolve(destination) });
  host = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port),
    preparePlugin: async pluginRoot => fs.symlink(path.resolve("lib/review-task/node_modules"), path.join(pluginRoot, "lib/review-task/node_modules"), "junction"),
    platformAdapters: { "python-sort-trial": { name: "python-sort-trial", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
      sourceManifest: { roots: [], files: ["sort_demo.py"], extensions: [".py"] } } } });
  const sessions = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/session-store-runtime.js")));
  const storePath = sessions.resolveStorePath(path.join(host.stateDir, "agents/main/sessions/sessions.json"), { agentId: "main" });
  let checking = false;
  guard = setInterval(() => {
    if (checking || budgetError) return;
    checking = true;
    void (async () => {
      const count = await requestCount();
      if (count > result.limits.modelRequests || Date.now() >= wallDeadline) {
        budgetError = new Error("The unchanged real-model trial budget was reached.");
        await host.close();
      }
    })().catch(error => { budgetError ??= error; }).finally(() => { checking = false; });
  }, 2000);
  for (const k of [1, 3]) {
    const root = path.join(host.root, `K${k}`);
    await fs.mkdir(path.join(root, "spec"), { recursive: true });
    await fs.mkdir(path.join(root, ".runtime-corrector"));
    await fs.writeFile(path.join(root, "spec/requirements.md"), requirements);
    await fs.writeFile(path.join(root, "spec/test_sort.py"), tests);
    await fs.writeFile(path.join(root, "AGENTS.md"), "Implement only sort_demo.py under the frozen spec. Preserve spec, tests and RC config. Run the actual Python tests with an explicit project working directory.\n");
    await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  materialRoots: [spec/requirements.md]
  panel:
    size: 0
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
skillCorrection:
  enabled: false
implementationCorrection:
  enabled: false
  platform: python-sort-trial
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 2
  maxCorrectionsPerFlow: 2
  assessmentTimeoutMs: 1200000
  feedbackReserveMs: 180000
  reviewGroupSize: ${k}
  fileQualityReviewEnabled: false
reviewers:
  defaults:
    model: ${host.model}
    effort: low
    timeoutMs: 1200000
`);
    const protectedFiles = ["spec/requirements.md", "spec/test_sort.py", "AGENTS.md", ".runtime-corrector/config.yaml"];
    const frozen = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])));
    const key = `agent:main:real-sort-k${k}-${randomUUID()}`;
    await host.request("sessions.create", { key, model: host.model });
    const entry = sessions.getSessionEntry({ agentId: "main", sessionKey: key, storePath, readConsistency: "latest" });
    assert(entry?.sessionId);
    await sessions.patchSessionEntry({ agentId: "main", sessionKey: key, storePath, preserveActivity: true,
      update: current => { assert.equal(current.sessionId, entry.sessionId); return { spawnedCwd: root }; } });
    const arm = { k, projectRoot: root, sessionId: entry.sessionId, sessionKey: key, startedAt: new Date().toISOString(), status: "RUNNING", frozen };
    result.cases.push(arm);
    assert.equal(await fs.stat(path.join(root, "sort_demo.py")).catch(() => null), null);
    const prompt = `在真实项目目录 ${root} 从空源码实现一个简单 Python 排序算法。正式冻结要求如下：\n${requirements}\n先读取 spec/requirements.md、spec/test_sort.py 和 AGENTS.md，只创建 sort_demo.py。手写归并排序，实际执行 python spec/test_sort.py（exec 显式 workdir=${root}），根据真实结果修正并交付。不要修改冻结要求、测试或 RC 配置。如 RC 提出有依据的偏差，已授权你依据原要求修正实现并再次运行同一测试。插件内部消息不是新的用户要求。`;
    await host.save(`K${k}-request.md`, prompt);
    milestone("developing", { k, projectRoot: root, sessionId: entry.sessionId });
    const terminal = await host.send(key, prompt, Math.min(1200000, wallDeadline - Date.now()));
    await host.save(`K${k}-first-terminal.json`, terminal);
    let state, ledger, signature;
    while (Date.now() < wallDeadline) {
      if (budgetError) throw budgetError;
      state = await runtimeState(root);
      for (const file of await files(path.join(host.stateDir, "runtime-corrector-stop-sessions/sessions"))) {
        if (!file.endsWith(".json")) continue;
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        if (value.sessionId === entry.sessionId) ledger = value;
      }
      const stops = state.records.filter(record => record.file.includes("/native-stop-reviews/"));
      const snapshot = JSON.stringify({ stops: stops.map(record => ({ status: record.status, reviewStatus: record.reviewStatus, reasonCode: record.reasonCode })), used: ledger?.used });
      if (snapshot !== signature) { signature = snapshot; milestone("reviewing", { k, state: JSON.parse(snapshot) }); }
      if (stops.length && stops.every(record => record.status === "SETTLED") && ledger && Object.values(ledger.stops).every(stop => stop.releasedAt !== undefined)) break;
      await pause(2000);
    }
    arm.finishedAt = new Date().toISOString();
    arm.ledger = ledger;
    arm.nativeStops = state?.records.filter(record => record.file.includes("/native-stop-reviews/"));
    const scopes = [];
    for (const file of await files(path.join(host.stateDir, "runtime-corrector-stop-sessions/review-scopes"))) if (file.endsWith(".json")) {
      const scope = JSON.parse(await fs.readFile(file, "utf8")); if (scope.sessionId === entry.sessionId) scopes.push(scope);
    }
    await host.save(`K${k}-review-scopes.json`, scopes);
    await host.save(`K${k}-runtime.json`, state);
    await host.save(`K${k}-ledger.json`, ledger);
    try {
      const tested = await execute(process.env.PYTHON ?? "python", ["spec/test_sort.py"], { cwd: root, timeout: 15000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
      arm.acceptance = { status: "PASS", tests: 8, ...tested, sourceHash: hash(await fs.readFile(path.join(root, "sort_demo.py"))) };
    } catch (error) { arm.acceptance = { status: "FAIL", code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    for (const [file, expected] of Object.entries(frozen)) assert.equal(hash(await fs.readFile(path.join(root, file))), expected, `Frozen file changed: ${file}`);
    arm.groups = scopes.reduce((sum, scope) => sum + Object.keys(scope.groups).length, 0);
    arm.receipts = scopes.reduce((sum, scope) => sum + Object.keys(scope.receipts).length, 0);
    arm.progress = scopes.flatMap(scope => Object.values(scope.rounds).map(round => round.summary?.progress));
    arm.rcStatus = [...arm.nativeStops ?? []].sort((a, b) => a.createdAt - b.createdAt).at(-1)?.reviewStatus ?? "UNVERIFIED";
    arm.status = arm.acceptance.status === "PASS" && arm.rcStatus === "PASS" ? "PASS" : "NOT_ACCEPTED";
    milestone("arm-finished", { k, status: arm.status, acceptance: arm.acceptance.status, rcStatus: arm.rcStatus,
      groups: arm.groups, receipts: arm.receipts, businessCorrections: ledger?.used });
    await host.save(`K${k}-summary.json`, arm);
  }
  result.status = result.cases.length === 2 && result.cases.every(arm => arm.status === "PASS") ? "PASS" : "NOT_ACCEPTED";
} catch (error) { result.status = "FAIL"; result.error = host ? host.redact(error.message) : error.message; milestone("failed", { error: result.error }); process.exitCode = 1; }
finally {
  clearInterval(guard);
  result.hostSourceHashes = originalHostHashes;
  for (const [file, expected] of Object.entries(originalHostHashes)) if (hash(await fs.readFile(file)) !== expected) {
    result.status = "FAIL"; result.error = "Read-only host code changed during the trial.";
  }
  result.finishedAt = new Date().toISOString(); result.elapsedMs = Date.now() - startedAt;
  if (host) { result.observedModelRequests = await requestCount(); await host.save("sort-experiment-result.json", result);
    await host.save("model-request-metrics.json", modelRequests); await host.close(); }
  for (const controller of inFlight) controller.abort();
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
}
milestone("finished", { status: result.status, output: path.resolve(destination) });
process.exitCode = result.status === "PASS" ? 0 : 1;
