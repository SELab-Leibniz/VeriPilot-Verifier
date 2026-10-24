import { promises as fs } from "node:fs";
import path from "node:path";

import * as claude from "./hosts/claude.mjs";
import * as codeagent from "./hosts/codeagent.mjs";
import * as openclaw from "./hosts/openclaw.mjs";
import { pluginBootstrapCommand } from "./plugin-bootstrap.mjs";
import { adaptSkillsForOpenClaw } from "./openclaw/skills.mjs";


const HOSTS = Object.freeze({ claude, codeagent, openclaw });
const EXCLUDED_TOP_LEVEL = new Set([
  ".git", ".github", ".runtime-correction", ".claude-plugin", ".cac-plugin",
  "dist", "node_modules", "packaging", "test",
]);
const REVIEW_DEPENDENCIES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"];
const copyArtifactEntry = file => !["node_modules", ".runtime-correction"].includes(path.basename(file));


async function reviewDependencyLock(artifactRoot, packageDocument) {
  const directory = path.join(artifactRoot, "lib", "review-task");
  const reviewPackage = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  const lock = JSON.parse(await fs.readFile(path.join(directory, "package-lock.json"), "utf8"));
  const dependencies = reviewPackage.dependencies ?? {};
  if (JSON.stringify(Object.keys(dependencies).sort()) !== JSON.stringify([...REVIEW_DEPENDENCIES].sort())
    || Object.values(dependencies).some(version => !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version))
    || lock.lockfileVersion !== 3 || !lock.packages?.[""]
    || Object.keys(lock.packages[""].dependencies ?? {}).length !== REVIEW_DEPENDENCIES.length
    || Object.keys(dependencies).some(name => lock.packages[""].dependencies?.[name] !== dependencies[name]
      || lock.packages[`node_modules/${name}`]?.version !== dependencies[name])) {
    throw new Error("Review worker requires exactly pinned Pi/typebox dependencies and their matching npm v3 lockfile.");
  }
  for (const [name, version] of Object.entries(packageDocument.dependencies ?? {})) {
    if (dependencies[name] !== version) throw new Error(`Plugin dependency ${name} is not covered by the review worker lockfile.`);
  }
  packageDocument.dependencies = { ...packageDocument.dependencies, ...dependencies };
  for (const [name, version] of Object.entries(reviewPackage.overrides ?? {})) {
    if (packageDocument.overrides?.[name] !== undefined && packageDocument.overrides[name] !== version) {
      throw new Error(`Plugin override ${name} conflicts with the review worker lockfile.`);
    }
  }
  if (reviewPackage.overrides) packageDocument.overrides = { ...packageDocument.overrides, ...reviewPackage.overrides };
  // Keep every locked transitive package untouched; only the artifact root's
  // identity and declarations differ from the standalone worker package.
  lock.name = packageDocument.name;
  lock.version = packageDocument.version;
  lock.packages[""] = Object.fromEntries([
    "name", "version", "license", "bin", "dependencies", "devDependencies", "optionalDependencies",
    "engines", "peerDependencies", "peerDependenciesMeta",
  ].filter(key => packageDocument[key] !== undefined).map(key => [key, packageDocument[key]]));
  return lock;
}


