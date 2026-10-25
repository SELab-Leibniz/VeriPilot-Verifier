import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readSessionSetting, ensureSessionSetting, setSessionSetting } from "../lib/openclaw/session-settings.mjs";
import { parseSimpleYaml } from "../lib/simple-yaml.mjs";
import { loadProjectPolicySource } from "../lib/policy/project-policy.mjs";
import { loadRuntimePlan } from "../lib/runtime-plan.mjs";
import { validateProjectConfig } from "../lib/policy/config-loader.mjs";

async function fixture(t) {
  const temporary = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "rc-session-settings-"));
  t.after(async () => {
    assert(path.resolve(root).startsWith(temporary + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = { projectRoot: root, namespace: path.join(root, "host-state"),
    identity: { agentId: "main", sessionKey: "agent:main:a", sessionId: "instance-a" } };
  const file = path.join(root, ".runtime-corrector", "sessions.local.yaml");
  return { root, base, file };
}

test("reading an unregistered session is read-only and defaults to enabled", async t => {
  const f = await fixture(t), value = await readSessionSetting(f.base);
  assert.equal(value.enabled, true);
  assert.equal(value.registered, false);
  assert.equal(value.path, f.file);
  assert.match(value.key, /^s_[a-f0-9]{64}$/u);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("registration snapshots false and later project defaults do not change it", async t => {
  const f = await fixture(t);
  const first = await ensureSessionSetting({ ...f.base, defaultEnabled: false });
  assert.equal(first.enabled, false);
  assert.equal(first.registered, true);
  assert.equal((await ensureSessionSetting({ ...f.base, defaultEnabled: true })).enabled, false);
  assert.equal((await readSessionSetting({ ...f.base, defaultEnabled: true })).enabled, false);
  assert.deepEqual(await fs.readdir(f.root), [".runtime-corrector"]);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ["sessions.local.yaml"]);
});

test("profiles, session incarnations and project directories keep separate choices", async t => {
  const f = await fixture(t);
  await setSessionSetting({ ...f.base, enabled: false });
  const variants = [
    { ...f.base, namespace: `${f.base.namespace}-other` },
    { ...f.base, identity: { ...f.base.identity, sessionId: "replacement-instance" } },
    { ...f.base, identity: { ...f.base.identity, agentId: "other" } },
    { ...f.base, projectRoot: path.join(f.root, "other-project") },
  ];
  for (const options of variants) {
    const selection = await readSessionSetting(options);
    assert.equal(selection.registered, false);
    assert.equal(selection.enabled, true);
  }
  assert.equal((await readSessionSetting(f.base)).enabled, false);
});

test("concurrent session updates merge distinct records and repeated set is idempotent", async t => {
  const f = await fixture(t);
  const second = { ...f.base, identity: { ...f.base.identity, sessionKey: "agent:main:b", sessionId: "instance-b" } };
  await Promise.all([setSessionSetting({ ...f.base, enabled: false }), setSessionSetting({ ...second, enabled: true })]);
  const before = await fs.readFile(f.file, "utf8");
  await setSessionSetting({ ...f.base, enabled: false });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.equal((await readSessionSetting(f.base)).enabled, false);
  assert.equal((await readSessionSetting(second)).enabled, true);
  assert.equal(Object.keys(parseSimpleYaml(before).sessions).length, 2);
});

test("independent writers serialize updates through the same short file lock", async t => {
  const f = await fixture(t);
  const moduleUrl = pathToFileURL(path.resolve("lib/openclaw/session-settings.mjs")).href;
  const run = options => new Promise((resolve, reject) => {
    const source = `import {setSessionSetting} from ${JSON.stringify(moduleUrl)}; await setSessionSetting(${JSON.stringify(options)});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { windowsHide: true });
    let errors = "";
    child.stderr.on("data", data => { errors += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(errors || `child exited ${code}`)));
  });
  await Promise.all(Array.from({ length: 3 }, (_, index) => run({ ...f.base,
    identity: { ...f.base.identity, sessionKey: `agent:main:${index}`, sessionId: `instance-${index}` }, enabled: index === 1 })));
  assert.equal(Object.keys(parseSimpleYaml(await fs.readFile(f.file, "utf8")).sessions).length, 3);
});

test("UI writes retain manual labels, comments and unrelated session settings", async t => {
  const f = await fixture(t);
  await setSessionSetting({ ...f.base, enabled: true, label: "编码会话" });
  const text = await fs.readFile(f.file, "utf8");
  await fs.writeFile(f.file, text.replace("version: 1", "# 手工说明\nversion: 1")
    .replace("    enabled: true", "    # 当前会话开关\n    enabled: true"));
  await setSessionSetting({ ...f.base, enabled: false });
  const updated = await fs.readFile(f.file, "utf8");
  assert.match(updated, /# 手工说明/u);
  assert.match(updated, /# 当前会话开关/u);
  assert.equal(parseSimpleYaml(updated).sessions[(await readSessionSetting(f.base)).key].label, "编码会话");
  assert.equal((await readSessionSetting(f.base)).enabled, false);
});

test("malformed, duplicate and mismatched records are refused without replacing user bytes", async t => {
  const f = await fixture(t);
  await setSessionSetting({ ...f.base, enabled: true });
  const valid = await fs.readFile(f.file, "utf8");
  const key = (await readSessionSetting(f.base)).key;
  for (const invalid of [
    valid.replace("enabled: true", 'enabled: "false"'),
    valid.replace("enabled: true", "enabled: true\n    enabled: false"),
    valid.replace(`  ${key}:`, "  s_wrong:"),
    valid.replace('sessionId: "instance-a"', 'sessionId: "different-instance"'),
    "version: 2\n",
    "",
  ]) {
    await fs.writeFile(f.file, invalid);
    await assert.rejects(readSessionSetting(f.base));
    await assert.rejects(setSessionSetting({ ...f.base, enabled: false }));
    assert.equal(await fs.readFile(f.file, "utf8"), invalid);
  }
});

test("project control fields validate and survive loading without changing feature compilation", async t => {
  const f = await fixture(t);
  const config = { version: 2, enabled: false, sessionDefaults: { enabled: false }, artifacts: [],
    dynamicGroundTruth: { enabled: true } };
  validateProjectConfig(config, "project.yaml");
  for (const bad of [{ ...config, enabled: "false" }, { ...config, sessionDefaults: { enabled: null } },
    { ...config, sessionDefaults: { enabled: true, force: true } }]) {
    assert.throws(() => validateProjectConfig(bad, "project.yaml"));
  }
  await fs.mkdir(path.dirname(f.file));
  await fs.writeFile(path.join(path.dirname(f.file), "config.yaml"),
    "version: 2\nenabled: false\nsessionDefaults:\n  enabled: false\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n");
  const source = await loadProjectPolicySource(f.root);
  assert.equal(source.enabled, false);
  assert.equal(source.sessionDefaults.enabled, false);
  const plan = await loadRuntimePlan({ cwd: f.root });
  assert.equal(plan.enabled, false);
  assert.equal(plan.runtimeV2.enabled, true, "the project gate does not rewrite which v2 features are configured");
});
