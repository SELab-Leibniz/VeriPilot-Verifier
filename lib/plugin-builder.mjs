import { promises as fs } from "node:fs";
import path from "node:path";

import * as claude from "./hosts/claude.mjs";
import * as codeagent from "./hosts/codeagent.mjs";
import * as openclaw from "./hosts/openclaw.mjs";
import { pluginBootstrapCommand } from "./plugin-bootstrap.mjs";
import { adaptSkillsForOpenClaw } from "./openclaw/skills.mjs";
import { bundleReviewDependency } from "./bundled-review-dependencies.mjs";


const HOSTS = Object.freeze({ claude, codeagent, openclaw });
// Deliberate runtime inputs. New repository directories never enter a release
// implicitly; new resource types must be added here with an artifact test.
const RUNTIME_FILES = [
  "config/runtime.yaml", "config/reviewer-defaults.json", "config/stop-defaults.json",
  "config/checklist-vocabulary.v1.json", "config/root-cause-catalog.v1.json",
  "config/platforms/harmonyos.json", "config/schemas/project-config.schema.json",
  "config/schemas/correction-result.schema.json", "knowledge/ir/default.json", "knowledge/ir/rules.md",
  "specs/custom-stage.md", "templates/project/.runtime-corrector/README.md",
  "templates/project/.runtime-corrector/config.yaml", "templates/project/.runtime-corrector/example.rules.yaml",
  "templates/project/.runtime-corrector/example.reviewer.md", "scripts/cli.mjs",
  "lib/review-task/prompts.json", "lib/review-task/package.json", "lib/review-task/package-lock.json",
];
const SKILL_FILES = [
  "skills/runtime-corrector-control/SKILL.md", "skills/runtime-corrector-init/SKILL.md",
  "skills/runtime-corrector-workflow/SKILL.md", "skills/semantic-review/SKILL.md",
  "skills/runtime-corrector-init/agents/openai.yaml", "skills/runtime-corrector-workflow/agents/openai.yaml",
];
const USER_DOCS = [
  "README.md", "README.en.md", "docs/README.md", "docs/tutorial.md", "docs/configuration.md",
  "docs/interfaces.md", "docs/how-it-works.md", "docs/openclaw.md", "docs/session-control.md",
  "docs/session-projects.md", "docs/openclaw-supervised-tasks.md", "docs/stop-task-review.md",
  "docs/stop-review-bounds.md", "docs/stop-metric-switches.md", "docs/m16-production-implementation-coverage.md",
];
const REVIEW_DEPENDENCIES = ["typebox"];

async function copyRuntime(source, artifactRoot, host) {
  async function copy(file) {
    const input = path.join(source, file);
    if (!(await fs.lstat(input)).isFile()) throw new Error(`Runtime input must be a regular file: ${file}`);
    const destination = path.join(artifactRoot, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(input, destination);
  }
  for (const file of [...RUNTIME_FILES, ...SKILL_FILES, ...USER_DOCS]) await copy(file);
  const modules = JSON.parse(await fs.readFile(path.join(source, "packaging/runtime-modules.json"), "utf8"));
  if (modules.schemaVersion !== 1 || ["common", ...Object.keys(HOSTS)].some(group => !Array.isArray(modules[group]))) {
    throw new Error("Invalid runtime module allowlist.");
  }
  const files = [...modules.common, ...modules[host]];
  if (new Set(files).size !== files.length || files.some(file => typeof file !== "string"
    || !/^lib\/(?:[a-z0-9-]+\/)*[a-z0-9][a-z0-9.-]*\.mjs$/u.test(file)
    || ["lib/plugin-builder.mjs", "lib/active-host.mjs"].includes(file))) {
    throw new Error("Runtime modules must be unique, explicit library paths.");
  }
  for (const file of files) await copy(file);
  await copy(`lib/hosts/${host}.mjs`);
  // Shared task definitions import OpenClaw's skill-discovery adapter. It has
  // only Node builtins; retaining this dependency keeps every core import valid.
  if (host !== "openclaw") await copy("lib/hosts/openclaw.mjs");
  if (host === "openclaw") {
    for (const file of ["scripts/configure-ma-host.mjs", "lib/openclaw/ui/app.mjs", "lib/openclaw/ui/index.html", "lib/openclaw/ui/style.css"]) await copy(file);
  } else {
    for (const name of ["runtime-event", "post-tool-use", "session-end", "evidence-distinctness-guard"]) await copy(`scripts/${name}.mjs`);
    await copy("hooks/hooks.json");
    for (const name of ["check", "explain", "help", "init", "spec", "stages", "validate"]) await copy(`commands/${name}.md`);
  }
  // The source navigation also links the repository-only maintenance guide.
  const navigation = path.join(artifactRoot, "docs/README.md");
  await fs.writeFile(navigation, (await fs.readFile(navigation, "utf8")).replace(/^.*\(maintenance\.md\).*\r?\n/gmu, ""));
  for (const name of USER_DOCS) {
    const file = path.join(artifactRoot, name);
    const tutorial = name.startsWith("docs/") ? "tutorial.md" : "docs/tutorial.md";
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/\((?:\.\.\/)?examples\/[^)]*\)/gu, `(${tutorial})`));
  }
}