export function resolvePluginHost(value) {
  if (!Object.hasOwn(HOSTS, value)) {
    throw new Error("Plugin host must be claude or codeagent or openclaw.");
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
    await fs.cp(path.join(source, entry.name), path.join(artifactRoot, entry.name), { recursive: true, filter: copyArtifactEntry });
  }

  const manifestTarget = path.join(artifactRoot, hostAdapter.manifestDirectory);
  await fs.mkdir(manifestTarget, { recursive: true });
  const manifestSource = path.join(source, "packaging", "hosts", host);
  if (host === "openclaw") {
    await fs.copyFile(path.join(manifestSource, "openclaw.plugin.json"), path.join(artifactRoot, "openclaw.plugin.json"));
  } else {
    await fs.copyFile(path.join(manifestSource, "plugin.json"), path.join(manifestTarget, "plugin.json"));
    await fs.copyFile(path.join(manifestSource, "marketplace.json"), path.join(manifestTarget, "marketplace.json"));
  }

  await fs.writeFile(
    path.join(artifactRoot, "lib", "active-host.mjs"),
    `export * from "./hosts/${host}.mjs";\n`,
    "utf8",
  );
  for (const inactive of Object.keys(HOSTS).filter((name) => name !== host)) {
    await fs.rm(path.join(artifactRoot, "lib", "hosts", `${inactive}.mjs`), { force: true });
  }
  if (host !== "claude") await fs.rm(path.join(artifactRoot, "lib", "claude-executable.mjs"), { force: true });
  if (host !== "openclaw") {
    await fs.rm(path.join(artifactRoot, "lib", "openclaw"), { recursive: true, force: true });
    await fs.rm(path.join(artifactRoot, "scripts", "diagnostics"), { recursive: true, force: true });
  }
  await fs.rm(path.join(artifactRoot, "lib", "plugin-builder.mjs"), { force: true });
  await fs.rm(path.join(artifactRoot, "scripts", "build-plugin.mjs"), { force: true });
  await fs.rm(path.join(artifactRoot, "plugin-target.json"), { force: true });

  const packagePath = path.join(artifactRoot, "package.json");
  const packageDocument = JSON.parse(await fs.readFile(packagePath, "utf8"));
  delete packageDocument.scripts["build:plugin"];
  delete packageDocument.scripts["build:plugins"];
  delete packageDocument.scripts["test:artifacts"];
  if (host === "openclaw") {
    packageDocument.name = "runtime-corrector-openclaw";
    packageDocument.version = "1.9.1-openclaw.11-session-projects.11";
    packageDocument.description = "Session-scoped runtime correction for OpenClaw 2026.7.1-2 and 2026.10.3.";
    packageDocument.engines.node = ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0";
    packageDocument.peerDependencies = { openclaw: "2026.7.1-2 || 2026.10.3" };
    packageDocument.peerDependenciesMeta = { openclaw: { optional: true } };
    packageDocument.openclaw = { extensions: ["./lib/openclaw/entry.mjs"],
      // The old host normalizes numeric correction releases to the base API.
      // Entry and adapters still enforce the exact verified runtime releases.
      compat: { pluginApi: ">=2026.7.1 <=2026.10.3" },
      build: { openclawVersion: "2026.7.1-2", pluginSdkVersion: "2026.7.1-2" } };
    packageDocument.scripts = { check: "node ./scripts/cli.mjs" };
    const lock = await reviewDependencyLock(artifactRoot, packageDocument);
    await fs.writeFile(path.join(artifactRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }
  await fs.writeFile(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`, "utf8");

  if (host === "openclaw") {
    for (const directory of ["hooks", "commands"]) {
      await fs.rm(path.join(artifactRoot, directory), { recursive: true, force: true });
    }
    for (const script of ["runtime-event.mjs", "post-tool-use.mjs", "session-end.mjs", "evidence-distinctness-guard.mjs", "benchmark-session-end.mjs"]) {
      await fs.rm(path.join(artifactRoot, "scripts", script), { force: true });
    }
    await fs.cp(path.join(manifestSource, "skills"), path.join(artifactRoot, "skills"), { recursive: true, filter: copyArtifactEntry });
    await adaptSkillsForOpenClaw(path.join(artifactRoot, "skills"));
    const guide = await fs.readFile(path.join(source, "docs", "openclaw.md"), "utf8");
    await fs.writeFile(path.join(artifactRoot, "README.md"), guide
      .replace(/\((openclaw-acceptance(?:-\d+)?\.md)\)/gu, "(docs/$1)")
      .replace("(openclaw-supervised-tasks.md)", "(docs/openclaw-supervised-tasks.md)"));
  } else await transformDeclarations(artifactRoot, hostAdapter);
  return artifactRoot;
}
