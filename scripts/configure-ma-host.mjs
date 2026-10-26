#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// MA 1.8.160 only retains load.paths manifests whose `main`
// exists. Its startup cleanup does not discover ~/.openclaw/extensions.
export async function configureMAHost({
  configPath = process.env.OPENCLAW_CONFIG_PATH
    ?? path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"), "openclaw.json"),
  pluginRoot = path.join(path.dirname(configPath), "extensions", "runtime-corrector"),
  reviewerModel,
  toolAgent,
} = {}) {
  configPath = path.resolve(configPath);
  pluginRoot = await fs.realpath(path.resolve(pluginRoot));
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"));
  const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"));
  const main = typeof manifest.main === "string" ? path.resolve(pluginRoot, manifest.main) : null;
  const relative = main && path.relative(pluginRoot, main);
  if (manifest.id !== "runtime-corrector" || !main || !relative || path.isAbsolute(relative)
    || relative === ".." || relative.startsWith(`..${path.sep}`)
    || !pkg.openclaw?.extensions?.includes(manifest.main)
    || !(await fs.stat(main)).isFile()) {
    throw new Error("Reinstall the rebuilt OpenClaw plugin: a matching manifest.main and openclaw.extensions entry is required.");
  }
  const original = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(original);
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (!object(config)) throw new Error("OpenClaw config must be an object.");
  config.plugins ??= {};
  const plugins = config.plugins;
  if (!object(plugins)) throw new Error("plugins must be an object.");
  plugins.load ??= {};
  plugins.entries ??= {};
  plugins.allow ??= [];
  if (!object(plugins.load) || !object(plugins.entries) || !Array.isArray(plugins.allow)) {
    throw new Error("Invalid plugins.load, plugins.entries or plugins.allow; configuration was not changed.");
  }
  plugins.load.paths ??= [];
  if (!Array.isArray(plugins.load.paths) || plugins.load.paths.some(value => typeof value !== "string")) {
    throw new Error("plugins.load.paths must be an array of paths.");
  }
  const portable = pluginRoot.replaceAll("\\", "/");
  if (!plugins.load.paths.some(value => path.resolve(value) === pluginRoot)) plugins.load.paths.push(portable);
  if (!plugins.allow.includes(manifest.id)) plugins.allow.push(manifest.id);
  plugins.entries[manifest.id] ??= {};
  const entry = plugins.entries[manifest.id];
  if (!object(entry)) throw new Error("Runtime Corrector entry must be an object.");
  entry.hooks ??= {};
  entry.config ??= {};
  if (!object(entry.hooks) || !object(entry.config)) throw new Error("Runtime Corrector hooks/config must be objects.");
  entry.enabled = true;
  entry.hooks.allowConversationAccess = true;
  entry.hooks.allowPromptInjection = true;
  if (reviewerModel !== undefined) {
    if (!reviewerModel.trim()) throw new Error("reviewerModel must not be empty.");
    entry.config.reviewerModel = reviewerModel;
  }
  if (toolAgent !== undefined) {
    const agent = config.agents?.list?.find(value => value.id === toolAgent);
    if (!agent) throw new Error(`Configured agent not found: ${toolAgent}`);
    agent.tools ??= {};
    if (!object(agent.tools)) throw new Error("Agent tools must be an object.");
    // Agent alsoAllow replaces the profile's global alsoAllow. Inherit the
    // current list only when this agent does not already own an explicit list.
    const alsoAllow = agent.tools.alsoAllow ?? config.tools?.alsoAllow ?? [];
    if (!Array.isArray(alsoAllow) || alsoAllow.some(value => typeof value !== "string")) {
      throw new Error("Agent/global tools.alsoAllow must be an array of tool names.");
    }
    agent.tools.alsoAllow = [...alsoAllow];
    if (!agent.tools.alsoAllow.includes("runtime_corrector")) agent.tools.alsoAllow.push("runtime_corrector");
  }
  if (JSON.stringify(JSON.parse(original)) === JSON.stringify(config)) {
    return { changed: false, configPath, pluginRoot };
  }
  const suffix = `${Date.now()}-${randomUUID()}`;
  const backupPath = `${configPath}.runtime-corrector-${suffix}.bak`;
  const temporary = `${configPath}.runtime-corrector-${suffix}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (await fs.readFile(configPath, "utf8") !== original) throw new Error("Config changed during setup; retry after closing MA.");
    await fs.writeFile(backupPath, original, { mode: 0o600, flag: "wx" });
    const retryable=new Set(['EPERM','EBUSY','EACCES']);
    for(let attempt=0;;attempt++){
      // A shared Windows reader may temporarily block atomic replacement.
      // Never delete the destination, and never overwrite a concurrent edit
      // after waiting for that reader to release its handle.
      if(await fs.readFile(configPath,'utf8')!==original)throw new Error('Config changed during setup; retry after closing MA.');
      try{await fs.rename(temporary,configPath);break;}
      catch(error){
        if(!retryable.has(error.code)||attempt>=7)throw error;
        await new Promise(resolve=>setTimeout(resolve,Math.min(10*2**attempt,250)));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { changed: true, configPath, pluginRoot, backupPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      config: { type: "string" }, "plugin-root": { type: "string" },
      "reviewer-model": { type: "string" }, help: { type: "boolean" },
      "tool-agent": { type: "string" },
    } });
    if (values.help) {
      console.log("node scripts/configure-ma-host.mjs [--config <openclaw.json>] [--plugin-root <installed-plugin>] [--reviewer-model <provider/model>] [--tool-agent <agent-id>]");
    } else {
      console.log(JSON.stringify(await configureMAHost({ configPath: values.config,
        pluginRoot: values["plugin-root"], reviewerModel: values["reviewer-model"], toolAgent: values["tool-agent"] }), null, 2));
    }
  } catch (error) {
    console.error(`[runtime-corrector] ${error.message}`);
    process.exitCode = 1;
  }
}
