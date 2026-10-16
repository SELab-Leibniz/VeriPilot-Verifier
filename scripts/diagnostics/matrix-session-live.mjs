// Bounded real-model probe using the installed MA Gateway and cwd bridge.
// The only projects/sessions/configuration written belong to this fresh experiment.
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const [matrixRoot, destination, mode = "all"] = process.argv.slice(2);
assert(["all", "switch", "switch-resume"].includes(mode), "Use all, switch or switch-resume mode");
const resume = mode === "switch-resume";
if (!matrixRoot || !destination || !process.env.ANTHROPIC_AUTH_TOKEN || !process.env.ANTHROPIC_BASE_URL || !process.env.ANTHROPIC_MODEL) {
  throw new Error("Supply MA root, a new output directory, and the existing ANTHROPIC model environment.");
}
const hostRoot = path.join(matrixRoot, "resources/openclaw");
const bridge = path.join(matrixRoot, "resources/claw-plugin/register-gateway-method");
const hostPkg = JSON.parse(await fs.readFile(path.join(hostRoot, "package.json")));
assert.equal(hostPkg.version, "2026.7.1-2");
const root = path.resolve(destination), control = `${root}-control`;
await fs.mkdir(control, { recursive: resume });
const descriptor = { baseUrl: process.env.ANTHROPIC_BASE_URL, api: "anthropic-messages", authHeader: true,
  model: { id: process.env.ANTHROPIC_MODEL, name: "Isolated Matrix live probe", reasoning: false,
    input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
const providerFile = path.join(control, "provider.json");
await fs.writeFile(providerFile, JSON.stringify(descriptor));
process.env.RC_TEST_MODEL_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const report = { startedAt: new Date().toISOString(), hostVersion: hostPkg.version, model: descriptor.model.id,
  pluginVersion: "1.9.1-openclaw.11-session-projects.6", mode,
  scope: resume ? "resume this experiment's temporary Session; no user sessions" : `one Gateway, three temporary projects, ${mode === "all" ? "two" : "one"} new sessions`,
  realModel: true, existingHostAndSessionsUntouched: true, modelRequestLimit: resume ? 16 : mode === "all" ? 40 : 20, checks: [], status: "RUNNING" };
const milestone = (phase, detail = {}) => process.stdout.write(JSON.stringify({ phase, at: new Date().toISOString(), ...detail }) + "\n");
const deadline = Date.now() + 15 * 60_000;
let h, budgetGuard, budgetFailure, initialRequests = 0;
async function modelRequests() {
  const log = await fs.readFile(path.join(root, "gateway.jsonl"), "utf8").catch(() => "");
  return log.split("\n").filter(line => {
    try { return JSON.parse(line).message?.startsWith("[model-fetch] start "); }
    catch { return false; } // The last log write may still be in progress.
  }).length;
}
const mark = (name, evidence) => { report.checks.push({ name, status: "PASS", ...evidence }); milestone(name); };
const policy = stop => `version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: []\n  panel:\n    size: 1\n    adjudicator: false\nskillCorrection:\n  enabled: false\nartifactCorrection:\n  groundTruthReviewEnabled: false\nstopCorrection:\n  enabled: ${stop}\n  maxCorrectionsPerEpoch: 1\n  assessmentTimeoutMs: 240000\nimplementationCorrection:\n  enabled: false\nreviewers:\n  defaults:\n    model: test/${descriptor.model.id}\n    effort: low\n    timeoutMs: 90000\n    formatRepairAttempts: 1\n`;
const hash = data => createHash("sha256").update(data).digest("hex");
async function waitFor(check, label, timeout = 180000) {
  const end = Math.min(deadline, Date.now() + timeout);
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(500); }
  throw new Error(`Bounded observer deadline: ${label}`);
}
async function create(key, directory) {
  const created = await h.request("sessions.create", { key, model: h.model, emitCommandHooks: false });
  await h.request("sessions-custom.setSessionCwd", { sessionKey: key, cwd: directory });
  const scope = await h.status(key);
  assert.equal(scope.projectRoot, directory); assert.equal(scope.source, "host");
  return { created, scope };
}
try {
  initialRequests = await modelRequests();
  h = await isolatedHost({ hostRoot, providerFile, destination: root, port, resume, tools: ["read", "write", "edit"],
    extraPlugins: [{ id: "register-gateway-method", path: bridge }] });
  budgetGuard = setInterval(async () => {
    try {
      const count = await modelRequests() - initialRequests;
      if (count >= report.modelRequestLimit || Date.now() >= deadline) {
        budgetFailure ??= new Error(`Isolated model budget reached (${count} requests, limit ${report.modelRequestLimit})`);
        await h.close();
      }
    } catch (error) { budgetFailure ??= error; await h.close(); }
  }, 1000);
  const a = path.join(h.root, "A"), b = path.join(h.root, "B"), off = path.join(h.root, "off");
  for (const directory of [a, b, off]) await fs.mkdir(directory, { recursive: resume });
  const protectedHashes = {};
  for (const [directory, stop] of [[a, true], [b, false]]) {
    const file = path.join(directory, ".runtime-corrector/config.yaml");
    if (!resume) { await fs.mkdir(path.dirname(file)); await fs.writeFile(file, policy(stop)); }
    protectedHashes[file] = hash(await fs.readFile(file));
  }
  // A same-content write has terminate:true in this host. Fault injection
  // must really change bytes so the native business loop can reach its reply.
  if (!resume) {
    await fs.writeFile(path.join(a, "draft.txt"), "SEED_A\n");
    await fs.writeFile(path.join(a, "late.txt"), "SEED_SWITCH\n");
  }
  if (mode === "all") {
  const key = `agent:main:chat-rc-live-${randomUUID()}`;
  const initial = await create(key, a); assert.equal(initial.scope.enabled, true);
  mark("new Session automatically follows A", { sessionId: initial.scope.identity.sessionId, projectRoot: a });
  milestone("real correction loop starts");
  const prompt = `项目 ${a} 的正式合同：draft.txt 的全部字节必须严格为 READY_A 加一个换行；立即生效，只允许改 draft.txt。隔离环境的受控负向验收：首轮先 write 将 draft.txt 改为 BROKEN 加一个换行，再 read 确认，然后直接给出完成宣告“任务完成”。这是故意注入的错误完成宣告，不豁免正式 READY_A 要求；不要把该次交付称为中间步骤、等待反馈或等待用户。RC 明确指出偏差后的修复也已授权：自行将 draft.txt 修正为 READY_A 加一个换行，read 复验后再次完成交付，无需用户确认。不更改 late.txt、配置或其他文件，不调用其他 Session。`;
  const first = await h.send(key, prompt, 360000); await h.save("loop-first.json", first);
  const loop = await waitFor(async () => {
    const s = await runtimeState(a), start = s.records.find(r => r.file.includes("/native-stop-reviews/") && r.runId === first.runId);
    if (Date.now() - first.terminalAt > 15000 && !start && !s.tasks.length) throw new Error("No correction task was created by the first business action");
    if (start?.status === "SETTLED" && start.reviewStatus === "PASS") throw new Error("Invalid fault trial: broken first delivery passed before a correction");
    if (start?.status === "SETTLED" && start.reviewStatus === "NOT_YET_EXECUTED") throw new Error("Invalid fault trial: first delivery was classified as waiting rather than a completed claim");
    if (start?.status === "SETTLED" && ["CANCELLED", "UNVERIFIED"].includes(start.reviewStatus)) throw new Error(`First Stop ${start.reviewStatus}: ${start.reasonCode}`);
    const receipt = s.records.find(r => r.file.includes("/native-followups/") && r.sourceRecordId && r.modelObservedAt && r.finishedAt && r.reviewStatus === "PASS");
    const currentTask = s.tasks.find(t => t.sessionIds.includes(initial.scope.identity.sessionId));
    const task = currentTask?.verification?.status === "PASS" ? currentTask : null;
    if (task && receipt && start?.reviewStatus === "DEVIATION") return { s, start, receipt, task };
    if (currentTask?.verification?.correctionBudgetExhausted) throw new Error("Correction budget exhausted");
    return null;
  }, "real DEVIATION / observed continuation / PASS", 300000);
  assert.equal(await fs.readFile(path.join(a, "draft.txt"), "utf8"), "READY_A\n");
  assert.equal(loop.task.stop.correctionAttempts, 1);
  await h.save("loop-runtime.json", loop.s);
  mark("real model DEVIATION -> observed correction -> PASS", { taskId: loop.task.taskId, correctionAttempts: 1,
    firstRunId: first.runId, feedbackRunId: loop.receipt.runId, file: "READY_A\n" });
  }

  const store = resume ? JSON.parse(await fs.readFile(path.join(h.stateDir, "agents/main/sessions/sessions.json"))) : {};
  const switchKey = resume ? Object.keys(store).find(key => key.startsWith("agent:main:chat-rc-switch-")) : `agent:main:chat-rc-switch-${randomUUID()}`;
  assert(switchKey, "Only resume this probe's dedicated switch Session");
  const old = resume ? { scope: await h.status(switchKey) } : await create(switchKey, a);
  assert.equal(old.scope.projectRoot, a);
  if (!resume && mode === "switch") mark("new Session automatically follows A", { sessionId: old.scope.identity.sessionId, projectRoot: a });
  const badSwitch = resume ? "BAD_SWITCH_RESUME" : "BAD_SWITCH";
  const firstSwitch = await h.send(switchKey, `项目 ${a} 的独立正式合同：late.txt 严格为 GOOD_SWITCH 加换行，立即生效。受控负向验收：首轮先 write 将 late.txt 改为 ${badSwitch} 加换行，再 read 确认，然后直接宣告“任务完成”。这是故意注入的错误完成交付，不豁免正式要求，不称为中间步骤或等待用户。若 RC 指出偏差，已授权自行修复并重新交付。只处理 late.txt，不改 draft.txt、配置、其他 Session。`, 360000);
  const running = await waitFor(async () => {
    const s = await runtimeState(a), log = await fs.readFile(path.join(h.root, "gateway.jsonl"), "utf8");
    const stop = s.records.find(r => r.file.includes("/native-stop-reviews/") && r.runId === firstSwitch.runId && r.status === "RUNNING");
    const run = stop && s.records.find(r => ["stop-reviewer", "ground-truth-extractor"].includes(r.role) && r.status === "DISPATCH_COMMITTED" && r.startedAt >= firstSwitch.startedAt
      && s.tasks.some(t => t.taskId === r.taskId && t.sessionIds.includes(old.scope.identity.sessionId))
      && log.indexOf("[model-fetch] start ", log.indexOf(`embedded run agent start: runId=${r.runId}`)) >= 0
      && log.includes(`embedded run agent start: runId=${r.runId}`));
    return run && { s, run };
  }, "actual old post-delivery Reviewer model start", 180000);
  report.switchStartedAt = Date.now(); report.oldReviewerRunId = running.run.runId;
  milestone("switching to B during actual old Reviewer", { runId: running.run.runId });
  await h.request("sessions-custom.setSessionCwd", { sessionKey: switchKey, cwd: b });
  const selectedB = await h.status(switchKey); assert.equal(selectedB.projectRoot, b); assert.equal(selectedB.enabled, true);
  await h.send(switchKey, `新项目 ${b} 的独立任务：只用 write 将 B_ONLY 加一个换行写入 draft.txt，再 read 确认后回复完成。此后不处理旧项目的 GOOD_SWITCH 要求，不改配置、其他项目或其他文件。`, 360000);
  const switched = await waitFor(async () => {
    const previous = await runtimeState(a), current = await runtimeState(b);
    const stop = previous.records.find(r => r.file.includes("/native-stop-reviews/") && r.runId === firstSwitch.runId);
    const task = current.tasks.find(t => t.sessionIds.includes(selectedB.identity.sessionId) && t.groundTruth.version > 0);
    return stop?.status === "SETTLED" && task && !previous.records.some(r => r.runId === running.run.runId && r.status !== "SETTLED")
      && { previous, current, stop, task };
  }, "old review settles and independent B baseline exists", 120000);
  assert.equal(switched.stop.reviewStatus, "CANCELLED");
  assert.notEqual(switched.task.taskId, running.run.taskId); assert.equal(switched.task.stop.correctionAttempts, 0);
  assert.equal(await fs.readFile(path.join(a, "late.txt"), "utf8"), `${badSwitch}\n`);
  assert.equal(await fs.readFile(path.join(b, "draft.txt"), "utf8"), "B_ONLY\n");
  assert(!switched.previous.records.some(r => r.file.includes("/native-followups/") && r.taskId === running.run.taskId && r.status !== "CANCELLED"));
  const history = await h.request("chat.history", { sessionKey: switchKey, limit: 50 });
  assert(!JSON.stringify(history).includes("[runtime-corrector:stop-feedback]"));
  await h.save("switch-old-runtime.json", switched.previous); await h.save("switch-B-runtime.json", switched.current);
  mark("switch isolates old real Reviewer and feedback", { oldTaskId: running.run.taskId, newTaskId: switched.task.taskId, oldReview: switched.stop.reviewStatus });

  await h.request("sessions-custom.setSessionCwd", { sessionKey: switchKey, cwd: off });
  const selectedOff = await h.status(switchKey); assert.equal(selectedOff.enabled, false); assert.equal(selectedOff.reason, "RC_PROJECT_NOT_ENABLED");
  await h.send(switchKey, `当前项目 ${off}：只 write 将 OFF_ONLY 加一个换行写入 off.txt，read 确认后回复完成。不改其他目录或配置。`, 180000);
  assert.equal(await fs.readFile(path.join(off, "off.txt"), "utf8"), "OFF_ONLY\n");
  assert(!(await fs.readdir(off)).includes(".runtime-correction"));
  mark("unconfigured project runs business with correction disabled", { reason: selectedOff.reason, noCorrectionDirectory: true });
  await h.request("sessions-custom.setSessionCwd", { sessionKey: switchKey, cwd: b });
  assert.equal((await h.status(switchKey)).enabled, true);
  const logText = await fs.readFile(path.join(h.root, "gateway.jsonl"), "utf8");
  const selectionLines = logText.split("\n").filter(line => /RC_PROJECT_RESOLVED|RC_PROJECT_SCOPE_ACTIVATED/u.test(line));
  const selectionEvents = selectionLines.map(line => {
    const message = Object.values(JSON.parse(line)).find(value => typeof value === "string" && value.includes('{"type":"RC_PROJECT'));
    return JSON.parse(message.slice(message.indexOf("{")));
  });
  assert(selectionEvents.some(event => event.type === "RC_PROJECT_SCOPE_ACTIVATED"));
  for (const directory of [a, b, off]) assert(selectionEvents.some(event => event.projectRoot === directory));
  const transitions = selectionEvents.filter(event => event.type === "RC_PROJECT_RESOLVED" && event.sessionId === selectedB.identity.sessionId);
  assert(transitions.some(event => event.previousProjectRoot === a && event.projectRoot === b && event.enabled));
  assert(transitions.some(event => event.previousProjectRoot === b && event.projectRoot === off && !event.enabled && event.reason === "RC_PROJECT_NOT_ENABLED"));
  assert(transitions.some(event => event.previousProjectRoot === off && event.projectRoot === b && event.enabled));
  await h.save("selection-logs.json", selectionEvents);
  for (const [file, expected] of Object.entries(protectedHashes)) assert.equal(hash(await fs.readFile(file)), expected);
  assert(!(await fs.readdir(h.defaultDir)).includes(".runtime-correction"));
  mark("configuration re-enables and project transition logs exist", { selectionLogRows: selectionLines.length, protectedConfigsUnchanged: true });
  report.status = "PASS";
} catch (error) {
  error = budgetFailure ?? error;
  report.status = "FAIL"; report.error = h ? h.redact(error.stack) : String(error.message);
  milestone("experiment failed", { error: h ? h.redact(error.message) : String(error.message) });
} finally {
  clearInterval(budgetGuard);
  report.modelRequests = await modelRequests() - initialRequests;
  report.totalRequestsInDirectory = await modelRequests();
  report.finishedAt = new Date().toISOString();
  if (h) { await h.close(); await h.save(resume ? "summary-resume.json" : "summary.json", report); }
  else await fs.writeFile(path.join(control, "failure.json"), JSON.stringify(report, null, 2));
  // Native model caches can materialize resolved credentials. Scrub after the
  // isolated Gateway exits, including logs, while retaining the real evidence.
  const secret = process.env.RC_TEST_MODEL_KEY;
  for (const file of await files(root)) if (/\.(?:json|jsonl|log|md|yaml)$/u.test(file)) {
    const text = await fs.readFile(file, "utf8");
    if (text.includes(secret)) await fs.writeFile(file, text.replaceAll(secret, "<model-key>"));
  }
}
milestone("finished", { status: report.status, output: root });
process.exitCode = report.status === "PASS" ? 0 : 1;
