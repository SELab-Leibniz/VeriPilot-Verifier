// A single real from-empty development run. --live is an explicit admission gate.
// All fixtures are prepared before admission; the observer never authors app code.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isolatedHost, runtimeState, files, pause } from "../../scripts/diagnostics/lib/isolated-openclaw.mjs";
import { assertIsolatedWorktree } from "../review-metrics-20261024/e2e-plan/worktree-fence.mjs";
import { classifyStopTerminal } from "../review-metrics-20261024/e2e-plan/stop-terminal.mjs";
import { fixtureConfig } from "./fixture-config.mjs";
import { loadRuntimePlan } from "../../lib/runtime-plan.mjs";
import { METRIC_CATALOG, METRIC_CATALOG_VERSION } from "../../lib/runtime-v2/metrics.mjs";

const execute = promisify(execFile), repository = await fs.realpath(process.cwd());
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), live = args.includes("--live");
assert(args.every(a => a === "--live" || a.startsWith("--output=") || a.startsWith("--case=") || a.startsWith("--max-corrections=")), "Unknown argument");
const budgetArgument = args.find(a => a.startsWith("--max-corrections="));
const maxCorrections = budgetArgument ? Number(budgetArgument.slice("--max-corrections=".length)) : null;
assert(maxCorrections === null || Number.isSafeInteger(maxCorrections) && maxCorrections >= 0);
const scenario = args.find(a => a.startsWith("--case="))?.slice(7) ?? "todolist";
assert(["todolist", "kitchen"].includes(scenario));
const kitchen = scenario === "kitchen", appFile = kitchen ? "kitchen.py" : "todo.py";
const scenarioName = kitchen ? "离线厨房" : "TodoList";
const successMarker = kitchen ? "KITCHEN_VERIFIED" : "TODOLIST_VERIFIED";
const expectedScenarios = kitchen ? 21 : 10;
const platform = `offline-${scenario}-python-test`;
const skillRoot = path.join(repository, "examples/openclaw-offline-kitchen/skills/build-offline-kitchen");
const verifierRelative = kitchen ? "skills/build-offline-kitchen/scripts/verify_kitchen.py" : "acceptance/verify_todolist.py";
const output = path.resolve(args.find(a => a.startsWith("--output="))?.slice(9)
  ?? path.join(repository, "experiments", `live-${scenario}-${Date.now()}`));
assert.equal(path.dirname(output), path.join(repository, "experiments"));
assert(new RegExp(`^live-${scenario}-[a-zA-Z0-9-]+$`, "u").test(path.basename(output)));
const hostRoot = "C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw";
const python = "C:/Users/user/miniforge3/python.exe";
const hash = b => createHash("sha256").update(b).digest("hex");
const sourceCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
const sourceBranch = (await execute("git", ["branch", "--show-current"], { cwd: repository })).stdout.trim();
const sourcePaths = (await Promise.all(["lib", "config"].map(p => files(path.join(repository, p))))).flat()
  .filter(p => !p.replaceAll("\\", "/").includes("/node_modules/"));
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async p =>
  [path.relative(repository, p).replaceAll("\\", "/"), hash(await fs.readFile(p))])));
const fixtures = kitchen ? {
  "spec/requirements.md": await fs.readFile(path.join(skillRoot, "references/requirements.md")),
  "skills/build-offline-kitchen/SKILL.md": await fs.readFile(path.join(skillRoot, "SKILL.md")),
  "skills/build-offline-kitchen/references/requirements.md": await fs.readFile(path.join(skillRoot, "references/requirements.md")),
  [verifierRelative]: await fs.readFile(path.join(skillRoot, "scripts/verify_kitchen.py")),
} : {
  "spec/requirements.md": await fs.readFile(path.join(here, "requirements.md")),
  "test_todo.py": await fs.readFile(path.join(repository, "examples/python-todolist-transactions/test_todo.py")),
  "acceptance/verify_todolist.py": await fs.readFile(path.join(here, "verify_todolist.py")),
};
const authFiles = [path.join(os.homedir(), ".openclaw/openclaw.json"), path.join(os.homedir(), ".openclaw/agents/main/agent/models.json")];
const authBytes = await Promise.all(authFiles.map(p => fs.readFile(p)));
const [configured, cache] = authBytes.map(b => JSON.parse(b.toString("utf8")));
const ref = typeof configured.agents?.defaults?.model === "string"
  ? configured.agents.defaults.model : configured.agents?.defaults?.model?.primary;
