import { execFile } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

export const nativeOwnerFile = "ma-extension-owner.json";
const pluginId = "runtime-corrector";
const execute = promisify(execFile);

export function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isMarketOwner(home, owner) {
  return typeof owner === "string" && path.isAbsolute(owner)
    && pathKey(path.dirname(owner)) === pathKey(path.join(home, ".matrixassistant", "plugins"))
    && /^runtime-corrector(?:-\d+\.\d+\.\d+)?$/u.test(path.basename(owner));
}

export function readNativeOwner(directory) {
  let value;
  try {
    value = JSON.parse(readFileSync(path.join(directory, nativeOwnerFile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!value || typeof value.owner !== "string" || !path.isAbsolute(value.owner)
    || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.version)
    || typeof value.token !== "string" || !/^[\da-f-]{36}$/u.test(value.token)) {
    throw new Error("Invalid RC market ownership record.");
  }
  return value;
}

export function sameNativeOwner(first, second) {
  return first && second && first.token === second.token && first.version === second.version
    && pathKey(first.owner) === pathKey(second.owner);
}

async function bundledCli(installRoot) {
  const executableDir = path.dirname(process.execPath);
  const roots = [process.resourcesPath, installRoot && path.join(installRoot, "resources"),
    path.join(executableDir, "resources"), path.resolve(executableDir, "..", "Resources")];
  for (const root of new Set(roots.filter(Boolean))) {
    const entry = path.join(root, "openclaw", "openclaw.mjs");
    try {
      if ((await fs.stat(entry)).isFile()) return entry;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  throw new Error("The MA-bundled OpenClaw CLI could not be found.");
}

export async function runNativeCommand(where, args, original, installRoot) {
  const cli = await bundledCli(installRoot);
  const config = JSON.parse(original.replace(/^\uFEFF/u, ""));
  // OpenClaw install enables the plugin and may also change its deny/allow
  // policy. Give the CLI a private copy and let the RC config transaction
  // apply its own settings. The actual state dir retains native install records.
  if (config.$include !== undefined || config.plugins?.$include !== undefined) {
    throw new Error("RC market installation cannot safely stage an included OpenClaw plugins config.");
  }
  const draft = path.join(path.dirname(where.config), `.${pluginId}-native-${randomUUID()}.json`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCLAW_NO_RESPAWN: "1", NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: draft, OPENCLAW_STATE_DIR: path.dirname(where.extensions), OPENCLAW_HOME: where.home };
  delete env.NODE_OPTIONS;
  await fs.writeFile(draft, original, { flag: "wx", mode: 0o600 });
  try {
    const { stdout } = await execute(process.execPath, [cli, "plugins", ...args], {
      env, windowsHide: true, timeout: 48000, maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, config: JSON.parse((await fs.readFile(draft, "utf8")).replace(/^\uFEFF/u, "")) };
  } catch (error) {
    const detail = (error.stderr?.trim() || error.stdout?.trim() || error.message).slice(-2000);
    throw new Error(`OpenClaw plugins ${args[0]} failed: ${detail}`, { cause: error });
  } finally {
    // A single native command writes at most one generation of this new file.
    await fs.rm(draft, { force: true });
    await fs.rm(`${draft}.bak`, { force: true });
  }
}
