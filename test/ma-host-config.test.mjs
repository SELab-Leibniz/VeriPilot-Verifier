import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { configureMAHost } from "../scripts/configure-ma-host.mjs";

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-matrix-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "extensions/runtime-corrector");
  const configPath = path.join(root, "openclaw.json");
  const manifestPath = path.join(pluginRoot, "openclaw.plugin.json");
  const manifest = { id: "runtime-corrector", main: "./lib/openclaw/entry.mjs" };
  await fs.mkdir(path.join(pluginRoot, "lib/openclaw"), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, manifest.main), "export default {};\n");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({ openclaw: { extensions: [manifest.main] } }));
  const original = JSON.stringify(config, null, 2) + "\n";
  await fs.writeFile(configPath, original);
  return { root, pluginRoot, configPath, manifestPath, manifest, original };
}

test("MA setup preserves other settings, backs up exact bytes and is idempotent", async t => {
  const otherEntry = { enabled: false, config: { untouched: true } };
  const config = { models: { providers: { user: { apiKey: "fixture-only" } } }, tools: { deny: ["exec"] },
    plugins: { enabled: true, load: { paths: ["/host/resources/plugins"] }, allow: ["other"],
      installs: { other: { source: "path" } }, entries: { other: otherEntry,
        "runtime-corrector": { enabled: false, config: { reviewerModel: "custom/previous", hookTimeoutMs: 600000 },
          hooks: { allowConversationAccess: false, otherPermission: false } } } } };
  const f = await fixture(t, config);
  const result = await configureMAHost(f);
  assert.equal(result.changed, true);
  assert.equal(await fs.readFile(result.backupPath, "utf8"), f.original);
  const updated = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  assert.deepEqual(updated.models, config.models);
  assert.deepEqual(updated.tools, config.tools);
  assert.deepEqual(updated.plugins.entries.other, otherEntry);
  assert.deepEqual(updated.plugins.installs, config.plugins.installs);
  assert.deepEqual(updated.plugins.load.paths, ["/host/resources/plugins", f.pluginRoot.replaceAll("\\", "/")]);
  assert.deepEqual(updated.plugins.entries["runtime-corrector"], {
    enabled: true, config: { reviewerModel: "custom/previous", hookTimeoutMs: 600000 },
    hooks: { allowConversationAccess: true, otherPermission: false, allowPromptInjection: true },
  });
  assert.deepEqual(updated.plugins.allow, ["other", "runtime-corrector"]);
  const files = await fs.readdir(f.root);
  const before = await fs.readFile(f.configPath, "utf8");
  assert.equal((await configureMAHost(f)).changed, false);
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
  assert.deepEqual(await fs.readdir(f.root), files);
});

test('MA setup retries a temporarily blocked replacement without deleting the config',async t=>{
 const f=await fixture(t,{tools:{deny:['write']}}),rename=fs.rename;let attempts=0;
 fs.rename=async function(from,to){if(to===f.configPath&&++attempts<=2)throw Object.assign(new Error('shared reader'),{code:'EPERM'});return rename.call(this,from,to);};
 let result;try{result=await configureMAHost(f);}finally{fs.rename=rename;}
 assert.equal(attempts,3);assert.equal(await fs.readFile(result.backupPath,'utf8'),f.original);
 assert.deepEqual(JSON.parse(await fs.readFile(f.configPath,'utf8')).tools.deny,['write']);
 assert.equal((await fs.readdir(f.root)).filter(name=>name.endsWith('.tmp')).length,0);
});

test('a persistent configuration lock fails finitely and preserves the original bytes',async t=>{
 const f=await fixture(t,{retained:true}),rename=fs.rename;let attempts=0;
 fs.rename=async function(from,to){if(to===f.configPath){attempts++;throw Object.assign(new Error('still locked'),{code:'EBUSY'});}return rename.call(this,from,to);};
 try{await assert.rejects(configureMAHost(f),error=>error.code==='EBUSY');}finally{fs.rename=rename;}
 assert.equal(attempts,8);assert.equal(await fs.readFile(f.configPath,'utf8'),f.original);
 assert.equal((await fs.readdir(f.root)).filter(name=>name.endsWith('.tmp')).length,0);
});

