// Preparation-only by default. Explicit --live is required after metric integration.
// All business writes by this observer occur before admission. No original host/session is used.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertIsolatedWorktree } from "./worktree-fence.mjs";

const execute = promisify(execFile), repository = await fs.realpath(process.cwd());
const args = process.argv.slice(2), live = args.includes("--live");
const mode = args.find(a => a.startsWith("--mode="))?.slice(7) ?? "develop";
assert(["stop", "develop", "stop-negative"].includes(mode));
assert(args.every(a => a === "--live" || a.startsWith("--mode=") || a.startsWith("--output=") || a.startsWith("--host=") || a.startsWith("--python=") || a.startsWith("--seed-app=")), "Unknown option");
const seedArgument = args.find(a => a.startsWith("--seed-app="))?.slice(11);
assert(!seedArgument || mode === "stop", "--seed-app is allowed only in stop mode; develop must start without kitchen.py");
const hostRoot = args.find(a => a.startsWith("--host="))?.slice(7) ?? "C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw";
const python = args.find(a => a.startsWith("--python="))?.slice(9) ?? "C:/Users/user/miniforge3/python.exe";
const hash = b => createHash("sha256").update(b).digest("hex");
const now = new Date().toISOString().replace(/[^0-9TZ]/gu, "");
const output = path.resolve(args.find(a => a.startsWith("--output="))?.slice(9) ?? path.join(repository, "experiments", `live-kitchen-${mode}-${now}`));
const allowed = path.join(repository, "experiments");
assert.equal(path.dirname(output), allowed, "Output must be a new direct experiments/live-kitchen-* directory");
assert(/^live-kitchen-[a-zA-Z0-9-]+$/u.test(path.basename(output)));
assert(!output.split(path.sep).includes(".runtime-correction"), "Private RC paths cannot own authoritative business materials");
await fs.access(path.join(repository, "lib/openclaw/runtime.mjs"));
await fs.access(python);
const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, "package.json"), "utf8"));
assert(["2026.7.1-2", "2026.10.3"].includes(pkg.version));
const skillName = "build-offline-kitchen", skillSource = path.join(repository, "examples/openclaw-offline-kitchen/skills", skillName);
const frozenContract = await fs.readFile(path.join(skillSource, "references/requirements.md"));
const originalSkill = await fs.readFile(path.join(skillSource, "SKILL.md"));
const verifierSource = await fs.readFile(path.join(skillSource, "scripts/verify_kitchen.py"));
let seedBytes, seedVerification, seedMetadata;
if (seedArgument) {
  const seedPath = await fs.realpath(path.resolve(seedArgument));
  assert.equal(path.basename(seedPath), "kitchen.py", "The frozen seed must retain the original kitchen.py filename");
  seedBytes = await fs.readFile(seedPath);
  // Prove the exact input with the unchanged oracle before any new Gateway or
  // task exists. The verifier creates and removes only its temporary test data.
  const checked = await execute(python, [path.join(skillSource, "scripts/verify_kitchen.py"), "--project", path.dirname(seedPath)], {
    cwd: path.dirname(seedPath), timeout: 120000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(checked.stderr, ""); assert.match(checked.stdout, /KITCHEN_VERIFIED\s*$/u);
  const acceptance = JSON.parse(checked.stdout.trim().split(/\r?\n/u)[0]);
  assert.equal(acceptance.status, "PASS"); assert.equal(acceptance.scenarios, 21);
  assert.equal(acceptance.codeHash, hash(seedBytes));
  assert.equal(hash(await fs.readFile(seedPath)), hash(seedBytes), "The source changed during seed verification");
  seedVerification = { source: seedPath, exitCode: 0, verifierSha256: hash(verifierSource), ...acceptance,
    stdout: checked.stdout, stderr: checked.stderr, observedAt: Date.now() };
  seedMetadata = { source: seedPath, sha256: hash(seedBytes), exactByteCopyBeforeAdmission: true,
    businessCodeAuthoredByObserver: false, unchangedBundledVerifier: { exitCode: 0, status: acceptance.status,
      scenarios: acceptance.scenarios, codeHash: acceptance.codeHash, verifierSha256: hash(verifierSource) },
    fullProof: live ? "seed-verifier-proof.json" : "Retained in memory during local preflight; a live run saves complete stdout before admission" };
}
// Observe the complete machine-protocol path, not just the final task adapter.
// These files are copied into the new plugin and checked before Gateway startup.
const adapterPaths = [
  "lib/runtime-v2/reviewer.mjs", "lib/runtime-v2/ground-truth-provenance.mjs", "lib/runtime-v2/ground-truth-ledger.mjs",
  "lib/runtime-v2/metrics.mjs", "lib/runtime-v2/review-scope.mjs", "lib/runtime-v2/review-routing.mjs",
  "lib/runtime-v2/stop-task-review.mjs", "lib/runtime-v2/orchestrator.mjs", "lib/runtime-v2/review-collector.mjs",
  "lib/runtime-v2/artifact-candidates.mjs", "lib/artifact-pipeline.mjs",
  "lib/openclaw/reviewer.mjs", "lib/openclaw/runtime.mjs", "lib/openclaw/stop-task-runtime.mjs",
  "lib/review-task/review-task.mjs", "lib/review-task/history-memory.mjs", "lib/review-task/prompts.json",
  "lib/review-task/prompt-profile.mjs", "lib/review-task/package-lock.json",
];
const sourceRevision = (await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
const sourceClean = !(await execute("git", ["status", "--porcelain"], { cwd: repository })).stdout.trim();
const adapterSource = { commit: sourceRevision, sourceClean, files: Object.fromEntries(await Promise.all(adapterPaths.map(async file =>
  [file, hash(await fs.readFile(path.join(repository, file)))]))) };
const admissionPaths = ["scripts/diagnostics/lib/isolated-openclaw.mjs", "lib/plugin-builder.mjs",
  "experiments/review-metrics-20261024/e2e-plan/gateway-kitchen.mjs", "experiments/review-metrics-20261024/e2e-plan/worktree-fence.mjs",
  "experiments/review-metrics-20261024/e2e-plan/kitchen-policy.yaml",
  `examples/openclaw-offline-kitchen/skills/${skillName}/SKILL.md`,
  `examples/openclaw-offline-kitchen/skills/${skillName}/references/requirements.md`,
  `examples/openclaw-offline-kitchen/skills/${skillName}/scripts/verify_kitchen.py`];
const sourceAdmissionFiles = { ...adapterSource.files, ...Object.fromEntries(await Promise.all(admissionPaths.map(async file =>
  [file, hash(await fs.readFile(path.join(repository, file)))]))) };
const authFiles = [path.join(os.homedir(), ".openclaw/openclaw.json"), path.join(os.homedir(), ".openclaw/agents/main/agent/models.json")];
const authBytes = await Promise.all(authFiles.map(file => fs.readFile(file)));
const [configured, cache] = authBytes.map(bytes => JSON.parse(bytes.toString("utf8")));
const ref = typeof configured.agents?.defaults?.model === "string" ? configured.agents.defaults.model : configured.agents?.defaults?.model?.primary;
const slash = ref.indexOf("/"), providerId = ref.slice(0, slash), modelId = ref.slice(slash + 1);
const p = configured.models?.providers?.[providerId], cached = cache.providers?.[providerId];
const provider = { ...cached, ...p, apiKey: p?.apiKey ?? cached?.apiKey, models: p?.models ?? cached?.models, headers: p?.headers ?? cached?.headers };
const model = provider.models?.find(m => m.id === modelId || m.id === ref);
assert(model && provider.api && provider.baseUrl, "Current authorized model is unavailable");
assert.equal(Object.keys(provider.headers ?? {}).length, 0, "Helper supports standard bearer auth; do not silently drop configured headers");
const resolve = value => typeof value === "string" ? value.replace(/\$\{([^}]+)\}/gu, (_, name) => process.env[name] ?? "") : value;
const key = resolve(provider.apiKey);
assert(typeof key === "string" && key.length > 0 && !key.startsWith("${"), "Existing authorized credential unavailable");
const metadata = { mode, live, hostRoot, hostVersion: pkg.version, node: process.version, python, model: ref,
  modelMetadata: { api: provider.api, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning },
  output, modelCalls: 0, gatewayUsed: false, originalHostModified: false, originalSessionAccessed: false,
  contractSha256: hash(frozenContract), skillSha256: hash(originalSkill), verifierSha256: hash(verifierSource),
  noBusinessCodeAuthoredByObserver: mode === "develop", noBusinessWritesAfterAdmission: true,
  ...(seedMetadata ? { seedApp: seedMetadata } : {}), adapterSource,
  sourceKeyLocation: "Existing authorized configuration/cache read in memory only", status: "PREFLIGHT_READY" };
if (!live) { process.stdout.write(JSON.stringify(metadata, null, 2) + "\n"); process.exit(0); }

await fs.mkdir(allowed, { recursive: true });
await fs.mkdir(output, { mode: 0o700 });
const report = { ...metadata, modelCalls: null, modelCallCountMethod: "No HTTP proxy in this harness; do not infer exact dispatch or billing counts from SDK events", startedAt: Date.now(), status: "RUNNING", currentCodeSource: "working tree at explicit --live admission" };
const secrets = [key], redact = value => secrets.reduce((s, secret) => s.replaceAll(secret, "<redacted>"), String(value));
const save = async (file, value) => fs.writeFile(path.join(output, file), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
await save("source-admission.json", { phase: mode === "develop" ? 4 : 3, at: new Date().toISOString(), sourceCommit: sourceRevision,
  sourceClean, output, mode, modelCallsAtAdmission: 0, gatewayUsedAtAdmission: false, stage4Run: mode === "develop",
  ...(seedMetadata ? { seedSource: seedMetadata.source, seedSha256: seedMetadata.sha256 } : {}),
  files: Object.entries(sourceAdmissionFiles).map(([file, sha256]) => ({ path: file, sha256 })) });
if (seedVerification) await save("seed-verifier-proof.json", seedVerification);
const log = async (phase, extra = {}) => { const row = { at: Date.now(), phase, ...extra }; process.stdout.write(JSON.stringify(row) + "\n"); await fs.appendFile(path.join(output, "timeline.jsonl"), JSON.stringify(row) + "\n"); };
const originals = Object.fromEntries(authFiles.map((file, index) => [file, hash(authBytes[index])]));
const descriptor = path.join(output, "provider.json");
await fs.writeFile(descriptor, JSON.stringify({ baseUrl: provider.baseUrl, api: provider.api, authHeader: provider.authHeader ?? true,
  model: { ...model, cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, null, 2));
const bin = path.join(output, "bin"), temp = path.join(output, "python-temp");
await fs.mkdir(bin); await fs.mkdir(temp);
await fs.writeFile(path.join(bin, "python3.13.cmd"), `@"${python}" %*\r\n`);
const envKeys = ["PATH", "PYTHONUTF8", "PYTHONIOENCODING", "PYTHONDONTWRITEBYTECODE", "TEMP", "TMP", "TMPDIR", "RC_TEST_MODEL_KEY"];
const oldEnv = Object.fromEntries(envKeys.map(name => [name, process.env[name]]));
Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  PYTHONDONTWRITEBYTECODE: "1", TEMP: temp, TMP: temp, TMPDIR: temp, RC_TEST_MODEL_KEY: key });
const freePort = async () => { const s = net.createServer(); await new Promise((r,j) => s.once("error", j).listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; };
const { isolatedHost, runtimeState, files, pause } = await import(pathToFileURL(path.join(repository, "scripts/diagnostics/lib/isolated-openclaw.mjs")));
const hostDestination = path.join(output, "host"), defaultDir = path.join(hostDestination, "default");
const policy = (await fs.readFile(new URL("./kitchen-policy.yaml", import.meta.url), "utf8")).replaceAll("{{modelId}}", model.id);
let host, projectRoot, sessionId;
const keyId = `agent:main:kitchen-${mode}-${randomUUID().slice(0,8)}`;
const digestFiles = async root => Object.fromEntries(await Promise.all((await files(root)).filter(p => !p.replaceAll("\\", "/").includes("/.git/")).map(async p => [path.relative(root,p).replaceAll("\\", "/"), hash(await fs.readFile(p))])));
const protectedPaths = ["spec/requirements.md", ".runtime-corrector/config.yaml", `skills/${skillName}/SKILL.md`, `skills/${skillName}/references/requirements.md`, `skills/${skillName}/scripts/verify_kitchen.py`];
let protectedHashes;
// OBSERVER_WINDOW_START: pure observer calculation, does not write product state.
function stopObservationWindow({ records, sessionId, fallbackDeadline, priorProductDeadline = null, graceMs = 15000 }) {
  const matching = records.filter(record => record.file?.replaceAll("\\", "/").includes("/native-stop-reviews/")
    && record.sessionId === sessionId && Number.isFinite(record.deadlineAt) && record.deadlineAt > 0);
  const productDeadlineAt = Math.max(priorProductDeadline ?? 0, ...matching.map(record => record.deadlineAt)) || null;
  return productDeadlineAt ? { deadlineAt: productDeadlineAt + graceMs, productDeadlineAt, graceMs,
    source: "actual native Stop record deadlineAt; grace is observer-only persistence allowance" }
    : { deadlineAt: fallbackDeadline, productDeadlineAt: null, graceMs: 0,
      source: "finite 30-minute fallback only while no valid own-session native Stop deadline is observed" };
}
// OBSERVER_WINDOW_END
try {
  await log("isolated Gateway preparation; unchanged Skill/verifier and SDK installation");
  report.gatewayStartupAttempted = true;
  host = await isolatedHost({ hostRoot, providerFile: descriptor, destination: hostDestination, port: await freePort(),
    // Existing configured hook ceiling is retained; absent configuration uses the helper default.
    ...(configured.plugins?.entries?.["runtime-corrector"]?.config?.hookTimeoutMs ? { hookTimeoutMs: configured.plugins.entries["runtime-corrector"].config.hookTimeoutMs } : {}),
    tools: ["read", "write", "edit", "exec", "runtime_corrector"],
    platformAdapters: { "offline-kitchen-python-test": { name: "offline-kitchen-python-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] }, sourceManifest: { roots: [], files: ["kitchen.py"], extensions: [".py"] } } },
    preparePlugin: async pluginRoot => {
      for (const [file, digest] of Object.entries(adapterSource.files)) assert.equal(hash(await fs.readFile(path.join(pluginRoot, file))), digest, "Adapter source changed during preparation");
      // Windows npm launcher requires the shell; this command has constant arguments and a checked cwd.
      await execute("npm.cmd", ["ci", "--ignore-scripts", "--omit=dev"], { cwd: pluginRoot, shell: true, timeout: 180000, maxBuffer: 1024 * 1024 });
      const lock = await fs.readFile(path.join(pluginRoot, "lib/review-task/package-lock.json"));
      assert.equal(hash(lock), hash(await fs.readFile(path.join(repository, "lib/review-task/package-lock.json"))));
      await fs.mkdir(path.join(defaultDir, "spec")); await fs.mkdir(path.join(defaultDir, ".runtime-corrector"));
      await fs.cp(skillSource, path.join(defaultDir, "skills", skillName), { recursive: true });
      await fs.writeFile(path.join(defaultDir, "spec/requirements.md"), frozenContract);
      await fs.writeFile(path.join(defaultDir, ".runtime-corrector/config.yaml"), policy);
      await fs.writeFile(path.join(defaultDir, ".gitignore"), ".runtime-correction/\n__pycache__/\n");
      if (mode !== "develop") {
        let app = seedBytes ?? await fs.readFile(path.join(repository, "examples/openclaw-offline-kitchen/app/kitchen.py"), "utf8");
        if (mode === "stop-negative") {
          // A separate faulted fixture, never changed after admission; record the exact mutation below.
          const before = app; app = app.replace('pantry[ing] = pantry.get(ing, 0) - need', 'pantry[ing] = pantry.get(ing, 0)');
          assert.notEqual(app, before, "Archived app shape changed; do not silently run an unbroken negative case");
          report.seedMutation = { sourceSha256: hash(before), badSha256: hash(app), operation: "replace pantry quantity subtraction with unchanged quantity" };
        }
        await fs.writeFile(path.join(defaultDir, "kitchen.py"), app);
      }
      await execute("git", ["init", "--quiet"], { cwd: defaultDir });
      await execute("git", ["add", "."], { cwd: defaultDir });
      await execute("git", ["-c", "user.name=RC Isolated Validation", "-c", "user.email=validation@example.invalid", "commit", "--quiet", "-m", "Frozen isolated kitchen input"], { cwd: defaultDir });
      report.preAdmissionInput = await digestFiles(defaultDir);
    }
  });
  report.gatewayUsed = true; report.gatewayPort = host.config.gateway.port;
  const created = await host.request("sessions.create", { key: keyId, label: `Kitchen ${mode}`, model: host.model, worktree: true, emitCommandHooks: false });
  sessionId = created.sessionId ?? created.entry?.sessionId;
  // The native create response must identify a worktree belonging to the new
  // frozen default git. Prove ownership before even the status command and
  // before any business model request; a generic absolute path is insufficient.
  assert(created.worktree?.path, "Native session creation did not return its managed worktree");
  const ownership = await assertIsolatedWorktree({ projectRoot: created.worktree.path, defaultDir, runRoot: output,
    stateDir: host.stateDir, repositoryRoot: repository,
    forbiddenRoots: ["C:/Users/user/workspace/program_workspace/RC-Exp/ma-vk-rc-r0"] });
  report.worktreeOwnership = ownership;
  await save("worktree-ownership.json", ownership);
  const status = await host.status(keyId); await save("project-status.json", status);
  assert.equal(status.source, "host"); assert.equal(status.enabled, true);
  projectRoot = status.projectRoot;
  assert.equal(await fs.realpath(projectRoot), ownership.projectRoot, "RC project status selected another worktree");
  assert(projectRoot && projectRoot !== defaultDir && path.isAbsolute(projectRoot));
  const relativeProject = path.relative(output, projectRoot);
  assert(relativeProject && relativeProject !== ".." && !relativeProject.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeProject), "Native worktree must remain inside this isolated run");
  assert(!projectRoot.replaceAll("\\", "/").split("/").includes(".runtime-correction"));
  const verifier = path.join(projectRoot, "skills", skillName, "scripts/verify_kitchen.py");
  protectedHashes = Object.fromEntries(await Promise.all(protectedPaths.map(async relative => [relative, hash(await fs.readFile(path.join(projectRoot, relative)))])));
  assert.equal(protectedHashes[`skills/${skillName}/SKILL.md`], hash(originalSkill));
  assert.equal(protectedHashes[`skills/${skillName}/scripts/verify_kitchen.py`], hash(verifierSource));
  if (mode === "develop") assert.equal(await fs.stat(path.join(projectRoot, "kitchen.py")).catch(() => null), null);
  Object.assign(report, { sessionKey: keyId, sessionId, projectRoot, protectedHashes, startsWithoutKitchen: mode === "develop" });
  await save("manifest.json", report);
  const common = `项目绝对目录=${projectRoot}。正式合同是冻结 spec/requirements.md，完整合同立即生效。应用仅Python标准库、离线本地JSON，不安装依赖；只创建/修改kitchen.py及项目本地应用数据，保留spec、Skill和RC配置。使用read/write/edit操作业务文件，业务文件限本项目；执行bundled verifier时设置workdir=${projectRoot}。在Windows上python3.13命令已由隔离PATH包装到真实Python；不要改Skill或verifier。真实运行原样 bundled verifier：python3.13 "${verifier}" --project "${projectRoot}"。仅在退出0且获得KITCHEN_VERIFIED后宣布完成。如收到RC的偏离反馈，已授权你按原合同修复并重跑该verifier，无需再次确认。`;
  const request = mode === "develop" ? `/skill ${skillName} 从不存在kitchen.py开始开发完整离线厨房应用。读取原Skill及冻结spec，实际实现全部合同并完成真实验收。${common}`
    : mode === "stop" ? `请对当前离线厨房应用完成整体验收并交付。${common}先读取现有代码和正式需求；代码已存在，无需重写。实际执行bundled verifier，若发现实际问题可以按合同修复；准确报告实际结果。`
    : `请进行最终交付验收。${common}本轮是有明确阶段顺序的隔离续作实验：第一轮只读取、实际运行verifier并如实报告本次最终交付结果，先不修改源码；正式应用合同并未豁免。收到RC反馈后的续作已授权实际修复并复验。第一轮只读是实验操作顺序，不得当作业务验收通过或删除正式合同。`;
  await save("request.md", request); await log("real business model task admission", { projectRoot, mode });
  const first = await host.send(keyId, request, 1200000); await save("first-terminal.json", first);
  const fallbackDeadline = Date.now() + 1800000; let signature, finalState, observedWindow, windowSignature;
  while (true) {
    const state = await runtimeState(projectRoot);
    observedWindow = stopObservationWindow({ records: state.records, sessionId, fallbackDeadline,
      priorProductDeadline: observedWindow?.productDeadlineAt });
    if (JSON.stringify(observedWindow) !== windowSignature) {
      windowSignature = JSON.stringify(observedWindow);
      await save("observer-deadline.json", { observedAt: Date.now(), ...observedWindow, productDeadlineModified: false });
      await log("observer follows actual Stop deadline", observedWindow);
    }
    const compact = { tasks: state.tasks.map(t => ({ taskId: t.taskId, status: t.status, verification: t.verification?.status, groundTruthVersion: t.groundTruth?.version, corrections: t.stop?.correctionAttempts })),
      stopRecords: state.records.filter(r => r.file.includes("/native-stop-reviews/")).map(r => ({ status: r.status, reviewStatus: r.reviewStatus, reasonCode: r.reasonCode })),
      receipts: state.records.filter(r => r.file.includes("/native-followups/")).map(r => ({ status: r.status, observed: Boolean(r.modelObservedAt), finished: Boolean(r.finishedAt), reviewStatus: r.reviewStatus })) };
    if (JSON.stringify(compact) !== signature) { signature = JSON.stringify(compact); await log("Stop observation", compact); await save("progress.json", compact); }
    const active = state.records.some(r => ["PENDING", "RUNNING", "DISPATCH_COMMITTED"].includes(r.status));
    const receipts = state.records.filter(r => r.file.includes("/native-followups/"));
    const finished = state.tasks.find(t => t.status === "COMPLETED" && t.verification?.status === "PASS");
    if (finished && !active && receipts.every(r => !["RESERVED", "ADMITTED"].includes(r.status) || r.finishedAt)) { finalState = state; break; }
    if (!active && state.tasks.some(t => t.verification?.correctionBudgetExhausted)) throw new Error("Correction budget exhausted; do not change budget or business assertions");
    if (!active && state.records.some(r => r.file.includes("/native-stop-reviews/") && ["UNVERIFIED", "CANCELLED"].includes(r.reviewStatus)) && !receipts.some(r => ["RESERVED", "ADMITTED"].includes(r.status))) throw new Error("Stop ended without verification; inspect saved trace");
    if (Date.now() >= observedWindow.deadlineAt) break;
    await pause(1500);
  }
  assert(finalState, observedWindow?.productDeadlineAt
    ? "Observer reached the recorded product Stop deadline plus 15-second persistence grace; never infer PASS from business output"
    : "No valid own-session Stop deadline observed before finite fallback; never infer PASS from business output");
  await save("runtime-final.json", finalState);
  const accepted = await execute(python, [verifier, "--project", projectRoot], { cwd: projectRoot, timeout: 120000, maxBuffer: 1024 * 1024 });
  assert.equal(accepted.stderr, ""); assert.match(accepted.stdout, /KITCHEN_VERIFIED\s*$/u);
  const app = JSON.parse(accepted.stdout.trim().split("\n")[0]); assert.equal(app.status, "PASS"); assert.equal(app.scenarios, 21);
  await save("independent-business-acceptance.json", { ...app, stdout: accepted.stdout, stderr: accepted.stderr });
  const allFiles = await files(path.join(projectRoot, ".runtime-correction"));
  const populations = [];
  for (const file of allFiles.filter(p => p.replaceAll("\\", "/").endsWith("/metrics/population.json"))) { const pop = JSON.parse(await fs.readFile(file, "utf8")); populations.push({ file, digest: pop.digest, counts: Object.fromEntries(Object.entries(pop.metrics ?? {}).map(([id, objects]) => [id, objects.length])) }); }
  const roleCounts = {};
  for (const record of finalState.records.filter(r => r.file.includes("/native-runs/"))) roleCounts[record.role ?? "unknown"] = (roleCounts[record.role ?? "unknown"] ?? 0) + 1;
  const taskRuns = allFiles.filter(p => p.replaceAll("\\", "/").includes("/review-task-runs/") && p.endsWith("result.json"));
  const workerResults = await Promise.all(taskRuns.map(async file => { const r=JSON.parse(await fs.readFile(file,"utf8")); return { file, taskId:r.taskId, scope:r.scope, completed:r.completed, verdict:r.verdict, elapsedMs:r.elapsedMs, metrics:r.metrics }; }));
  const nativeBusinessVerifierCalls = host.events.filter(e => e.event === "agent" && e.payload?.stream === "tool" && e.payload.data?.name === "exec" && e.payload.data.phase === "start" && JSON.stringify(e.payload.data.args).includes("verify_kitchen.py"));
  // The unchanged actual CLI output remains independently authoritative; tool event naming varies by host release.
  for (const [relative, digest] of Object.entries(protectedHashes)) assert.equal(hash(await fs.readFile(path.join(projectRoot, relative))), digest, `Protected fixture changed: ${relative}`);
  for (const [file, digest] of Object.entries(originals)) assert.equal(hash(await fs.readFile(file)), digest, "Original host configuration/cache changed");
  Object.assign(report, { status: "PASS", finishedAt: Date.now(), businessAcceptance: app, populations, roleCounts, workerResults,
    nativeBusinessVerifierToolEvents: nativeBusinessVerifierCalls.length, fullStopVerified: finalState.tasks.some(t => t.verification?.status === "PASS"),
    artifactReviewConfigured: true, skillReviewConfigured: true, implementationReviewConfigured: true, stopReviewConfigured: true,
    scopeBoundary: "Only naturally populated metrics count as full Stop coverage. Enabled modules are not claimed triggered without saved records.",
    protectedInputsUnchanged: true, originalHostConfigurationUnchanged: true });
  await log("whole Stop and independent 21-scenario acceptance completed", { status: report.status, populations });
} catch (error) {
  Object.assign(report, { status: "FAIL", failedAt: Date.now(), error: redact(error.stack) });
  if (projectRoot) await save("runtime-at-failure.json", await runtimeState(projectRoot)).catch(() => {});
  await log("failed; retained independent evidence and unchanged assertions", { error: redact(error.message) });
} finally {
  if (host) await host.close();
  for (const [name, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await save("report.json", report);
}
process.exitCode = report.status === "PASS" ? 0 : 1;
