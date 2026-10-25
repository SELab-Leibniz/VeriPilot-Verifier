// Real isolated Gateway and model experiment. Never edits a user's profile or session.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const execute = promisify(execFile), repository = await fs.realpath(process.cwd());
const destination = path.resolve(process.argv[2] ?? `experiments/live-session-switches-insertion-${Date.now()}`);
const mode = process.argv[3] ?? "all";
assert(["all", "transitions"].includes(mode));
assert.equal(path.dirname(destination), path.join(repository, "experiments"));
assert(/^live-session-switches-insertion-[a-zA-Z0-9-]+$/u.test(path.basename(destination)));
const hostRoot = "C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw";
const bridge = "C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/claw-plugin/register-gateway-method";
const python = "C:/Users/user/miniforge3/python.exe";
const dependencySource = path.join(repository, "experiments/live-todolist-isolated-20261025-01/host/plugin/runtime-corrector-openclaw");
const hash = data => createHash("sha256").update(data).digest("hex");
const originalFiles = [path.join(os.homedir(), ".openclaw/openclaw.json"), path.join(os.homedir(), ".openclaw/agents/main/agent/models.json")];
const originalBytes = await Promise.all(originalFiles.map(file => fs.readFile(file)));
const [configured, cache] = originalBytes.map(bytes => JSON.parse(bytes.toString("utf8")));
const primaryRef = typeof configured.agents?.defaults?.model === "string" ? configured.agents.defaults.model : configured.agents?.defaults?.model?.primary;
const slash = primaryRef.indexOf("/"), providerId = primaryRef.slice(0, slash), modelId = primaryRef.slice(slash + 1);
const p = configured.models?.providers?.[providerId], c = cache.providers?.[providerId];
const useAnthropic = process.env.RC_INSERTION_PROVIDER === "anthropic";
const provider = useAnthropic ? { baseUrl: process.env.ANTHROPIC_BASE_URL, api: "anthropic-messages", authHeader: true,
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN, models: [{ id: process.env.ANTHROPIC_MODEL, name: "Isolated insertion switch experiment",
    reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 }] }
  : { ...c, ...p, apiKey: p?.apiKey ?? c?.apiKey, models: p?.models ?? c?.models };
