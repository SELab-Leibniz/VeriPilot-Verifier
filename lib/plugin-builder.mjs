import { promises as fs } from "node:fs";
import path from "node:path";

import * as claude from "./hosts/claude.mjs";
import * as codeagent from "./hosts/codeagent.mjs";
import { pluginBootstrapCommand } from "./plugin-bootstrap.mjs";


const HOSTS = Object.freeze({ claude, codeagent });
const EXCLUDED_TOP_LEVEL = new Set([
  ".git", ".github", ".runtime-correction", ".claude-plugin", ".cac-plugin",
  "dist", "node_modules", "packaging", "test",
]);


export function resolvePluginHost(value) {
  if (!Object.hasOwn(HOSTS, value)) {
    throw new Error("Plugin host must be claude or codeagent.");
  }
  return HOSTS[value];
}


function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}


async function transformMarkdown(file, hostAdapter) {
  const original = await fs.readFile(file, "utf8");
  const transformed = original.replace(
    /node -e "[^"\r\n]*" "(scripts\/[a-z0-9-]+\.mjs)"/gu,
    (_match, entry) => pluginBootstrapCommand(entry, hostAdapter, { inlineRoot: true }),
  );
  await fs.writeFile(file, transformed, "utf8");
}


function replaceHookCommands(value, hostAdapter) {
  if (Array.isArray(value)) return value.map((entry) => replaceHookCommands(entry, hostAdapter));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "command" && typeof entry === "string") {
      const match = entry.match(/"(scripts\/[a-z0-9-]+\.mjs)"$/u);
      if (!match) throw new Error(`Unsupported generated hook command: ${entry}`);
      return [key, pluginBootstrapCommand(match[1], hostAdapter)];
    }
    return [key, replaceHookCommands(entry, hostAdapter)];
  }));
}


async function transformDeclarations(artifactRoot, hostAdapter) {
  const hookPath = path.join(artifactRoot, "hooks", "hooks.json");
  const hookDocument = JSON.parse(await fs.readFile(hookPath, "utf8"));
  await fs.writeFile(hookPath, `${JSON.stringify(replaceHookCommands(hookDocument, hostAdapter), null, 2)}\n`, "utf8");
  async function transformMarkdownTree(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) await transformMarkdownTree(candidate);
      else if (entry.isFile() && entry.name.endsWith(".md")) await transformMarkdown(candidate, hostAdapter);
    }
  }
  for (const directory of ["commands", "skills"]) {
    await transformMarkdownTree(path.join(artifactRoot, directory));
  }
}


export async function buildPlugin({ host, sourceRoot, outputRoot }) {
  const hostAdapter = resolvePluginHost(host);
  const source = await fs.realpath(path.resolve(sourceRoot));
  const output = path.resolve(outputRoot);
  const artifactRoot = path.join(output, `runtime-corrector-${host}`);
  if (!inside(output, artifactRoot) || artifactRoot === source || inside(artifactRoot, source)) {
    throw new Error("Plugin output must be a dedicated directory outside the source tree ancestry.");
  }
  await fs.mkdir(output, { recursive: true });
  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(artifactRoot, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    await fs.cp(path.join(source, entry.name), path.join(artifactRoot, entry.name), { recursive: true });
  }

  const manifestTarget = path.join(artifactRoot, hostAdapter.manifestDirectory);
  await fs.mkdir(manifestTarget, { recursive: true });
  const manifestSource = path.join(source, "packaging", "hosts", host);
  await fs.copyFile(path.join(manifestSource, "plugin.json"), path.join(manifestTarget, "plugin.json"));
  if (host === "claude") {
    await fs.copyFile(path.join(manifestSource, "marketplace.json"), path.join(manifestTarget, "marketplace.json"));
  }

  await fs.writeFile(
    path.join(artifactRoot, "lib", "active-host.mjs"),
    `export * from "./hosts/${host}.mjs";\n`,
    "utf8",
  );
  const inactiveHostFile = path.join(artifactRoot, "lib", "hosts", host === "claude" ? "codeagent.mjs" : "claude.mjs");
  await fs.rm(inactiveHostFile, { force: true });
  if (host === "codeagent") await fs.rm(path.join(artifactRoot, "lib", "claude-executable.mjs"), { force: true });
  await fs.rm(path.join(artifactRoot, "lib", "plugin-builder.mjs"), { force: true });
  await fs.rm(path.join(artifactRoot, "scripts", "build-plugin.mjs"), { force: true });
  await fs.rm(path.join(artifactRoot, "plugin-target.json"), { force: true });

  const packagePath = path.join(artifactRoot, "package.json");
  const packageDocument = JSON.parse(await fs.readFile(packagePath, "utf8"));
  delete packageDocument.scripts["build:plugin"];
  delete packageDocument.scripts["build:plugins"];
  delete packageDocument.scripts["test:artifacts"];
  await fs.writeFile(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`, "utf8");

  await transformDeclarations(artifactRoot, hostAdapter);
  if (host === "codeagent") {
    const runtimeConfig = path.join(artifactRoot, "config", "runtime.yaml");
    const text = await fs.readFile(runtimeConfig, "utf8");
    if (!text.includes("semanticReviewTimeoutMs: 240000")) {
      throw new Error("CodeAgent timeout template is missing the expected semantic-review default.");
    }
    await fs.writeFile(runtimeConfig, text.replace("semanticReviewTimeoutMs: 240000", "semanticReviewTimeoutMs: 900000"), "utf8");
  }
  return artifactRoot;
}
