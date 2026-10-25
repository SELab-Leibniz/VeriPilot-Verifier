import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { buildPlugin } from "../lib/plugin-builder.mjs";


const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS = Object.freeze({
  SessionStart: { source: "startup" },
  UserPromptSubmit: { prompt: "hello" },
  PreToolUse: { tool_name: "Read", tool_input: {}, tool_use_id: "tool-1" },
  PostToolUse: { tool_name: "Read", tool_input: {}, tool_response: {}, tool_use_id: "tool-1" },
  Stop: { stop_hook_active: false },
  PreCompact: { trigger: "manual", custom_instructions: null },
  SessionEnd: { reason: "clear" },
});

async function artifacts(t) {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-artifacts-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-artifact-project-"));
  t.after(() => Promise.all([
    fs.rm(outputRoot, { recursive: true, force: true }),
    fs.rm(projectRoot, { recursive: true, force: true }),
  ]));
  const transcript = path.join(projectRoot, "transcript.jsonl");
  await fs.writeFile(transcript, "");
  const claude = await buildPlugin({ host: "claude", sourceRoot: SOURCE_ROOT, outputRoot });
  const codeagent = await buildPlugin({ host: "codeagent", sourceRoot: SOURCE_ROOT, outputRoot });
  return { outputRoot, projectRoot, transcript, claude, codeagent };
}

function posixDrivePath(value) {
  const match = value.match(/^([a-zA-Z]):[\\/](.*)$/u);
  return match ? "/" + match[1].toLowerCase() + "/" + match[2].replaceAll("\\", "/") : value;
}

function invocation(command) {
  const match = command.match(/^node -e "([^"]*)" "(scripts\/[a-z0-9-]+\.mjs)"$/u);
  assert.ok(match, command);
  return ["-e", match[1], match[2]];
}

function commandInvocations(markdown) {
  return [...markdown.matchAll(
    /^node -e "([^"]*)" "(\$\{[A-Z0-9_]+\})" "(scripts\/[a-z0-9-]+\.mjs)"(?: (.*))?$/gmu,
  )].map((match) => ({
    source: match[1], rootReference: match[2], entry: match[3], tail: match[4] ?? "",
  }));
}

function commandArguments(value) {
  const args = [];
  for (const match of value.matchAll(/"([^"]*)"|(\S+)/gu)) args.push(match[1] ?? match[2]);
  return args;
}

test("plugin-target defaults to OpenClaw and rejects unknown hosts", async () => {
  const target = JSON.parse(await fs.readFile(path.join(SOURCE_ROOT, "plugin-target.json"), "utf8"));
  assert.equal(target.host, "openclaw");
  await assert.rejects(buildPlugin({
    host: "future", sourceRoot: SOURCE_ROOT, outputRoot: path.join(os.tmpdir(), "unused-plugin-output"),
  }), /claude or codeagent/u);
});

async function filesUnder(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

async function checkLocalLinks(file) {
  const document = await fs.readFile(file, "utf8");
  for (const match of document.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/iu.test(target) || /[<>*{}]/u.test(target)) continue;
    await assert.doesNotReject(fs.access(path.resolve(path.dirname(file), decodeURIComponent(target))), `${file}: ${target}`);
  }
}

test("all hosts package complete runtime imports, resources and usable documentation only", async t => {
  const built = await artifacts(t);
  built.openclaw = await buildPlugin({ host: "openclaw", sourceRoot: SOURCE_ROOT, outputRoot: built.outputRoot });
  for (const host of ["claude", "codeagent", "openclaw"]) {
    const root = built[host], files = await filesUnder(root);
    const scripts = files.filter(file => path.dirname(file) === path.join(root, "scripts")).map(file => path.basename(file)).sort();
    assert.deepEqual(scripts, (host === "openclaw" ? ["cli.mjs", "configure-ma-host.mjs"]
      : ["cli.mjs", "evidence-distinctness-guard.mjs", "post-tool-use.mjs", "runtime-event.mjs", "session-end.mjs"]).sort());
    for (const file of files) {
      assert(!path.relative(root, file).split(path.sep).some(part => ["experiments", "test", "examples", "diagnostics", "node_modules", ".runtime-correction", ".github"].includes(part)), file);
      if (file.endsWith(".md")) await checkLocalLinks(file);
      if (!file.endsWith(".mjs")) continue;
      const source = await fs.readFile(file, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"']+\.mjs)\1/gu)) {
        await assert.doesNotReject(fs.access(path.resolve(path.dirname(file), match[2])), `${host}: ${file}: ${match[2]}`);
      }
    }
    for (const resource of ["config/stop-defaults.json", "config/schemas/project-config.schema.json", "knowledge/ir/default.json",
      "templates/project/.runtime-corrector/config.yaml", "specs/custom-stage.md", "lib/review-task/prompts.json", "lib/review-task/package-lock.json"]) {
      await fs.access(path.join(root, resource));
    }
    if (host === "openclaw") {
      const entry = await import(pathToFileURL(path.join(root, "lib/openclaw/entry.mjs")).href);
      assert.equal(entry.default.id, "runtime-corrector");
      assert.doesNotThrow(() => entry.default.register({ registrationMode: "cli-metadata" }));
      await fs.access(path.join(root, "lib/openclaw/ui/index.html"));
      await fs.access(path.join(root, "skills/runtime-corrector/SKILL.md"));
    }
  }
  for (const name of ["README.md", "README.en.md", ...((await filesUnder(path.join(SOURCE_ROOT, "docs")))
    .filter(file => file.endsWith(".md") && !file.includes(`${path.sep}experiments${path.sep}`))
    .map(file => path.relative(SOURCE_ROOT, file)))]) await checkLocalLinks(path.join(SOURCE_ROOT, name));
});

