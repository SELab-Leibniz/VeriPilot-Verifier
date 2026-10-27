import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseSimpleYaml } from "../simple-yaml.mjs";
import { validateProjectConfig } from "../policy/config-loader.mjs";
import { loadConfig } from "../runtime-corrector.mjs";

const queues = new Map();
const files = ["config.yaml", "config.reference.yaml", "example.reviewer.md", "example.rules.yaml", "README.md"];

async function withLock(projectRoot, callback) {
  const lock = path.join(projectRoot, ".runtime-corrector.lock");
  const previous = queues.get(lock) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const started = Date.now();
    let handle;
    while (!handle) {
      try { handle = await fs.open(lock, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() - started >= 5000) throw new Error("RC_PROJECT_CONFIG_BUSY");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await callback(); }
    finally { await handle.close(); await fs.rm(lock, { force: true }); }
  });
  queues.set(lock, next);
  try { return await next; }
  finally { if (queues.get(lock) === next) queues.delete(lock); }
}

// Edit only one scalar in the same restricted YAML accepted by the loader.
// Keep all other lines, comments, BOM, line endings and final newline intact.
function scalar(contents, keys, value) {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = contents.slice(bom.length), eol = text.includes("\r\n") ? "\r\n" : "\n";
  const ended = text.endsWith("\n"), lines = text.split(/\r?\n/);
  if (ended) lines.pop();
  let start = 0, end = lines.length;
  for (let depth = 0; depth < keys.length; depth++) {
    const indent = "  ".repeat(depth), key = keys[depth];
    let index = start;
    while (index < end && !new RegExp(`^${indent}${key}\\s*:`).test(lines[index])) index++;
    if (index === end) {
      const added = keys.slice(depth).map((name, offset) => `${"  ".repeat(depth + offset)}${name}:${depth + offset === keys.length - 1 ? ` ${JSON.stringify(value)}` : ""}`);
      lines.splice(end, 0, ...added);
      break;
    }
    if (depth === keys.length - 1) {
      lines[index] = lines[index].replace(new RegExp(`^(${indent}${key}\\s*:\\s*).*?$`), (_match, prefix) => `${prefix}${JSON.stringify(value)}`);
      break;
    }
    start = index + 1;
    end = start;
    while (end < lines.length && (!lines[end].trim() || lines[end].trimStart().startsWith("#")
      || lines[end].length - lines[end].trimStart().length > depth * 2)) end++;
  }
  return bom + lines.join(eol) + (ended ? eol : "");
}

async function regular(file, directory = false) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error("RC_PROJECT_CONFIG_PATH_UNSAFE");
}

async function absent(file) {
  try { await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("RC_PROJECT_CONFIG_EXISTS：已有 .runtime-corrector，未覆盖任何文件。");
}

export async function writeProjectControl({ projectRoot, field, enabled, assertCurrent }) {
  if (!["project", "default"].includes(field) || typeof enabled !== "boolean") throw new Error("RC_PROJECT_CONTROL_INVALID");
  return withLock(projectRoot, async () => {
    await assertCurrent();
    const policyRoot = path.join(projectRoot, ".runtime-corrector"), file = path.join(policyRoot, "config.yaml");
    await regular(policyRoot, true);
    await regular(file);
    const original = await fs.readFile(file, "utf8"), document = parseSimpleYaml(original, { source: file });
    validateProjectConfig(document, file);
    const current = field === "project" ? document.enabled !== false : document.sessionDefaults?.enabled !== false;
    if (current === enabled) return { changed: false, configPath: file };
    const expected = structuredClone(document), keys = field === "project" ? ["enabled"] : ["sessionDefaults", "enabled"];
    if (field === "project") expected.enabled = enabled;
    else (expected.sessionDefaults ??= {}).enabled = enabled;
    const contents = scalar(original, keys, enabled), next = parseSimpleYaml(contents, { source: file });
    validateProjectConfig(next, file);
    if (!isDeepStrictEqual(next, expected)) throw new Error("RC_PROJECT_CONFIG_EDIT_INVALID");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await assertCurrent();
      await regular(policyRoot, true);
      await regular(file);
      if (await fs.readFile(file, "utf8") !== original) throw new Error("RC_PROJECT_CONFIG_CONFLICT");
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return { changed: true, configPath: file };
  });
}

export async function initializeProjectConfig({ projectRoot, pluginRoot, reviewerModel, assertCurrent }) {
  return withLock(projectRoot, async () => {
    await assertCurrent();
    const target = path.join(projectRoot, ".runtime-corrector");
    await absent(target);
    const model = reviewerModel();
    if (typeof model !== "string" || !model.trim()) throw new Error("RC_REVIEWER_MODEL_UNCONFIGURED：请先运行 /rc-setup 设置 RC 模型。");
    const stagingRoot = path.join(projectRoot, `.runtime-corrector-init-${randomUUID()}.tmp`);
    const staging = path.join(stagingRoot, ".runtime-corrector");
    await fs.mkdir(stagingRoot, { mode: 0o700 });
    try {
      await fs.mkdir(staging, { mode: 0o700 });
      for (const name of files) {
        const source = path.join(pluginRoot, ".runtime-corrector-default", name);
        await regular(source);
        await fs.copyFile(source, path.join(staging, name));
      }
      const configPath = path.join(staging, "config.yaml");
      let contents = await fs.readFile(configPath, "utf8");
      validateProjectConfig(parseSimpleYaml(contents, { source: configPath }), configPath);
      contents = scalar(scalar(scalar(contents, ["enabled"], false), ["sessionDefaults", "enabled"], false),
        ["reviewers", "defaults", "model"], model);
      await fs.writeFile(configPath, contents, { mode: 0o600 });
      await loadConfig({ cwd: stagingRoot, pluginRoot });
      await assertCurrent();
      await absent(target);
      await fs.rename(staging, target);
    } finally {
      // Delete only this operation's staging tree inside the selected project.
      if (path.dirname(stagingRoot) !== projectRoot || !path.basename(stagingRoot).startsWith(".runtime-corrector-init-")) {
        throw new Error("RC_PROJECT_STAGING_PATH_UNSAFE");
      }
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
    return { initialized: true, configPath: path.join(target, "config.yaml"), reviewerModel: model };
  });
}
