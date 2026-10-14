// Opt-in live acceptance. Uses a NEW profile, the real Gateway/model/reviewers,
// and real Python commands. Never imports a replacement reviewer or checker.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "../../lib/plugin-builder.mjs";
import { FileTransactionJournal } from "../../lib/runtime-v2/transaction-journal.mjs";
import { readReport } from "../../lib/openclaw/report.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--resume"), "Usage: openclaw-python-todolist.mjs [--resume previous-test-root]");
const resume = args[0] === "--resume" ? path.resolve(args[1]) : null;
const host = process.env.RC_TODO_HOST ?? "/opt/homebrew/lib/node_modules/openclaw";
const hostVersion = JSON.parse(await fs.readFile(path.join(host, "package.json"))).version;
assert.equal(hostVersion, "2026.7.1-2");
const source = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw/openclaw.json")));
const selected = { ...process.env };
for (const line of (await fs.readFile(process.env.RC_TODO_ENV_FILE ?? path.join(os.homedir(), ".openclaw/.env"), "utf8")).split(/\r?\n/u)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
  if (match) selected[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/u, "$2");
}
const expand = value => typeof value === "string" ? value.replace(/\$\{([^}]+)\}/gu, (_, key) => {
  assert.ok(selected[key], `Missing configured environment variable ${key}`); return selected[key];
}) : value;
function selection(ref) {
  const slash = ref.indexOf("/"), providerId = ref.slice(0, slash), modelId = expand(ref.slice(slash + 1));
  if (providerId === "provided") {
    assert.ok(selected.RC_TODO_API_KEY, "User-provided credential unavailable");
    assert.equal(selected.RC_TODO_BASE_URL, "https://open.bigmodel.cn/api/coding/paas/v4", "Only the explicitly authorized endpoint is accepted");
    return { modelId, providerId, key: selected.RC_TODO_API_KEY,
      provider: { baseUrl: selected.RC_TODO_BASE_URL, api: "openai-completions", authHeader: true, timeoutSeconds: 300 },
      spec: { id: modelId, name: modelId, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  }
  const provider = source.models.providers[providerId];
  assert.ok(provider, "Configured provider missing");
  const spec = provider.models.find(item => expand(item.id) === modelId);
  assert.ok(spec, "Configured model missing");
  const reference = /^\$\{([^}]+)\}$/u.exec(provider.apiKey ?? "");
  assert.ok(reference, "Use a configured environment credential reference");
  const key = selected[reference[1]]; assert.ok(key, "Configured model credential unavailable");
  return { modelId, providerId, spec: { ...spec, id: modelId, name: modelId }, key,
    provider: { baseUrl: expand(provider.baseUrl), api: provider.api, authHeader: provider.authHeader } };
}
const primary = source.agents.defaults.model;
const work = selection(process.env.RC_TODO_WORK_MODEL ?? (typeof primary === "string" ? primary : primary.primary));
const review = selection(process.env.RC_TODO_REVIEW_MODEL ?? source.plugins?.entries?.["runtime-corrector"]?.config?.reviewerModel ??
  (typeof primary === "string" ? primary : primary.primary));
const root = resume ?? await fs.mkdtemp(path.join(os.tmpdir(), "rc-openclaw-todo-live-"));
const previous = resume ? JSON.parse(await fs.readFile(path.join(root, "report.json"))) : null;
if (resume) {
  assert.equal(previous.root, root); assert.equal(previous.gatewayUsed, true);
  assert.equal(previous.originalProfileTouched, false);
  assert.equal(previous.workspace, path.join(root, "workspace"));
  assert.equal(await fs.realpath(root), await fs.realpath(previous.root));
  assert.ok(path.basename(root).startsWith("rc-openclaw-todo-live-"), "Only a prior isolated fixture may be resumed");
}
await fs.chmod(root, 0o700);
const workspace = path.join(root, "workspace"), token = randomUUID(), configPath = path.join(root, "openclaw.json");
const todoPath = path.join(workspace, "todo.py");
const redact = value => [work.key, review.key, token].reduce((text, secret) => text.replaceAll(secret, "<redacted>"), String(value));
const report = { ...previous, hostVersion, branch: "codex/file-transaction-deltas", root, workspace,
  workModel: `${work.providerId}/${work.modelId}`, reviewModel: `${review.providerId}/${review.modelId}`,
  gatewayUsed: true, replacementReviewer: false, originalProfileTouched: false,
  phases: previous?.phases ?? [], checks: previous?.checks ?? {}, passed: false };
delete report.error;
const save = () => fs.writeFile(path.join(root, "report.json"), redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 });
const progress = event => console.log(JSON.stringify({ event, root }));
if (!resume) {
await fs.mkdir(workspace);
await fs.cp(path.join(sourceRoot, "examples/python-todolist-transactions"), workspace, { recursive: true });
// A real defect is placed only in this new disposable app; the model must repair it.
await fs.writeFile(todoPath, (await fs.readFile(todoPath, "utf8")).replace('elif action == "complete":\n            item["completed"] = True',
  'elif action == "complete":\n            item["completed"] = False'));
await fs.writeFile(path.join(workspace, ".runtime-corrector/config.yaml"), `version: 2
artifacts:
  - name: todo-app
    stage: coding
    patterns: [todo.py]
    rules:
      enabled: false
    review:
      enabled: true
      criteria: todo.reviewer.md
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
skillCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 2
  assessmentTimeoutMs: 900000
reviewers:
  defaults:
    session: detached
    timeoutMs: 600000
limits:
  semanticReviewTimeoutMs: 600000
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`);
await fs.writeFile(path.join(workspace, ".runtime-corrector/todo.reviewer.md"),
  "Review the actual todo.py against the user's request. Complete must persist true; reopen false. Preserve atomic JSON storage, all six actions, Unicode, immutable original operation receipts, and rejection without mutation. Cite exact source lines; do not invent test results.\n");
}
const listener = net.createServer();
await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
const port = previous?.port ?? listener.address().port;
await new Promise(resolve => listener.close(resolve));
report.port = port;
const config = { gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: "${RC_TODO_GATEWAY_TOKEN}" } },
  agents: { defaults: { workspace, skipBootstrap: true, timeoutSeconds: 900, sandbox: { mode: "off" },
    model: { primary: `todo-work/${work.modelId}` }, models: {
      [`todo-work/${work.modelId}`]: { params: { extra_body: { thinking: { type: "disabled" } } } },
      [`todo-review/${review.modelId}`]: { params: { extra_body: { thinking: { type: "disabled" } } } },
    } } },
  models: { providers: { "todo-work": { ...work.provider, apiKey: "${RC_TODO_WORK_KEY}", models: [work.spec] },
    "todo-review": { ...review.provider, apiKey: "${RC_TODO_REVIEW_KEY}", models: [review.spec] } } },
  tools: { allow: ["read", "write", "edit", "exec", "process"], exec: { host: "gateway", security: "full", ask: "off" } },
  plugins: { allow: ["runtime-corrector"], entries: { "runtime-corrector": { enabled: true,
    hooks: { allowConversationAccess: true, allowPromptInjection: true },
    config: { reviewerModel: `todo-review/${review.modelId}`, reviewerTimeoutMs: 600000, hookTimeoutMs: 600000 } } } },
  logging: { level: "info", consoleLevel: "error", file: path.join(root, "gateway.jsonl") } };