test("builds mutually exclusive Claude and CodeAgent artifacts", async (t) => {
  const built = await artifacts(t);
  await assert.rejects(fs.access(path.join(SOURCE_ROOT, ".claude-plugin", "plugin.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(SOURCE_ROOT, ".cac-plugin", "plugin.json")), { code: "ENOENT" });
  for (const [host, manifestDirectory] of [["claude", ".claude-plugin"], ["codeagent", ".cac-plugin"]]) {
    const manifest = JSON.parse(await fs.readFile(path.join(built[host], manifestDirectory, "plugin.json"), "utf8"));
    const marketplace = JSON.parse(await fs.readFile(path.join(built[host], manifestDirectory, "marketplace.json"), "utf8"));
    assert.equal(manifest.name, "runtime-corrector");
    assert.equal(marketplace.name, "runtime-corrector-local");
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].source, "./");
    for (const key of ["name", "version", "description"]) {
      assert.equal(marketplace.plugins[0][key], manifest[key], `${host} marketplace plugin ${key}`);
    }
    assert.equal(marketplace.metadata.version, manifest.version, `${host} marketplace metadata version`);
  }
  await assert.rejects(fs.access(path.join(built.claude, ".cac-plugin")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(built.codeagent, ".claude-plugin")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(built.claude, "lib", "hosts", "codeagent.mjs")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(built.codeagent, "lib", "hosts", "claude.mjs")), { code: "ENOENT" });
  assert.match(await fs.readFile(path.join(built.claude, "lib", "active-host.mjs"), "utf8"), /hosts\/claude/u);
  assert.match(await fs.readFile(path.join(built.codeagent, "lib", "active-host.mjs"), "utf8"), /hosts\/codeagent/u);
  for (const name of ["claude", "codeagent"]) {
    assert.match(await fs.readFile(path.join(built[name], "config", "runtime.yaml"), "utf8"), /semanticReviewTimeoutMs: 1200000/u);
  }
  const claudeHost = await import(pathToFileURL(path.join(built.claude, "lib", "active-host.mjs")).href);
  const codeAgentHost = await import(pathToFileURL(path.join(built.codeagent, "lib", "active-host.mjs")).href);
  assert.deepEqual([claudeHost.defaultSemanticReviewTimeoutMs, claudeHost.defaultReviewerTimeoutMs], [1200000, 1200000]);
  assert.deepEqual([codeAgentHost.defaultSemanticReviewTimeoutMs, codeAgentHost.defaultReviewerTimeoutMs], [1200000, 1200000]);
});

for (const host of ["claude", "codeagent"]) {
  test(host + " artifact declares and executes all seven hook events", async (t) => {
    const built = await artifacts(t);
    const root = built[host];
    const hooks = JSON.parse(await fs.readFile(path.join(root, "hooks", "hooks.json"), "utf8")).hooks;
    assert.deepEqual(Object.keys(hooks), Object.keys(EVENTS));
    const rootKey = host === "claude" ? "CLAUDE_PLUGIN_ROOT" : "CODEAGENT3_PLUGIN_ROOT";
    const manifestDirectory = host === "claude" ? ".claude-plugin" : ".cac-plugin";
    for (const [eventName, fields] of Object.entries(EVENTS)) {
      const command = hooks[eventName][0].hooks[0].command;
      assert.match(command, new RegExp(rootKey, "u"));
      assert.match(command, new RegExp(manifestDirectory.replace(".", "\\."), "u"));
      assert.doesNotMatch(command, /PLUGIN_ROOT_CONFLICT/u);
      const payload = {
        session_id: "session-artifact",
        transcript_path: built.transcript,
        cwd: built.projectRoot,
        hook_event_name: eventName,
        ...fields,
      };
      const env = { ...process.env };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.CODEAGENT3_PLUGIN_ROOT;
      env[rootKey] = host === "codeagent" && process.platform === "win32" ? posixDrivePath(root) : root;
      const result = spawnSync(process.execPath, invocation(command), {
        cwd: built.projectRoot,
        env,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(result.status, 0, eventName + ": " + result.stderr);
      assert.doesNotMatch(result.stderr, /PLUGIN_ROOT_CONFLICT/u);
      if (result.stdout.trim()) assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
  });
}

for (const host of ["claude", "codeagent"]) {
  test(`${host} slash commands locate the artifact without an exported root environment`, async (t) => {
    const built = await artifacts(t);
    const root = built[host];
    const commandFiles = (await fs.readdir(path.join(root, "commands")))
      .filter((name) => name.endsWith(".md"))
      .sort();
    assert.deepEqual(commandFiles, [
      "check.md", "explain.md", "help.md", "init.md", "spec.md", "stages.md", "validate.md",
    ]);
    const rootKey = host === "claude" ? "CLAUDE_PLUGIN_ROOT" : "CODEAGENT3_PLUGIN_ROOT";
    const foreignKey = host === "claude" ? "CODEAGENT3_PLUGIN_ROOT" : "CLAUDE_PLUGIN_ROOT";
    let invocationCount = 0;
    for (const commandFile of commandFiles) {
      const markdown = await fs.readFile(path.join(root, "commands", commandFile), "utf8");
      const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
      assert.match(frontmatter, /^description: .+$/mu);
      assert.match(frontmatter, /^allowed-tools: Bash, PowerShell$/mu);
      const declarations = commandInvocations(markdown);
      assert.ok(declarations.length > 0, commandFile);
      for (const [index, declaration] of declarations.entries()) {
        invocationCount += 1;
        assert.equal(declaration.entry, "scripts/cli.mjs");
        assert.equal(declaration.rootReference, `\${${rootKey}}`);
        assert.match(declaration.source, new RegExp(rootKey, "u"));
        const caseRoot = path.join(built.projectRoot, host, `${commandFile}-${index}`);
        await fs.mkdir(path.dirname(caseRoot), { recursive: true });
        await fs.cp(path.join(SOURCE_ROOT, "examples", "simple-project"), caseRoot, { recursive: true });
        const tail = declaration.tail
          .replaceAll("$ARGUMENTS", commandFile === "stages.md" ? "requirements off" : "requirements")
          .replaceAll("<artifact-path>", "docs/requirements.md");
        if (commandFile === "init.md") {
          await fs.rm(path.join(caseRoot, ".runtime-corrector"), { recursive: true, force: true });
        }
        const env = { ...process.env };
        delete env[rootKey];
        delete env[foreignKey];
        const inlineRoot = host === "codeagent" && process.platform === "win32"
          ? posixDrivePath(root)
          : root;
        const result = spawnSync(process.execPath, [
          "-e", declaration.source, inlineRoot, declaration.entry, ...commandArguments(tail),
        ], { cwd: caseRoot, env, encoding: "utf8", timeout: 20000 });
        assert.equal(result.status, 0, `${commandFile} #${index}: ${result.stderr}`);
        assert.notEqual(result.stdout.trim(), "", `${commandFile} #${index}`);
        assert.doesNotMatch(result.stderr, /PLUGIN_ROOT_(?:CONFLICT|MISSING|HOST_MISMATCH)/u);
        if (commandFile === "init.md") {
          await fs.access(path.join(caseRoot, ".runtime-corrector", "config.yaml"));
        }
      }
    }
    assert.equal(invocationCount, 8);
  });
}

test("CodeAgent declarations use only the selected session and root protocol", async (t) => {
  const built = await artifacts(t);
  const hooks = await fs.readFile(path.join(built.codeagent, "hooks", "hooks.json"), "utf8");
  assert.match(hooks, /CODEAGENT3_PLUGIN_ROOT/u);
  assert.match(hooks, /\.cac-plugin/u);
  assert.doesNotMatch(hooks, /PLUGIN_ROOT_CONFLICT/u);
  const launcher = await fs.readFile(path.join(built.codeagent, "lib", "reviewer-launcher.mjs"), "utf8");
  assert.doesNotMatch(launcher, /SESSION_DIALECTS|plan\.sessionDialect|function assertSessionDialect/u);
  assert.match(launcher, /sessionDialect.*has been removed/u);
});
