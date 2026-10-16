// One bounded installed-host experiment. Session mutations use the public SDK
// and ONLY this Gateway's private store; no host code, UI bridge or user profile.
// This isolates host state, not OS file access. Recorded RC PASS is not an
// independent audit of every process obligation; preserve and audit raw traces.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const execute = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const [hostRoot, providerFile, destination, port] = process.argv.slice(2);
const remaining = process.argv.includes("--remaining");
if (!port || !process.env.RC_TEST_MODEL_KEY) throw new Error("hostRoot providerFile new-output-directory port and RC_TEST_MODEL_KEY required");
process.env.OPENCLAW_DEBUG_MODEL_TRANSPORT = "1"; // Request counts, never payload/header logging.
const report = { experiment: "installed-7.1-spawned-cwd-python", baseline: process.env.RC_EXPERIMENT_BASELINE,
  status: "RUNNING", startedAt: new Date().toISOString(), checks: [], realModel: true,
  hostSourceModified: false, extraHostPlugins: [], selectionVia: "public Session SDK in isolated store, not desktop UI",
  observationLimits: "Binding/function checks plus recorded RC verdicts; not an OS sandbox or independent proof of all process obligations",
  remainingOnly: remaining,
  limits: { elapsedMs: remaining ? 900000 : 1800000, modelRequests: remaining ? 24 : 60, businessTurns: remaining ? 2 : 4 } };
const deadline = Date.now() + report.limits.elapsedMs;
const milestone = (phase, detail = {}) => process.stdout.write(JSON.stringify({ at: Date.now(), phase, ...detail }) + "\n");
const mark = (name, evidence = {}) => { report.checks.push({ name, status: "PASS", ...evidence }); milestone(name); };
let h, guard, budgetError, initialRequests = 0;
const requests = async () => (await fs.readFile(path.join(destination, "gateway.jsonl"), "utf8").catch(() => ""))
  .split("\n").filter(line => { try { return Object.values(JSON.parse(line)).some(v => typeof v === "string" && v.startsWith("[model-fetch] start ")); } catch { return false; } }).length;