await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: "1", RC_TODO_WORK_KEY: work.key, RC_TODO_REVIEW_KEY: review.key, RC_TODO_GATEWAY_TOKEN: token };
const cli = path.join(host, "openclaw.mjs");
function command(args, timeout = 60000, executable = process.execPath, cwd = sourceRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += redact(data); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); if (timedOut || code) reject(new Error(`Command failed (${timedOut ? "timeout" : code}): ${output}`)); else resolve(output); });
  });
}
const hostCommand = (args, timeout) => command([cli, ...args], timeout);
const parse = output => { const start = output.indexOf("{"); assert.ok(start >= 0, output); return JSON.parse(output.slice(start)); };
const rpc = async (method, params, timeout = 30000) => parse(await hostCommand([
  "gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", String(timeout),
], timeout + 10000));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let gateway, gatewayOutput = "", stopRequested = false;
async function stop(signal = "SIGTERM") {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode) return;
  gateway.kill(signal);
  await Promise.race([new Promise(resolve => gateway.once("exit", resolve)), pause(10000).then(() => gateway.kill("SIGKILL"))]);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopRequested = true; void stop().then(() => process.exit(130)); });
async function start() {
  gatewayOutput = "";
  gateway = spawn(process.execPath, [cli, "gateway", "run", "--port", String(port), "--bind", "loopback"],
    { env, cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", data => { gatewayOutput += redact(data); });
  gateway.once("error", error => { gatewayOutput += redact(error.message); });
  for (let attempt = 0; attempt < 20; attempt++) {
    try { if ((await rpc("health", {}, 3000)).ok) { progress("GATEWAY_READY"); return; } } catch { /* bounded startup retry */ }
    if (gateway.exitCode !== null || gateway.signalCode) break;
    await pause(1000);
  }
  throw new Error(`Isolated Gateway did not start: ${gatewayOutput}`);
}
async function files(directory) {
  const out = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await files(file)); else if (entry.isFile()) out.push(file);
  }
  return out;
}
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
let taskDir, transcriptPath, sessionId = previous?.sessionId;
const key = "agent:main:file-transaction-todo-live";
async function getTask() {
  if (!taskDir) {
    const candidates = (await files(path.join(workspace, ".runtime-correction/tasks"))).filter(file => file.endsWith("/task.json"));
    for (const file of candidates) if ((await readJson(file)).sessionIds.includes(sessionId)) { taskDir = path.dirname(file); break; }
  }
  return taskDir ? new FileTransactionJournal(taskDir).load() : null; // read-only, NEVER performs recovery on behalf of the host
}
async function reviews() {
  const out = [];
  for (const file of (await files(path.join(workspace, ".runtime-correction/openclaw/native-stop-reviews"))).filter(file => file.endsWith(".json"))) out.push(await readJson(file));
  return out.filter(record => record.sessionId === sessionId);
}
async function send(message, name, { crash = false } = {}) {
  progress(`MODEL_PHASE_${name}`);
  const sent = await rpc("chat.send", { sessionKey: key, message, idempotencyKey: randomUUID() });
  const phase = { name, runId: sent.runId, startedAt: new Date().toISOString() }; report.phases.push(phase); await save();
  let finished = false;
  const deadline = Date.now() + 1200000;
  while (Date.now() < deadline && !stopRequested) {
    if (gateway.signalCode || gateway.exitCode !== null) {
      if (crash) { phase.crashed = true; await save(); return phase; }
      throw new Error(`Gateway exited in ${name}: ${gatewayOutput.slice(-3000)}`);
    }
    if (!finished) {
      try { const completion = await rpc("agent.wait", { runId: sent.runId, timeoutMs: 1000 }, 5000);
        if (completion.status !== "timeout") { phase.completion = completion; finished = true; assert.equal(completion.status, "ok", JSON.stringify(completion)); }
      } catch (error) {
        if (!crash) throw error;
        // The socket can close a few milliseconds before the child exit event.
        await pause(200);
        if (!gateway.signalCode && gateway.exitCode === null) throw error;
      }
    }
    const receipts = await reviews();
    const receipt = receipts.find(record => record.runId === sent.runId);
    const loaded = await getTask();
    if (finished && receipt?.status === "SETTLED") {
      phase.receipt = receipt; phase.verification = loaded?.state.verification; phase.finishedAt = new Date().toISOString();
      phase.assessments = Object.keys(loaded?.state.assessments ?? {}).length;
      await save(); progress(`PHASE_SETTLED_${name}_${receipt.reviewStatus}`); return phase;
    }
    await pause(1500);
  }
  throw new Error(`Timed out waiting for real model and terminal review (${name})`);
}