assert(typeof ref === "string" && ref.includes("/"));
const slash = ref.indexOf("/"), providerId = ref.slice(0, slash), modelId = ref.slice(slash + 1);
const p = configured.models?.providers?.[providerId], c = cache.providers?.[providerId];
const provider = { ...c, ...p, apiKey: p?.apiKey ?? c?.apiKey, models: p?.models ?? c?.models, headers: p?.headers ?? c?.headers };
const model = provider.models?.find(m => m.id === modelId || m.id === ref);
assert(model && provider.api && provider.baseUrl, "Existing authorized model unavailable");
assert.equal(Object.keys(provider.headers ?? {}).length, 0, "Unsupported custom auth headers");
const key = typeof provider.apiKey === "string" ? provider.apiKey.replace(/\$\{([^}]+)\}/gu, (_, n) => process.env[n] ?? "") : null;
assert(key && !key.startsWith("${"), "Existing authorized credential unavailable");
fixtures[".runtime-corrector/config.yaml"] = fixtureConfig(await fs.readFile(path.join(here, "config.yaml"), "utf8"),
  { modelId: model.id, scenario, maxCorrections });
fixtures[".gitignore"] = Buffer.from(".runtime-correction/\n__pycache__/\n");
const protectedHashes = Object.fromEntries(Object.entries(fixtures).map(([p, bytes]) => [p, hash(bytes)]));
const originals = Object.fromEntries(authFiles.map((file, i) => [file, hash(authBytes[i])]));
const report = { status: "PREFLIGHT_READY", scenario, appFile, verifierRelative, expectedScenarios, output, sourceCommit, model: ref, hostRoot, python,
  sourceBranch, metricCatalogVersion: METRIC_CATALOG_VERSION, m16PolicySha256: hash(METRIC_CATALOG.M16.description),
  maxCorrectionsOverride: maxCorrections,
  maxCorrectionsPerEpoch: maxCorrections ?? JSON.parse(await fs.readFile(path.join(repository, "config/stop-defaults.json"), "utf8")).maxCorrectionsPerEpoch,
  documentCorrectionEnabled: false, skillCorrectionEnabled: false, stopCorrectionEnabled: true,
  implementationCorrectionEnabled: true, startsWithoutApp: true, protectedHashes,
  businessCodeAuthoredByObserver: false, originalSessionAccessed: false,
  modelCalls: null, modelCallCountMethod: "No HTTP proxy; SDK events are not exact billing counts" };