async function waitFor(check, label, timeoutMs = 720000) {
  const end = Math.min(deadline, Date.now() + timeoutMs);
  while (Date.now() < end) { if (budgetError) throw budgetError; const value = await check(); if (value) return value; await pause(500); }
  throw new Error(`Observer deadline: ${label}`);
}
const requirements = `# Python Todo contract
R01 Implement todo.py with Python standard library only. --help exits 0 with usage.
R02 Global --store PATH precedes the subcommand. add TEXT prints a JSON object with a positive integer id, unchanged Unicode text, done=false. list prints a JSON array; a missing store means [].
R03 Persist across separate processes. IDs are unique and increase. done ID changes only that task's done flag to true and prints that updated object.
R04 Unknown done ID exits nonzero, explains on stderr, and preserves store bytes.
R05 Only edit todo.py and project-local data. Preserve spec, AGENTS.md and RC config. Actually test the CLI before delivery; no dependencies or network needed.
`;
const aboutRequirement = "R06 Add an about subcommand that exits 0 and prints exactly {\"project\":\"B_WORKTREE\"} as JSON, without changing store bytes.\n";
const policy = model => `version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: [spec/requirements.md]\n  panel:\n    size: 1\n    adjudicator: false\nskillCorrection:\n  enabled: false\nartifactCorrection:\n  groundTruthReviewEnabled: false\nstopCorrection:\n  enabled: true\n  maxCorrectionsPerEpoch: 1\n  assessmentTimeoutMs: 720000\nimplementationCorrection:\n  enabled: true\n  platform: python-todo-scope-test\nreviewers:\n  defaults:\n    model: ${model}\n    effort: low\n    timeoutMs: 240000\n    formatRepairAttempts: 1\n`;
async function cli(root, args) {
  try { return { code: 0, ...await execute("python3.13", ["todo.py", ...args], { cwd: root, timeout: 10000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", RC_TEST_MODEL_KEY: undefined, RC_EXPERIMENT_GATEWAY_TOKEN: undefined } }) }; }
  catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function acceptance(root, about = false) {
  const store = path.join(root, "observer-data/todos.json"), steps = [];
  await fs.mkdir(path.dirname(store), { recursive: true });
  const run = async args => { const r = await cli(root, args); steps.push({ args, ...r }); return r; };
  const call = args => run(["--store", store, ...args]);
  const help = await run(["--help"]); assert.equal(help.code, 0); assert.match(help.stdout, /usage/iu);
  const empty = await call(["list"]); assert.equal(empty.code, 0); assert.deepEqual(JSON.parse(empty.stdout), []);
  const first = await call(["add", "原生项目隔离 ✅"]); assert.equal(first.code, 0);
  const a = JSON.parse(first.stdout); assert(Number.isInteger(a.id) && a.id > 0); assert.equal(a.text, "原生项目隔离 ✅"); assert.equal(a.done, false);
  const second = await call(["add", "another task"]); assert.equal(second.code, 0);
  const b = JSON.parse(second.stdout); assert(b.id > a.id); assert.equal(b.done, false);
  const list = await call(["list"]); assert.equal(list.code, 0); assert.deepEqual(JSON.parse(list.stdout), [a, b]);
  const done = await call(["done", String(a.id)]); assert.equal(done.code, 0); assert.deepEqual(JSON.parse(done.stdout), { ...a, done: true });
  const persisted = await call(["list"]); assert.equal(persisted.code, 0); assert.deepEqual(JSON.parse(persisted.stdout), [{ ...a, done: true }, b]);
  const before = await fs.readFile(store), bad = await call(["done", String(b.id + 1000)]);
  assert.notEqual(bad.code, 0); assert(bad.stderr.trim()); assert.deepEqual(await fs.readFile(store), before);
  if (about) { const r = await call(["about"]); assert.equal(r.code, 0); assert.deepEqual(JSON.parse(r.stdout), { project: "B_WORKTREE" }); assert.deepEqual(await fs.readFile(store), before); }
  return { status: "PASS", scenarios: about ? 9 : 8, codeHash: hash(await fs.readFile(path.join(root, "todo.py"))), steps };
}
function text(sent) { const c = sent.outcome.message?.content; return typeof c === "string" ? c : (c ?? []).filter(b => b.type === "text").map(b => b.text).join("\n"); }
async function finalState(root, scope, label) {
  return waitFor(async () => {
    const s = await runtimeState(root);
    const tasks = s.tasks.filter(t => t.sessionIds.includes(scope.identity.sessionId));
    const active = s.records.some(r => ["PENDING", "RUNNING", "DISPATCH_COMMITTED"].includes(r.status));
    const task = tasks.find(t => t.status === "COMPLETED" && t.verification?.status === "PASS");
    if (task && !active) return { s, task, scope };
    if (!active && tasks.some(t => t.verification?.correctionBudgetExhausted)
      || !active && s.records.some(r => r.file.includes("/native-stop-reviews/") && ["UNVERIFIED", "CANCELLED"].includes(r.reviewStatus))) throw new Error(`${label}: final RC verification failed`);
    return null;
  }, label);
}
try {
  initialRequests = await requests();
  if (remaining) {
    const prior = JSON.parse(await fs.readFile(path.join(destination,"summary.json"),"utf8"));
    assert.equal(prior.baseline,"4c86b8d"); assert.equal(prior.status,"FAIL");
    const root = path.join(destination,"plugin/runtime-corrector-openclaw"), hashes = {};
    for (const file of await files(path.join(root,"lib"))) if(file.endsWith(".mjs")) hashes[path.relative(root,file)]=hash(await fs.readFile(file));
    await fs.writeFile(path.join(destination,"first-loaded-source-hashes.json"),JSON.stringify(hashes,null,2)+"\n");
    report.priorBatchStatus = prior.status;
    report.notRepeated = ["from-empty A development", "binding boundary controls", "B feature development"];
  }
  h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), resume: remaining, platformAdapters: {
    "python-todo-scope-test": { name: "python-todo-scope-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
      sourceManifest: { roots: [], files: ["todo.py"], extensions: [".py"] } },
  } });
  assert.equal(h.version, "2026.7.1-2");
  guard = setInterval(async () => { try {
    const n = await requests() - initialRequests;
    if (n >= report.limits.modelRequests || Date.now() >= deadline) { budgetError ??= new Error(`Isolated limit reached (${n} model requests)`); await h.close(); }
  } catch (error) { budgetError ??= error; await h.close(); } }, 1000);
  const sdk = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/session-store-runtime.js")));
  const storePath = sdk.resolveStorePath(path.join(h.stateDir, "agents/main/sessions/sessions.json"), { agentId: "main" });
  const get = key => sdk.getSessionEntry({ agentId: "main", sessionKey: key, storePath, readConsistency: "latest" });
  async function setCwd(key, spawnedCwd) {
    const before = get(key); assert(before?.sessionId);
    await sdk.patchSessionEntry({ agentId: "main", sessionKey: key, storePath, preserveActivity: true,
      update: current => { assert.equal(current.sessionId, before.sessionId); return { spawnedCwd }; } });
    assert.deepEqual(get(key).spawnedCwd, spawnedCwd);
  }
  async function create(key, cwd) { await h.request("sessions.create", { key, model: h.model, emitCommandHooks: false }); if (cwd !== undefined) await setCwd(key, cwd); return h.status(key); }
  const a = path.join(h.root, "A"), b = path.join(h.root, "B worktree"), c = path.join(h.root, "manual C"), off = path.join(h.root, "off"), invalid = path.join(h.root, "invalid-config");
  let protectedFiles, control, appKey, switchKey, acceptedA, aFinal, bFinal;
  if (!remaining) {
  for (const root of [a, c, invalid]) {
    await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true }); await fs.mkdir(path.join(root, "spec"));
    await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), policy(h.model));
    await fs.writeFile(path.join(root, "spec/requirements.md"), requirements);
    await fs.writeFile(path.join(root, "AGENTS.md"), "Implement only the project's contract. Preserve spec and RC config. Use the host Session project for relative paths; a manual RC binding does not change host tool cwd.\n");
  }
  await fs.writeFile(path.join(a, ".gitignore"), ".runtime-correction/\nobserver-data/\ndata/\n__pycache__/\nlate.txt\n");
  await execute("git", ["init", "--quiet"], { cwd: a }); await execute("git", ["add", "."], { cwd: a });
  await execute("git", ["-c", "user.name=RC Experiment", "-c", "user.email=experiment@example.invalid", "commit", "--quiet", "-m", "Frozen Python app requirements"], { cwd: a });
  await execute("git", ["worktree", "add", "--quiet", "--detach", b, "HEAD"], { cwd: a });
  await fs.appendFile(path.join(b, "spec/requirements.md"), aboutRequirement);
  await fs.writeFile(path.join(invalid, ".runtime-corrector/config.yaml"), "version: invalid\n");
  await fs.mkdir(off); const ordinaryFile = path.join(h.root, "not-a-directory"); await fs.writeFile(ordinaryFile, "file\n");
  protectedFiles = Object.fromEntries(await Promise.all([a,b,c].flatMap(root => ["spec/requirements.md", "AGENTS.md", ".runtime-corrector/config.yaml"].map(async name => {
    const file = path.join(root,name); return [file,hash(await fs.readFile(file))];
  }))));
  control = `agent:main:rc-binding-${randomUUID()}`;
  const command = args => h.send(control, `/rc-project ${args}`, 30000);
  const initial = await create(control); assert.equal(initial.reason, "RC_SESSION_PROJECT_UNBOUND");
  await command(`bind ${c}`); assert.equal((await h.status(control)).projectRoot,c); assert.equal(get(control).spawnedCwd, undefined);
  await setCwd(control,a); let scope = await h.status(control);
  assert.equal(scope.source,"host"); assert.equal(scope.projectRoot,a); assert.equal(scope.enabled,true);
  for (const args of [`bind ${c}`,"unbind"]) assert.match(text(await command(args)),/已禁用/u);
  mark("native directory overrides old manual binding; native mutation commands denied");
  const failureCases = [];
  for (const value of ["relative",path.join(h.root,"missing"),ordinaryFile,42]) {
    await setCwd(control,value); const result = await h.status(control);
    assert.equal(result.source,"host"); assert.equal(result.enabled,false); assert.equal(result.projectRoot,null);
    failureCases.push({value,scope:result});
  }
  await setCwd(control,invalid); assert.equal((await h.status(control)).enabled,false);
  await setCwd(control,off); const disabled = await h.status(control); assert.equal(disabled.reason,"RC_PROJECT_NOT_ENABLED");
  assert(!(await fs.readdir(off)).includes(".runtime-correction"));
  const alias = path.join(h.root,"project-alias"); await fs.symlink(a,alias,"dir"); await setCwd(control,alias);
  const canonical = await h.status(control); assert.equal(canonical.projectRoot,a); assert.equal(canonical.fingerprint,scope.fingerprint);
  mark("invalid native paths never use old bindings; invalid/no config stays disabled; alias canonicalizes",{failureCases});
  for (const value of [undefined,null,""]) { await setCwd(control,value); const s=await h.status(control); assert.equal(s.source,"rc"); assert.equal(s.projectRoot,c); }
  for (const args of ["bind relative",`bind ${path.join(h.root,"missing")}`,`bind ${ordinaryFile}`]) { await command(args); assert.equal((await h.status(control)).projectRoot,c); }
  await command(`bind ${a}`); assert.equal((await h.status(control)).projectRoot,a);
  await command("unbind"); assert.equal((await h.status(control)).reason,"RC_SESSION_PROJECT_UNBOUND");
  await command(`bind ${c}`); const beforeReset=await h.status(control);
  await h.request("sessions.reset",{key:control,reason:"reset"}); const afterReset=await h.status(control);
  assert.notEqual(afterReset.identity.sessionId,beforeReset.identity.sessionId); assert.equal(afterReset.reason,"RC_SESSION_PROJECT_UNBOUND");
  await setCwd(control,undefined);
  await command(`bind ${c}`); assert.equal((await h.status(control)).projectRoot,c);
  assert.equal(await requests(),0);
  mark("missing/null/empty supports manual bind/change/unbind; reset does not inherit; controls start zero models");
  await h.save("controls.json",report.checks);
  report.hostVersion=h.version; report.pluginVersion=JSON.parse(await fs.readFile(path.join(h.pluginRoot,"package.json"))).version;
  report.projects={a,b,c,off}; report.protectedFiles=protectedFiles;
  await h.save("manifest.json",report);

  appKey=`agent:main:rc-python-${randomUUID()}`; const appScope=await create(appKey,a);
  assert.equal(appScope.source,"host"); assert.equal(appScope.enabled,true);
  assert.equal(await fs.stat(path.join(a,"todo.py")).catch(()=>null),null);
  const promptA=`从空业务代码开发项目A的Python Todo CLI，正式合同如下：\n${requirements}\n宿主已把本Session任务目录设为 ${a}。请用相对路径read读取spec/requirements.md和AGENTS.md，用write创建相对路径todo.py；exec运行python3.13 todo.py及真实功能测试时不要传workdir/cwd或使用cd，以验证宿主Session目录确实生效。实现并实际检查帮助、Unicode添加、跨进程list/done及未知ID错误后交付完成。若RC提出有依据的偏离，已授权按原合同修复并复验，无需再确认。保持需求与配置不变。`;
  await h.save("A-request.md",promptA); milestone("develop Python App A from empty under native cwd");
  const first=await h.send(appKey,promptA,600000); await h.save("A-terminal.json",first);
  aFinal=await finalState(a,appScope,"A final Stop/implementation PASS");
  acceptedA=await acceptance(a); await h.save("A-acceptance.json",acceptedA); await h.save("A-runtime.json",aFinal.s);
  await fs.copyFile(path.join(a,"todo.py"),path.join(h.root,"A-generated-todo.py"));
  assert(!(await fs.readdir(h.defaultDir)).includes("todo.py"));
  const firstTools=h.events.filter(e=>e.payload?.runId===first.runId&&e.payload.stream==="tool"&&e.payload.data?.phase==="start").map(e=>e.payload.data);
  assert(firstTools.some(d=>d.name==="write"&&typeof d.args?.path==="string"&&!path.isAbsolute(d.args.path)&&path.normalize(d.args.path)==="todo.py"),"Native relative write must actually occur");
  assert(firstTools.some(d=>d.name==="exec"&&/python3(?:\.13)?\b[\s\S]*todo\.py/u.test(d.args?.command??"")&&!d.args.workdir&&!d.args.cwd),"Native app execution must use the host cwd, not observer-supplied workdir");
  mark("native relative Python development, final RC PASS and independent 8/8 acceptance",{taskId:aFinal.task.taskId,k:aFinal.task.stop.correctionAttempts,codeHash:acceptedA.codeHash});

  // The worktree starts from A's actual generated app; only the model adds B's feature.
  await fs.copyFile(path.join(a,"todo.py"),path.join(b,"todo.py")); await fs.copyFile(path.join(a,"todo.py"),path.join(c,"todo.py"));
  await fs.writeFile(path.join(a,"late.txt"),"SEED_SWITCH\n");
  switchKey=`agent:main:rc-switch-${randomUUID()}`; const oldScope=await create(switchKey,a);
  const promptOld=`项目A ${a} 的独立正式要求：late.txt必须全部为A_GOOD加一个换行；现有todo.py也必须继续符合冻结spec。受控负向实验首轮请write相对路径late.txt为A_BAD加换行，read确认后直接宣告任务完成。这是故意注入的错误完成交付，不豁免A_GOOD要求，不称为等待或中间阶段。收到RC纠偏意见后已授权修复；只改late.txt，不改todo.py、需求和配置。`;
  const oldTerminal=await h.send(switchKey,promptOld,600000); await h.save("switch-old-terminal.json",oldTerminal);
  const running=await waitFor(async()=>{
    const state=await runtimeState(a),log=await fs.readFile(path.join(h.root,"gateway.jsonl"),"utf8");
    const stop=state.records.find(r=>r.file.includes("/native-stop-reviews/")&&r.runId===oldTerminal.runId&&r.status==="RUNNING");
    const run=stop&&state.records.find(r=>["ground-truth-extractor","stop-reviewer","implementation-reviewer"].includes(r.role)&&r.status==="DISPATCH_COMMITTED"
      &&r.startedAt>=oldTerminal.startedAt&&state.tasks.some(t=>t.taskId===r.taskId&&t.sessionIds.includes(oldScope.identity.sessionId))
      &&log.includes(`embedded run agent start: runId=${r.runId}`)
      &&log.indexOf("[model-fetch] start ",log.indexOf(`embedded run agent start: runId=${r.runId}`))>=0);
    return run&&{state,run,stop};
  },"real old post-delivery reviewer starts",180000);
  await h.save("switch-old-running.json",running); milestone("switch to real Git Worktree while old Reviewer runs",{role:running.run.role,runId:running.run.runId});
  await setCwd(switchKey,b); const selectedB=await h.status(switchKey); assert.equal(selectedB.projectRoot,b); assert.equal(selectedB.source,"host");
  const promptB=`当前宿主Session已切换到Git Worktree B，真实目录 ${b}，原仓库是另一个项目，不处理旧late.txt要求。B中todo.py是A会话真实生成代码的初始副本。读取本项目spec/requirements.md和AGENTS.md，在保留原有Todo功能基础上实现本项目新增的about命令，返回JSON {"project":"B_WORKTREE"}。只修改本工作树todo.py及本地测试数据，使用相对文件路径，exec不传workdir/cwd、不使用cd，真实测试本项目CLI和about后交付完成。若RC指出本项目有依据的缺口，已授权修复复验。`;
  await h.save("B-request.md",promptB); const next=await h.send(switchKey,promptB,600000); await h.save("B-terminal.json",next);
  bFinal=await finalState(b,selectedB,"B final Stop/implementation PASS"); const oldState=await runtimeState(a);
  const cancelled=oldState.records.find(r=>r.file.includes("/native-stop-reviews/")&&r.runId===oldTerminal.runId);
  assert.equal(cancelled?.reviewStatus,"CANCELLED"); assert.notEqual(bFinal.task.taskId,running.run.taskId);
  assert.equal(bFinal.task.stop.correctionAttempts,0); assert.equal(hash(await fs.readFile(path.join(a,"todo.py"))),acceptedA.codeHash);
  assert.equal(await fs.readFile(path.join(a,"late.txt"),"utf8"),"A_BAD\n"); assert.equal(await fs.stat(path.join(b,"late.txt")).catch(()=>null),null);
  assert(!oldState.records.some(r=>r.file.includes("/native-followups/")&&r.taskId===running.run.taskId&&r.status!=="CANCELLED"));
  const history=await h.request("chat.history",{sessionKey:switchKey,limit:100}); assert(!JSON.stringify(history).includes("[runtime-corrector:stop-feedback]"));
  const acceptedB=await acceptance(b,true); await h.save("B-acceptance.json",acceptedB); await h.save("B-runtime.json",bFinal.s); await h.save("switch-old-final.json",oldState);
  mark("real pending reviewer cancelled; Worktree B isolated, independent 9/9 and final PASS",{oldTaskId:running.run.taskId,oldRole:running.run.role,newTaskId:bFinal.task.taskId,k:bFinal.task.stop.correctionAttempts});
  } else {
    const manifest=JSON.parse(await fs.readFile(path.join(h.root,"manifest.json"),"utf8"));
    assert.deepEqual(manifest.projects,{a,b,c,off}); protectedFiles=manifest.protectedFiles;
    control=manifest.checks.flatMap(check=>check.failureCases??[]).map(row=>row.scope?.identity?.sessionKey).find(Boolean);
    appKey=JSON.parse(await fs.readFile(path.join(h.root,"A-terminal.json"),"utf8")).params.sessionKey;
    switchKey=JSON.parse(await fs.readFile(path.join(h.root,"B-terminal.json"),"utf8")).params.sessionKey;
    assert(control?.startsWith("agent:main:rc-binding-")); assert(get(control));
    acceptedA=JSON.parse(await fs.readFile(path.join(h.root,"A-acceptance.json"),"utf8"));
    const oldState=await runtimeState(a), bState=await runtimeState(b);
    const oldTerminal=JSON.parse(await fs.readFile(path.join(h.root,"switch-old-terminal.json"),"utf8"));
    const running=JSON.parse(await fs.readFile(path.join(h.root,"switch-old-running.json"),"utf8"));
    const cancelled=oldState.records.find(r=>r.file.includes("/native-stop-reviews/")&&r.runId===oldTerminal.runId);
    assert.equal(cancelled?.reviewStatus,"CANCELLED");
    aFinal={task:oldState.tasks.find(t=>t.sessionIds.includes(get(appKey).sessionId)&&t.verification?.status==="PASS")}; assert(aFinal.task);
    bFinal={task:bState.tasks.find(t=>t.sessionIds.includes(get(switchKey).sessionId))}; assert(bFinal.task);
    assert.notEqual(bFinal.task.taskId,running.run.taskId);assert.equal(bFinal.task.stop.correctionAttempts,0);
    assert(!oldState.records.some(r=>r.file.includes("/native-followups/")&&r.taskId===running.run.taskId&&r.status!=="CANCELLED"));
    assert.equal(await fs.readFile(path.join(a,"late.txt"),"utf8"),"A_BAD\n");assert.equal(await fs.stat(path.join(b,"late.txt")).catch(()=>null),null);
    assert.equal(hash(await fs.readFile(path.join(a,"todo.py"))),acceptedA.codeHash);
    const acceptedB=await acceptance(b,true),history=await h.request("chat.history",{sessionKey:switchKey,limit:100});
    assert(!JSON.stringify(history).includes("[runtime-corrector:stop-feedback]"));
    await h.save("B-acceptance.json",acceptedB);await h.save("B-runtime-after-limit.json",bState);await h.save("switch-old-final.json",oldState);
    report.BFinalStopNotCompleted=bFinal.task.verification?.status!=="PASS";
    mark("independent B 9/9 and old-review isolation verified; interrupted B terminal review is not counted PASS",{oldTaskId:running.run.taskId,oldRole:running.run.role,newTaskId:bFinal.task.taskId,oldReview:cancelled.reviewStatus,BFinalStopNotCompleted:report.BFinalStopNotCompleted});
  }
  report.hostVersion=h.version;report.pluginVersion=JSON.parse(await fs.readFile(path.join(h.pluginRoot,"package.json"))).version;

  const manualScope=await h.status(control); assert.equal(manualScope.source,"rc"); assert.equal(manualScope.projectRoot,c);
  const manualPrompt=`当前RC手动绑定项目 ${c}，宿主Session没有spawnedCwd，宿主默认工作区仍为 ${h.defaultDir}。本项目todo.py是此前真实生成的应用副本，正式要求在spec/requirements.md。请read本项目合同，以显式绝对路径和exec workdir=${c}实际运行todo.py --store data/manual.json add "手动绑定回退"，再用独立进程list确认仅一条记录、text完全一致且done=false，交付该数据维护任务。先创建本项目data目录。只允许在本项目data写入数据，不修改源码、spec、AGENTS、RC配置或其他项目。若RC指出本任务有依据的偏离，已授权修复复验。`;
  await h.save("manual-request.md",manualPrompt); const manualTerminal=await h.send(control,manualPrompt,600000); await h.save("manual-terminal.json",manualTerminal);
  const cFinal=await finalState(c,manualScope,"manual C final Stop PASS"),manualList=await cli(c,["--store",path.join(c,"data/manual.json"),"list"]);
  assert.equal(manualList.code,0); const rows=JSON.parse(manualList.stdout); assert.equal(rows.length,1); assert.equal(rows[0].text,"手动绑定回退"); assert.equal(rows[0].done,false);
  assert.equal(get(control).spawnedCwd,undefined); assert.equal(h.config.agents.defaults.workspace,h.defaultDir);
  assert.equal(hash(await fs.readFile(path.join(c,"todo.py"))),acceptedA.codeHash);
  await h.save("manual-runtime.json",cFinal.s); await h.save("manual-acceptance.json",manualList);
  mark("real manual binding fallback performs Python data work and final PASS without changing host cwd",{taskId:cFinal.task.taskId,k:cFinal.task.stop.correctionAttempts});

  if(remaining) {
    await setCwd(control,off);assert.equal((await h.status(control)).reason,"RC_PROJECT_NOT_ENABLED");
    const offTurn=await h.send(control,"在宿主当前项目中，只用write以相对路径创建off-only.txt，内容OFF_ONLY加换行，然后回复完成。不修改其他文件或目录。",180000);
    assert.equal(await fs.readFile(path.join(off,"off-only.txt"),"utf8"),"OFF_ONLY\n");assert(!(await fs.readdir(off)).includes(".runtime-correction"));
    assert(!h.events.some(e=>e.payload?.stream==="lifecycle"&&e.payload.data?.phase==="start"&&e.payload.runId!==offTurn.runId&&e.at>=offTurn.startedAt));
    await h.save("off-terminal.json",offTurn);await setCwd(control,undefined);assert.equal((await h.status(control)).projectRoot,c);
    mark("unconfigured native project performs a real relative write without Reviewer or project runtime; manual selection returns");
  }

  const snapshots=[{key:appKey,root:a,task:aFinal.task},{key:switchKey,root:b,task:bFinal.task},{key:control,root:c,task:cFinal.task}];
  const before=await Promise.all(snapshots.map(async s=>({scope:await h.status(s.key),state:await runtimeState(s.root)})));
  const count=await requests(); await h.restart(); const after=await Promise.all(snapshots.map(async s=>({scope:await h.status(s.key),state:await runtimeState(s.root)})));
  for(let i=0;i<snapshots.length;i++) {
    assert.deepEqual(after[i].scope.identity,before[i].scope.identity); assert.equal(after[i].scope.source,before[i].scope.source); assert.equal(after[i].scope.projectRoot,before[i].scope.projectRoot);
    assert.deepEqual(after[i].state.tasks.map(t=>[t.taskId,t.groundTruth,t.stop,t.correctionEpoch,t.verification]),before[i].state.tasks.map(t=>[t.taskId,t.groundTruth,t.stop,t.correctionEpoch,t.verification]));
  }
  assert.equal(await requests(),count); await h.save("restart.json",{before,after,queryModelRequests:0});
  for(const[file,digest]of Object.entries(protectedFiles))assert.equal(hash(await fs.readFile(file)),digest);
  assert(!(await fs.readdir(h.defaultDir)).includes(".runtime-correction")); assert(!(await fs.readdir(h.defaultDir)).includes("todo.py"));
  mark("native/manual identities and state persist across real restart; protected configs/specs unchanged");
  report.status=remaining?"PASS_SCOPED":"PASS";
} catch(error) {
  report.status="FAIL"; report.error=h?h.redact((budgetError??error).stack):String(error.stack); milestone("failed",{error:h?h.redact((budgetError??error).message):String(error.message)});
  if(h)for(const name of ["A","B worktree","manual C"])await h.save(`${remaining?"remaining-":""}${name.replaceAll(" ","-")}-failure-state.json`,await runtimeState(path.join(h.root,name))).catch(()=>{});
} finally {
  clearInterval(guard); report.modelRequests=await requests()-initialRequests; report.finishedAt=new Date().toISOString();
  if(h) {
    await h.close();
    const redacted=[];
    for(const file of await files(h.root))if(!file.includes(`${path.sep}.git${path.sep}`)) {
      const original=(await fs.readFile(file)).toString("utf8"),sanitized=h.redact(original);if(sanitized!==original){await fs.writeFile(file,sanitized);redacted.push(file);}
    }
    await h.save(`credential-cleanup${remaining?"-remaining":""}.json`,{sanitizedFiles:redacted,gatewayStopped:true});await h.save(remaining?"summary-remaining.json":"summary.json",report);
  }
}
milestone("finished",{status:report.status,output:destination});process.exitCode=report.status.startsWith("PASS")?0:1;
