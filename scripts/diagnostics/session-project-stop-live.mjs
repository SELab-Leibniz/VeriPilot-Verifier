import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { isolatedHost, runtimeState, pause } from "./lib/isolated-openclaw.mjs";
const execute = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const [hostRoot, providerFile, destination, port] = process.argv.slice(2);
if (!hostRoot || !providerFile || !destination || !port) throw new Error("hostRoot providerFile new-output-directory port required");
const h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), platformAdapters: {
  "mini-python-stop-test": { name: "mini-python-stop-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
    sourceManifest: { roots: [], files: ["mini_app.py"], extensions: [".py"] } },
} });
const baseline = process.env.RC_EXPERIMENT_BASELINE ?? "working-tree";
const native = h.version === "2026.10.3", outcome = { hostVersion: h.version, baseline, experiment: "E1/E2/E4", cases: [], status: "RUNNING" };
const milestone = value => { process.stdout.write(JSON.stringify({ hostVersion: h.version, at: Date.now(), ...value }) + "\n"); };
const policy = stop => `version: 2\nartifacts:\n  - name: app\n    stage: proposal\n    patterns: [mini_app.py]\n    rules:\n      enabled: false\n    review:\n      enabled: false\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: [spec/requirements.md]\n  panel:\n    size: 1\n    adjudicator: false\nartifactCorrection:\n  groundTruthReviewEnabled: false\nstopCorrection:\n  enabled: ${stop}\n  assessmentTimeoutMs: 720000\n  maxCorrectionsPerEpoch: 2\nimplementationCorrection:\n  enabled: ${stop}\n  platform: mini-python-stop-test\nreviewers:\n  defaults:\n    model: ${h.model}\n    effort: low\n    timeoutMs: 240000\n`;
const app = stamp => `import argparse\n\ndef main():\n    parser = argparse.ArgumentParser(description="Readiness CLI")\n    parser.parse_args()\n    print("${stamp}")\n\nif __name__ == "__main__":\n    main()\n`;
async function prepare(name, stamp, stop = true) {
  const directory = path.join(h.root, name); await fs.mkdir(path.join(directory, ".runtime-corrector"), { recursive: true });
  await fs.mkdir(path.join(directory, "spec"));
  await fs.writeFile(path.join(directory, ".runtime-corrector/config.yaml"), policy(stop));
  await fs.writeFile(path.join(directory, "mini_app.py"), app(stamp));
  await fs.writeFile(path.join(directory, "spec/requirements.md"), `# Formal requirements\nR01 Default CLI exits 0 and stdout is exactly ${name === "A" ? "READY" : stamp} plus one newline; stderr is empty.\nR02 --help exits 0 and shows usage; Python standard library only.\nR03 Only mini_app.py may be edited. Do not modify requirements, AGENTS, RC configuration or host.\n`);
  await fs.writeFile(path.join(directory, "AGENTS.md"), "Only work on this project's mini_app.py under the user's instructions. Preserve requirements and RC configuration. Use read/edit/write for code, exec for the explicit Python validation commands. No dependencies or external filesystem edits.\n");
  await fs.writeFile(path.join(directory, ".gitignore"), ".runtime-correction/\n__pycache__/\n");
  await execute("git", ["init", "--quiet"], { cwd: directory }); await execute("git", ["add", "."], { cwd: directory });
  await execute("git", ["-c", "user.name=RC Experiment", "-c", "user.email=experiment@example.invalid", "commit", "--quiet", "-m", "Frozen experiment fixture"], { cwd: directory });
  const key = `agent:main:rc-stop-${name.toLowerCase()}`;
  const created = await h.request("sessions.create", { key, model: h.model, label: `RC Stop ${name}`, emitCommandHooks: false,
    ...(native ? { cwd: directory, ...(name === "A" ? { worktree: true, worktreeName: "stop-a" } : {}) } : {}) });
  if (!native) await h.send(key, `/rc-project bind ${directory}`, 30000);
  const scope = await h.status(key);
  assert.equal(scope.source, native ? "host" : "rc"); assert.equal(scope.enabled, true);
  const protectedFiles = ["spec/requirements.md", "AGENTS.md", ".runtime-corrector/config.yaml"];
  const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, hash(await fs.readFile(path.join(scope.projectRoot, file)))])));
  return { name, key, sessionId: created.sessionId, origin: directory, projectRoot: scope.projectRoot, scope, protectedHashes };
}
async function acceptance(project, stamp) {
  const main = await execute("python3.13", ["mini_app.py"], { cwd: project.projectRoot, timeout: 10000 });
  const help = await execute("python3.13", ["mini_app.py", "--help"], { cwd: project.projectRoot, timeout: 10000 });
  return { stdout: main.stdout, stderr: main.stderr, ready: main.stdout === stamp + "\n" && main.stderr === "", help: /usage/iu.test(help.stdout) };
}
async function frozen(project) {
  for (const [file, expected] of Object.entries(project.protectedHashes)) assert.equal(hash(await fs.readFile(path.join(project.projectRoot, file))), expected, `Protected file changed: ${project.name}/${file}`);
}
async function waitForReview(project, limit = 60000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const state = await runtimeState(project.projectRoot);
    if (state.records.some(r => r.file.includes("/native-stop-reviews/") && ["PENDING", "RUNNING"].includes(r.status))) return state;
    await pause(1000);
  }
  throw new Error(`No native Stop checkpoint observed for ${project.name}`);
}
async function waitForPass(project, initialRunId, limit = 1800000) {
  const deadline = Date.now() + limit; let signature;
  while (Date.now() < deadline) {
    const state = await runtimeState(project.projectRoot);
    const compact = { tasks: state.tasks.map(t => ({ taskId: t.taskId, status: t.status, groundTruth: t.groundTruth.version,
      correctionAttempts: t.stop.correctionAttempts, verification: t.verification && { status: t.verification.status, assessmentId: t.verification.assessmentId } })),
      stop: state.records.filter(r => r.file.includes("/native-stop-reviews/")).map(r => ({ runId: r.runId, status: r.status, reviewStatus: r.reviewStatus })),
      receipts: state.records.filter(r => r.file.includes("/native-followups/")).map(r => ({ runId: r.runId, status: r.status, observed: Boolean(r.modelObservedAt), reviewStatus: r.reviewStatus, reason: r.reason })) };
    const next = JSON.stringify(compact);
    if (next !== signature) { signature = next; milestone({ project: project.name, phase: "RC progress", ...compact }); await h.save(`${project.name}-progress.json`, compact); }
    const initial = state.records.find(r => r.file.includes("/native-stop-reviews/") && r.runId === initialRunId);
    if (state.evaluations.some(e => e.implementationReview?.status === "COMPLETED" && e.implementationReview.sourceManifestCount === 0)) {
      throw new Error("Experiment platform source manifest is empty; implementation-review fixture is invalid");
    }
    const receipts = state.records.filter(r => r.file.includes("/native-followups/"));
    // Cached hook assessments must not make the observer wait through an
    // unbounded busy retry. Preserve the failed trial before stopping it.
    const retries = state.journals.filter(e => e.type === "NATIVE_STOP_REVIEW_RETRY");
    if (retries.length > 20 && new Set(retries.map(e => e.failureAttempt)).size === 1) throw new Error("Stop repeats one cached infrastructure failure without progressing");
    if (receipts.some(r => ["REJECTED", "UNVERIFIED"].includes(r.status) && !r.modelObservedAt)) throw new Error(`Native continuation not admitted: ${receipts.find(r => ["REJECTED", "UNVERIFIED"].includes(r.status))?.reason}`);
    if (initial?.status === "SETTLED" && initial.reviewStatus === "PASS" && project.name === "A") throw new Error("Fault injection invalid: initial defective delivery was accepted without a deviation");
    const final = state.tasks.find(t => t.status === "COMPLETED" && t.verification?.status === "PASS");
    const active = state.records.filter(r => (r.file.includes("/native-stop-reviews/") || r.file.includes("/native-runs/")) && ["PENDING", "RUNNING", "DISPATCH_COMMITTED"].includes(r.status));
    if (final && !active.length && receipts.every(r => !["RESERVED", "ADMITTED"].includes(r.status) || r.finishedAt)) return state;
    if (!active.length && state.tasks.some(t => t.verification?.correctionBudgetExhausted)) throw new Error("Business correction budget exhausted without PASS");
    if (initial?.status === "SETTLED" && ["CANCELLED", "UNVERIFIED"].includes(initial.reviewStatus) && !active.length && !receipts.length) throw new Error(`Stop did not complete: ${initial.reviewStatus}`);
    await pause(2000);
  }
  throw new Error(`Stop chain observer deadline exceeded for ${project.name}`);
}
try {
  const a = await prepare("A", "BROKEN"), b = await prepare("B", "PEER_READY");
  await h.save("manifest.json", { codeBaseline: baseline, hostVersion: h.version, model: h.model, A: a, B: b,
    settings: { k: 2, roleMs: 240000, stopMs: 720000, hookMs: 600000 }, firstRoundReadOnly: true, observerNeverEditsApp: true,
    peerValidationMethod: native ? "two-cli-exec" : "single-python-subprocess-assertion" });
  const initialAcceptance = await acceptance(a, "READY"); assert.equal(initialAcceptance.ready, false); await h.save("A-initial-acceptance.json", initialAcceptance);
  const promptA = `对项目 ${a.projectRoot} 的 Python CLI 做正式交付验收。正式要求现在生效：\nR01 在该目录执行 python3.13 mini_app.py 必须退出0，stdout严格为READY加一个换行，stderr为空。\nR02 python3.13 mini_app.py --help退出0并显示usage，只用标准库。\nR03 只能修改mini_app.py，不改spec/requirements.md、AGENTS.md、.runtime-corrector或宿主，不安装依赖。\n这是控制Stop续作的故障注入实验。第一轮读取正式需求和当前代码，只运行默认入口与--help检查，不修改代码，然后交付“当前交付验收报告”，如实说明R01。第一轮只读是操作顺序，不是正式要求的阶段豁免。\n如果收到Runtime Corrector的Stop不通过反馈，已经授权你依据R01-R03实际修改mini_app.py并复测默认入口与--help，然后交付报告，无需用户再次确认，不能只解释修法。第一轮不要提前修复。read/edit/write使用${a.projectRoot}内的正确路径；所有exec显式设置workdir=${a.projectRoot}，命令使用上述原样Python调用，不用cd。`;
  await h.save("A-request.md", promptA);
  milestone({ phase: "A initial inspection", projectRoot: a.projectRoot });
  const initial = await h.send(a.key, promptA); await h.save("A-first-terminal.json", initial);
  const initialBytes = await fs.readFile(path.join(a.projectRoot, "mini_app.py")); await h.save("A-first-terminal.py", initialBytes.toString());
  assert(initialBytes.toString().includes('print("BROKEN")'), "Business model repaired before receiving RC feedback; invalid trial");
  await waitForReview(a);
  const peerAssertion = String.raw`import json, subprocess; a = subprocess.run(["python3.13", "mini_app.py"], capture_output=True, text=True); b = subprocess.run(["python3.13", "mini_app.py", "--help"], capture_output=True, text=True); print(json.dumps({"default_exit": a.returncode, "stdout": a.stdout, "stderr": a.stderr, "help_exit": b.returncode, "help_usage": "usage" in b.stdout.lower()})); assert a.returncode == 0 and a.stdout == "PEER_READY\n" and a.stderr == "" and b.returncode == 0 and "usage" in b.stdout.lower(); print("PEER_ACCEPTED")`;
  const peerInstructions = native
    ? `必须分别用两次exec、显式workdir=${b.projectRoot}执行原样命令 python3.13 mini_app.py 和 python3.13 mini_app.py --help。直接读取宿主返回的stdout、stderr和退出码。`
    : `只调用一次exec，显式workdir=${b.projectRoot}，原样执行以下命令：\npython3.13 -c '${peerAssertion}'\n该只读脚本在内存中分别运行默认入口和--help，输出真实退出码/stdout/stderr并断言R01/R02，成功才打印PEER_ACCEPTED。这已经完成所有验证，不再增加其他exec检查，不通过shell捕获退出码或stderr。`;
  const promptB = `对独立项目${b.projectRoot}做最终交付验收。R01默认入口python3.13 mini_app.py退出0，stdout严格PEER_READY加换行、stderr空；R02 --help退出0显示usage；R03保持全部现有文件不变，不修改任何代码或配置，不创建项目外临时文件。读取spec/requirements.md和mini_app.py，${peerInstructions}禁止cd、管道、重定向、临时输出文件以及shell复合命令。成功后交付“全部任务完成”报告。只处理这个项目。`;
  await h.save("B-request.md", promptB);
  const peerPromise = h.send(b.key, promptB).then(async terminal => { await h.save("B-first-terminal.json", terminal); return { terminal }; }, error => ({ error }));
  const aState = await waitForPass(a, initial.runId), peerResult = await peerPromise;
  if (peerResult.error) throw peerResult.error;
  const peer = peerResult.terminal, bState = await waitForPass(b, peer.runId);
  await h.save("A-runtime-final.json", aState); await h.save("B-runtime-final.json", bState);
  const aTask = aState.tasks.find(t => t.status === "COMPLETED"), bTask = bState.tasks.find(t => t.status === "COMPLETED");
  assert(aTask.groundTruth.version > 0 && bTask.groundTruth.version > 0);
  assert.deepEqual(aTask.sessionIds, [a.sessionId]); assert.deepEqual(bTask.sessionIds, [b.sessionId]); assert.notEqual(aTask.taskId, bTask.taskId);
  assert.equal(bTask.stop.correctionAttempts, 0);
  assert.equal(aTask.correctionEpoch.id, 1, "RC feedback must not open a new requirement epoch");
  assert.equal(aTask.groundTruth.version, aTask.assessments[`${initial.runId}:stop`].verification.requirementVersion);
  const receipts = aState.records.filter(r => r.file.includes("/native-followups/"));
  assert(receipts.some(r => r.status === "ADMITTED" && r.sourceRecordId && r.modelObservedAt && r.finishedAt && r.reviewStatus === "PASS"));
  assert(aState.records.some(r => r.file.includes("/native-stop-reviews/") && r.runId === initial.runId && r.reviewStatus === "DEVIATION"));
  assert(!bState.records.some(r => r.file.includes("/native-followups/")));
  const aa = await acceptance(a, "READY"), ba = await acceptance(b, "PEER_READY"); assert(aa.ready && aa.help && ba.ready && ba.help);
  await frozen(a); await frozen(b);
  if (native) { assert.notEqual(a.projectRoot, a.origin); assert((await fs.readFile(path.join(a.origin, "mini_app.py"), "utf8")).includes('print("BROKEN")')); }
  const reviewA = aState.records.filter(r => r.file.includes("/native-runs/")), reviewB = bState.records.filter(r => r.file.includes("/native-runs/"));
  const overlaps = reviewA.flatMap(x => reviewB.filter(y => x.startedAt < (y.settledAt ?? Infinity) && y.startedAt < (x.settledAt ?? Infinity)).map(y => ({ aRunId: x.runId, bRunId: y.runId })));
  assert(overlaps.length, "No actual cross-session review overlap; concurrency case not exercised");
  outcome.cases.push({ id: native ? "E1-N" : "E1-L", status: "PASS", initialRunId: initial.runId, taskId: aTask.taskId, initialAcceptance, finalAcceptance: aa,
    correctionAttempts: aTask.stop.correctionAttempts, epoch: aTask.correctionEpoch.id, groundTruthVersion: aTask.groundTruth.version, receipts, stops: aState.records.filter(r => r.file.includes("/native-stop-reviews/")) });
  outcome.cases.push({ id: native ? "E2-N" : "E2-L", status: "PASS", peerTaskId: bTask.taskId, correctionAttempts: bTask.stop.correctionAttempts, finalAcceptance: ba, overlaps });
  const before = await Promise.all([a,b].map(async p => ({ name: p.name, scope: await h.status(p.key), task: (await runtimeState(p.projectRoot)).tasks.find(t => t.taskId === (p.name === "A" ? aTask.taskId : bTask.taskId)) })));
  const modelEventsBefore = h.events.filter(e => e.event === "agent" && e.payload?.stream === "lifecycle" && e.payload.data?.phase === "start").length;
  await h.restart();
  const after = await Promise.all([a,b].map(async p => ({ name: p.name, scope: await h.status(p.key), history: await h.request("chat.history", { sessionKey: p.key, limit: 50 }), task: (await runtimeState(p.projectRoot)).tasks.find(t => t.taskId === (p.name === "A" ? aTask.taskId : bTask.taskId)) })));
  for (let i=0;i<2;i++) { assert.deepEqual(after[i].scope.identity,before[i].scope.identity); assert.equal(after[i].scope.projectRoot,before[i].scope.projectRoot);
    for (const field of ["taskId","groundTruth","stop","correctionEpoch"]) assert.deepEqual(after[i].task[field], before[i].task[field]); }
  assert.equal(h.events.filter(e => e.event === "agent" && e.payload?.stream === "lifecycle" && e.payload.data?.phase === "start").length, modelEventsBefore);
  outcome.cases.push({ id: native ? "E4-N" : "E4-L", status: "PASS", before, after, queryStartedNoModel: true });
  await h.save("A-runtime-final.json", aState); await h.save("B-runtime-final.json", bState); await h.save("A-final.py", await fs.readFile(path.join(a.projectRoot, "mini_app.py"), "utf8"));
  assert(!(await fs.readdir(h.defaultDir)).includes(".runtime-correction")); outcome.status = "PASS";
} catch (error) {
  outcome.status = "FAIL"; outcome.error = h.redact(error.stack); milestone({ phase: "failed", error: h.redact(error.message) });
  const manifest = await fs.readFile(path.join(h.root, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
  if (manifest) for (const name of ["A", "B"]) await h.save(`${name}-runtime-at-failure.json`, await runtimeState(manifest[name].projectRoot)).catch(() => {});
}
finally { await h.save("summary.json", outcome); await h.close(); }
milestone({ phase: "finished", status: outcome.status, output: h.root }); process.exitCode = outcome.status === "PASS" ? 0 : 1;