async function records(loaded = null) {
  loaded ??= await getTask();
  const journal = new FileTransactionJournal(taskDir), out = [];
  for (let sequence = 1; sequence <= loaded.head.sequence; sequence++) out.push(await journal.readRecord(sequence));
  return out;
}
async function faultPhase({ name, point, match, outputs = false, action, artifact = false, evaluation = false }) {
  if (report.checks[name]) return;
  const before = await getTask(), priorOps = (await records(before)).map(record => record.operationId).filter(Boolean);
  const operation = `live-${name}`, title = `恢复验证 ${name}`;
  const invocation = `python3 todo.py --store data/recovery.json --operation-id ${operation} add '${title}'`;
  const saved = report.phases.findLast(phase => phase.name === name && phase.boundary);
  let stopped, marker, killed, recovery;
  if (saved) {
    // Resume an interrupted acceptance driver without repeating a model request
    // or overwriting the already recorded crash boundary.
    stopped = saved; recovery = saved.boundary;
    marker = await readJson(path.join(root, `fault-${name}.json`));
    killed = await getTask();
    await fs.rm(path.join(root, "fault-arm.json"), { force: true });
  } else {
  await fs.writeFile(path.join(root, "fault-arm.json"), JSON.stringify({ name, point, match, outputs, evaluation }));
  const artifactMarker = `# ${name} attempt ${report.phases.filter(phase => phase.name === name).length + 1}`;
  const instruction = artifact
    ? `先读取 todo.py，再通过 edit 工具在文件末尾追加一行新的、无语义影响的注释 ${artifactMarker}，触发真实产物审阅；即使有之前的测试标记，也追加本次这行。不要改变业务逻辑。然后通过 exec 执行命令 ${invocation}，再执行 python3 todo.py --store data/recovery.json list。不要改测试、配置或 .runtime-correction。`
    : `请只通过 exec 在当前工作区执行命令 ${invocation}，然后执行 python3 todo.py --store data/recovery.json list。不要修改任何源码、测试、配置或 .runtime-correction。`;
  stopped = await send(`继续当前任务，保持 TodoList 的现有全部需求和功能，不建立新任务。${instruction}实际执行成功后回复“本轮添加已完成并验证”。`, name, { crash: true });
  assert.equal(stopped.crashed, true, "The real host must reach the armed durability boundary");
  marker = await readJson(path.join(root, `fault-${name}.json`));
  assert.equal(marker.point, point); assert.equal(marker.pid, gateway.pid);
  assert.ok(marker.record, "A real host transaction must reach the seam");
  if (outputs) assert.ok(marker.record.effects.outputs?.length > 0, "Output recovery must use a real review outbox");
  killed = await getTask();
  const published = point !== "commit-written";
  assert.equal(marker.head.sequence, marker.record.sequence - (published ? 0 : 1));
  recovery = { name, point, killedPid: marker.pid, operationId: marker.record.operationId,
    stoppedSequence: killed.head.sequence, commitSequence: marker.record.sequence, published,
    outputReferences: marker.record.effects.outputs?.length ?? 0 };
  stopped.boundary = recovery;
  if (published) {
    assert.equal((await records(killed)).filter(record => record.commitId === marker.record.commitId).length, 1);
    if (["published", "output-partial"].includes(point)) {
      assert.equal(killed.state.projectionPending, true);
      const effects = await new FileTransactionJournal(taskDir).effects(marker.record.sequence);
      recovery.rounds = (effects.outputs ?? []).map(output => output.result.metadata.roundId);
      recovery.evaluationFiles = Object.keys(effects.files ?? {}).filter(file => file.startsWith("evaluations/"));
      recovery.evaluationHashes = Object.fromEntries(recovery.evaluationFiles.map(file => [file,
        createHash("sha256").update(effects.files[file]).digest("hex")]));
      if (match === ":stop") {
        assert.ok(recovery.evaluationFiles.length > 0);
        const pendingReport = await readReport({ workspaceDir: workspace, sessionId, sessionKey: key });
        const evaluation = JSON.parse(effects.files[recovery.evaluationFiles[0]]);
        assert.deepEqual(pendingReport.assessment, evaluation,
          "A published native review remains exactly readable before projection, including an UNVERIFIED verdict");
        recovery.publishedReviewStatus = killed.state.verification.status;
        recovery.publishedReportStatus = pendingReport.verification;
      }
    }
  } else {
    assert.equal(killed.head.stateHash, marker.head.stateHash);
    assert.ok(!(await records(killed)).some(record => record.commitId === marker.record.commitId));
  }
  if (point === "checkpoint-published") {
    assert.equal(killed.head.checkpoint, marker.head.sequence);
    recovery.recoveryFilesBeforeCleanup = (await files(path.join(taskDir, "transactions/log"))).length;
    assert.ok(recovery.recoveryFilesBeforeCleanup > 0, "Crash must precede reclamation");
  }
  if (point === "output-partial") {
    const contents = await fs.readdir(path.dirname(marker.outputFile));
    assert.deepEqual(contents, ["diagnostic.md"], "Only the first report file exists at the interruption");
    recovery.partialReport = marker.outputFile;
  }
  // A published POST means the native exec already changed the Python store.
  if (action === "post") {
    const app = await readJson(path.join(workspace, "data/recovery.json"));
    assert.ok(app.receipts[operation]); recovery.businessCommandAlreadyExecuted = true;
  }
  await save(); progress(`FAULT_CONFIRMED_${name}`);
  await start();
  }
  const startedAt = Date.now();
  const restarted = await send(`上轮隔离 Gateway 在持久化边界被中断。继续使用相同 TodoList；请通过 exec 重新执行同一业务命令 ${invocation}，然后执行 python3 todo.py --store data/recovery.json list 与 python3 -m unittest -v test_todo.py。operation-id 必须保持 ${operation}；不要改代码、配置或报告文件。检查测试通过，回复“已恢复并验证”。`, `RECOVER_${name}`);
  recovery.modelAndReviewRecoveryMs = Date.now() - startedAt;
  assert.equal(restarted.receipt.reviewStatus, "PASS", JSON.stringify(restarted.receipt));
  const after = await getTask(), afterRecords = await records(after), afterOps = afterRecords.map(record => record.operationId).filter(Boolean);
  for (const op of priorOps) assert.equal(afterOps.filter(item => item === op).length, 1, "No prior logical decision is duplicated");
  assert.equal(new Set(afterOps).size, afterOps.length, "All committed operation IDs are unique");
  assert.equal(afterRecords.filter(record => record.commitId === marker.record.commitId).length, recovery.published ? 1 : 0);
  assert.equal(after.state.projectionPending, false);
  const app = await readJson(path.join(workspace, "data/recovery.json"));
  assert.equal(app.items.filter(item => item.title === title).length, 1);
  assert.ok(app.receipts[operation]);
  if (recovery.partialReport) {
    assert.ok((await fs.readdir(path.dirname(recovery.partialReport))).includes("result.json"));
    assert.equal((await readJson(path.join(path.dirname(recovery.partialReport), "result.json"))).metadata.roundId,
      path.basename(path.dirname(recovery.partialReport)));
  }
  for (const round of recovery.rounds ?? []) {
    const matches = (await files(path.join(workspace, ".runtime-correction/runs"))).filter(file => path.basename(path.dirname(file)) === round && path.basename(file) === "result.json");
    assert.equal(matches.length, 1, "Original output round is retried, never regenerated");
  }
  for (const [file, expected] of Object.entries(recovery.evaluationHashes ?? {})) {
    assert.equal(createHash("sha256").update(await fs.readFile(path.join(taskDir, file))).digest("hex"), expected,
      "Recovery projects the original committed evaluation without calling the model again for that operation");
  }
  assert.ok((await files(path.join(taskDir, "transactions/checkpoints"))).length <= 2);
  recovery.authoritativeAssessmentsPreserved = Object.keys(killed.state.assessments ?? {}).every(id => after.state.assessments[id]);
  assert.equal(recovery.authoritativeAssessmentsPreserved, true);
  recovery.duplicateBusinessItems = 0; recovery.duplicateLogicalOperations = 0;
  report.checks[name] = true; await save();
}

