import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/plugin-builder.mjs";
import { parseSimpleYaml } from "../lib/simple-yaml.mjs";
import { writeProjectControl, initializeProjectConfig } from "../lib/openclaw/project-settings.mjs";
import { runInternalExecution, runManagedExecution } from "../lib/openclaw/internal-context.mjs";

let build, pluginRoot, createProjects, registerProject, registerControl;
before(async () => {
  build = await fs.mkdtemp(path.join(os.tmpdir(), "rc-project-settings-build-"));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: build });
  ({ createSessionProjects: createProjects, registerProjectCommand: registerProject } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/session-projects.mjs"))));
  ({ registerSessionControl: registerControl } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/session-control.mjs"))));
});
after(() => fs.rm(build, { recursive: true, force: true }));

async function fixture(t, version = "2026.7.1-2") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-project-settings-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "selected-project"), other = path.join(root, "other-project"), state = path.join(root, "host-state");
  await Promise.all([projectRoot, other, state].map(dir => fs.mkdir(dir)));
  const entries = new Map(), commands = new Map();
  let hostConfig = { agents: { defaults: { model: "custom/business" } }, plugins: { entries: {
    "runtime-corrector": { config: { reviewerModel: "custom/current-reviewer" } } } } };
  const api = { id: "runtime-corrector", rootDir: pluginRoot, pluginConfig: { reviewerModel: "custom/stale-reviewer" }, logger: { info() {} },
    runtime: { version, config: { current: () => hostConfig }, state: { resolveStateDir: () => state },
      sandbox: { resolveSandboxRuntimeStatus: () => ({ sandboxed: false }) }, agent: {
        resolveAgentWorkspaceDir: () => other,
        session: { getSessionEntry: ({ sessionKey }) => entries.get(sessionKey), resolveStorePath: () => path.join(state, "sessions.json") },
      } }, registerCommand(command) { commands.set(command.name, command); } };
  const projects = createProjects(api, { pluginRoot });
  const runtime = { projects, reconcileSessionControl: ctx => projects.resolve({}, ctx) };
  registerProject(api, projects, runtime.reconcileSessionControl);
  registerControl(api, runtime);
  function session(id, directory = projectRoot) {
    const ctx = { agentId: "build-agent", sessionKey: `agent:build-agent:${id}`, sessionId: id,
      workspaceDir: directory, isAuthorizedSender: true, gatewayClientScopes: ["operator.admin"] };
    entries.set(ctx.sessionKey, { sessionId: id, spawnedCwd: directory });
    return ctx;
  }
  const a = session("a");
  const run = async (name, ctx, args) => (await commands.get(name).handler({ ...ctx, args })).text;
  const json = async (name, ctx, args) => JSON.parse(await run(name, ctx, args));
  const file = path.join(projectRoot, ".runtime-corrector/config.yaml");
  return { root, projectRoot, other, file, entries, commands, projects, a, session, run, json, api,
    config: () => hostConfig, setConfig(value) { hostConfig = value; } };
}

for (const version of ["2026.7.1-2", "2026.10.3"]) test(`${version}: packaged init uses the selected project and current RC model, without enabling correction or overwriting files`, async t => {
  const f = await fixture(t, version);
  f.config().plugins.entries["runtime-corrector"].config.reviewerModel = "custom/changed-before-init";
  const result = await f.json("rc-project", f.a, "init");
  assert.equal(result.initialized, true);
  assert.equal(result.projectRoot, f.projectRoot);
  assert.equal(result.projectEnabled, false);
  assert.equal(result.sessionDefaultEnabled, false);
  assert.equal(result.enabled, false);
  const bytes = await fs.readFile(f.file, "utf8"), config = parseSimpleYaml(bytes);
  const expected = parseSimpleYaml(await fs.readFile(path.join(pluginRoot, ".runtime-corrector-default/config.yaml"), "utf8"));
  expected.reviewers.defaults.model = "custom/changed-before-init";
  assert.deepEqual(config, expected, "initialization changes only the current reviewer model in the supplied defaults");
  assert.equal(config.reviewers.defaults.model, "custom/changed-before-init");
  assert.equal(config.stopCorrection.waitMode, "until_pass");
  assert.equal(config.stopCorrection.maxCorrectionsPerSession, 2);
  assert.equal(config.implementationCorrection.enabled, true);
  assert.equal(config.enabled, false);
  assert.equal(config.sessionDefaults.enabled, false);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ["README.md", "config.reference.yaml", "config.yaml", "example.reviewer.md", "example.rules.yaml"]);
  await assert.rejects(fs.access(path.join(f.other, ".runtime-corrector")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(f.projectRoot, ".runtime-correction")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(path.dirname(f.file), "sessions.local.yaml")), { code: "ENOENT" });
  assert.match(await f.run("rc-project", f.a, "init"), /RC_PROJECT_CONFIG_EXISTS/u);
  assert.equal(await fs.readFile(f.file, "utf8"), bytes);
  assert.deepEqual(await fs.readdir(f.projectRoot), [".runtime-corrector"]);
  assert.equal((await f.json("rc-project", f.a, "on")).enabled, false);
  assert.equal((await f.json("rc-session", f.a, "on")).effectiveEnabled, true);
});