const modelRef = useAnthropic ? `anthropic-env/${process.env.ANTHROPIC_MODEL}` : primaryRef;
const model = useAnthropic ? provider.models[0] : provider.models.find(value => value.id === modelId || value.id === primaryRef);
const key = provider.apiKey.replace(/\$\{([^}]+)\}/gu, (_, name) => process.env[name] ?? "");
assert(key && model && provider.baseUrl && provider.api);
assert.equal(Object.keys(provider.headers ?? {}).length, 0);
const redact = value => String(value).replaceAll(key, "<model-key>");
const sourceFiles = (await Promise.all(["lib", "config"].map(dir => files(path.join(repository, dir))))).flat()
  .filter(file => !file.replaceAll("\\", "/").includes("/node_modules/"));
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(repository, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
const report = { experiment: "insertion-sort-session-switches", mode, startedAt: new Date().toISOString(), status: "RUNNING",
  sourceBranch: (await execute("git", ["branch", "--show-current"])).stdout.trim(),
  sourceCommit: (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(), model: modelRef,
  diagnosticHash: hash(await fs.readFile(new URL(import.meta.url))),
  hostRoot, cases: [], transitions: [], sourceHashes, businessCodeAuthoredByObserver: false,
  limits: { observerMinutes: 30, privateReviewerRuns: 90, correctionsPerTask: 1 },
  reviewScope: "Switch admission/cancellation/persistence only. Ground Truth and Stop M08 configured; Stop verdict and correction quality are explicitly outside acceptance." };
await fs.mkdir(destination, { mode: 0o700 });
const save = (name, value) => fs.writeFile(path.join(destination, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
const milestone = async (phase, values = {}) => {
  const row = { at: new Date().toISOString(), phase, ...values };
  process.stdout.write(redact(JSON.stringify(row)) + "\n");
  await fs.appendFile(path.join(destination, "timeline.jsonl"), redact(JSON.stringify(row)) + "\n");
};
const providerFile = path.join(destination, "provider.json");
await fs.writeFile(providerFile, JSON.stringify({ baseUrl: provider.baseUrl, api: provider.api, authHeader: provider.authHeader ?? true,
  model: { ...model, cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, null, 2));
const temp = path.join(destination, "python-temp"); await fs.mkdir(temp);
Object.assign(process.env, { RC_TEST_MODEL_KEY: key, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", TEMP: temp, TMP: temp });
const verifier = path.join(destination, "verify_insertion.py");
await fs.writeFile(verifier, `import ast, importlib.util, json, random, sys
from pathlib import Path
p = Path(sys.argv[1])
source = p.read_text(encoding="utf-8-sig")
tree = ast.parse(source)
for node in ast.walk(tree):
    if isinstance(node, ast.Call):
        assert not (isinstance(node.func, ast.Name) and node.func.id == "sorted"), "built-in sorted is forbidden"
        assert not (isinstance(node.func, ast.Attribute) and node.func.attr == "sort"), "list.sort is forbidden"
assert any(isinstance(n, (ast.For, ast.While)) for n in ast.walk(tree)), "an insertion algorithm must contain a loop"
spec = importlib.util.spec_from_file_location("insertion_test", p)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = [[], [1], [3, 1, 2], [2, 2, -1, 0, -1], list(range(8)), list(range(8, -1, -1))]
rng = random.Random(20261025)
cases += [[rng.randint(-30, 30) for _ in range(rng.randint(0, 35))] for _ in range(30)]
for values in cases:
    expected = sorted(values)
    result = module.insertion_sort(values[:])
    assert isinstance(result, list) and result == expected, (values, result, expected)
print(json.dumps({"status":"PASS", "vectors":len(cases), "file":str(p)}, ensure_ascii=False))
`, "utf8");
const verifierHash = hash(await fs.readFile(verifier));
const freePort = async () => { const server = net.createServer(); await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const stopMetrics = Array.from({ length: 16 }, (_, i) => `    M${String(i + 1).padStart(2, "0")}: ${i + 1 === 8}`).join("\n");
let h, guard, fatal, closing, started = Date.now();
const closeHost = () => closing ??= h?.close();
const policy = (enabled = true, defaultEnabled = true) => `version: 2
enabled: ${enabled}
sessionDefaults:
  enabled: ${defaultEnabled}
artifacts: []
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
    adjudicator: false
skillCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 1
  assessmentTimeoutMs: 600000
  waitTimeoutMs: 600000
  metrics:
${stopMetrics}
  fileQualityReviewEnabled: false
implementationCorrection:
  enabled: false
reviewers:
  defaults:
    model: ${h.model}
    effort: low
    timeoutMs: 300000
    formatRepairAttempts: 1
`;
const cfgPath = project => path.join(project.root, ".runtime-corrector/config.yaml");
const configHash = async project => fs.readFile(cfgPath(project)).then(hash, error => { if (error.code === "ENOENT") return null; throw error; });
const params = project => ({ sessionKey: project.key, sessionId: project.sessionId });
const get = project => h.request("runtime-corrector.session.get", params(project));
const set = (project, enabled) => h.request("runtime-corrector.session.set", { ...params(project), enabled });
const text = turn => { const blocks = turn.outcome.message?.content; return typeof blocks === "string" ? blocks : (blocks ?? []).filter(block => block.type === "text").map(block => block.text).join("\n"); };
async function state(root) {
  try { return await runtimeState(root); } catch (error) { if (error instanceof SyntaxError || error.code === "ENOENT") { await pause(50); return runtimeState(root); } throw error; }
}
const roles = snapshot => snapshot.records.filter(record => record.file.includes("/native-runs/"));
const stops = snapshot => snapshot.records.filter(record => record.file.includes("/native-stop-reviews/"));
async function waitFor(check, label, timeout = 660000) {
  const deadline = Math.min(started + 30 * 60_000, Date.now() + timeout);
  while (Date.now() < deadline) { if (fatal) throw fatal; const value = await check(); if (value) return value; await pause(350); }
  throw new Error(`Observer deadline: ${label}`);
}
async function prepare(name, { root, master = true, defaults = true, choice = "inherit", filename = "insertion_sort.py" } = {}) {
  root ??= path.join(h.root, "projects", name);
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), policy(true, defaults));
  await fs.mkdir(path.join(root, "spec"), { recursive: true });
  await fs.writeFile(path.join(root, "spec/requirements.md"), "# Python 插入排序正式交付要求\n\nR1 用户指定的 insertion_sort.py 实现 insertion_sort(values)，接收整数列表并返回升序列表。\nR2 正确处理空列表、负数、重复值，保留所有元素及数量。\nR3 使用真正的插入排序，不调用 sorted 或 list.sort，只用标准库。\n");
  await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  const sessionKey = `agent:main:insertion-${name}-${randomUUID().slice(0, 6)}`;
  const created = await h.request("sessions.create", { key: sessionKey, model: h.model, label: `Insertion ${name}`, emitCommandHooks: false });
  await h.request("sessions-custom.setSessionCwd", { sessionKey, cwd: root });
  const scope = await h.status(sessionKey);
  assert.equal(scope.projectRoot, root); assert.equal(scope.source, "host");
  const project = { name, root, key: sessionKey, sessionId: created.sessionId ?? scope.identity.sessionId, filename,
    master, defaults, choice, expected: master && (choice === "inherit" ? defaults : choice === "on") };
  if (choice !== "inherit") await set(project, choice === "on");
  if (!master) await fs.writeFile(cfgPath(project), policy(false, defaults));
  return project;
}
function prompt(project, suffix = "") {
  return `写一个python 插入排序 算法文件。正式要求见 spec/requirements.md，即刻生效。\nR1 在 ${path.join(project.root, project.filename)} 实现 insertion_sort(values)，输入整数列表，返回升序列表。\nR2 正确处理空列表、负数、重复值，保留元素数量。\nR3 必须采用真正的插入排序，不调用 sorted 或 list.sort，不安装第三方依赖。\n${suffix}\n只修改上述算法文件，不修改任何配置、需求、验收脚本或宿主。请直接用 write 写入算法文件，再用 exec 执行 python "${verifier}" "${path.join(project.root, project.filename)}"，workdir 明确为 ${project.root}。不手动调用 runtime_corrector 工具，由插件自动处理。最后报告实际结果。`;
}
async function acceptance(project) {
  assert.equal(hash(await fs.readFile(verifier)), verifierHash, "Frozen verifier was changed");
  const result = await execute(python, [verifier, path.join(project.root, project.filename)], { cwd: project.root, timeout: 15000, env: process.env });
  return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
}
const taskFor = (snapshot, project) => snapshot.tasks.find(value => value.rootSessionId === project.sessionId);
const reviewEvidence = snapshot => roles(snapshot).map(record => ({ taskId: record.taskId, role: record.role, status: record.status, runId: record.runId }));
async function activated(project, previousCount = -1) {
  return waitFor(async () => {
    const snapshot = await state(project.root), task = taskFor(snapshot, project);
    return task && roles(snapshot).length > previousCount && roles(snapshot).some(record => record.taskId === task.taskId) ? { snapshot, task } : null;
  }, `${project.name} real reviewer admitted`, 90000);
}
async function paused(project) {
  return waitFor(async () => {
    const snapshot = await state(project.root), task = taskFor(snapshot, project);
    return task && !roles(snapshot).some(record => record.taskId === task.taskId && record.status !== "SETTLED") ? { snapshot, task } : null;
  // The native host can finish an already accepted model request after its
  // local cancellation. This is cleanup time, not the switch's response time.
  }, `${project.name} own reviewers cancelled`, 90000);
}
async function runCase(project) {
  const item = { id: project.name, project: project.root, sessionKey: project.key, sessionId: project.sessionId,
    combination: { projectEnabled: project.master, defaultEnabled: project.defaults, sessionChoice: project.choice,
      configPresent: project.configPresent !== false, legacyDefaults: project.legacyDefaults === true },
    expectedEnabled: project.expected, status: "RUNNING" };
  report.cases.push(item); await milestone("case start", { id: item.id, expectedEnabled: item.expectedEnabled });
  try {
    const status = await get(project); item.controlBefore = status; assert.equal(status.effectiveEnabled, project.expected);
    const frozen = await configHash(project);
    await save(`${project.name}-request.md`, prompt(project));
    const turn = await h.send(project.key, prompt(project), 600000); item.runId = turn.runId;
    await save(`${project.name}-terminal.json`, turn);
    item.business = await acceptance(project);
    if (project.expected) {
      const { snapshot, task } = await activated(project);
      item.rc = { taskId: task.taskId, reviewerAdmitted: true, reviewerRuns: reviewEvidence(snapshot), stopVerdictRequired: false };
    } else {
      await pause(600);
      const snapshot = await state(project.root);
      assert.equal(snapshot.tasks.length, 0); assert.equal(roles(snapshot).length, 0); assert.equal(stops(snapshot).length, 0);
      item.rc = { taskCount: 0, reviewerCount: 0, stopCount: 0 };
    }
    assert.equal(await configHash(project), frozen, "Business model modified project configuration");
    item.controlAfter = await get(project); assert.equal(item.controlAfter.effectiveEnabled, project.expected);
    if (!project.master) await assert.rejects(set(project, true), /RC_PROJECT_DISABLED/u);
    item.status = "PASS";
  } catch (error) {
    item.status = "FAIL"; item.error = h.redact(error.stack);
    await set(project, false).catch(() => {});
  }
  if (project.expected) { await set(project, false).catch(() => {}); await paused(project).catch(() => {}); }
  await save("report.json", report); await milestone("case finished", { id: item.id, status: item.status, error: item.error });
}
async function transition(name, run) {
  const item = { id: name, status: "RUNNING" }; report.transitions.push(item); await milestone("transition start", { id: name });
  try { Object.assign(item, await run()); item.status = "PASS"; }
  catch (error) { item.status = "FAIL"; item.error = h.redact(error.stack); }
  await save("report.json", report); await milestone("transition finished", { id: name, status: item.status, error: item.error });
}
async function editPreference(project, enabled) {
  const status = await get(project), contents = await fs.readFile(status.settingsFile, "utf8");
  const begin = contents.indexOf(`  ${status.recordKey}:`); assert(begin >= 0);
  const tail = contents.slice(begin), end = tail.slice(1).search(/\n  s_[a-f0-9]+:/u);
  const length = end < 0 ? tail.length : end + 1;
  const block = tail.slice(0, length), changed = block.replace(/(\n    enabled: )\b(?:true|false)\b/u, `$1${enabled}`);
  assert.notEqual(changed, block);
  await fs.writeFile(status.settingsFile, contents.slice(0, begin) + changed + tail.slice(length));
  return get(project);
}

try {
  await save("observer-source.mjs", await fs.readFile(new URL(import.meta.url), "utf8"));
  await save("source-admission.json", { ...report, originalConfigHashes: Object.fromEntries(originalFiles.map((file, i) => [file, hash(originalBytes[i])])) });
  await milestone("starting isolated Gateway", { model: modelRef, output: destination });
  h = await isolatedHost({ hostRoot, providerFile, destination: path.join(destination, "host"), port: await freePort(),
    tools: ["read", "write", "edit", "exec"],
    hookTimeoutMs: 600000, extraPlugins: [{ id: "register-gateway-method", path: bridge }], preparePlugin: async pluginRoot => {
      const expectedLock = await fs.readFile(path.join(dependencySource, "package-lock.json"));
      assert.equal(hash(await fs.readFile(path.join(pluginRoot, "package-lock.json"))), hash(expectedLock), "Dependency lock differs from reusable installation");
      await fs.cp(path.join(dependencySource, "node_modules"), path.join(pluginRoot, "node_modules"), { recursive: true });
      for (const [file, digest] of Object.entries(sourceHashes)) {
        if (["lib/active-host.mjs", "lib/claude-executable.mjs", "lib/plugin-builder.mjs", "lib/hosts/claude.mjs", "lib/hosts/codeagent.mjs"].includes(file)) continue;
        assert.equal(hash(await fs.readFile(path.join(pluginRoot, file))), digest, `Frozen plugin differs: ${file}`);
      }
    } });
  Object.assign(report, { hostVersion: h.version, pluginRoot: h.pluginRoot, port: h.config.gateway.port });
  guard = setInterval(async () => {
    const reviewerStarts = h.events.filter(event => event.event === "agent" && event.payload?.stream === "lifecycle"
      && event.payload.data?.phase === "start" && String(event.payload.sessionKey ?? "").includes(":runtime-corrector:")).length;
    const stopped = await fs.access(path.join(destination, "STOP")).then(() => true, () => false);
    if (stopped || reviewerStarts > 90 || Date.now() - started > 30 * 60_000) {
      fatal ??= new Error(stopped ? "Experiment stop file received" : "Experiment reviewer/time budget reached"); void closeHost();
    }
  }, 1000);
  if (mode === "all") {
  // One positive first catches runtime/provider faults before the disabled controls.
  const combinations = [];
  for (const master of [true, false]) for (const defaults of [true, false]) for (const choice of ["inherit", "on", "off"]) combinations.push({ master, defaults, choice });
  for (const combination of combinations) {
    const name = `p${+combination.master}-d${+combination.defaults}-${combination.choice}`;
    await runCase(await prepare(name, combination));
    if (fatal) throw fatal;
  }
  const absent = await prepare("config-absent");
  await fs.unlink(cfgPath(absent)); absent.expected = false; absent.configPresent = false;
  assert.equal((await get(absent)).reason, "RC_PROJECT_NOT_ENABLED"); await runCase(absent);
  const legacy = await prepare("legacy-defaults");
  await fs.writeFile(cfgPath(legacy), policy().replace("enabled: true\nsessionDefaults:\n  enabled: true\n", ""));
  legacy.legacyDefaults = true; await runCase(legacy);
  }
  const shared = path.join(h.root, "projects", "shared"), a = await prepare("peer-a", { root: shared, defaults: false, choice: "on", filename: "a/insertion_sort.py" });
  const b = await prepare("peer-b", { root: shared, defaults: false, filename: "b/insertion_sort.py" });
  await transition("same-project-independent-and-mid-review-off", async () => {
    assert.equal((await get(a)).effectiveEnabled, true); assert.equal((await get(b)).effectiveEnabled, false);
    const aWork = h.send(a.key, prompt(a), 600000).then(turn => ({ turn }), error => ({ error }));
    const pending = await waitFor(async () => {
      const snapshot = await state(shared), task = taskFor(snapshot, a);
      const running = task && roles(snapshot).find(record => record.taskId === task.taskId && record.status === "DISPATCH_COMMITTED");
      if (!running) return null;
      const log = (await fs.readFile(path.join(h.root, "gateway.jsonl"), "utf8")).split("\n").flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const start = log.findIndex(row => String(row.message ?? "").includes(`embedded run agent start: runId=${running.runId}`));
      const fetch = start >= 0 && log.slice(start + 1).find(row => String(row.message ?? "").startsWith("[model-fetch] start "));
      return fetch && { task, running, reviewerModelStartedAt: Date.parse(fetch.time) };
    }, "A actual private reviewer running", 180000);
    const before = pending.task;
    const at = Date.now(), disabled = await set(a, false); assert.equal(disabled.effectiveEnabled, false);
    assert(pending.reviewerModelStartedAt <= at);
    const finalA = await paused(a);
    await set(b, true);
    const peer = await h.send(b.key, prompt(b), 600000), finalB = await activated(b), first = await aWork;
    if (first.error) throw first.error;
    assert.notEqual(before.taskId, finalB.task.taskId);
    const after = finalA.snapshot.tasks.find(t => t.taskId === before.taskId);
    assert.equal(after.stop.correctionAttempts, before.stop.correctionAttempts);
    assert.notEqual(after.status, "STOPPED_UNVERIFIED");
    assert.equal((await get(a)).effectiveEnabled, false); assert.equal((await get(b)).effectiveEnabled, true);
    a.retainedTaskId = before.taskId; a.retainedCorrections = before.stop.correctionAttempts;
    await set(b, false); await paused(b);
    return { taskA: before.taskId, taskB: finalB.task.taskId, cancelledReviewerA: pending.running.runId,
      reviewerAAfter: reviewEvidence(finalA.snapshot), reviewerB: reviewEvidence(finalB.snapshot),
      reviewerModelStartedAt: pending.reviewerModelStartedAt,
      businessRunA: first.turn.runId, businessRunB: peer.runId, closeAppliedAt: at, businessA: await acceptance(a), businessB: await acceptance(b) };
  });
  await transition("reopen-keeps-task-and-budget", async () => {
    await set(a, true);
    const snapshot = await state(shared), task = taskFor(snapshot, a);
    assert.equal(task.taskId, a.retainedTaskId); assert.equal(task.stop.correctionAttempts, a.retainedCorrections);
    const count = roles(snapshot).length;
    const turn = await h.send(a.key, prompt(a, "继续同一算法文件，在文件头添加注释 # switch-reopen 并保留排序算法，然后复测。必须实际修改。"), 600000);
    const done = await activated(a, count);
    assert(roles(done.snapshot).length > count, "Reopen did not admit a new reviewer");
    assert.equal(done.task.taskId, a.retainedTaskId);
    return { taskId: done.task.taskId, correctionsImmediatelyAfterReopen: task.stop.correctionAttempts, runId: turn.runId, newReviewerAdmitted: true, business: await acceptance(a) };
  });
  await transition("project-total-off-restores-saved-choices", async () => {
    try {
    await set(b, false);
    await fs.writeFile(cfgPath(a), policy(false, false));
    const disabledA = await get(a), disabledB = await get(b);
    assert.equal(disabledA.effectiveEnabled, false); assert.equal(disabledA.requestedEnabled, true);
    assert.equal(disabledB.effectiveEnabled, false); assert.equal(disabledB.requestedEnabled, false);
    await assert.rejects(set(a, true), /RC_PROJECT_DISABLED/u);
    await paused(a); const count = roles(await state(shared)).length;
    await h.send(a.key, prompt(a, "继续同一文件，在文件头添加 # project-off 并保留排序算法，然后复测。必须实际修改。"), 600000);
    assert.equal(roles(await state(shared)).length, count);
    const business = await acceptance(a);
    await fs.writeFile(cfgPath(a), policy(true, true));
    const enabledA = await get(a), stillOffB = await get(b);
    assert.equal(enabledA.effectiveEnabled, true); assert.equal(stillOffB.effectiveEnabled, false);
    return { disabledA, disabledB, enabledA, stillOffB, projectOffAdmittedNoReviewers: true, business };
    } finally { await fs.writeFile(cfgPath(a), policy(true, true)); }
  });
  await transition("manual-file-off-and-on", async () => {
    assert.equal((await editPreference(a, false)).effectiveEnabled, false);
    await paused(a);
    const before = await state(shared), count = roles(before).length;
    const turn = await h.send(a.key, prompt(a, "继续同一文件，在文件头添加 # manual-off-validation 并保留排序算法，然后复测。必须实际修改。"), 600000);
    assert.equal(roles(await state(shared)).length, count);
    await save("manual-off-terminal.json", turn);
    assert.equal((await editPreference(a, true)).effectiveEnabled, true);
    const on = await h.send(a.key, prompt(a, "继续同一文件，在文件头添加 # manual-on-validation 并保留排序算法，然后复测。必须实际修改。"), 600000);
    const done = await activated(a, count); assert(roles(done.snapshot).length > count);
    assert.equal(done.task.taskId, a.retainedTaskId);
    return { taskId: done.task.taskId, offStartedNoReviewers: true, onStartedNewReviewers: true, runId: on.runId, business: await acceptance(a) };
  });
  await transition("commands-and-restart-preserve-state-without-models", async () => {
    await set(a, false); await paused(a);
    const before = await state(shared), count = roles(before).length;
    const preservedTask = taskFor(before, a);
    const off = await h.send(a.key, "/rc-session off", 30000); assert.equal(JSON.parse(text(off)).effectiveEnabled, false);
    const on = await h.send(a.key, "/rc-session on", 30000); assert.equal(JSON.parse(text(on)).effectiveEnabled, true);
    const beforeA = await get(a), beforeB = await get(b);
    await h.restart();
    const afterA = await get(a), afterB = await get(b), after = await state(shared);
    assert.deepEqual(afterA.identity, beforeA.identity); assert.equal(afterA.effectiveEnabled, true);
    assert.equal(afterB.effectiveEnabled, false); assert.equal(roles(after).length, count);
    const task = after.tasks.find(t => t.taskId === a.retainedTaskId);
    assert.equal(task.stop.correctionAttempts, preservedTask.stop.correctionAttempts);
    assert.equal(task.correctionEpoch.id, preservedTask.correctionEpoch.id);
    return { afterA, afterB, taskId: task.taskId, queryAndRestartStartedNoReviewers: true };
  });
  await transition("host-plugin-total-off", async () => {
    h.config.plugins.entries["runtime-corrector"].config.enabled = false;
    await fs.writeFile(h.configFile, JSON.stringify(h.config, null, 2)); await h.restart();
    const project = await prepare("plugin-disabled", { defaults: true }); project.expected = false;
    assert.equal((await get(project)).reason, "RC_PLUGIN_DISABLED");
    const turn = await h.send(project.key, prompt(project), 600000);
    assert.equal(roles(await state(project.root)).length, 0);
    assert.equal((await state(project.root)).tasks.length, 0);
    h.config.plugins.entries["runtime-corrector"].config.enabled = true;
    await fs.writeFile(h.configFile, JSON.stringify(h.config, null, 2)); await h.restart();
    return { disabledTurn: turn.runId, business: await acceptance(project), restoredReason: (await get(project)).reason };
  });
  report.status = [...report.cases, ...report.transitions].every(item => item.status === "PASS") ? "PASS" : "MIXED";
} catch (error) {
  report.status = "FAIL"; report.error = h?.redact(error.stack) ?? redact(error.stack); await milestone("experiment failed", { error: report.error });
} finally {
  clearInterval(guard);
  if (h) {
    // End only this experiment's Gateways and their own private reviewers.
    await closeHost(); report.gatewayAfterClose = h.health;
    report.hostDefaultWorkspaceUntouched = !(await fs.readdir(h.defaultDir)).includes(".runtime-correction");
  }
  report.originalProfileHashesUnchanged = (await Promise.all(originalFiles.map(async (file, i) => hash(await fs.readFile(file)) === hash(originalBytes[i])))).every(Boolean);
  report.finishedAt = new Date().toISOString(); report.elapsedSeconds = Math.round((Date.now() - started) / 1000);
  await save("report.json", report); await milestone("finished", { status: report.status, cases: report.cases.length, transitions: report.transitions.length, output: destination });
}
process.exitCode = report.status === "PASS" ? 0 : 1;
