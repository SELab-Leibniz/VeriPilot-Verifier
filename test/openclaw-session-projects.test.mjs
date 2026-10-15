import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/plugin-builder.mjs";
import { nativeProjectDirectory, projectCapability } from "../lib/openclaw/project-compat.mjs";
let build, pluginRoot, createProjects, createRuntime, entry;
before(async () => {
  build = await fs.mkdtemp(path.join(os.tmpdir(), "rc-session-build-"));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: build });
  ({ createSessionProjects: createProjects } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/session-projects.mjs"))));
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs"))));
  entry = (await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/entry.mjs")))).default;
});
after(() => fs.rm(build, { recursive: true, force: true }));
const config = "version: 2\nartifacts:\n  - name: draft\n    stage: drafting\n    patterns: [draft.md]\n    rules:\n      enabled: false\n    review:\n      enabled: false\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: []\n  panel:\n    size: 0\nstopCorrection:\n  enabled: false\n";
async function fixture(t, version = "2026.7.1-2", reviewerFactory) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-session-projects-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = path.join(root, "a"), b = path.join(root, "b"), off = path.join(root, "off"), stateDir = path.join(root, "host-state");
  for (const dir of [a, b, off]) await fs.mkdir(dir);
  for (const dir of [a, b]) { await fs.mkdir(path.join(dir, ".runtime-corrector")); await fs.writeFile(path.join(dir, ".runtime-corrector/config.yaml"), config); }
  const entries = new Map(), transcripts = new Map(), warnings = [], sharedState = {}, calls = [];
  const api = { id: "runtime-corrector", rootDir: pluginRoot, config: {}, pluginConfig: {}, logger: { warn: m => warnings.push(m) },
    runtime: { version, state: { resolveStateDir: () => stateDir }, sandbox: { resolveSandboxRuntimeStatus: () => ({ sandboxed: false }) }, agent: {
      resolveAgentWorkspaceDir: () => off, runEmbeddedAgent: async () => { calls.push(1); throw new Error("unexpected model"); },
      session: { getSessionEntry: ({ sessionKey }) => entries.get(sessionKey), resolveStorePath: () => path.join(stateDir, "sessions.json"),
        resolveSessionFilePath: (_id, record) => record.sessionFile, runWithWorkAdmission: async (params, callback) => callback(params.signal) },
    } }, registerCommand(command) { this.projectCommand = command; }, registerTool() {}, on() {}, registerAgentToolResultMiddleware() {} };
  async function session(id, cwd = off) {
    const ctx = { agentId: "main", sessionId: id, sessionKey: `agent:main:${id}`, workspaceDir: cwd, runId: `${id}-run` };
    const file = path.join(root, `${id}.jsonl`);
    const records = [{ type: "session", id }, { type: "message", id: `${id}-u0`, parentId: null, message: { role: "user", content: `Old ${id}` } }];
    transcripts.set(ctx.sessionKey, records);
    await fs.writeFile(file, records.map(JSON.stringify).join("\n"));
    entries.set(ctx.sessionKey, { sessionId: id, sessionFile: file, spawnedCwd: cwd });
    return ctx;
  }
  const compatibility = async () => ({ loadTranscriptEvents: ({ sessionKey }) => transcripts.get(sessionKey) });
  const projects = createProjects(api, { pluginRoot, compatibility });
  const runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true, projectScopes: projects, compatibility, reviewerFactory });
  async function command(ctx, args, scopes = ["operator.admin"]) { return projects.command({ ...ctx, args, isAuthorizedSender: true, gatewayClientScopes: scopes }); }
  async function user(ctx, text) {
    const records = transcripts.get(ctx.sessionKey), id = `${ctx.sessionId}-u${records.length}`;
    records.push({ type: "message", id, parentId: records.at(-1).id, message: { role: "user", content: text } });
    await fs.writeFile(entries.get(ctx.sessionKey).sessionFile, records.map(JSON.stringify).join("\n"));
    await runtime.prompt({ prompt: text }, ctx);
  }
  return { root, a, b, off, stateDir, api, entries, transcripts, warnings, sharedState, calls, projects, runtime, command, user, session };
}

test("capability uses verified release contracts; arbitrary fields never select native or legacy", () => {
  assert.equal(projectCapability({ runtime: { version: "2026.7.1-2" } }).mode, "legacy");
  assert.equal(projectCapability({ runtime: { version: "2026.10.3" } }).mode, "native");
  for (const version of [undefined, "2026.10.4", "2026.8.1"]) assert.equal(projectCapability({ runtime: { version, agent: { resolveSessionWorkspaceDir() {} } } }).mode, "unavailable");
  assert.equal(nativeProjectDirectory({ spawnedCwd: "/task/tree", worktree: { repoRoot: "/origin" } }), "/task/tree");
  assert.equal(nativeProjectDirectory({ spawnedBy: "parent", spawnedWorkspaceDir: "/child", spawnedCwd: "/other" }), "/child");
  for (const record of [{}, { spawnedCwd: "relative" }, { spawnedCwd: "/local", execNode: "remote" }, { spawnedCwd: "/local", repositoryWorkspaceId: "cloud" }]) assert.throws(() => nativeProjectDirectory(record));
});