// Only the GENERATED test plugin gets these observers. They use the existing
// journal fault seam, record writes, and SIGKILL their own Gateway at an exact
// durable boundary. No review verdict, state or commit data is synthesized.
async function instrument(pluginRoot) {
  const fixture = path.join(pluginRoot, "lib/runtime-v2/todo-live-fixture.mjs");
  await fs.writeFile(fixture, `import fs from "node:fs/promises"; import path from "node:path";
const root = ${JSON.stringify(root)};
export async function todoLiveFault(point, journal, extra = {}) {
  const head = await fs.readFile(journal.file("head.json"), "utf8").then(JSON.parse).catch(() => null);
  let record = null;
  if (head) record = await fs.readFile(journal.file("log", String(head.sequence + (point === "commit-written" ? 1 : 0)).padStart(12, "0") + ".json"), "utf8").then(JSON.parse).catch(() => null);
  if (point === "projected") await fs.appendFile(path.join(root, "state-io.jsonl"), JSON.stringify({ sequence: head?.sequence, bytes: (await fs.stat(path.join(journal.directory, "task.json"))).size }) + "\\n");
  const arm = await fs.readFile(path.join(root, "fault-arm.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!arm || arm.point !== point || !new RegExp(arm.match).test(record?.operationId ?? "") || (arm.outputs && !record?.effects?.outputs?.length)) return;
  if (arm.evaluation && !record?.effects?.fileNames?.some(name => name.startsWith("evaluations/"))) return;
  const marker = path.join(root, "fault-" + arm.name + ".json");
  const handle = await fs.open(marker, "wx").catch(error => { if (error.code === "EEXIST") return null; throw error; });
  if (!handle) return;
  await handle.writeFile(JSON.stringify({ point, pid: process.pid, taskDir: journal.directory, head, record, ...extra })); await handle.sync(); await handle.close();
  await fs.rm(path.join(root, "fault-arm.json"));
  process.kill(process.pid, "SIGKILL"); await new Promise(() => {});
}
export async function todoLiveOutput(file, cwd) {
  const names = await fs.readdir(path.join(cwd, ".runtime-correction/tasks"));
  for (const name of names) { const directory = path.join(cwd, ".runtime-correction/tasks", name); await todoLiveFault("output-partial", { directory, file: (...parts) => path.join(directory, "transactions", ...parts) }, { outputFile: file }); }
}
`);
  const journalFile = path.join(pluginRoot, "lib/runtime-v2/transaction-journal.mjs");
  let journal = await fs.readFile(journalFile, "utf8");
  assert.ok(journal.includes("this.fault = fault;"));
  journal = 'import { todoLiveFault } from "./todo-live-fixture.mjs";\n' + journal.replace("this.fault = fault;", "this.fault = async point => { await fault(point); await todoLiveFault(point, this); };\n    this.options.checkpointEvery = 4;");
  await fs.writeFile(journalFile, journal);
  const resultFile = path.join(pluginRoot, "lib/result-store.mjs");
  let result = await fs.readFile(resultFile, "utf8");
  const line = 'await fs.writeFile(roundDiagnosticPath, diagnosticMarkdown, "utf8");';
  assert.ok(result.includes(line));
  result = 'import { todoLiveOutput } from "./runtime-v2/todo-live-fixture.mjs";\n' + result.replace(line, `${line}\n  await todoLiveOutput(roundDiagnosticPath, cwd);`);
  await fs.writeFile(resultFile, result);
  report.testInstrumentation = { generatedPluginOnly: true, checkpointEvery: 4,
    alteredAlgorithms: false, seams: ["existing journal fault callback", "after first report file"],
    generatedJournalSha256: createHash("sha256").update(journal).digest("hex") };
}