test('a concurrent config edit during replacement backoff is never overwritten',async t=>{
 const f=await fixture(t,{retained:true}),rename=fs.rename;let attempts=0;
 const concurrent='{"concurrent":"preserve exact bytes"}\n';
 fs.rename=async function(from,to){if(to===f.configPath){attempts++;await fs.writeFile(to,concurrent);throw Object.assign(new Error('reader released after another editor wrote'),{code:'EPERM'});}return rename.call(this,from,to);};
 try{await assert.rejects(configureMAHost(f),/Config changed during setup/);}finally{fs.rename=rename;}
 assert.equal(attempts,1);assert.equal(await fs.readFile(f.configPath,'utf8'),concurrent);
 assert.equal((await fs.readdir(f.root)).filter(name=>name.endsWith('.tmp')).length,0);
});

test("CLI restores an erased RC entry and model using an explicit isolated config", async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, ["scripts/configure-ma-host.mjs", "--config", f.configPath,
    "--reviewer-model", "custom/reviewer"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, true);
  const { plugins } = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  assert.equal(plugins.entries["runtime-corrector"].config.reviewerModel, "custom/reviewer");
  assert.equal(plugins.entries["runtime-corrector"].enabled, true);
  assert.equal(plugins.entries["runtime-corrector"].hooks.allowConversationAccess, true);
  assert.equal(plugins.entries["runtime-corrector"].hooks.allowPromptInjection, true);
  assert.deepEqual(plugins.load.paths, [f.pluginRoot.replaceAll("\\", "/")]);
});

test("old manifests and mismatched entry points fail before changing configuration", async t => {
  for (const main of [undefined, "../outside.mjs", "./missing.mjs"]) {
    const f = await fixture(t);
    await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, main }));
    await assert.rejects(configureMAHost(f), /Reinstall the rebuilt/);
    assert.equal(await fs.readFile(f.configPath, "utf8"), f.original);
    assert.deepEqual((await fs.readdir(f.root)).sort(), ["extensions", "openclaw.json"]);
  }
});

test("malformed config is not overwritten and equivalent Windows paths are not duplicated", async t => {
  for (const plugins of [[], { load: { paths: "invalid" } }, { entries: { "runtime-corrector": { hooks: [] } } }]) {
    const f = await fixture(t, { plugins });
    await assert.rejects(configureMAHost(f));
    assert.equal(await fs.readFile(f.configPath, "utf8"), f.original);
  }
  const f = await fixture(t);
  await fs.writeFile(f.configPath, JSON.stringify({ plugins: { load: { paths: [f.pluginRoot] } } }));
  await configureMAHost(f);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, "utf8")).plugins.load.paths, [f.pluginRoot]);
});

test("agent tool opt-in preserves inherited tools, deny rules and other agents without changing global tools", async t => {
  const config = { tools: { profile: "coding", alsoAllow: ["browser", "coding"], deny: ["exec"] },
    agents: { list: [{ id: "main", default: true, tools: { deny: ["write"] } },
      { id: "other", tools: { alsoAllow: ["read"], deny: ["runtime_corrector"] } }] } };
  const f = await fixture(t, config);
  const result = await configureMAHost({ ...f, toolAgent: "main" });
  const updated = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  assert.deepEqual(updated.tools, config.tools);
  assert.deepEqual(updated.agents.list[0].tools, { deny: ["write"], alsoAllow: ["browser", "coding", "runtime_corrector"] });
  assert.deepEqual(updated.agents.list[1], config.agents.list[1]);
  assert.equal(await fs.readFile(result.backupPath, "utf8"), f.original);
  assert.equal((await configureMAHost({ ...f, toolAgent: "main" })).changed, false);
});

test("agent tool opt-in retains an existing explicit scope and fails safely for missing agents or invalid lists", async t => {
  const f = await fixture(t, { tools: { alsoAllow: ["browser"] },
    agents: { list: [{ id: "main", tools: { profile: "minimal", alsoAllow: ["read"] } }] } });
  await configureMAHost({ ...f, toolAgent: "main" });
  const updated = JSON.parse(await fs.readFile(f.configPath, "utf8"));
  assert.deepEqual(updated.agents.list[0].tools, { profile: "minimal", alsoAllow: ["read", "runtime_corrector"] });
  for (const config of [{ agents: { list: [] } },
    { agents: { list: [{ id: "main", tools: { alsoAllow: "invalid" } }] } }]) {
    const broken = await fixture(t, config);
    await assert.rejects(configureMAHost({ ...broken, toolAgent: "main" }));
    assert.equal(await fs.readFile(broken.configPath, "utf8"), broken.original);
  }
});
