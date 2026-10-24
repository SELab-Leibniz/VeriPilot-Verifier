// Real Python files/processes and RC native hooks, with deterministic host and
// reviewer doubles. This is deliberately distinct from a real-model Gateway trial.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildPlugin } from "../../lib/plugin-builder.mjs";
const execute = promisify(execFile), sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const output = process.argv[2]; if (!output) throw new Error("new-output-directory required");
await fs.mkdir(output, { mode: 0o700 }); const root = await fs.realpath(output);
const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot, outputRoot: path.join(root, "plugin") });
const load = name => import(pathToFileURL(path.join(pluginRoot, "lib", name)));
const { createOpenClawRuntime } = await load("openclaw/runtime.mjs"), { findTask } = await load("runtime-v2/task-store.mjs");
const { registerStopWorkOwner } = await load("openclaw/stop-work-owner.mjs");
const source = await fs.readFile(path.join(sourceRoot, "examples/python-todolist-transactions/todo.py"), "utf8");
const tests = await fs.readFile(path.join(sourceRoot, "examples/python-todolist-transactions/test_todo.py"), "utf8");
const broken = source.replace('item["completed"] = True', 'item["completed"] = False'); assert.notEqual(source, broken);
const policy = `version: 2
artifacts:
  - name: app
    stage: proposal
    patterns: [todo.py]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
stopCorrection:
  enabled: true
  assessmentTimeoutMs: 60000
  maxCorrectionsPerEpoch: 2
implementationCorrection:
  enabled: false
reviewers:
  defaults:
    timeoutMs: 20000
`;
const requirement = "Develop todo.py with add, list, rename, complete, reopen and delete. Preserve Unicode and cross-process JSON persistence, reject invalid input and deduplicate operation IDs. All nine frozen Python unittest acceptance tests must pass. Only edit todo.py.";
const cases = [];
for (const version of ["2026.7.1-2", "2026.10.3"]) {
  const arm = path.join(root, version), a = path.join(arm, "A"), b = path.join(arm, "B"), off = path.join(arm, "off");
  for (const directory of [a, b, off]) await fs.mkdir(directory, { recursive: true });
  for (const directory of [a, b]) {
    await fs.mkdir(path.join(directory, ".runtime-corrector")); await fs.writeFile(path.join(directory, ".runtime-corrector/config.yaml"), policy);
    await fs.writeFile(path.join(directory, "test_todo.py"), tests);
  }
  const entries = new Map(), transcripts = new Map(), reviews = [], admissions = [], warnings = [], sharedState = {};
  let runtime, service;
  const api = { id: "runtime-corrector", config: {}, pluginConfig: {}, logger: { warn(value) { warnings.push(value); } },
    registerService(value) { service = value; }, runtime: { version,
      state: { resolveStateDir: () => path.join(arm, "host-state") }, sandbox: { resolveSandboxRuntimeStatus: () => ({ sandboxed: false }) },
      agent: { resolveAgentWorkspaceDir: () => off, session: {
        getSessionEntry: ({ sessionKey }) => entries.get(sessionKey), resolveStorePath: () => path.join(arm, "sessions.json"),
        resolveSessionFilePath: (_id, record) => record.sessionFile, runWithWorkAdmission: async (params, run) => run(params.signal),
      } }, subagent: { run: async args => {
        admissions.push(args);
        const entry = entries.get(args.sessionKey), ctx = entry.ctx, directory = entry.projectRoot;
        const next = { ...ctx, runId: args.idempotencyKey };
        await append(args.sessionKey, "user", args.message, { runId: args.idempotencyKey });
        await runtime.prompt({ prompt: args.message }, next);
        await writeBusiness(directory, args.sessionKey, next, source, "repair");
        const checked = await python(directory); assert.equal(checked.code, 0);
        await append(args.sessionKey, "assistant", "The actual Python suite passed after repair.");
        await runtime.agentEnd({ runId: next.runId, sessionId: next.sessionId, success: true }, next);
        return { runId: args.idempotencyKey };
      } } } };
  const compatibility = async () => ({ loadTranscriptEvents: ({ sessionKey }) => transcripts.get(sessionKey) });
  const owner = registerStopWorkOwner(api, sharedState);
  const lifetime = new AbortController(), timers = new Set();
  if (service) service.start({ scheduler: { version: 1, signal: lifetime.signal, schedule({ run, delayMs }) {
    const timer = setTimeout(() => { timers.delete(timer); void run(); }, delayMs); timers.add(timer);
    return { cancel() { clearTimeout(timer); timers.delete(timer); } };
  } } });
  async function python(directory) {
    // Keep parent and nested acceptance stores in this isolated run. Sandboxed
    // Windows redirects OS temp to a location that nested Python processes may
    // not be allowed to use; no source or test assertions need to change.
    const temporary = path.join(directory, ".runtime-correction", "python-temp");
    await fs.mkdir(temporary, { recursive: true });
    try { return { code: 0, ...await execute(process.env.PYTHON ?? "python3", ["-m", "unittest", "-v", "test_todo.py"], {
      // The unchanged suite launches further CLI processes. Environment flags
      // also reach those children; a parent-only -X flag would not. This makes
      // Unicode IO explicit on Windows without weakening any assertion.
      cwd: directory, timeout: 20000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
        TEMP: temporary, TMP: temporary, TMPDIR: temporary } }) }; }
    catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  async function followupReceipts(directory) {
    const location = path.join(directory, ".runtime-correction/openclaw/native-followups");
    const scopes = await fs.readdir(location).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const result = [];
    for (const scope of scopes) for (const name of await fs.readdir(path.join(location, scope))) {
      if (name.endsWith(".json")) result.push(JSON.parse(await fs.readFile(path.join(location, scope, name), "utf8")));
    }
    return result;
  }
  async function waitForVerified(requested) {
    const deadline = Date.now() + 60000;
    let records = [], last;
    while (Date.now() < deadline) {
      let timer;
      try {
        records = await Promise.race([runtime.waitForNativeReviews(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Offline Stop observer exceeded its unchanged 60-second window.")), Math.max(1, deadline - Date.now()));
        })]);
      } finally { clearTimeout(timer); }
      const tasks = await Promise.all(requested.map(item => findTask({ projectRoot: item.directory, sessionId: item.ctx.sessionId })));
      const receipts = (await Promise.all(requested.map(item => followupReceipts(item.directory)))).flat();
      last = { tasks: tasks.map(task => ({ taskId: task?.taskId, verification: task?.verification?.status })),
        receipts: receipts.map(receipt => ({ status: receipt.status, observed: Boolean(receipt.modelObservedAt), finished: Boolean(receipt.finishedAt), reason: receipt.reason })) };
      if (tasks.every(task => task?.verification?.status === "PASS")
        && receipts.every(receipt => receipt.modelObservedAt && receipt.finishedAt)) return records;
      if (receipts.some(receipt => ["CANCELLED", "REJECTED", "UNVERIFIED"].includes(receipt.status)))
        throw new Error(`Offline corrective continuation failed: ${JSON.stringify(last)}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    throw new Error(`Offline Stop did not finish its corrective review: ${JSON.stringify(last)}`);
  }
  const factory = async ({ request, schema, projectRoot, role }) => {
    let result;
    if (schema.properties.operations) {
      const user = request.sourceCatalog?.find(item => item.kind === "USER_MESSAGE");
      result = { summary: "Explicit Todo acceptance", taskClassification: "CONTINUATION", operations:
        request.currentGroundTruth?.version === 0 && user ? [{ operation: "ADD", category: "requirements", text: requirement,
          authority: "USER_EXPLICIT", severity: "HARD", source: { ref: user.ref, subject: "MAIN_TASK", kind: "USER_MESSAGE" } }] : [] };
    } else {
      const tested = await python(projectRoot), evidence = tested.stdout + tested.stderr;
      reviews.push({ projectRoot, role, code: tested.code, evidence });
      const task = JSON.parse(await fs.readFile(request.groundTruthPath));
      result = { summary: tested.code === 0 ? "All nine Python tests passed" : "Completion leaves completed false",
        stopClassification: "TASK_COMPLETE", metricObjectJudgements: Object.values(request.population?.metrics ?? {}).flat().map(item => ({
          objectId: item.objectId, judgement: tested.code === 0 ? "PASS" : "DEVIATION", reason: "Actual frozen Python acceptance suite",
          evidence: [evidence.slice(-2000)] })), findings: tested.code === 0 ? [] : [{ deviationKey: "todo-complete", rootCauseId: "OTHER", severity: "blocker",
          reason: "complete does not mark the task completed", actualEvidence: [evidence.slice(-2000)], expectedConstraint: requirement,
          violatedGroundTruthIds: task.claims.map(claim => claim.claimId) }] };
    }
    return { result, sessionId: "deterministic-reviewer", close: async () => {} };
  };
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  runtime = createOpenClawRuntime(api, { pluginRoot, nativeHooks: true, sharedState, compatibility, reviewerFactory: factory, stopWorkOwner: owner });
  async function append(key, role, content, extra = {}) {
    const records = transcripts.get(key), record = { type: "message", id: `${records.length}-${key}`, parentId: records.at(-1)?.id ?? null,
      message: { role, content, ...extra } }; records.push(record);
    await fs.writeFile(entries.get(key).sessionFile, records.map(JSON.stringify).join("\n")); return record;
  }
  async function session(name, directory) {
    const sessionId = `session-${name}`, sessionKey = `agent:main:python-${name}`, sessionFile = path.join(arm, `${name}.jsonl`);
    const ctx = { sessionId, sessionKey, agentId: "main", workspaceDir: version === "2026.10.3" ? directory : off, runId: `initial-${name}` };
    entries.set(sessionKey, { sessionId, sessionFile, spawnedCwd: directory, projectRoot: directory, ctx });
    transcripts.set(sessionKey, [{ type: "session", id: sessionId }]);
    await fs.writeFile(sessionFile, transcripts.get(sessionKey).map(JSON.stringify).join("\n"));
    // Both supported hosts expose native project selection through this
    // fixture's persisted spawnedCwd; legacy RC binding is no longer legal.
    const selected = await runtime.projects.resolve({}, ctx);
    assert.equal(selected.enabled, true); assert.equal(selected.projectRoot, directory);
    await append(sessionKey, "user", requirement); await runtime.prompt({ prompt: requirement }, ctx);
    return ctx;
  }
  async function writeBusiness(directory, key, ctx, contents, id) {
    const toolCallId = `${ctx.sessionId}-${id}`;
    await runtime.beforeTool({ toolName: "write", toolCallId, params: { path: path.join(directory, "todo.py") } }, ctx);
    await append(key, "assistant", [{ type: "toolCall", id: toolCallId, name: "write", arguments: { path: path.join(directory, "todo.py"), content: contents } }]);
    await fs.writeFile(path.join(directory, "todo.py"), contents);
    await append(key, "toolResult", [{ type: "text", text: "todo.py written" }], { toolCallId, toolName: "write" });
    await runtime.toolResult({ toolName: "write", toolCallId, args: { path: path.join(directory, "todo.py") },
      result: { content: [{ type: "text", text: "todo.py written" }], isError: false } }, { ...ctx, runtime: "openclaw" });
  }
  try {
    const ca = await session("A", a), cb = await session("B", b);
    await writeBusiness(a, ca.sessionKey, ca, broken, "broken"); await writeBusiness(b, cb.sessionKey, cb, source, "correct");
    const positive = await python(b); assert.equal(positive.code, 0, positive.stderr);
    const failed = await python(a); assert.notEqual(failed.code, 0); assert.match(failed.stderr, /FAIL: test_complete_and_reopen/);
    for (const ctx of [ca, cb]) {
      await append(ctx.sessionKey, "assistant", "Candidate delivered; RC should independently assess it.");
      await runtime.reply({ kind: "final", sessionKey: ctx.sessionKey, runId: ctx.runId, payload: { text: "Delivered." } }, ctx);
    }
    // A completed old review is not proof that an admitted correction and its
    // recheck have both finished. Observe real task state and durable receipts.
    const records = await waitForVerified([{ ctx: ca, directory: a }, { ctx: cb, directory: b }]);
    const ta = await findTask({ projectRoot: a, sessionId: ca.sessionId }), tb = await findTask({ projectRoot: b, sessionId: cb.sessionId });
    assert.equal(ta.verification.status, "PASS"); assert.equal(tb.verification.status, "PASS");
    assert.equal(ta.stop.correctionAttempts, 1); assert.equal(tb.stop.correctionAttempts, 0); assert.notEqual(ta.taskId, tb.taskId);
    assert.equal(ta.correctionEpoch.id, 1); assert.equal(admissions.length, 1);
    assert.equal(records.find(r => r.runId === ca.runId).reviewStatus, "DEVIATION");
    assert(records.some(r => r.runId === admissions[0].idempotencyKey && r.reviewStatus === "PASS"));
    const final = await python(a); assert.equal(final.code, 0); assert.deepEqual(await fs.readdir(off), []);
    for (const dir of [a,b]) assert.equal(await fs.readFile(path.join(dir, ".runtime-corrector/config.yaml"), "utf8"), policy);
    const receiptFiles = await fs.readdir(path.join(a, ".runtime-correction/openclaw/native-followups"));
    const receiptDir = path.join(a, ".runtime-correction/openclaw/native-followups", receiptFiles[0]);
    const receipt = JSON.parse(await fs.readFile(path.join(receiptDir, (await fs.readdir(receiptDir)).find(name => name.endsWith(".json")))));
    assert(receipt.modelObservedAt && receipt.finishedAt); assert.equal(receipt.reviewStatus, "PASS");
    const value = { version, status: "PASS", A: { taskId: ta.taskId, groundTruthVersion: ta.groundTruth.version, k: ta.stop.correctionAttempts, epoch: ta.correctionEpoch.id },
      B: { taskId: tb.taskId, k: tb.stop.correctionAttempts }, records, receipt, reviews, actualPythonTests: 9, finalPythonOutput: final.stderr };
    cases.push(value); await fs.writeFile(path.join(arm, "result.json"), JSON.stringify(value, null, 2));
  } finally { lifetime.abort(); for (const timer of timers) clearTimeout(timer); await runtime.dispose(); }
}
await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ status: "PASS", scope: "Real Python subprocesses and RC native hooks; deterministic host/reviewer doubles; no model API or running OpenClaw server.", cases }, null, 2));
process.stdout.write(JSON.stringify({ status: "PASS", output: root, cases: cases.map(c => ({ version: c.version, A: c.A, B: c.B, actualPythonTests: c.actualPythonTests })) }) + "\n");
