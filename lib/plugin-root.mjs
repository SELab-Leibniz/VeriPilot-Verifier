import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const EXPECTED_PLUGIN_NAME = "runtime-corrector";
const ROOT_ENV_KEYS = ["CLAUDE_PLUGIN_ROOT", "CODEAGENT3_PLUGIN_ROOT"];


function pluginRootError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}


function normalizedDeclaration(env, key) {
  const value = env?.[key];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}


function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}


async function readPluginIdentity(root) {
  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw pluginRootError(
      "PLUGIN_ROOT_IDENTITY_MISMATCH",
      `Plugin root does not contain a readable Runtime Corrector manifest: ${root}`,
      error,
    );
  }
  if (manifest?.name !== EXPECTED_PLUGIN_NAME) {
    throw pluginRootError(
      "PLUGIN_ROOT_IDENTITY_MISMATCH",
      `Plugin root has unexpected identity ${JSON.stringify(manifest?.name)}: ${root}`,
    );
  }
  return manifest;
}


async function canonicalDeclaredRoot(value, key) {
  if (!path.isAbsolute(value)) {
    throw pluginRootError(
      "PLUGIN_ROOT_NOT_ABSOLUTE",
      `${key} must contain an absolute plugin path.`,
    );
  }
  let canonical;
  let stats;
  try {
    canonical = await fs.realpath(value);
    stats = await fs.stat(canonical);
  } catch (error) {
    throw pluginRootError(
      "PLUGIN_ROOT_NOT_DIRECTORY",
      `${key} does not identify an existing plugin directory: ${value}`,
      error,
    );
  }
  if (!stats.isDirectory()) {
    throw pluginRootError(
      "PLUGIN_ROOT_NOT_DIRECTORY",
      `${key} does not identify a plugin directory: ${value}`,
    );
  }
  await readPluginIdentity(canonical);
  return canonical;
}


async function rootForExecutingModule(executingModuleUrl) {
  if (!executingModuleUrl) {
    throw pluginRootError(
      "PLUGIN_ROOT_EXECUTION_MISMATCH",
      "The executing module URL is required to verify the plugin root.",
    );
  }
  let current = path.dirname(fileURLToPath(executingModuleUrl));
  while (true) {
    const manifestPath = path.join(current, ".claude-plugin", "plugin.json");
    try {
      await fs.access(manifestPath);
      await readPluginIdentity(current);
      return fs.realpath(current);
    } catch (error) {
      if (error?.code === "PLUGIN_ROOT_IDENTITY_MISMATCH") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw pluginRootError(
    "PLUGIN_ROOT_IDENTITY_MISMATCH",
    `The executing module is not inside a ${EXPECTED_PLUGIN_NAME} artifact.`,
  );
}


export async function resolvePluginRoot({
  env = process.env,
  executingModuleUrl,
  explicitRoot = null,
} = {}) {
  const declarations = Object.fromEntries(
    ROOT_ENV_KEYS.map((key) => [key, normalizedDeclaration(env, key)]),
  );
  const moduleRoot = await rootForExecutingModule(executingModuleUrl);
  const candidates = [];

  for (const key of ROOT_ENV_KEYS) {
    if (!declarations[key]) continue;
    candidates.push({ key, root: await canonicalDeclaredRoot(declarations[key], key) });
  }
  if (explicitRoot !== null && explicitRoot !== undefined) {
    const value = typeof explicitRoot === "string" ? explicitRoot.trim() : "";
    if (!value) {
      throw pluginRootError("PLUGIN_ROOT_MISSING", "The explicit plugin root is empty.");
    }
    candidates.push({
      key: "explicitRoot",
      root: await canonicalDeclaredRoot(value, "explicitRoot"),
    });
  }
  if (candidates.length === 0) {
    throw pluginRootError(
      "PLUGIN_ROOT_MISSING",
      `Set one of ${ROOT_ENV_KEYS.join(" or ")} to the plugin installation directory.`,
    );
  }

  const distinctRoots = new Set(candidates.map((candidate) => candidate.root));
  if (distinctRoots.size > 1) {
    throw pluginRootError(
      "PLUGIN_ROOT_CONFLICT",
      `Plugin root declarations disagree: ${candidates.map(({ key, root }) => `${key}=${root}`).join(", ")}`,
    );
  }
  const [selectedRoot] = distinctRoots;
  if (selectedRoot !== moduleRoot) {
    throw pluginRootError(
      "PLUGIN_ROOT_EXECUTION_MISMATCH",
      `Declared plugin root ${selectedRoot} does not match executing plugin root ${moduleRoot}.`,
    );
  }

  return {
    root: moduleRoot,
    source: explicitRoot !== null && explicitRoot !== undefined ? "explicit" : "module",
    declarations,
  };
}


export async function resolvePluginEntry({ root, entry } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw pluginRootError("PLUGIN_ROOT_NOT_ABSOLUTE", "Plugin root must be absolute.");
  }
  const candidate = path.resolve(root, entry ?? "");
  if (!isPathInside(root, candidate)) {
    throw pluginRootError(
      "PLUGIN_ROOT_ENTRY_ESCAPE",
      `Plugin entry escapes the plugin root: ${entry}`,
    );
  }
  let canonicalEntry;
  try {
    canonicalEntry = await fs.realpath(candidate);
  } catch (error) {
    throw pluginRootError(
      "PLUGIN_ROOT_ENTRY_ESCAPE",
      `Plugin entry is unavailable: ${entry}`,
      error,
    );
  }
  const canonicalRoot = await fs.realpath(root);
  if (!isPathInside(canonicalRoot, canonicalEntry)) {
    throw pluginRootError(
      "PLUGIN_ROOT_ENTRY_ESCAPE",
      `Plugin entry resolves outside the plugin root: ${entry}`,
    );
  }
  return canonicalEntry;
}