test("unbound and unconfigured sessions perform no baseline, reviewer or directory creation", async t => {
  const f = await fixture(t), ctx = await f.session("unbound");
  await f.runtime.sessionStart({}, ctx); await f.user(ctx, "Work");
  assert.equal(f.sharedState.states.size, 0); assert.deepEqual(f.calls, []);
  await f.command(ctx, `bind ${f.off}`);
  await f.user(ctx, "Unconfigured project work");
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "off", params: { path: "draft.md" } }, ctx);
  await f.runtime.reply({ kind: "final", sessionKey: ctx.sessionKey, runId: ctx.runId, payload: { text: "Done" } }, ctx);
  await f.runtime.sessionEnd({}, ctx);
  assert.deepEqual(await fs.readdir(f.off), []); assert.deepEqual(f.calls, []);
});

test("legacy A/B bindings persist independently and never rewrite the host working directory", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B");
  assert.equal((await f.command(a, `bind ${f.a}`)).hostWorkingDirectoryChanged, false);
  await f.command(b, `bind ${f.b}`);
  assert.equal(a.workspaceDir, f.off); assert.equal(f.api.runtime.agent.resolveAgentWorkspaceDir(), f.off);
  const restarted = createProjects(f.api, { pluginRoot });
  assert.equal((await restarted.resolve({}, a)).projectRoot, f.a);
  assert.equal((await restarted.resolve({}, b)).projectRoot, f.b);
  await Promise.all([f.user(a, "Only project A"), f.user(b, "Only project B")]);
  for (const ctx of [a, b]) await f.runtime.beforeTool({ toolName: "write", toolCallId: `${ctx.sessionId}-write`, params: { path: "draft.md" } }, ctx);
  const sa = f.sharedState.states.get("main:A"), sb = f.sharedState.states.get("main:B");
  assert.equal(sa.projectRoot, f.a); assert.equal(sb.projectRoot, f.b); assert.notEqual(sa.scopeTaskId, sb.scopeTaskId);
  assert(!JSON.stringify(sa.entries).includes("Only project B")); assert(!JSON.stringify(sb.entries).includes("Only project A"));
  assert.deepEqual(await fs.readdir(f.off), []);
  const taskA = JSON.parse(await fs.readFile(path.join(f.a, ".runtime-correction/tasks", sa.scopeTaskId, "task.json")));
  const taskB = JSON.parse(await fs.readFile(path.join(f.b, ".runtime-correction/tasks", sb.scopeTaskId, "task.json")));
  assert.deepEqual(taskA.sessionIds, ["A"]); assert.deepEqual(taskB.sessionIds, ["B"]);
});

test("same-project sessions have distinct task budgets and requirement state; restart restores each scope", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B");
  for (const ctx of [a, b]) await f.command(ctx, `bind ${f.a}`);
  await f.user(a, "A requirement"); await f.user(b, "B requirement");
  const sa = f.sharedState.states.get("main:A"), sb = f.sharedState.states.get("main:B");
  assert.notEqual(sa.scopeTaskId, sb.scopeTaskId);
  const reopened = createRuntime(f.api, { pluginRoot, nativeHooks: true });
  await reopened.prompt({ prompt: "A requirement" }, a);
  assert.equal((await reopened.projects.activate(await reopened.projects.resolve({}, a))).taskId, sa.scopeTaskId);
});

