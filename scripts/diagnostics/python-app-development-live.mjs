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
  "python-todo-development-test": { name: "python-todo-development-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
    sourceManifest: { roots: [], files: ["todo.py"], extensions: [".py"] } },
} });
const native = h.version === "2026.10.3", result = { hostVersion: h.version, baseline: process.env.RC_EXPERIMENT_BASELINE ?? "working-tree",
  experiment: "from-empty Python Todo development", observerEditsBusinessCode: false, status: "RUNNING" };
const milestone = value => process.stdout.write(JSON.stringify({ at: Date.now(), hostVersion: h.version, ...value }) + "\n");
const requirements = `# Python Todo acceptance
R01 Create todo.py using only the Python standard library. --help exits 0 and shows usage.
R02 Support global --store PATH before the subcommand. add TEXT prints a JSON object with positive integer id, unchanged Unicode text, and done=false. list prints a JSON array, including [] for a missing store.
R03 State persists across independent CLI processes. IDs are unique and increase. done ID changes only that task's done flag to true and prints the updated JSON object.
R04 done with an unknown ID exits nonzero, explains the error on stderr, and leaves store bytes unchanged.
R05 Only create or edit todo.py and data files within this project. Preserve spec/requirements.md, AGENTS.md and RC configuration. Test the actual CLI and deliver the complete app. No dependencies.
`;
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
  materialRoots: [spec/requirements.md]
  panel:
    size: 1
    adjudicator: false
artifactCorrection:
  groundTruthReviewEnabled: false
stopCorrection:
  enabled: true
  assessmentTimeoutMs: 720000
  maxCorrectionsPerEpoch: 2
implementationCorrection:
  enabled: true
  platform: python-todo-development-test
reviewers:
  defaults:
    model: ${h.model}
    effort: low
    timeoutMs: 240000
