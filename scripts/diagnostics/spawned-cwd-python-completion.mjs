// Complete only the interrupted B/off cases; retain the original experiment.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const [hostRoot, providerFile, root, port] = process.argv.slice(2);
const afterRoutingFix = process.argv.includes("--after-routing-fix");
const fresh = afterRoutingFix || process.argv.includes("--fresh-control");
const prefix = afterRoutingFix ? "routing-fix-control" : fresh ? "positive-control" : "completion";
if (!port || !process.env.RC_TEST_MODEL_KEY) throw new Error("hostRoot providerFile previous-output-directory port and RC_TEST_MODEL_KEY required");
process.env.OPENCLAW_DEBUG_MODEL_TRANSPORT = "1";
const read = async name => JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
const count = async () => (await fs.readFile(path.join(root, "gateway.jsonl"), "utf8")).split("\n").filter(line => {
  try { return Object.values(JSON.parse(line)).some(v => typeof v === "string" && v.startsWith("[model-fetch] start ")); } catch { return false; }
}).length;
const report = { status: "RUNNING", startedAt: new Date().toISOString(), realModel: true,
  kind: fresh ? "one independent positive Session after a retained historical violation; never resets the old task" : "continue existing B task with a new native business turn; not automatic replay of an interrupted process",
  limits: { modelRequests: 90, elapsedMs: 1500000 }, hostSourceModified: false };