if (!live) { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exit(0); }
await fs.mkdir(output, { mode: 0o700 });
const redact = value => String(value).replaceAll(key, "<redacted>");
const save = async (name, value) => fs.writeFile(path.join(output, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
const log = async (phase, extra = {}) => { const row = { at: Date.now(), phase, ...extra };
  process.stdout.write(JSON.stringify(row) + "\n"); await fs.appendFile(path.join(output, "timeline.jsonl"), JSON.stringify(row) + "\n"); };
Object.assign(report, { status: "RUNNING", startedAt: Date.now() });
await save("source-admission.json", { sourceCommit, sourceBranch, sourceHashes, protectedHashes,
  metricCatalogVersion: METRIC_CATALOG_VERSION, m16PolicySha256: report.m16PolicySha256, admittedAt: report.startedAt });
await fs.writeFile(path.join(output, "observer-at-admission.mjs"), await fs.readFile(fileURLToPath(import.meta.url)));
await save("manifest.json", report);
const providerFile = path.join(output, "provider.json");
await fs.writeFile(providerFile, JSON.stringify({ baseUrl: provider.baseUrl, api: provider.api, authHeader: provider.authHeader ?? true,
  model: { ...model, cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, null, 2));
const bin = path.join(output, "bin"), temp = path.join(output, "python-temp");
await fs.mkdir(bin); await fs.mkdir(temp);
await fs.writeFile(path.join(bin, "python3.13.cmd"), `@"${python}" %*\r\n`);
Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  PYTHONDONTWRITEBYTECODE: "1", TEMP: temp, TMP: temp, TMPDIR: temp, RC_TEST_MODEL_KEY: key });
const freePort = async () => { const s = net.createServer(); await new Promise((r, j) => s.once("error", j).listen(0, "127.0.0.1", r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port; };
const destination = path.join(output, "host"), defaultDir = path.join(destination, "default");
let host, projectRoot, sessionId, businessOutcome, businessError, businessFinished = false, worktreeProtectedHashes;
const sessionKey = `agent:main:${scenario}-${randomUUID().slice(0, 8)}`;
const archived = new Map();
const archiveNative = async () => {
  for (const file of await files(path.join(projectRoot, ".runtime-correction/.internal-requests"))) {
    try {
      const stat = await fs.stat(file), signature = `${stat.size}:${stat.mtimeMs}`;
      if (archived.get(file) === signature) continue;
      const relative = path.relative(path.join(projectRoot, ".runtime-correction/.internal-requests"), file);
      const target = path.join(output, "native-traces-snapshots", relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file, target); archived.set(file, signature);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
};
try {
  await log("prepare isolated Gateway; freeze tests; no application source");
  host = await isolatedHost({ hostRoot, providerFile, destination, port: await freePort(),
    ...(configured.plugins?.entries?.["runtime-corrector"]?.config?.hookTimeoutMs
      ? { hookTimeoutMs: configured.plugins.entries["runtime-corrector"].config.hookTimeoutMs } : {}),
    platformAdapters: { [platform]: { name: platform,
      kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
      sourceManifest: { roots: [], files: [appFile], extensions: [".py"] } } },
    preparePlugin: async pluginRoot => {
      for (const [file, digest] of Object.entries(sourceHashes)) {
        // buildPlugin intentionally selects the actual host in this generated entry.
        if (["lib/active-host.mjs", "lib/claude-executable.mjs", "lib/plugin-builder.mjs",
          "lib/hosts/claude.mjs", "lib/hosts/codeagent.mjs"].includes(file)) continue;
        assert.equal(hash(await fs.readFile(path.join(pluginRoot, file))), digest, `Plugin copy differs: ${file}`);
      }
      assert.match(await fs.readFile(path.join(pluginRoot, "lib/active-host.mjs"), "utf8"), /hosts\/openclaw\.mjs/u);
      await execute("npm.cmd", ["ci", "--ignore-scripts", "--omit=dev"], { cwd: pluginRoot, shell: true, timeout: 180000, maxBuffer: 1024 * 1024 });
      for (const [file, bytes] of Object.entries(fixtures)) { const target = path.join(defaultDir, file);
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
      assert.equal(await fs.stat(path.join(defaultDir, appFile)).catch(() => null), null);
      await execute("git", ["init", "--quiet"], { cwd: defaultDir });
      await execute("git", ["add", "."], { cwd: defaultDir });
      await execute("git", ["-c", "user.name=RC Isolated Validation", "-c", "user.email=validation@example.invalid", "commit", "--quiet", "-m", `Frozen isolated ${scenario} acceptance; no app`], { cwd: defaultDir });
    } });
  const created = await host.request("sessions.create", { key: sessionKey, label: `Isolated Python ${scenario} E2E`, model: host.model, worktree: true, emitCommandHooks: false });
  sessionId = created.sessionId ?? created.entry?.sessionId;
  assert(created.worktree?.path && sessionId);
  const ownership = await assertIsolatedWorktree({ projectRoot: created.worktree.path, defaultDir, runRoot: output,
    stateDir: host.stateDir, repositoryRoot: repository,
    forbiddenRoots: ["C:/Users/user/workspace/program_workspace/RC-Exp/ma-vk-rc-r0"] });
  await save("worktree-ownership.json", ownership);
  const status = await host.status(sessionKey); await save("project-status.json", status);
  assert.equal(status.source, "host"); assert.equal(status.enabled, true);
  projectRoot = status.projectRoot;
  assert.equal(await fs.realpath(projectRoot), ownership.projectRoot);
  assert.equal(await fs.stat(path.join(projectRoot, appFile)).catch(() => null), null);
  const effectivePlan = await loadRuntimePlan({ cwd: projectRoot, pluginRoot: host.pluginRoot });
  const actual = effectivePlan.runtimeV2;
  assert.equal(actual.skillCorrection.enabled, false);
  assert.equal(actual.artifactCorrection.groundTruthReviewEnabled, false);
  assert.equal(actual.artifactCorrection.stageMetricsEnabled, false);
  assert.equal(actual.stopCorrection.enabled, true);
  assert.equal(actual.stopCorrection.maxCorrectionsPerEpoch, report.maxCorrectionsPerEpoch);
  assert.equal(actual.implementationCorrection.enabled, true);
  assert(effectivePlan.artifacts.every(artifact => artifact.reviewEnabled === false && artifact.rulesPolicy.enabled === false));
  await save("effective-config.json", { skillCorrection: actual.skillCorrection, artifactCorrection: actual.artifactCorrection,
    stopCorrection: actual.stopCorrection, implementationCorrection: actual.implementationCorrection,
    metricCatalogVersion: METRIC_CATALOG_VERSION });
  worktreeProtectedHashes = {};
  for (const [file, expected] of Object.entries(fixtures)) {
    const actual = await fs.readFile(path.join(projectRoot, file));
    // Git's Windows checkout may convert LF to CRLF before task admission.
    const normalize = bytes => bytes.toString("utf8").replaceAll("\r\n", "\n");
    assert.equal(normalize(actual), normalize(expected), `Frozen fixture differs after checkout: ${file}`);
    worktreeProtectedHashes[file] = hash(actual);
  }
  const verifier = path.join(projectRoot, verifierRelative);
  Object.assign(report, { sessionKey, sessionId, projectRoot, gatewayPort: host.config.gateway.port, hostVersion: host.version, worktreeProtectedHashes });
  await save("manifest.json", report);
  const request = `请从不存在${appFile}开始，开发并交付离线Python ${scenarioName} CLI。项目绝对目录=${projectRoot}。正式完整合同是冻结的spec/requirements.md，读取该合同${kitchen ? "及skills/build-offline-kitchen/SKILL.md，使用原Skill中的业务步骤" : "和test_todo.py"}，实现全部需求。仅Python标准库；不安装依赖、不联网、不从其他项目复制现成实现。仅创建或修改${appFile}及项目本地应用数据，保留合同、Skill、测试、验收器和RC配置。使用read/write/edit操作业务文件，exec的workdir明确设为项目目录。宿主是Windows PowerShell，不支持&&；列目录用Get-ChildItem，不要使用dir /b或拼接cd命令。python3.13已包装到真实Python。${kitchen ? "厨房验收器以python -I -S启动应用，忽略PYTHONUTF8环境变量；需保证Windows管道中的Unicode JSON正确输出。" : ""}真实运行原样冻结验收器：python3.13 "${verifier}" --project "${projectRoot}"。验收器/测试明确允许创建并清理其自己的TemporaryDirectory；其他业务写入仍限本项目。只有该命令退出0并输出${successMarker}，才可声明已验证完成。如收到纠偏反馈，已经授权按完整原合同修复${appFile}并重跑原验收器，无需再次确认。文档纠偏和Skill纠偏关闭，Stop和实现核验开启；不要自行改配置。最终回复简短说明实际结果。`;
  await save("request.md", request); await log("business admission", { projectRoot, sessionId, sessionKey });
  // Keep the observer responsive and persist partial outcomes while chat.send is pending.
  const business = host.send(sessionKey, request).then(async value => { businessOutcome = value;
    await save("first-terminal.json", value); businessFinished = true;
  }, async error => { businessError = error; businessFinished = true; await save("business-error.json", { error: redact(error.stack) }); });
  const fallbackDeadline = Date.now() + 1800000; let signature, productDeadline = 0, rejectionSince = 0, finalTerminal;
  while (true) {
    await archiveNative();
    const state = await runtimeState(projectRoot);
    const tasks = state.tasks.filter(t => t.rootSessionId === sessionId || t.sessionIds?.includes(sessionId));
    assert(tasks.length <= 1, "Ambiguous own-session task");
    const task = tasks[0];
    for (const r of state.records) if (r.file.includes("/native-stop-reviews/") && r.sessionId === sessionId && Number.isFinite(r.deadlineAt)) productDeadline = Math.max(productDeadline, r.deadlineAt);
    let population;
    if (task) try { population = JSON.parse(await fs.readFile(path.join(projectRoot, ".runtime-correction/tasks", task.taskId, "metrics/population.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    let terminal = classifyStopTerminal(state, { taskId: task?.taskId, population, ownerAlive: host.health.alive });
    const latestOwnStop = state.records.filter(r => r.file.includes("/native-stop-reviews/") && r.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    // A committed product expiry is terminal failure even when its followup
    // receipt is left open. Do not wait for a later child-job deadline.
    if (terminal.kind === "WAITING" && latestOwnStop?.status === "SETTLED"
      && ["REVIEW_DEADLINE_EXPIRED", "STOP_WAIT_DEADLINE_EXPIRED"].includes(latestOwnStop.reasonCode))
      terminal = { kind: "NOT_ACCEPTED", allMetricsPass: false, reasonCode: latestOwnStop.reasonCode,
        reason: "Product Stop expired; an unfinished receipt does not extend the observer wait.", taskId: task?.taskId };
    const compact = { businessFinished, owner: host.health, tasks: tasks.map(t => ({ taskId: t.taskId, status: t.status,
      verification: t.verification?.status, groundTruthVersion: t.groundTruth?.version, corrections: t.stop?.correctionAttempts })),
      stops: state.records.filter(r => r.file.includes("/native-stop-reviews/")).map(r => ({ jobId: r.jobId, status: r.status, reviewStatus: r.reviewStatus, reasonCode: r.reasonCode, followupStatus: r.followupStatus })),
      runs: state.records.filter(r => r.file.includes("/native-runs/")).map(r => ({ role: r.role, status: r.status })),
      receipts: state.records.filter(r => r.file.includes("/native-followups/")).map(r => ({ status: r.status, observed: Boolean(r.modelObservedAt), finished: Boolean(r.finishedAt) })), terminal: terminal.kind };
    if (JSON.stringify(compact) !== signature) { signature = JSON.stringify(compact);
      await log("observation", compact); await save("progress.json", compact); await save("runtime-progress.json", state); }
    if (businessFinished && ["ALL_METRICS_PASS", "SETTLED_WITH_UNVERIFIED"].includes(terminal.kind)) { finalTerminal = terminal; break; }
    if (terminal.kind === "NOT_ACCEPTED") {
      rejectionSince ||= Date.now();
      if (Date.now() - rejectionSince >= 15000 || !host.health.alive) { finalTerminal = terminal; break; }
    } else rejectionSince = 0;
    if (businessError || Date.now() >= (productDeadline ? productDeadline + 15000 : fallbackDeadline)) {
      finalTerminal = { kind: "NOT_ACCEPTED", allMetricsPass: false, reason: businessError?.message ?? "Recorded Stop deadline elapsed; no certified terminal", productDeadline }; break;
    }
    await pause(4000);
  }
  await save("stop-terminal.json", { ...finalTerminal, observedAt: Date.now(), owner: host.health });
  Object.assign(report, { stopTerminal: finalTerminal, businessTurnFinished: businessFinished, businessTurnError: businessError?.message,
    status: finalTerminal.kind });
  // This verifier writes only its isolated test temp data, regardless of Stop outcome.
  let accepted;
  try { const value = await execute(python, [verifier, "--project", projectRoot], { cwd: projectRoot, timeout: 120000, maxBuffer: 1024 * 1024 });
    accepted = { exitCode: 0, stdout: value.stdout, stderr: value.stderr }; }
  catch (e) { accepted = { exitCode: e.code, stdout: e.stdout, stderr: e.stderr }; }
  await save("independent-business-acceptance.json", accepted);
  report.businessAcceptance = JSON.parse(accepted.stdout.trim().split(/\r?\n/u)[0]);
  report.businessAcceptance.exitCode = accepted.exitCode;
  if (report.businessAcceptance.status !== "PASS" || accepted.exitCode !== 0
    || report.businessAcceptance.scenarios !== expectedScenarios || !accepted.stdout.includes(successMarker)) report.status = "BUSINESS_FAILED";
  if (businessFinished) await business;
} catch (error) {
  Object.assign(report, { status: "HARNESS_FAILED", error: redact(error.stack) });
  await log("harness failure", { error: redact(error.message) });
} finally {
  if (projectRoot) await save("runtime-final.json", await runtimeState(projectRoot)).catch(e => { report.snapshotError = redact(e.message); });
  if (projectRoot && worktreeProtectedHashes) {
    report.protectedInputChecks = Object.fromEntries(await Promise.all(Object.entries(worktreeProtectedHashes).map(async ([file, digest]) => {
      const bytes = await fs.readFile(path.join(projectRoot, file)).catch(() => null);
      return [file, bytes !== null && hash(bytes) === digest];
    })));
  }
  report.originalHostChecks = Object.fromEntries(await Promise.all(Object.entries(originals).map(async ([file, digest]) => {
    const bytes = await fs.readFile(file).catch(() => null);
    return [file, bytes !== null && hash(bytes) === digest];
  })));
  if (Object.values(report.protectedInputChecks ?? {}).includes(false) || Object.values(report.originalHostChecks).includes(false))
    report.status = "INTEGRITY_FAILED";
  if (host) { report.ownerBeforeClose = host.health; await host.close(); report.ownedGatewayClosed = true; }
  report.finishedAt = Date.now();
  await save("report.json", report); await log("run ended", { status: report.status, businessAcceptance: report.businessAcceptance?.status, elapsedMs: report.finishedAt - report.startedAt });
}
process.exitCode = ["ALL_METRICS_PASS", "SETTLED_WITH_UNVERIFIED"].includes(report.status) && report.businessAcceptance?.status === "PASS" ? 0 : 1;