test("project gates override sessions while default changes leave saved session choices intact", async t => {
  const f = await fixture(t);
  await f.run("rc-project", f.a, "init");
  await f.projects.ensure(await f.projects.resolve({}, f.a));
  assert.equal((await f.json("rc-session-default", f.a, "on")).sessionDefaultEnabled, true);
  assert.equal((await f.json("rc-session", f.a, "status")).requestedEnabled, false);
  const b = f.session("b");
  await f.projects.ensure(await f.projects.resolve({}, b));
  assert.equal((await f.json("rc-session", b, "status")).requestedEnabled, true);
  const settingsFile = path.join(path.dirname(f.file), "sessions.local.yaml"), choices = await fs.readFile(settingsFile, "utf8");
  await f.run("rc-session-default", f.a, "off");
  assert.equal(await fs.readFile(settingsFile, "utf8"), choices);
  assert.equal((await f.json("rc-session", b, "status")).requestedEnabled, true);
  assert.equal((await f.json("rc-session", f.session("c"), "status")).requestedEnabled, false);
  await f.run("rc-project", f.a, "on");
  assert.equal((await f.json("rc-session", b, "status")).effectiveEnabled, true);
  await f.run("rc-session", f.a, "on");
  await f.run("rc-project", f.a, "off");
  for (const ctx of [f.a, b]) {
    const status = await f.json("rc-session", ctx, "status");
    assert.equal(status.requestedEnabled, true);
    assert.equal(status.effectiveEnabled, false);
    assert.equal(status.reason, "RC_PROJECT_DISABLED");
  }
  await f.run("rc-project", f.a, "on");
  for (const ctx of [f.a, b]) assert.equal((await f.json("rc-session", ctx, "status")).effectiveEnabled, true);
});

test("control edits merge concurrent changes, preserve BOM/comments/CRLF and leave correction configuration unchanged", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.file));
  const original = "\uFEFF# keep this comment\r\nversion: 2\r\nartifacts: []\r\ndynamicGroundTruth:\r\n  enabled: true\r\nstopCorrection:\r\n  enabled: true\r\n  maxCorrectionsPerSession: 2\r\n";
  await fs.writeFile(f.file, original);
  const before = parseSimpleYaml(original);
  const b = f.session("b");
  await Promise.all([f.run("rc-project", f.a, "off"), f.run("rc-session-default", b, "off")]);
  const saved = await fs.readFile(f.file, "utf8"), after = parseSimpleYaml(saved);
  assert.deepEqual(after, { ...before, enabled: false, sessionDefaults: { enabled: false } });
  assert(saved.startsWith("\uFEFF# keep this comment\r\n"));
  assert.equal(saved.replace(/\r\n/gu, "").includes("\n"), false);
  assert(saved.endsWith("\r\n"));
  assert.equal((await f.json("rc-session-default", b, "status")).sessionDefaultEnabled, false);
  const mtime = (await fs.stat(f.file)).mtimeMs;
  await f.run("rc-project", f.a, "off");
  assert.equal((await fs.stat(f.file)).mtimeMs, mtime);
  assert.equal(await fs.readFile(f.file, "utf8"), saved);
});