try {
  if (!resume) {
    const plugin = await buildPlugin({ host: "openclaw", sourceRoot, outputRoot: path.join(root, "build") });
    await instrument(plugin);
    await hostCommand(["plugins", "install", "--force", plugin], 120000);
  }
  report.pluginVersion = (await readJson(path.join(root, "extensions/runtime-corrector/openclaw.plugin.json"))).version;
  await save(); progress("ISOLATED_PLUGIN_INSTALLED");
  await start();
  const created = resume ? { sessionId } : await rpc("sessions.create", { key, model: `todo-work/${work.modelId}`, label: "Python Todo real-model transaction acceptance", emitCommandHooks: false });
  sessionId = created.sessionId; report.sessionId = sessionId;
  transcriptPath = created.entry?.sessionFile ?? path.join(root, "agents/main/sessions", `${sessionId}.jsonl`);
  if (!report.checks.realModelRepairedBugAndReviewed) {
  const initial = await send("请修复并交付当前工作区的 Python 文件型 TodoList。要求 add/list/rename/complete/reopen/delete 正确，complete 后重启程序仍为 true，reopen 为 false；保留 Unicode、原子存储和 operation-id 去重及原回执；无效输入不得改文件。代码预置过一个小缺陷，若之前的执行已修好则直接复验。先读 todo.py 与 test_todo.py，必要时修改 todo.py，实际执行 python3 -m unittest -v test_todo.py。再用 exec 在 data/live-validation.json 上执行 add 买牛奶、rename、complete、reopen、delete、list 的真实命令，每次修改指定稳定 operation-id。宿主 shell 为 zsh，请使用完整的 python3 命令调用，每条命令展开完整参数；可沿用相同操作回执继续。不要改测试、插件配置或 .runtime-correction。全部完成后明确说明已修复并验证。", "REPAIR_AND_CRUD");
  assert.equal(initial.receipt.reviewStatus, "PASS", JSON.stringify(initial.receipt));
  assert.equal(initial.verification?.status, "PASS");
  report.checks.realModelRepairedBugAndReviewed = true;
  }
  assert.equal(await fs.readFile(path.join(workspace, "test_todo.py"), "utf8"),
    await fs.readFile(path.join(sourceRoot, "examples/python-todolist-transactions/test_todo.py"), "utf8"), "The model must not weaken the tests");
  const python = await command(["-m", "unittest", "-v", "test_todo.py"], 30000, "python3", workspace);
  await fs.writeFile(path.join(root, "python-final.txt"), python);
  assert.match(python, /Ran 9 tests/u); report.checks.pythonNineTests = true;
  await save();
  await faultPhase({ name: "COMMIT_NOT_PUBLISHED", point: "commit-written", match: ":pre$" });
  await faultPhase({ name: "POST_PUBLISHED_BEFORE_PROJECTION", point: "published", match: ":post$", action: "post" });
  await faultPhase({ name: "STOP_PUBLISHED_BEFORE_EVALUATION", point: "published", match: ":stop", evaluation: true });
  await faultPhase({ name: "OUTPUT_PARTIAL", point: "output-partial", match: ":post$", outputs: true, artifact: true });
  await faultPhase({ name: "CHECKPOINT_PUBLISHED_BEFORE_CLEANUP", point: "checkpoint-published", match: ".*" });
  if (!report.checks.tornUnpublishedTail) {
    const before = await getTask();
    await fs.writeFile(path.join(taskDir, "transactions/log", `${String(before.head.sequence + 1).padStart(12, "0")}.json`), '{"incomplete":');
    await fs.appendFile(path.join(taskDir, "journal/events.jsonl"), '{"incomplete":');
    const tail = await send("最终检查：请通过 exec 执行 python3 -m unittest -v test_todo.py，并执行 python3 todo.py --store data/recovery.json list。保持源码和配置不变，成功后说明已完成全部验证。", "TORN_TAIL_RECOVERY");
    assert.equal(tail.receipt.reviewStatus, "PASS");
    const events = (await fs.readFile(path.join(taskDir, "journal/events.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    const committed = events.filter(event => event.eventId);
    assert.equal(new Set(committed.map(event => event.eventId)).size, committed.length);
    report.checks.tornUnpublishedTail = true; report.events = { count: events.length, committedWithIds: committed.length, duplicateIds: 0 };
  }
  const final = await getTask(), all = await records(final);
  assert.equal(await fs.readFile(path.join(workspace, "test_todo.py"), "utf8"),
    await fs.readFile(path.join(sourceRoot, "examples/python-todolist-transactions/test_todo.py"), "utf8"));
  report.checks.testSuiteUnchanged = true;
  const noHistory = all.filter(record => /:(?:pre|post)$/u.test(record.operationId ?? ""));
  report.journal = { versions: final.head.sequence, logicalHookDecisions: noHistory.length,
    assessments: Object.keys(final.state.assessments ?? {}).length,
    ordinaryHookBytes: noHistory.map(record => Buffer.byteLength(JSON.stringify(record)) + 1),
    checkpoints: (await files(path.join(taskDir, "transactions/checkpoints"))).length };
  assert.ok(noHistory.length > 10);
  const io = (await fs.readFile(path.join(root, "state-io.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  report.stateProjectionIo = { writes: io.length, bytes: io.reduce((sum, row) => sum + row.bytes, 0),
    fullStateStillWritten: true };
  const retained = await files(path.join(taskDir, "transactions"));
  report.journal.files = retained.length; report.journal.bytes = (await Promise.all(retained.map(file => fs.stat(file)))).reduce((sum, item) => sum + item.size, 0);
  assert.equal(final.state.verification.status, "PASS");
  assert.ok(final.state.verification.evidence?.fingerprints[todoPath], "Restarted native acceptance must fingerprint the actual app source");
  report.publicReport = await readReport({ workspaceDir: workspace, sessionId, sessionKey: key });
  assert.equal(report.publicReport.verification, "PASS", "User-visible acceptance must agree with the native review receipt");
  report.passed = true;
} catch (error) {
  report.error = redact(error.stack ?? error); process.exitCode = 1;
} finally {
  await stop();
  await fs.writeFile(path.join(root, "gateway-console.txt"), gatewayOutput, { mode: 0o600 });
  if (transcriptPath) {
    const entries = (await fs.readFile(transcriptPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse);
    report.native = { messages: entries.filter(entry => entry.type === "message").length,
      modelCalls: entries.filter(entry => entry.message?.role === "assistant" && entry.message?.usage?.totalTokens > 0).length,
      tools: entries.flatMap(entry => Array.isArray(entry.message?.content) ? entry.message.content.filter(block => ["toolCall", "tool_use"].includes(block.type)).map(block => ({ id: block.id, name: block.name })) : []),
      usage: entries.filter(entry => entry.message?.role === "assistant").map(entry => entry.message?.usage).filter(Boolean) };
    const loaded = await getTask(); report.taskId = loaded?.state.taskId; report.verification = loaded?.state.verification;
    report.taskAssessments = loaded?.state.assessments;
  }
  await save(); console.log(JSON.stringify({ passed: report.passed, report: path.join(root, "report.json"), error: report.error }));
}