test("native workspace Skill read creates a watcher in the bound business project without skillRoots", async t => {
  const calls = [];
  const reviewerFactory = async input => {
    calls.push(input);
    return { result: { summary: "Skill constraints", taskClassification: "CONTINUATION", operations: [],
      skillGroundTruth: { constraints: [{ constraintId: "verify", kind: "STEP", modality: "MUST", statement: "Run the verifier before delivery." }], taskOverlays: [] } },
      close: async () => {} };
  };
  const f = await fixture(t, "2026.7.1-2", reviewerFactory), ctx = await f.session("native-skill");
  const skill = path.join(f.off, "skills/workspace-note/SKILL.md");
  await fs.mkdir(path.dirname(skill), { recursive: true }); await fs.writeFile(skill, "# Workspace note\nRun the verifier before delivery.\n");
  await fs.appendFile(path.join(f.a, ".runtime-corrector/config.yaml"), "skillCorrection:\n  enabled: true\n  selection:\n    mode: include\n    include: [workspace-note]\n");
  await f.command(ctx, `bind ${f.a}`);
  await f.runtime.beforeTool({ toolName: "read", toolCallId: "host-skill-read", params: { path: skill } }, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.skill.directory, path.dirname(skill));
  const state = f.sharedState.states.get("main:native-skill");
  const task = JSON.parse(await fs.readFile(path.join(f.a, ".runtime-correction/tasks", state.scopeTaskId, "task.json")));
  const watchers = Object.values(task.watchers);
  assert.equal(watchers.length, 1); assert.equal(watchers[0].skillId, "workspace-note");
  assert.deepEqual(watchers[0].invocationIds, ["host-skill-read"]);
  assert.equal(state.projectRoot, f.a); assert.equal(state.executionDirectory, f.off);
  assert.equal((await fs.readdir(f.off)).includes(".runtime-correction"), false);
});

test("only authenticated host-authorized users mutate bindings; sandbox and confined paths fail closed", async t => {
  const f = await fixture(t), ctx = await f.session("security");
  for (const patch of [{ isAuthorizedSender: false }, { gatewayClientScopes: ["operator.read"] }, { gatewayClientScopes: undefined, senderIsOwner: false }, { sessionId: "stale" }]) {
    await assert.rejects(f.projects.command({ ...ctx, args: `bind ${f.a}`, isAuthorizedSender: true, gatewayClientScopes: ["operator.admin"], ...patch }));
  }
  f.api.runtime.sandbox.resolveSandboxRuntimeStatus = () => ({ sandboxed: true });
  await assert.rejects(f.command(ctx, `bind ${f.a}`));
  f.api.runtime.sandbox.resolveSandboxRuntimeStatus = () => ({ sandboxed: false });
  f.api.config.tools = { fs: { workspaceOnly: true } };
  await assert.rejects(f.command(ctx, `bind ${f.a}`), /FILESYSTEM_POLICY_DENIED/);
  await assert.rejects(f.command(ctx, "bind relative"));
  assert.equal((await f.projects.resolve({}, ctx)).enabled, false);
  assert.deepEqual(await fs.readdir(f.off), []);
});

test("native selection overrides old bindings, disallows mutations and uses the actual worktree", async t => {
  const f = await fixture(t), ctx = await f.session("upgrade");
  await f.command(ctx, `bind ${f.a}`);
  f.api.runtime.version = "2026.10.3";
  ctx.workspaceDir = f.b;
  f.entries.get(ctx.sessionKey).spawnedCwd = f.b;
  f.entries.get(ctx.sessionKey).worktree = { repoRoot: f.a };
  const native = createProjects(f.api, { pluginRoot });
  const scope = await native.resolve({}, ctx);
  assert.equal(scope.mode, "native"); assert.equal(scope.source, "host"); assert.equal(scope.projectRoot, f.b);
  for (const args of [`bind ${f.a}`, "unbind"]) await assert.rejects(native.command({ ...ctx, args, isAuthorizedSender: true, gatewayClientScopes: ["operator.admin"] }), /已禁用/);
  assert.equal((await native.command({ ...ctx, args: "status", isAuthorizedSender: true, gatewayClientScopes: ["operator.read"] })).projectRoot, f.b);
});

test("native missing/conflicting/stale directory never uses Agent defaults or a stored manual binding", async t => {
  const f = await fixture(t), ctx = await f.session("conflict"); await f.command(ctx, `bind ${f.a}`);
  f.api.runtime.version = "2026.10.3"; const native = createProjects(f.api, { pluginRoot });
  delete f.entries.get(ctx.sessionKey).spawnedCwd;
  assert.equal((await native.resolve({}, ctx)).projectRoot, null);
  f.entries.get(ctx.sessionKey).spawnedCwd = f.a;
  assert.equal((await native.resolve({}, ctx)).reason, "HOST_PROJECT_CONTEXT_CONFLICT");
  ctx.workspaceDir = f.a; assert.equal((await native.resolve({}, ctx)).enabled, true);
  f.entries.get(ctx.sessionKey).sessionId = "replaced";
  assert.equal((await native.resolve({}, ctx)).projectRoot, null);
});

