import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildPlugin } from "../lib/plugin-builder.mjs";

const execute = promisify(execFile);
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(SOURCE, "examples/python-todolist-transactions");
const SCRIPT = fileURLToPath(import.meta.url);
const SESSION = "python-todo-host", RUN = "python-todo-run";
const requirement = "todo.py must support add, list, rename, complete, reopen and delete; preserve Unicode and file persistence across processes; reject invalid input; deduplicate operation IDs.";
const byteLength = value => Buffer.byteLength(JSON.stringify(value));
async function python(root, args) {
  try { const result = await execute(process.env.PYTHON ?? "python3", args, { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }); return { code: 0, ...result }; }
  catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function modules(pluginRoot) {
  const load = name => import(pathToFileURL(path.join(pluginRoot, "lib", name)));
  const [runtime, store, journal, report, utils, evidence] = await Promise.all([load("openclaw/runtime.mjs"), load("runtime-v2/task-store.mjs"),
    load("runtime-v2/transaction-journal.mjs"), load("openclaw/report.mjs"), load("runtime-v2/utils.mjs"), load("openclaw/evidence.mjs")]);
  return { ...runtime, ...store, ...journal, ...report, ...evidence, readJson: utils.readJson };
}
async function host(root, pluginRoot, fresh = false) {
  const mod = await modules(pluginRoot), warnings = [], reviews = [];
  const factory = async ({ request, schema, role }) => {
    let result;
    if (schema.properties.operations) {
      const source = request.sourceCatalog?.find(item => item.kind === "USER_MESSAGE");
      result = { summary: "Explicit Python Todo requirement", taskClassification: "CONTINUATION", operations:
        request.currentGroundTruth?.version === 0 && source ? [{ operation: "ADD", category: "requirements", text: requirement,
          authority: "USER_EXPLICIT", severity: "HARD", source: { ref: source.ref, subject: "MAIN_TASK", kind: "USER_MESSAGE" } }] : [] };
    } else if (schema.properties.stopClassification) {
      const tested = await python(root, ["-m", "unittest", "-v", "test_todo.py"]);
      const evidence = tested.stdout + tested.stderr;
      const claims = (await mod.readJson(request.groundTruthPath)).claims;
      result = { summary: tested.code === 0 ? "Nine real Python CLI tests passed." : "Real Python tests failed: completed flag did not become true.",
        stopClassification: tested.code === 0 ? "TASK_COMPLETE" : "INTERMEDIATE",
        metricObjectJudgements: Object.values(request.population?.metrics ?? {}).flat().map(item => ({ objectId: item.objectId,
          judgement: tested.code === 0 ? "PASS" : "DEVIATION", reason: tested.code === 0 ? "Current Python CLI suite passed." : "Completion test failed on current source.",
          evidence: [evidence.slice(-1800)] })), findings: tested.code === 0 ? [] : [{ deviationKey: "todo-complete", rootCauseId: "OTHER", severity: "blocker",
          reason: "The complete command leaves completed false.", actualEvidence: [evidence.slice(-1800)], expectedConstraint: requirement,
          violatedGroundTruthIds: claims.map(claim => claim.claimId) }] };
      await fs.mkdir(path.join(root, "evidence"), { recursive: true });
      await fs.writeFile(path.join(root, "evidence", `python-tests-${reviews.length}.txt`), evidence);
      reviews.push({ role, code: tested.code, output: evidence });
    } else throw new Error(`Unexpected checker schema for ${role}`);
    return { result, sessionId: "local-checker", requestDirectory: root, close: async () => {} };
  };
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  const api = { id: "runtime-corrector", config: {}, pluginConfig: { hookTimeoutMs: 10000 }, logger: { warn: text => warnings.push(text), error: text => warnings.push(text) },
    runtime: { agent: { resolveAgentWorkspaceDir: () => root, runEmbeddedAgent: () => assert.fail("No model/network runner is allowed in this experiment") } } };
  const runtime = mod.createOpenClawRuntime(api, { pluginRoot, reviewerFactory: factory });
  const params = { sessionId: SESSION, sessionKey: "agent:main:python-todo", runId: RUN, agentId: "main", workspaceDir: root,
    sessionFile: path.join(root, "native.jsonl"), provider: "local-test", modelId: "local-test", prompt: requirement };
  const state = await runtime.beginSupervised(params, new AbortController().signal, { continuation: !fresh, deadlineAt: Date.now() + 300000 });
  state.onTaskState = async task => {
    if (task.control?.generation === "python-todo-owner") return;
    await mod.withTaskState({ projectRoot: root, taskId: task.taskId }, current => { current.control = { ...current.control, generation: "python-todo-owner", cancelEpoch: current.control?.cancelEpoch ?? 0 }; });
  };
  const lease = runtime.bindWorker("python-todo-worker", state);
  const ctx = { ...params, sessionId: "python-todo-worker", trigger: "user" };
  const task = () => mod.findTask({ projectRoot: root, sessionId: SESSION });
  const tool = async (spec, duplicate = false) => {
    const toolName = spec.action === "write" ? "write" : "exec";
    const args = spec.action === "write" ? { path: "todo.py" } : { command: ["python3", "todo.py", ...spec.args].join(" ") };
    const before = { toolName, toolCallId: spec.id, params: args };
    await runtime.beforeTool(before, ctx);
    if (duplicate) {
      const version = (await task()).journalSequence;
      await runtime.beforeTool(before, ctx);
      assert.equal((await task()).journalSequence, version, "duplicate pre hook must not commit again");
    }
    let result;
    if (spec.action === "write") {
      const source = await fs.readFile(path.join(EXAMPLE, "todo.py"), "utf8");
      await fs.writeFile(path.join(root, "todo.py"), spec.bug ? source.replace('item["completed"] = True', 'item["completed"] = False') : source);
      result = { code: 0, stdout: "todo.py written", stderr: "" };
    } else result = await python(root, ["todo.py", "--store", "data/todos.json", "--operation-id", spec.id, ...spec.args]);
    assert.equal(result.code, spec.expected ?? 0, result.stderr);
    const event = { toolName, toolCallId: spec.id, args, isError: result.code !== 0,
      result: { content: [{ type: "text", text: result.stdout + result.stderr }], isError: result.code !== 0 } };
    const forwarded = await runtime.toolResult(event, { runtime: "openclaw" });
    if (forwarded) assert.equal(forwarded.result.content[0].text, event.result.content[0].text, "tool output must survive the middleware");
    if (duplicate) {
      const version = (await task()).journalSequence;
      assert.deepEqual(await runtime.toolResult(event, { runtime: "openclaw" }), forwarded);
      assert.equal((await task()).journalSequence, version, "duplicate post hook must not commit again");
    }
    assert.equal(warnings.length, 0, warnings.join("\n"));
    return { ...result, value: spec.action === "write" || result.code ? null : JSON.parse(result.stdout) };
  };
  const assess = async assessmentId => {
    const ledger = mod.createEvidenceLedger(root);
    const targets = new Set([...await runtime.evidenceFiles(state), path.join(root, "test_todo.py")]);
    if (await fs.stat(path.join(root, "data/todos.json")).catch(() => null)) targets.add(path.join(root, "data/todos.json"));
    await ledger.capture([...targets]);
    return runtime.assessSupervised(state, { assessmentId, text: "Task completed.", stopHookActive: false,
      assessmentContext: { evidence: ledger.snapshot, evidenceMatches: ledger.matches } });
  };
  return { mod, runtime, state, lease, task, tool, assess, warnings, reviews, params };
}
async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result.push({ name: path.relative(root, file).replaceAll(path.sep, "/"), bytes: (await fs.stat(file)).size });
    }
  }
  await visit(root); return result;
}
async function crashWorker(root, pluginRoot, phase, spec) {
  const h = await host(root, pluginRoot), Journal = h.mod.FileTransactionJournal;
  const kill = async point => { if (point === phase) {
    await new Promise(resolve => process.stdout.write(`CRASH:${point}\n`, resolve)); process.kill(process.pid, "SIGKILL");
  } };
  if (phase === "output-partial") {
    const writeFile = fs.writeFile;
    fs.writeFile = async (file, ...args) => {
      const result = await writeFile(file, ...args);
      if (String(file).includes(`${path.sep}runs${path.sep}`) && String(file).endsWith(`${path.sep}diagnostic.md`)) await kill(phase);
      return result;
    };
  }
  const publish = Journal.prototype.publish;
  Journal.prototype.publish = async function (loaded, state, effects, options) {
    if (options?.operationId === `${RUN}:${spec.id}:${phase === "commit-written" ? "pre" : "post"}`) this.fault = kill;
    return publish.call(this, loaded, state, effects, options);
  };
  const compact = Journal.prototype.compact;
  Journal.prototype.compact = async function (loaded) {
    if (phase === "checkpoint-published" && loaded.state.assessments?.[`${RUN}:${spec.id}:post`]) {
      this.options.checkpointEvery = 1; this.fault = kill;
    }
    return compact.call(this, loaded);
  };
  await h.tool(spec);
  throw new Error(`Crash point ${phase} was not reached`);
}
async function killAt(root, pluginRoot, phase, spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "--crash-worker", root, pluginRoot, phase, JSON.stringify(spec)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => { try { assert.equal(signal, "SIGKILL", stderr); assert.match(stdout, new RegExp(`CRASH:${phase}`)); resolve({ phase, signal }); } catch (error) { reject(error); } });
  });
}
export async function runTodoScenario({ rounds = 72, output = null, keep = false } = {}) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "rc-python-todo-e2e-")), root = path.join(sandbox, "app");
  const start = performance.now();
  try {
    const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: SOURCE, outputRoot: path.join(sandbox, "plugin") });
    await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
    await fs.copyFile(path.join(EXAMPLE, ".runtime-corrector/config.yaml"), path.join(root, ".runtime-corrector/config.yaml"));
    await fs.copyFile(path.join(EXAMPLE, "test_todo.py"), path.join(root, "test_todo.py"));
    let h = await host(root, pluginRoot, true);
    await h.tool({ id: "write-broken", action: "write", bug: true });
    const broken = await h.assess("python-broken");
    assert.equal(broken.decision, "block", JSON.stringify(broken));
    assert.equal(h.reviews[0].code, 1); assert.match(h.reviews[0].output, /FAIL: test_complete_and_reopen/);
    await h.tool({ id: "write-fixed", action: "write" }, true);
    const repaired = await h.assess("python-fixed");
    assert.equal(repaired.decision, "allow", JSON.stringify(repaired));
    assert.equal(h.reviews.at(-1).code, 0);
    const directory = h.mod.taskDirectory(root, (await h.task()).taskId), journal = new h.mod.FileTransactionJournal(directory);
    const ordinary = [], legacy = [], expectedItems = new Map();
    for (let i = 0; i < rounds; i++) {
      const id = `journey-${i}`, kind = i % 4;
      const latest = [...expectedItems.keys()].at(-1);
      const args = kind === 0 ? ["add", `任务 ${i} 🥛`] : kind === 1 ? ["rename", String(latest), `更新 ${i}`]
        : kind === 2 ? ["complete", String(latest)] : ["delete", String(latest)];
      const result = await h.tool({ id, args }, true);
      if (kind === 3) expectedItems.delete(result.value.id); else expectedItems.set(result.value.id, result.value);
      const state = await h.task();
      const record = await journal.readRecord(state.decisionSequence);
      ordinary.push(byteLength(record) + 1);
      const effects = await journal.effects(state.decisionSequence);
      legacy.push(Buffer.byteLength(JSON.stringify({ commitId: record.commitId, assessmentId: record.operationId,
        files: { "task.json": JSON.stringify(state) }, events: effects.events ?? [], outputs: effects.outputs ?? [] }, null, 2)));

      assert.deepEqual(JSON.parse((await python(root, ["todo.py", "--store", "data/todos.json", "list"])).stdout), [...expectedItems.values()]);
    }
    const storePath = path.join(root, "data/todos.json"), unchanged = await fs.readFile(storePath, "utf8");
    await h.tool({ id: "reject-empty", args: ["add", "   "], expected: 1 }, true);
    await h.tool({ id: "reject-missing", args: ["delete", "999999"], expected: 1 }, true);
    assert.equal(await fs.readFile(storePath, "utf8"), unchanged);
    const beforeCrash = await journal.load(), recoveryStart = performance.now();
    await fs.rm(path.join(directory, "task.json"));
    assert.deepEqual((await journal.load()).state, beforeCrash.state);
    await h.mod.withTaskState({ projectRoot: root, taskId: beforeCrash.state.taskId }, () => {});
    const recoveryMs = performance.now() - recoveryStart;
    h.lease.close();
    const crashes = [];
    for (const phase of ["commit-written", "published", "projected", "output-partial", "checkpoint-published"]) {
      const spec = { id: `crash-${phase}`, action: phase === "commit-written" || phase === "published" ? undefined : "write",
        args: ["add", `恢复 ${phase}`] };
      const receiptsBefore = Object.keys(JSON.parse(await fs.readFile(path.join(root, "data/todos.json"), "utf8")).receipts).length;
      crashes.push(await killAt(root, pluginRoot, phase, spec));
      h = await host(root, pluginRoot);
      const pending = await h.task();
      if (["published", "projected", "output-partial"].includes(phase)) {
        assert.equal(pending.projectionPending, true);
        await h.mod.readReport({ workspaceDir: root, sessionId: SESSION });
      }
      const committed = pending.decisionSequence != null ? await journal.effects(pending.decisionSequence) : null;
      if (phase === "output-partial") {
        const roundId = committed.outputs[0].result.metadata.roundId;
        const partialFiles = (await files(path.join(root, ".runtime-correction/runs"))).filter(file => file.name.includes(roundId));
        assert.deepEqual(partialFiles.map(file => path.basename(file.name)), ["diagnostic.md"]);
      }
      await h.tool(spec, true);
      if (phase === "output-partial") {
        const roundId = committed.outputs[0].result.metadata.roundId;
        const completed = (await files(path.join(root, ".runtime-correction/runs"))).filter(file => file.name.includes(roundId));
        assert(completed.some(file => file.name.endsWith("result.json")));
        assert.equal(new Set(completed.map(file => path.dirname(file.name))).size, 1, "output retry must reuse the original round");
      }
      const after = await h.task(); assert.equal(after.projectionPending, false);
      const app = JSON.parse(await fs.readFile(path.join(root, "data/todos.json"), "utf8"));
      assert.equal(Object.keys(app.receipts).length, receiptsBefore + (spec.action === "write" ? 0 : 1));
      const records = [];
      for (let seq = 1; seq <= (await journal.head()).sequence; seq++) { const record = await journal.readRecord(seq); if (record.operationId === `${RUN}:${spec.id}:post`) records.push(record); }
      assert.equal(records.length, 1); // committed events/outputs, including retries, have one logical owner
      crashes.at(-1).outputReferences = records[0].effects.outputs?.length ?? 0;
      h.lease.close();
    }
    const head = await journal.head();
    await fs.writeFile(journal.file("log", `${String(head.sequence + 1).padStart(12, "0")}.json`), '{"changes":');
    h = await host(root, pluginRoot);
    await h.tool({ id: "tail-recovery", args: ["list"] }, true);
    const final = await h.assess("python-final");
    assert.equal(final.decision, "allow", JSON.stringify(final));
    const verified = await h.mod.readReport({ workspaceDir: root, sessionId: SESSION });
    assert.equal(verified.verification, "PASS", JSON.stringify({ status: verified.status, guard: verified.guard, evidenceCurrent: verified.evidenceCurrent }));
    const state = await h.task(), contents = (await fs.readFile(path.join(directory, "journal/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const ids = contents.map(event => event.eventId).filter(Boolean); assert.equal(new Set(ids).size, ids.length);
    const inventory = await files(directory), allRuntimeFiles = await files(path.join(root, ".runtime-correction")), deltaFiles = inventory.filter(file => /^transactions\/(log\/|audit\/\d+-\d+\.jsonl)/.test(file.name));
    assert(Math.max(...ordinary) < Math.min(...ordinary) * 1.5, `ordinary commit sizes grew: ${JSON.stringify(ordinary)}`);
    assert(inventory.filter(file => file.name.startsWith("transactions/checkpoints/")).length <= 2);
    const report = { generatedAt: new Date().toISOString(), environment: { node: process.version, python: (await python(root, ["--version"])).stdout.trim(), platform: process.platform },
      scope: "Real Python subprocesses, real JSON files, compiled OpenClaw plugin runtime beforeTool/toolResult and terminal assessment; deterministic local checker runs Python tests; no real model service or running OpenClaw server.",
      pythonTests: 9, defectDetected: true, repairedDecision: repaired.decision, finalDecision: final.decision, verification: verified.verification,
      appOperations: rounds + 2, rejectedToolOperations: 2, duplicateHookRequestsAtLeast: rounds * 2, assessmentCount: Object.keys(state.assessments).length,
      reconstructedOldPostHookBytes: legacy.reduce((a, b) => a + b, 0), reconstructedOldPostHookFirst: legacy[0], reconstructedOldPostHookLast: legacy.at(-1),
      newPostHookBytes: ordinary.reduce((a, b) => a + b, 0), ordinaryFirstBytes: ordinary[0], ordinaryLastBytes: ordinary.at(-1), ordinaryMinBytes: Math.min(...ordinary), ordinaryMaxBytes: Math.max(...ordinary),
      runtimeFileCount: allRuntimeFiles.length, runtimeTotalBytes: allRuntimeFiles.reduce((sum, file) => sum + file.bytes, 0),
      retainedFileCount: inventory.length, retainedTotalBytes: inventory.reduce((sum, file) => sum + file.bytes, 0), retainedDeltaBytes: deltaFiles.reduce((sum, file) => sum + file.bytes, 0),
      checkpointCount: inventory.filter(file => file.name.startsWith("transactions/checkpoints/")).length, currentStateBytes: byteLength(state),
      deletedProjectionRecoveryMs: recoveryMs, crashes, tornUnpublishedTailRecovered: true, duplicateEventIds: 0, warnings: h.warnings,
      elapsedMs: performance.now() - start, ...(keep ? { testDirectory: sandbox } : {}) };
    h.lease.close();
    if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
    return report;
  } finally { if (!keep) await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 3 }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === "--crash-worker") await crashWorker(process.argv[3], process.argv[4], process.argv[5], JSON.parse(process.argv[6]));
else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputIndex = process.argv.indexOf("--output");
  console.log(JSON.stringify(await runTodoScenario({ output: outputIndex < 0 ? null : path.resolve(process.argv[outputIndex + 1]), keep: process.argv.includes("--keep") }), null, 2));
}
