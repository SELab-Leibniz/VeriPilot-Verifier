import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSimpleYaml } from "../lib/simple-yaml.mjs";
import {
  decodeHookInput,
  encodeHookOutput,
} from "../lib/protocol/claude-core-hooks.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPAT_FIXTURE_ROOT = path.join(PLUGIN_ROOT, "test", "compat", "legacy-feature-baseline");


async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(PLUGIN_ROOT, relativePath), "utf8"));
}


async function readCompatJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(COMPAT_FIXTURE_ROOT, relativePath), "utf8"));
}


async function discoverCompatJson(directory) {
  const entries = await fs.readdir(path.join(COMPAT_FIXTURE_ROOT, directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.posix.join(directory, entry.name))
    .sort();
}


async function discoverCommandNames() {
  const entries = await fs.readdir(path.join(PLUGIN_ROOT, "commands"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.basename(entry.name, ".md"))
    .sort();
}


async function discoverSkillNames() {
  const entries = await fs.readdir(path.join(PLUGIN_ROOT, "skills"), { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(PLUGIN_ROOT, "skills", entry.name, "SKILL.md"));
      names.push(entry.name);
    } catch {
      // Only directories that expose a Claude skill declaration are discoverable skills.
    }
  }
  return names.sort();
}


async function workspace(t, configLines) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-capability-floor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".runtime-corrector", "config.yaml"),
    `${configLines.join("\n")}\n`,
    "utf8",
  );
  return root;
}


function primaryCommand(hooks, eventName) {
  const registration = hooks.hooks[eventName].find((entry) => entry.matcher === undefined)
    ?? hooks.hooks[eventName][0];
  assert.ok(registration, `${eventName} must have a registration`);
  assert.equal(registration.hooks.length, 1, `${eventName} primary registration must be unambiguous`);
  return registration.hooks[0].command;
}