test("project switches cancel old reviewers, drop delayed tool feedback and start fresh tasks when returning", async t => {
  const f = await fixture(t), ctx = await f.session("switch"); await f.command(ctx, `bind ${f.a}`); await f.user(ctx, "A task");
  const old = f.sharedState.states.get("main:switch");
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "late", params: { path: path.join(f.a, "draft.md") } }, ctx);
  await f.command(ctx, `bind ${f.b}`);
  assert.equal(old.abortSignal.aborted, true);
  await f.user(ctx, "B task");
  assert.equal(await f.runtime.toolResult({ toolName: "write", toolCallId: "late", args: { path: path.join(f.a, "draft.md") }, result: { content: [] } }, { runtime: "openclaw" }), undefined);
  assert.equal(await f.runtime.toolResult({ toolName: "write", toolCallId: "late", args: { path: path.join(f.a, "draft.md") }, result: { content: [] } }, ctx), undefined);
  const current = f.sharedState.states.get("main:switch"); assert.equal(current.projectRoot, f.b);
  assert(!JSON.stringify(current.entries).includes("A task"));
  await f.command(ctx, `bind ${f.a}`); await f.user(ctx, "New A task");
  assert.notEqual(f.sharedState.states.get("main:switch").scopeTaskId, old.scopeTaskId);
  await f.command(ctx, "unbind"); assert.equal((await f.projects.resolve({}, ctx)).projectRoot, null);
});

test("concurrent first hooks reuse one Session scope and task", async t => {
  const f = await fixture(t), ctx = await f.session("concurrent"); await f.command(ctx, `bind ${f.a}`);
  await Promise.all([f.runtime.beforeTool({ toolName: "write", toolCallId: "one", params: { path: "draft.md" } }, ctx),
    f.runtime.beforeTool({ toolName: "write", toolCallId: "two", params: { path: "draft.md" } }, ctx)]);
  assert.equal(f.sharedState.states.size, 1);
  assert.equal((await fs.readdir(path.join(f.a, ".runtime-correction/tasks"))).length, 1);
});

test("host-native same-session scope changes cancel prior state and fence its old baseline", async t => {
  const f = await fixture(t, "2026.10.3"), ctx = await f.session("native", f.a);
  await f.user(ctx, "A native task"); const old = f.sharedState.states.get("main:native");
  f.entries.get(ctx.sessionKey).spawnedCwd = f.b; ctx.workspaceDir = f.b;
  await f.user(ctx, "B native task");
  const state = f.sharedState.states.get("main:native");
  assert.equal(old.abortSignal.aborted, true); assert.equal(state.projectRoot, f.b);
  assert(!JSON.stringify(state.entries).includes("A native task")); assert(JSON.stringify(state.entries).includes("B native task"));
});

test("manual status/check entry uses the same project resolution and cannot trigger zero-config correction", async t => {
  const f = await fixture(t), ctx = await f.session("tool");
  const factories = []; f.api.registerTool = factory => factories.push(factory);
  entry.register(f.api);
  const tool = factories.at(-1)(ctx);
  assert.equal((await tool.execute("check", { command: "check", subject: "draft.md" })).isError, true);
  const result = await tool.execute("query", { command: "project" });
  assert.match(result.content[0].text, /RC_SESSION_PROJECT_UNBOUND/);
  assert.deepEqual(await fs.readdir(f.off), []);
});

test("manual artifact checks keep separate latest/rounds for sessions sharing one project", async t => {
  const f = await fixture(t), a = await f.session("manualA"), b = await f.session("manualB");
  await fs.writeFile(path.join(f.a, ".runtime-corrector/config.yaml"), config + "output:\n  persist: true\n  mode: centralized\n");
  await fs.writeFile(path.join(f.a, "draft.md"), "A checked draft.\n");
  for (const ctx of [a, b]) await f.command(ctx, `bind ${f.a}`);
  const first = await f.runtime.manualCheck(a, "draft.md"), second = await f.runtime.manualCheck(b, "draft.md");
  assert(first.result.outputFiles.length > 0); assert(second.result.outputFiles.length > 0);
  assert(!first.result.outputFiles.some(file => second.result.outputFiles.includes(file)));
  assert(first.result.outputFiles.every(file => file.includes("openclaw/session-artifacts")));
  assert.deepEqual(f.calls, []); assert.deepEqual(await fs.readdir(f.off), []);
});

test("bound project config remains authoritative when an artifact's child directory has another RC config", async t => {
  const f = await fixture(t), ctx = await f.session("nested");
  await fs.writeFile(path.join(f.a, ".runtime-corrector/config.yaml"), config.replace("[draft.md]", "[child/draft.md]"));
  await fs.mkdir(path.join(f.a, "child/.runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(f.a, "child/.runtime-corrector/config.yaml"), "invalid child config");
  await fs.writeFile(path.join(f.a, "child/draft.md"), "Bound project's artifact.\n");
  await f.command(ctx, `bind ${f.a}`);
  const checked = await f.runtime.manualCheck(ctx, "child/draft.md");
  assert.equal(checked.projectRoot, f.a);
  await assert.rejects(fs.access(path.join(f.a, "child/.runtime-correction")), { code: "ENOENT" });
});