test("untrusted users, private RC runs, stale sessions, missing projects and missing RC models cannot create config", async t => {
  const f = await fixture(t);
  for (const ctx of [{ ...f.a, isAuthorizedSender: false }, { ...f.a, gatewayClientScopes: ["operator.read"] }]) {
    assert.match(await f.run("rc-project", ctx, "init"), /权限/u);
    assert.match(await f.run("rc-session-default", ctx, "off"), /权限/u);
  }
  for (const execute of [runInternalExecution, runManagedExecution]) {
    assert.match(await execute("private", () => f.run("rc-project", f.a, "init")), /权限/u);
    assert.match(await execute("private", () => f.run("rc-session-default", f.a, "on")), /权限/u);
  }
  f.entries.get(f.a.sessionKey).sessionId = "replacement";
  assert.match(await f.run("rc-project", f.a, "init"), /HOST_SESSION_REPLACED_OR_MISSING/u);
  f.entries.get(f.a.sessionKey).sessionId = f.a.sessionId;
  delete f.entries.get(f.a.sessionKey).spawnedCwd;
  assert.match(await f.run("rc-project", f.a, "init"), /RC_SESSION_PROJECT_UNBOUND/u);
  f.entries.get(f.a.sessionKey).spawnedCwd = f.projectRoot;
  f.setConfig({});
  assert.equal(f.api.pluginConfig.reviewerModel, "custom/stale-reviewer");
  assert.match(await f.run("rc-project", f.a, "init"), /RC_REVIEWER_MODEL_UNCONFIGURED/u);
  assert.match(await f.run("rc-project", f.a, "init /untrusted/path"), /用法/u);
  await assert.rejects(fs.access(path.dirname(f.file)), { code: "ENOENT" });
});

test("malformed config is never repaired by switch commands and initialization refuses even an existing empty directory", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.file));
  assert.match(await f.run("rc-project", f.a, "init"), /RC_PROJECT_CONFIG_EXISTS/u);
  const invalid = "version: 2\nenabled: nope\nartifacts: []\n";
  await fs.writeFile(f.file, invalid);
  assert.match(await f.run("rc-project", f.a, "off"), /enabled|artifact/u);
  assert.match(await f.run("rc-session-default", f.a, "on"), /enabled|artifact/u);
  assert.equal(await fs.readFile(f.file, "utf8"), invalid);
});

test("a project switch during staged init and a concurrent manual config edit are rejected before publication", async t => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(initializeProjectConfig({ projectRoot: f.projectRoot, pluginRoot,
    reviewerModel: () => "custom/reviewer", async assertCurrent() { if (++checks === 2) throw new Error("HOST_SESSION_REPLACED_OR_MISSING"); } }), /HOST_SESSION_REPLACED_OR_MISSING/u);
  assert.deepEqual(await fs.readdir(f.projectRoot), []);
  await f.run("rc-project", f.a, "init");
  const original = await fs.readFile(f.file, "utf8"), concurrent = `${original}\n# edited concurrently\n`;
  checks = 0;
  await assert.rejects(writeProjectControl({ projectRoot: f.projectRoot, field: "project", enabled: true,
    async assertCurrent() { if (++checks === 2) await fs.writeFile(f.file, concurrent); } }), /RC_PROJECT_CONFIG_CONFLICT/u);
  assert.equal(await fs.readFile(f.file, "utf8"), concurrent);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ["README.md", "config.reference.yaml", "config.yaml", "example.reviewer.md", "example.rules.yaml"]);
});

test("project commands refuse a linked configuration directory rather than writing another project's files", async t => {
  const f = await fixture(t);
  const externalPolicy = path.join(f.other, ".runtime-corrector");
  await fs.mkdir(externalPolicy);
  const original = "version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n";
  const externalConfig = path.join(externalPolicy, "config.yaml");
  await fs.writeFile(externalConfig, original);
  try { await fs.symlink(externalPolicy, path.dirname(f.file), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Directory links are unavailable."); return; } throw error; }
  assert.match(await f.run("rc-project", f.a, "off"), /RC_PROJECT_CONFIG_PATH_UNSAFE/u);
  assert.match(await f.run("rc-session-default", f.a, "off"), /RC_PROJECT_CONFIG_PATH_UNSAFE/u);
  assert.equal(await fs.readFile(externalConfig, "utf8"), original);
});