function runDeclaredCommand(command, { cwd, input, bom = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${bom ? "\uFEFF" : ""}${JSON.stringify(input)}`);
  });
}


function parseProtocolStdout(stdout, label) {
  if (stdout === "") return null;
  const match = stdout.match(/^([^\r\n]+)\r?\n$/u);
  assert.ok(match, `${label} must emit exactly one JSON line with a terminal newline`);
  const [line] = match.slice(1);
  assert.equal(line, line.trim(), `${label} emitted surrounding whitespace`);
  const output = JSON.parse(line);
  assert.ok(
    output !== null && typeof output === "object" && !Array.isArray(output),
    `${label} must emit a JSON object`,
  );
  return output;
}


function frontmatter(document, source) {
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  assert.ok(match, `${source} must have YAML frontmatter`);
  return parseSimpleYaml(match[1], { source });
}


test("repository-owned capability fixture defines the discoverable compatibility floor", async () => {
  const contract = await readCompatJson("contract.json");
  assert.equal(contract.identifier, "claude-plugin-core-hooks-json-stdio");
  assert.doesNotMatch(contract.identifier, /claude(?:-code)?@?\d/u);
  assert.deepEqual(contract.events, [
    { name: "SessionStart", input: "input/session-start.json" },
    { name: "UserPromptSubmit", input: "input/user-prompt-submit.json" },
    { name: "PreToolUse", input: "input/pre-tool-use.json" },
    { name: "PostToolUse", input: "input/post-tool-use.json" },
    { name: "Stop", input: "input/stop.json" },
    { name: "PreCompact", input: "input/pre-compact.json" },
    { name: "SessionEnd", input: "input/session-end.json" },
  ]);
  assert.deepEqual(contract.commands, [
    "check",
    "explain",
    "help",
    "init",
    "spec",
    "stages",
    "validate",
  ]);
  assert.deepEqual(contract.skills, [
    "runtime-corrector-control",
    "runtime-corrector-init",
    "runtime-corrector-workflow",
    "semantic-review",
  ]);

  const declaredInputs = contract.events.map((event) => event.input).sort();
  const inputFixtures = await discoverCompatJson("input");
  assert.deepEqual(inputFixtures, declaredInputs);

  for (const event of contract.events) {
    const input = await readCompatJson(event.input);
    assert.equal(input.hook_event_name, event.name, event.input);
    assert.equal(Object.hasOwn(input, "hook_event_id"), false, event.input);
    assert.deepEqual(decodeHookInput(JSON.stringify(input)), input, event.input);
  }

  const outputFixtures = await discoverCompatJson("output");
  const declaredOutputs = contract.outputs.map((output) => output.fixture).sort();
  assert.deepEqual(outputFixtures, declaredOutputs);
  const outputEventNames = [];
  const outputForms = [];
  for (const outputFixturePath of outputFixtures) {
    const fixture = await readCompatJson(outputFixturePath);
    const declaration = contract.outputs.find((output) => output.fixture === outputFixturePath);
    assert.ok(declaration, outputFixturePath);
    assert.equal(fixture.form, declaration.form, outputFixturePath);
    assert.ok(contract.events.some((event) => event.name === fixture.eventName), outputFixturePath);
    outputEventNames.push(fixture.eventName);
    outputForms.push(fixture.form);
    const input = await readCompatJson(fixture.input);
    assert.deepEqual(
      encodeHookOutput(fixture.eventName, input, fixture.outcome),
      fixture.expected,
      outputFixturePath,
    );
  }
  assert.deepEqual([...new Set(outputEventNames)].sort(), contract.events.map((event) => event.name).sort());
  assert.deepEqual([...new Set(outputForms)].sort(), [...contract.outputForms].sort());

  assert.deepEqual(await discoverCommandNames(), [...contract.commands].sort());
  assert.deepEqual(await discoverSkillNames(), [...contract.skills].sort());
  assert.deepEqual([...contract.optionalTools].sort(), ["Monitor", "PowerShell"]);
  assert.deepEqual([...contract.outputForms].sort(), [
    "empty-stdout",
    "feedback-context",
    "skill-permission-allow",
    "stop-block",
    "stop-release",
  ]);
});


test("parseProtocolStdout accepts only empty stdout or one terminally-newline-delimited JSON object", () => {
  assert.equal(parseProtocolStdout("", "empty"), null);
  assert.deepEqual(parseProtocolStdout('{"result":true}\n', "json"), { result: true });
  assert.deepEqual(parseProtocolStdout('{"result":true}\r\n', "windows json"), { result: true });

  for (const stdout of [
    '{"result":true}',
    '{"result":true}\n\n',
    ' {"result":true}\n',
    '{"result":true} \n',
    '\n{"result":true}\n',
    '\n',
    'null\n',
    '[]\n',
  ]) {
    assert.throws(() => parseProtocolStdout(stdout, "invalid protocol stdout"), Error, stdout);
  }
});


test("plugin hooks expose complete shell commands within the supported capability floor", async () => {
  const config = await readJson("hooks/hooks.json");
  const eventNames = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "PreCompact",
    "SessionEnd",
  ];

  assert.deepEqual(Object.keys(config.hooks).sort(), [...eventNames].sort());
  assert.equal(config.hooks.PostToolBatch, undefined);
  for (const [eventName, registrations] of Object.entries(config.hooks)) {
    for (const registration of registrations) {
      for (const hook of registration.hooks) {
        assert.equal(hook.type, "command", `${eventName} hook type`);
        assert.equal(Object.hasOwn(hook, "args"), false, `${eventName} uses unsupported args`);
        assert.match(
          hook.command,
          /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[a-z0-9-]+\.mjs"$/u,
          `${eventName} command must quote the plugin-root script path`,
        );
      }
    }
  }

  assert.equal(
    config.hooks.PreToolUse[0].matcher,
    "Skill|Bash|PowerShell|Write|Edit|NotebookEdit|Monitor",
  );
  assert.equal(config.hooks.PostToolUse[0].matcher, undefined);
  assert.match(primaryCommand(config, "PostToolUse"), /post-tool-use\.mjs"$/u);
});


test("marketplace and command frontmatter parse into the host-supported scalar schema", async () => {
  const marketplace = await readJson(".claude-plugin/marketplace.json");
  assert.equal(marketplace.name, "runtime-corrector-local");
  assert.deepEqual(marketplace.metadata, {
    description: "Marketplace for the standalone Runtime Corrector Claude Code plugin.",
    version: "1.9.1",
  });
  assert.equal(Object.hasOwn(marketplace, "description"), false);
  assert.equal(Object.hasOwn(marketplace, "version"), false);
  assert.equal(marketplace.plugins[0].name, "runtime-corrector");
  assert.equal(marketplace.plugins[0].source, "./");

  const check = frontmatter(await fs.readFile(path.join(PLUGIN_ROOT, "commands", "check.md"), "utf8"), "commands/check.md");
  const stages = frontmatter(await fs.readFile(path.join(PLUGIN_ROOT, "commands", "stages.md"), "utf8"), "commands/stages.md");
  assert.equal(check["argument-hint"], "[artifact-path]");
  assert.equal(stages["argument-hint"], "[<stage> <on|off>]");
});


test("effective primary hook commands accept complete baseline inputs without hook_event_id", async (t) => {
  const root = await workspace(t, [
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  panel:",
    "    size: 0",
    "skillCorrection:",
    "  enabled: false",
    "stopCorrection:",
    "  enabled: false",
  ]);
  const transcriptPath = path.join(root, "transcript.jsonl");
  await fs.writeFile(transcriptPath, "", "utf8");
  const common = {
    session_id: "baseline-session",
    transcript_path: transcriptPath,
    cwd: root,
  };
  const inputs = {
    SessionStart: { ...common, hook_event_name: "SessionStart", source: "startup" },
    UserPromptSubmit: { ...common, hook_event_name: "UserPromptSubmit", prompt: "hi" },
    PreToolUse: {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "runtime-corrector-workflow" },
      tool_use_id: "toolu-pre-baseline",
    },
    PostToolUse: {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: path.join(root, "README.md") },
      tool_response: { content: "not found" },
      tool_use_id: "toolu-post-baseline",
    },
    Stop: { ...common, hook_event_name: "Stop", stop_hook_active: false },
    PreCompact: {
      ...common,
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
    },
    SessionEnd: { ...common, hook_event_name: "SessionEnd", reason: "other" },
  };
  const hooks = await readJson("hooks/hooks.json");

  for (const [eventName, input] of Object.entries(inputs)) {
    assert.equal(Object.hasOwn(input, "hook_event_id"), false, eventName);
    const result = await runDeclaredCommand(primaryCommand(hooks, eventName), { cwd: root, input });
    assert.equal(result.code, 0, `${eventName}: ${result.stderr}`);
    const output = parseProtocolStdout(result.stdout, eventName);
    if (output?.hookSpecificOutput) {
      assert.equal(output.hookSpecificOutput.hookEventName, eventName);
    }
  }
});


test("effective PostToolUse command accepts BOM input and labels its output with the input event", async (t) => {
  const root = await workspace(t, [
    "version: 2",
    "artifacts:",
    "  - name: requirements",
    "    stage: requirements",
    "    format: markdown",
    "    patterns:",
    "      - spec/*.md",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  panel:",
    "    size: 0",
  ]);
  const transcriptPath = path.join(root, "transcript.jsonl");
  const brokenArtifact = path.join(root, "spec", "broken.md");
  await fs.writeFile(transcriptPath, "", "utf8");
  await fs.mkdir(brokenArtifact, { recursive: true });
  const input = {
    session_id: "bom-post-tool-session",
    transcript_path: transcriptPath,
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: brokenArtifact, content: "# Requirements" },
    tool_response: { filePath: brokenArtifact, success: true },
    tool_use_id: "toolu-post-bom",
  };
  const hooks = await readJson("hooks/hooks.json");
  const result = await runDeclaredCommand(primaryCommand(hooks, "PostToolUse"), {
    cwd: root,
    input,
    bom: true,
  });

  assert.equal(result.code, 0, result.stderr);
  const output = parseProtocolStdout(result.stdout, "PostToolUse BOM");
  assert.equal(output.hookSpecificOutput.hookEventName, input.hook_event_name);
  assert.match(output.hookSpecificOutput.additionalContext, /runtime-corrector/u);
});


test("effective Stop command emits only valid block and release unions across its crash ceiling", async (t) => {
  const root = await workspace(t, [
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  panel:",
    "    size: 0",
    "stopCorrection:",
    "  enabled: true",
  ]);
  const transcriptPath = path.join(root, "transcript.jsonl");
  await fs.mkdir(transcriptPath);
  const hooks = await readJson("hooks/hooks.json");
  const command = primaryCommand(hooks, "Stop");
  const input = {
    session_id: "stop-union-session",
    transcript_path: transcriptPath,
    cwd: root,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Everything is complete and fully verified.",
  };

  const outputs = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runDeclaredCommand(command, { cwd: root, input });
    assert.equal(result.code, 0, result.stderr);
    outputs.push(parseProtocolStdout(result.stdout, `Stop attempt ${attempt + 1}`));
  }
  for (const output of outputs) {
    const block = output?.decision === "block"
      && typeof output.reason === "string"
      && output.continue === undefined;
    const release = output?.continue === true
      && typeof output.systemMessage === "string"
      && output.decision === undefined;
    assert.ok(block || release, JSON.stringify(output));
    assert.equal(output.hookSpecificOutput, undefined);
  }
  assert.equal(outputs[0].decision, "block");
  assert.equal(outputs[1].decision, "block");
  assert.equal(outputs[2].continue, true);
});


test("effective runtime command stays silent when shadow processing fails", async (t) => {
  const root = await workspace(t, [
    "shadowMode: true",
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  panel:",
    "    size: 0",
    "stopCorrection:",
    "  enabled: true",
  ]);
  const hooks = await readJson("hooks/hooks.json");
  const result = await runDeclaredCommand(primaryCommand(hooks, "Stop"), {
    cwd: root,
    input: {
      session_id: "shadow-session",
      transcript_path: path.join(root, "missing.jsonl"),
      cwd: root,
      hook_event_name: "Stop",
      stop_hook_active: false,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
});