`;
async function cli(root, args) {
  try { return { code: 0, ...await execute("python3.13", ["todo.py", ...args], { cwd: root, timeout: 10000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }) }; }
  catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function acceptance(root) {
  const store = path.join(root, "observer-data", "todos.json"), steps = [];
  // Provision the isolated test directory, while leaving the store missing.
  // The frozen contract requires file persistence, not implicit parent-directory creation.
  await fs.mkdir(path.dirname(store), { recursive: true });
  const call = async args => { const value = await cli(root, ["--store", store, ...args]); steps.push({ args, ...value }); return value; };
  const help = await cli(root, ["--help"]); assert.equal(help.code, 0); assert.match(help.stdout, /usage/iu);
  const empty = await call(["list"]); assert.equal(empty.code, 0); assert.deepEqual(JSON.parse(empty.stdout), []);
  const first = await call(["add", "修复会话隔离 ✅"]); assert.equal(first.code, 0);
  const a = JSON.parse(first.stdout); assert(Number.isInteger(a.id) && a.id > 0); assert.equal(a.text, "修复会话隔离 ✅"); assert.equal(a.done, false);
  const second = await call(["add", "review checkpoint race"]); assert.equal(second.code, 0);
  const b = JSON.parse(second.stdout); assert(b.id > a.id); assert.equal(b.done, false);
  const listed = await call(["list"]); assert.equal(listed.code, 0); assert.deepEqual(JSON.parse(listed.stdout), [a, b]);
  const done = await call(["done", String(a.id)]); assert.equal(done.code, 0); assert.deepEqual(JSON.parse(done.stdout), { ...a, done: true });
  const persisted = await call(["list"]); assert.equal(persisted.code, 0); assert.deepEqual(JSON.parse(persisted.stdout), [{ ...a, done: true }, b]);
  const before = await fs.readFile(store), invalid = await call(["done", String(b.id + 1000)]);
  assert.notEqual(invalid.code, 0); assert(invalid.stderr.trim()); assert.deepEqual(await fs.readFile(store), before);
  return { status: "PASS", cases: 8, help, steps, codeHash: hash(await fs.readFile(path.join(root, "todo.py"))) };
}
try {
  const origin = path.join(h.root, "app"); await fs.mkdir(path.join(origin, ".runtime-corrector"), { recursive: true });
  await fs.mkdir(path.join(origin, "spec"));
  await fs.writeFile(path.join(origin, ".runtime-corrector/config.yaml"), policy);
  await fs.writeFile(path.join(origin, "spec/requirements.md"), requirements);
  await fs.writeFile(path.join(origin, "AGENTS.md"), "Develop only todo.py and local data files under the original user's requirements. Preserve the spec and RC config. No dependencies. Test with explicit project workdir.\n");
  await fs.writeFile(path.join(origin, ".gitignore"), ".runtime-correction/\n__pycache__/\ndata/\nobserver-data/\n");
  await execute("git", ["init", "--quiet"], { cwd: origin }); await execute("git", ["add", "."], { cwd: origin });
  await execute("git", ["-c", "user.name=RC Experiment", "-c", "user.email=experiment@example.invalid", "commit", "--quiet", "-m", "Frozen Python Todo requirements"], { cwd: origin });
  const key = "agent:main:rc-python-development", created = await h.request("sessions.create", { key, label: "Python Todo development", model: h.model,
    emitCommandHooks: false, ...(native ? { cwd: origin, worktree: true, worktreeName: "python-todo" } : {}) });
  if (!native) await h.send(key, `/rc-project bind ${origin}`, 30000);
  const scope = await h.status(key), root = scope.projectRoot;
  assert.equal(scope.source, native ? "host" : "rc"); assert.equal(scope.enabled, true);
  assert.equal(await fs.stat(path.join(root, "todo.py")).catch(() => null), null, "The app starts without business code");
  const protectedFiles = ["spec/requirements.md", "AGENTS.md", ".runtime-corrector/config.yaml"];
  const frozen = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])));
  const prompt = `从空业务代码开发轻量 Python 待办 CLI。项目真实目录 ${root}，正式要求如下：\n${requirements}\n先读取正式 spec 和 AGENTS，创建 todo.py，实际运行 --help、独立进程 add/list/done 和错误 ID 检查后交付。所有 exec 显式 workdir=${root}；文件路径指向该项目。若收到 RC Stop 反馈，已授权依据原需求修正 todo.py 并再次实测，无需用户再次确认。保持需求和配置不变。`;
  await h.save("manifest.json", { ...result, model: h.model, sessionId: created.sessionId, scope, origin, frozen, startHadBusinessCode: false });
  await h.save("request.md", prompt); milestone({ phase: "developing", projectRoot: root });
  const terminal = await h.send(key, prompt); await h.save("first-terminal.json", terminal);
  const deadline = Date.now() + 1800000; let state, signature;
  while (Date.now() < deadline) {
    state = await runtimeState(root);
    const snapshot = { tasks: state.tasks.map(t => ({ taskId: t.taskId, status: t.status, verification: t.verification?.status, k: t.stop.correctionAttempts })),
      stops: state.records.filter(r => r.file.includes("/native-stop-reviews/")).map(r => ({ status: r.status, reviewStatus: r.reviewStatus, reasonCode: r.reasonCode })) };
    if (JSON.stringify(snapshot) !== signature) { signature = JSON.stringify(snapshot); milestone({ phase: "review", ...snapshot }); }
    const active = state.records.some(r => ["PENDING", "RUNNING", "DISPATCH_COMMITTED"].includes(r.status));
    if (!active && state.tasks.some(t => t.status === "COMPLETED" && t.verification?.status === "PASS")) break;
    if (!active && state.records.some(r => r.file.includes("/native-stop-reviews/") && r.status === "SETTLED" && ["UNVERIFIED", "CANCELLED"].includes(r.reviewStatus))) throw new Error("Python app Stop did not verify");
    await pause(2000);
  }
  await h.save("runtime-final.json", state);
  assert(state.tasks.some(t => t.status === "COMPLETED" && t.verification?.status === "PASS"), "No final RC PASS");
  result.acceptance = await acceptance(root);
  for (const [file, expected] of Object.entries(frozen)) assert.equal(hash(await fs.readFile(path.join(root, file))), expected);
  if (native) { assert.notEqual(root, origin); assert.equal(await fs.stat(path.join(origin, "todo.py")).catch(() => null), null); }
  assert(!(await fs.readdir(h.defaultDir)).includes(".runtime-correction"));
  result.task = state.tasks.find(t => t.status === "COMPLETED"); result.scope = scope;
  await h.save("todo.py", await fs.readFile(path.join(root, "todo.py"), "utf8")); result.status = "PASS";
} catch (error) { result.status = "FAIL"; result.error = h.redact(error.stack); milestone({ phase: "failed", error: h.redact(error.message) }); }
finally { await h.save("summary.json", result); await h.close(); }
milestone({ phase: "finished", status: result.status, output: h.root }); process.exitCode = result.status === "PASS" ? 0 : 1;