const initialRequests = await count(), deadline = Date.now() + report.limits.elapsedMs;
report.initialModelRequests = initialRequests;
let budgetBaseline = initialRequests;
let h, guard, limitError;
const progress = (phase, data = {}) => console.log(JSON.stringify({ phase, ...data }));
async function cli(project, args) {
  try { return { code: 0, ...await execute("python3.13", ["todo.py", ...args], { cwd: project, timeout: 10000,
    env: { ...process.env, RC_TEST_MODEL_KEY: undefined, RC_EXPERIMENT_GATEWAY_TOKEN: undefined, PYTHONDONTWRITEBYTECODE: "1" } }) }; }
  catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
try {
  const manifest = await read("manifest.json");
  let bKey = (await read("B-terminal.json")).params.sessionKey;
  const control = manifest.checks.flatMap(c => c.failureCases ?? []).map(r => r.scope?.identity?.sessionKey).find(Boolean);
  const { a, b, c, off } = manifest.projects;
  const originalTaskId = (await read("B-runtime-after-limit.json")).tasks[0].taskId;
  const beforeB = await runtimeState(b), oldTask = beforeB.tasks.find(t => t.taskId === originalTaskId);
  assert(oldTask, "Preserve the original B task independently of directory iteration order");
  if (fresh) {
    assert.equal(oldTask.verification?.status, "DEVIATION"); assert.equal(oldTask.verification.correctionBudgetExhausted, true);
  } else { assert.equal(oldTask.status, "ACTIVE"); assert.equal(oldTask.stop.correctionAttempts, 0); }
  report.beforeBTask = oldTask;
  report.historicalArchive = `${root}-before-completion`;
  // Refuse to overwrite the archive or accidentally run this expensive phase twice.
  if (fresh) {
    const previous = await read(afterRoutingFix ? "positive-control-summary.json" : "completion-summary.json"); assert.equal(previous.status, "FAIL");
    assert.equal(await fs.stat(path.join(root, `${prefix}-summary.json`)).catch(() => null), null, "Do not repeat or overwrite a control");
    const originalLog = await fs.readFile(path.join(report.historicalArchive, "gateway.jsonl"), "utf8");
    budgetBaseline = originalLog.split("\n").filter(line => {
      try { return Object.values(JSON.parse(line)).some(v => typeof v === "string" && v.startsWith("[model-fetch] start ")); } catch { return false; }
    }).length;
    if (afterRoutingFix) {
      assert(JSON.stringify(await read("positive-control-final-B-state.json")).includes("EVIDENCE_OWNER_MISMATCH"), "Only run after the retained routing failure");
      budgetBaseline = initialRequests; // One new candidate after a production fix; same RC budgets.
      report.kind = "one new Session after the shared extraction-prompt fix; all prior tasks remain unchanged";
    }
    report.oldTaskOutcomeRetained = { taskId: oldTask.taskId, status: oldTask.status, verification: oldTask.verification.status, k: oldTask.stop.correctionAttempts };
  } else {
    assert.equal(await fs.stat(report.historicalArchive).catch(() => null), null);
    await fs.cp(root, report.historicalArchive, { recursive: true, verbatimSymlinks: true });
  }
  report.sharedBudgetBaseline = budgetBaseline;
  const untouched = {};
  for (const project of [a, c]) for (const name of ["todo.py", ...(project === a ? ["late.txt"] : [])]) {
    const file = path.join(project, name); untouched[file] = hash(await fs.readFile(file));
  }
  h = await isolatedHost({ hostRoot, providerFile, destination: root, port: Number(port), resume: true,
    platformAdapters: { "python-todo-scope-test": { name: "python-todo-scope-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
      sourceManifest: { roots: [], files: ["todo.py"], extensions: [".py"] } } } });
  report.pluginVersion = JSON.parse(await fs.readFile(path.join(h.pluginRoot, "package.json"), "utf8")).version;
  if (afterRoutingFix) assert.equal(report.pluginVersion, "1.9.1-openclaw.11-session-projects.8");
  guard = setInterval(async () => {
    try { if (await count() - budgetBaseline >= report.limits.modelRequests || Date.now() >= deadline) {
      limitError ??= new Error("Completion experiment safety limit reached"); await h.close();
    } } catch (error) { limitError ??= error; await h.close(); }
  }, 2000);
  const sdk = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/session-store-runtime.js")));
  const storePath = sdk.resolveStorePath(path.join(h.stateDir, "agents/main/sessions/sessions.json"), { agentId: "main" });
  if (fresh) {
    bKey = `agent:main:rc-positive-${randomUUID()}`;
    await h.request("sessions.create", { key: bKey, model: h.model, emitCommandHooks: false });
    await sdk.patchSessionEntry({ agentId: "main", sessionKey: bKey, storePath, preserveActivity: true, update: () => ({ spawnedCwd: b }) });
  }
  const scope = await h.status(bKey);
  assert.equal(scope.source, "host"); assert.equal(scope.projectRoot, b);
  report.BScope = scope;
  const opening = fresh ? "在这个独立Session中验收并交付现有应用，不开发新功能。" : "继续完成本Session的应用验收交付，上轮实验网关被观察器关闭。";
  const prompt = `${opening} 宿主项目为 ${b}，现有Python Todo应用已经写好；正式需求以spec/requirements.md中的R01至R06为准，不重做开发，不修改需求、AGENTS和RC配置。请读取现有合同与代码，实际运行帮助、Unicode添加、独立进程list/done、未知ID失败且存储字节不变，以及about返回B_WORKTREE且不改变存储。只在当前项目data/${afterRoutingFix ? prefix : fresh ? "positive-control" : "completion-test"}目录保存测试数据；不要使用公共/tmp、其他项目或默认工作区，不需网络和依赖。用相对路径调用原生工具，exec不传cwd/workdir、不使用cd，验证宿主spawnedCwd生效。若应用有实际缺陷只修todo.py；若没有则不改源码。完成实际检查后交付；RC若提出有依据的偏离，已授权原生续作修复和复验，无需再次确认。`;
  await h.save(`${prefix}-B-request.md`, prompt); progress("B native verification started", { priorTaskId: oldTask.taskId, fresh });
  const terminal = await h.send(bKey, prompt, 900000); await h.save(`${prefix}-B-terminal.json`, terminal);
  let final, last;
  while (Date.now() < deadline) {
    if (limitError) throw limitError;
    const state = await runtimeState(b), task = state.tasks.find(t => fresh ? t.sessionIds.includes(scope.identity.sessionId) : t.taskId === oldTask.taskId);
    assert(task, "Existing task must remain identifiable");
    if (fresh) assert.notEqual(task.taskId, oldTask.taskId);
    const reviews = state.records.filter(r => r.file.includes("/native-stop-reviews/") && r.createdAt >= terminal.startedAt);
    const settled = reviews.find(r => r.status === "SETTLED" && r.reviewStatus === "PASS" && r.evaluationId === task.verification?.evaluationId);
    const view = JSON.stringify({ status: task.status, verification: task.verification?.status, k: task.stop.correctionAttempts,
      reviews: reviews.map(r => [r.status, r.reviewStatus]), requests: await count() - initialRequests });
    if (view !== last) { progress("B review progress", JSON.parse(view)); last = view; }
    if (task.status === "COMPLETED" && task.verification?.status === "PASS" && settled) { final = { state, task, settled }; break; }
    const exhaustedSettled = task.verification?.correctionBudgetExhausted
      && reviews.some(r => r.status === "SETTLED" && r.evaluationId === task.verification.evaluationId);
    if (exhaustedSettled || reviews.some(r => r.status === "SETTLED" && ["UNVERIFIED", "CANCELLED"].includes(r.reviewStatus))) {
      throw new Error("B native final review did not pass; preserve evidence without repeating or clearing state");
    }
    await pause(1000);
  }
  assert(final, "B final review observer deadline");
  const evaluation = final.state.evaluations.find(e => e.evaluationId === final.task.verification.evaluationId);
  assert(evaluation?.implementationReview, "Configured implementation review must have evidence");
  assert.equal(evaluation.implementationReview.status, "COMPLETED");
  await h.save(`${prefix}-B-runtime.json`, final.state);
  report.B = { task: final.task, stop: final.settled, implementationReview: evaluation.implementationReview };
  // Independent function checks use fresh project-local data, not the old fixture.
  const store = path.join(b, `observer-${prefix}/todos.json`), steps = [];
  await fs.mkdir(path.dirname(store), { recursive: true }); assert.equal(await fs.stat(store).catch(() => null), null);
  const run = async args => { const result = await cli(b, args); steps.push({ args, ...result }); return result; };
  const call = args => run(["--store", store, ...args]);
  const help = await run(["--help"]); assert.equal(help.code, 0); assert.match(help.stdout, /usage/iu);
  const empty = await call(["list"]); assert.equal(empty.code, 0); assert.deepEqual(JSON.parse(empty.stdout), []);
  const add = async text => { const r = await call(["add", text]); assert.equal(r.code, 0); const value = JSON.parse(r.stdout); assert(value.id > 0); assert.equal(value.text, text); assert.equal(value.done, false); return value; };
  const first = await add("完整闭环 ✅"), second = await add("second"); assert(second.id > first.id);
  const listed = await call(["list"]); assert.equal(listed.code, 0); assert.deepEqual(JSON.parse(listed.stdout), [first, second]);
  const done = await call(["done", String(first.id)]); assert.equal(done.code, 0); assert.deepEqual(JSON.parse(done.stdout), { ...first, done: true });
  const persisted = await call(["list"]); assert.equal(persisted.code, 0); assert.deepEqual(JSON.parse(persisted.stdout), [{ ...first, done: true }, second]);
  const before = await fs.readFile(store), missing = await call(["done", String(second.id + 1000)]);
  assert.notEqual(missing.code, 0); assert(missing.stderr.trim()); assert.deepEqual(await fs.readFile(store), before);
  const about = await call(["about"]); assert.equal(about.code, 0); assert.deepEqual(JSON.parse(about.stdout), { project: "B_WORKTREE" }); assert.deepEqual(await fs.readFile(store), before);
  report.BAcceptance = { status: "PASS", scenarios: 9, steps, codeHash: hash(await fs.readFile(path.join(b, "todo.py"))) };
  progress("B final Stop and implementation verified", { k: final.task.stop.correctionAttempts });

  const identity = { agentId: "main", sessionKey: control, storePath, readConsistency: "latest" };
  const oldEntry = sdk.getSessionEntry(identity); assert(oldEntry); assert.equal(oldEntry.spawnedCwd, undefined);
  await sdk.patchSessionEntry({ ...identity, preserveActivity: true, update: current => { assert.equal(current.sessionId, oldEntry.sessionId); return { spawnedCwd: off }; } });
  const offScope = await h.status(control); assert.equal(offScope.source, "host"); assert.equal(offScope.reason, "RC_PROJECT_NOT_ENABLED");
  const offStart = Date.now(), modelsBeforeOff = await count();
  const offTerminal = await h.send(control, "在宿主当前项目中，只用write相对路径创建off-only.txt，内容OFF_ONLY加换行，然后回复完成；不要修改其他文件或目录。", 180000);
  await h.save(`${prefix}-off-terminal.json`, offTerminal);
  await pause(1500);
  assert.equal(await fs.readFile(path.join(off, "off-only.txt"), "utf8"), "OFF_ONLY\n");
  assert.equal(await fs.stat(path.join(off, ".runtime-correction")).catch(() => null), null);
  const foreignRuns = h.events.filter(e => e.at >= offStart && e.payload?.stream === "lifecycle" && e.payload.data?.phase === "start" && e.payload.runId !== offTerminal.runId);
  assert.equal(foreignRuns.length, 0, "Unconfigured project must not start Reviewer runs");
  report.off = { status: "PASS", scope: offScope, businessRunId: offTerminal.runId, marker: "OFF_ONLY\n", runtimeDirectoryExists: false,
    additionalReviewerRuns: 0, businessModelRequests: await count() - modelsBeforeOff };
  await sdk.patchSessionEntry({ ...identity, preserveActivity: true, update: () => ({ spawnedCwd: undefined }) });
  const manual = await h.status(control); assert.equal(manual.source, "rc"); assert.equal(manual.projectRoot, c);
  const beforeRestart = await runtimeState(b), countBeforeRestart = await count();
  await h.restart(); assert.equal((await h.status(bKey)).projectRoot, b); assert.equal((await h.status(control)).projectRoot, c);
  const afterRestart = await runtimeState(b);
  assert.deepEqual(afterRestart.tasks, beforeRestart.tasks); assert.equal(await count(), countBeforeRestart);
  if (fresh) assert.deepEqual(afterRestart.tasks.find(t => t.taskId === oldTask.taskId), oldTask);
  if (afterRoutingFix) for (const prior of beforeB.tasks) assert.deepEqual(afterRestart.tasks.find(t => t.taskId === prior.taskId), prior);
  report.restart = { status: "PASS", newModelRequests: 0 };
  for (const [file, digest] of Object.entries({ ...manifest.protectedFiles, ...untouched })) assert.equal(hash(await fs.readFile(file)), digest);
  assert.equal(await fs.stat(path.join(h.defaultDir, "todo.py")).catch(() => null), null);
  assert.equal(await fs.stat(path.join(h.defaultDir, ".runtime-correction")).catch(() => null), null);
  report.protectedFilesAndOtherProjectsUnchanged = true; report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = h ? h.redact((limitError ?? error).stack) : String(error.stack); progress("completion failed", { error: report.error }); }
finally {
  clearInterval(guard); if (h) {
    await h.save(`${prefix}-final-B-state.json`, await runtimeState(path.join(root, "B worktree")));
    await h.close();
    for (const file of await files(root)) if (!file.includes(`${path.sep}.git${path.sep}`)) {
      const original = (await fs.readFile(file)).toString("utf8"), redacted = h.redact(original);
      if (redacted !== original) await fs.writeFile(file, redacted);
    }
    report.modelRequests = await count() - initialRequests; report.finishedAt = new Date().toISOString();
    await h.save(`${prefix}-summary.json`, report);
  }
}
progress("finished", { status: report.status, modelRequests: report.modelRequests });
process.exitCode = report.status === "PASS" ? 0 : 1;