async function reviewDependencyLock(sourceRoot, artifactRoot, packageDocument) {
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
    throw new Error("Review worker requires exactly pinned standalone schema dependencies and their matching npm v3 lockfile.");
  }
  if (Object.keys(lock.packages).some(name => /(?:^|\/)@earendil-works\/pi-/u.test(name)))
    throw new Error('Review lockfile must not contain Pi packages.');
  for (const [name, version] of Object.entries(packageDocument.dependencies ?? {})) {
    if (dependencies[name] !== version) throw new Error(`Plugin dependency ${name} is not covered by the review worker lockfile.`);
  }
  if (Object.keys(lock.packages).some(name => name !== "" && !REVIEW_DEPENDENCIES.some(dependency => name === `node_modules/${dependency}`))) {
    throw new Error("Review dependency archive must contain its complete dependency closure.");
  }
  const bundled = {};
  for (const [name, version] of Object.entries(dependencies)) {
    bundled[name] = await bundleReviewDependency({ sourceRoot, artifactRoot, name, version,
      integrity: lock.packages[`node_modules/${name}`].integrity });
  }
  // Use a private relative import. The host may discard node_modules during a
  // directory install, and its dependency resolver must not supply another copy.
  const declaration = "import { Type } from 'typebox';";
  for (const name of ["review-task.mjs", "history-memory.mjs"]) {
    const workerFile = path.join(directory, name);
    const worker = await fs.readFile(workerFile, "utf8");
    if (worker.split(declaration).length !== 2) throw new Error(`Review worker TypeBox import changed: ${name}`);
    await fs.writeFile(workerFile, worker.replace(declaration, "import { Type } from '../../vendor/typebox/build/index.mjs';"));
  }
  delete packageDocument.dependencies;
  packageDocument.runtimeCorrector = { bundledDependencies: bundled };
  for (const [name, version] of Object.entries(reviewPackage.overrides ?? {})) {
    if (packageDocument.overrides?.[name] !== undefined && packageDocument.overrides[name] !== version) {
      throw new Error(`Plugin override ${name} conflicts with the review worker lockfile.`);
    }
  }
  if (reviewPackage.overrides) packageDocument.overrides = { ...packageDocument.overrides, ...reviewPackage.overrides };
  // The standalone worker lock remains in lib/review-task as provenance. The
  // installable root has no external runtime dependency to fetch or hoist.
  lock.packages = {};
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
  await copyRuntime(source, artifactRoot, host);

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
  const packagePath = path.join(artifactRoot, "package.json");
  const packageDocument = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  packageDocument.scripts = { check: "node ./scripts/cli.mjs" };
  if (host === "openclaw") {
    packageDocument.name = "runtime-corrector-openclaw";
    packageDocument.version = "1.9.1-openclaw.11-session-projects.15";
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
    const lock = await reviewDependencyLock(source, artifactRoot, packageDocument);
    await fs.writeFile(path.join(artifactRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }
  await fs.writeFile(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`, "utf8");

  if (host === "openclaw") {
    const nativeSkill = "skills/runtime-corrector/SKILL.md";
    await fs.mkdir(path.join(artifactRoot, "skills/runtime-corrector"), { recursive: true });
    await fs.copyFile(path.join(manifestSource, nativeSkill), path.join(artifactRoot, nativeSkill));
    await adaptSkillsForOpenClaw(path.join(artifactRoot, "skills"));
    const guide = await fs.readFile(path.join(source, "docs", "openclaw.md"), "utf8");
    await fs.writeFile(path.join(artifactRoot, "README.md"), guide.replace(/\(([^()/#]+\.md)(#[^()]*)?\)/gu, "(docs/$1$2)"));
  } else await transformDeclarations(artifactRoot, hostAdapter);
  return artifactRoot;
}
