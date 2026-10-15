// Inject a file regression after a real successful business verifier call.
// The business request and review contract contain no fault-injection waiver.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const execute = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const [hostRoot, providerFile, destination, port, seedFile] = process.argv.slice(2);
if (!seedFile) throw new Error("hostRoot providerFile new-output-directory port verified-seed-file required");
const skillName = "build-offline-kitchen", source = fileURLToPath(new URL(`../../examples/openclaw-offline-kitchen/skills/${skillName}`, import.meta.url));
const h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), workspaceSkillSources: [source], platformAdapters: {
  "offline-kitchen-python-test": { name: "offline-kitchen-python-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
    sourceManifest: { roots: [], files: ["kitchen.py"], extensions: [".py"] } },
} });
const project = path.join(h.root, "kitchen"), key = "agent:main:rc-kitchen-stale-result";
const skillRoot = path.join(h.defaultDir, "skills", skillName), verifier = path.join(skillRoot, "scripts/verify_kitchen.py");
const result = { experiment: "offline-kitchen-out-of-band-regression", hostVersion: h.version, baseline: process.env.RC_EXPERIMENT_BASELINE,
  status: "RUNNING", observerRepairsBusinessCode: false, observerFaultMutation: "Only one write after the actual business verifier succeeds" };
const milestone = data => process.stdout.write(JSON.stringify({ at: Date.now(), ...data }) + "\n");
async function snapshot() {
  const state = await runtimeState(project), skillDocuments = [];
  for (const file of await files(path.join(project, ".runtime-correction/tasks"))) if (file.includes(`/skills/${skillName}/`) && file.endsWith(".json")) skillDocuments.push({ file, ...JSON.parse(await fs.readFile(file, "utf8")) });
  return { ...state, skillDocuments };
}
async function acceptance() {
  const r = await execute("python3.13", [verifier, "--project", project], { cwd: project, timeout: 120000 });
  assert.match(r.stdout, /KITCHEN_VERIFIED\s*$/u); assert.equal(r.stderr, "");
  const d = JSON.parse(r.stdout.split("\n")[0]); assert.equal(d.status, "PASS"); assert.equal(d.scenarios, 21); return d;
}
try {
  assert.equal(h.version, "2026.7.1-2");
  await fs.mkdir(path.join(project, ".runtime-corrector"), { recursive: true }); await fs.mkdir(path.join(project, "spec"));
  const seed = await fs.readFile(seedFile);
  await fs.writeFile(path.join(project, "kitchen.py"), seed); await fs.writeFile(path.join(project, "reference-kitchen.py"), seed);
  await fs.copyFile(path.join(skillRoot, "references/requirements.md"), path.join(project, "spec/requirements.md"));
  const policy = `version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: [spec/requirements.md]\n  panel:\n    size: 1\n    adjudicator: false\nskillCorrection:\n  enabled: true\n  selection:\n    mode: include\n    include: [${skillName}]\n  completionCheckIntervalTurns: 10\n  maxWatchTurns: 30\n  maxFeedbacksPerSkill: 1\nartifactCorrection:\n  groundTruthReviewEnabled: false\nstopCorrection:\n  enabled: true\n  assessmentTimeoutMs: 720000\n  maxCorrectionsPerEpoch: 2\nimplementationCorrection:\n  enabled: true\n  platform: offline-kitchen-python-test\nreviewers:\n  defaults:\n    model: ${h.model}\n    effort: low\n    timeoutMs: 240000\n`;
  await fs.writeFile(path.join(project, ".runtime-corrector/config.yaml"), policy);
  const frozen = Object.fromEntries(await Promise.all(["reference-kitchen.py", "spec/requirements.md", ".runtime-corrector/config.yaml"].map(async file => [file, hash(await fs.readFile(path.join(project, file)))])));
  const frozenSkill = Object.fromEntries(await Promise.all((await files(skillRoot)).map(async file => [path.relative(skillRoot, file), hash(await fs.readFile(file))])));
  const created = await h.request("sessions.create", { key, model: h.model, emitCommandHooks: false });
  await h.send(key, `/rc-project bind ${project}`, 30000); const scope = await h.status(key); assert.equal(scope.enabled, true);
  await h.save("seed-acceptance.json", await acceptance());
  await h.save("manifest.json", { ...result, model: h.model, project, key, sessionId: created.sessionId, scope, seedFile,
    seedHash: hash(seed), frozen, frozenSkill, verifier, skillRoot, explicitSkillRoots: false });
  await h.save("process-first-generation.json", JSON.parse(await fs.readFile(path.join(h.root, "process.json"), "utf8")));
  const prompt = `/skill ${skillName} 项目绝对目录=${project}。对现有离线厨房Python应用做正式最终验收，完整遵守冻结spec/requirements.md及Skill。read原Skill和项目合同，实际运行Skill自带verify_kitchen.py并得到KITCHEN_VERIFIED后交付完成。若RC指出偏离或证据过期，已授权按正式合同修复kitchen.py并再次运行bundled verifier，无需用户确认；只读reference-kitchen.py提供已验证的参考实现，可读取但不可修改。只改kitchen.py和本项目数据，保持Skill/spec/RC配置/参考文件不变；exec显式workdir=${project}。`;
  await h.save("request.md", prompt); milestone({ phase: "normal native Skill request", project });
  let terminal, mainError;
  const pending = h.send(key, prompt).then(r => (terminal = r), error => { mainError = error; });
  const starts = new Map(); let cursor = 0, injected;
  const injectionDeadline = Date.now() + 600000;
  while (!injected && Date.now() < injectionDeadline) {
    for (const event of h.events.slice(cursor)) {
      const p = event.payload, d = p?.data;
      if (p?.stream !== "tool") continue;
      if (d?.phase === "start" && d.name === "exec" && d.args?.command?.includes(verifier) && d.args.command.includes(project)) starts.set(d.toolCallId, event);
      if (d?.phase === "result" && starts.has(d.toolCallId) && JSON.stringify(d.result).includes("KITCHEN_VERIFIED")) {
        const before = await fs.readFile(path.join(project, "kitchen.py"));
        await h.save("verified-before-fault.py", before.toString());
        const bad = 'print("KITCHEN_BROKEN")\n';
        await fs.writeFile(path.join(project, "kitchen.py"), bad);
        injected = { verifierRunId: p.runId, toolCallId: d.toolCallId, realVerifierResultAt: event.at,
          injectedAt: Date.now(), beforeHash: hash(before), afterHash: hash(Buffer.from(bad)), mutation: bad };
        await h.save("fault-injection.json", injected); milestone({ phase: "file changed after real successful verifier", ...injected }); break;
      }
    }
    cursor = h.events.length;
    if (!injected && (terminal || mainError)) throw mainError ?? new Error("Initial delivery ended before successful verifier observation");
    if (!injected) await pause(50);
  }
  assert(injected, "No injection opportunity observed"); await pending; if (mainError) throw mainError;
  await h.save("first-terminal.json", terminal); assert(terminal.terminalAt >= injected.injectedAt);
  const firstSource = await fs.readFile(path.join(project, "kitchen.py"), "utf8");
  assert(firstSource.includes("KITCHEN_BROKEN"), "Trial invalid: business agent repaired the external regression before delivery");
  await h.save("first-delivered-kitchen.py", firstSource);
  const deadline = Date.now() + 1800000; let state, signature;
  while (Date.now() < deadline) {
    state = await snapshot();
    const compact = { tasks: state.tasks.map(t => ({ taskId: t.taskId, status: t.status, verification: t.verification?.status, k: t.stop.correctionAttempts })),
      receipts: state.records.filter(r => r.file.includes("/native-followups/")).map(r => ({ status: r.status, observed: Boolean(r.modelObservedAt), reviewStatus: r.reviewStatus })) };
    if (JSON.stringify(compact) !== signature) { signature = JSON.stringify(compact); milestone(compact); }
    const active = state.records.some(r => ["PENDING", "RUNNING", "DISPATCH_COMMITTED"].includes(r.status));
    if (!active && state.tasks.some(t => t.status === "COMPLETED" && t.verification?.status === "PASS")) break;
    if (!active && state.tasks.some(t => t.verification?.correctionBudgetExhausted)) throw new Error("Correction budget exhausted");
    if (!active && state.records.some(r => r.file.includes("/native-stop-reviews/") && ["UNVERIFIED", "CANCELLED"].includes(r.reviewStatus))) throw new Error("Stop could not verify the regression");
    await pause(2000);
  }
  await h.save("runtime-final.json", state);
  const task = state.tasks.find(t => t.status === "COMPLETED" && t.verification?.status === "PASS"); assert(task);
  assert(state.records.some(r => r.file.includes("/native-stop-reviews/") && r.runId === terminal.runId && r.reviewStatus === "DEVIATION"));
  const receipts = state.records.filter(r => r.file.includes("/native-followups/"));
  assert(receipts.some(r => r.status === "ADMITTED" && r.modelObservedAt && r.finishedAt && r.reviewStatus === "PASS"));
  assert.equal(task.stop.correctionAttempts, 1); assert(Object.values(task.watchers).some(w => w.skillId === skillName));
  assert(state.records.some(r => r.role === "skill-reviewer" && r.status === "SETTLED"));
  const accepted = await acceptance(); await h.save("acceptance.json", accepted);
  for (const [file, digest] of Object.entries(frozen)) assert.equal(hash(await fs.readFile(path.join(project, file))), digest);
  for (const [file, digest] of Object.entries(frozenSkill)) assert.equal(hash(await fs.readFile(path.join(skillRoot, file))), digest);
  const before = { scope: await h.status(key), task: (await snapshot()).tasks[0] };
  const modelStarts = () => h.events.filter(e => e.payload?.stream === "lifecycle" && e.payload.data?.phase === "start").length;
  const count = modelStarts(); await h.restart();
  const after = { scope: await h.status(key), task: (await snapshot()).tasks[0] };
  assert.deepEqual(after.scope.identity, before.scope.identity); assert.equal(after.scope.projectRoot, before.scope.projectRoot);
  for (const field of ["taskId", "groundTruth", "stop", "correctionEpoch", "watchers"]) assert.deepEqual(after.task[field], before.task[field]);
  assert.equal(modelStarts(), count); await h.save("restart.json", { before, after, queriesStartedNoModel: true });
  assert(!(await fs.readdir(h.defaultDir)).includes(".runtime-correction"));
  Object.assign(result, { status: "PASS", taskId: task.taskId, correctionAttempts: task.stop.correctionAttempts, watchers: task.watchers,
    injected, acceptance: accepted, receipts, restart: "PASS" }); await h.save("kitchen.py", await fs.readFile(path.join(project, "kitchen.py"), "utf8"));
} catch (error) {
  result.status = "FAIL"; result.error = h.redact(error.stack); milestone({ phase: "failed", error: h.redact(error.message) });
  await h.save("runtime-at-failure.json", await snapshot()).catch(() => {});
} finally { await h.save("summary.json", result); await h.close(); }
milestone({ phase: "finished", status: result.status, output: h.root }); process.exitCode = result.status === "PASS" ? 0 : 1;
