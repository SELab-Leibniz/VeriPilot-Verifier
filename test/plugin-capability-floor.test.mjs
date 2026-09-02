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


function declaredNodeCommand(command) {
  const match = command.match(/^node -e "([^"\r\n]+)" "(scripts\/[a-z0-9-]+\.mjs)"$/u);
  assert.ok(match, `unsupported declared command shape: ${command}`);
  return { bootstrap: match[1], entry: match[2] };
}


function shellInvocation(command) {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return { executable: "/bin/sh", args: ["-c", command] };
}


function runDeclaredCommand(command, {
  cwd,
  input,
  bom = false,
  rawInput = null,
  env: overrides = {},
}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.CODEAGENT3_PLUGIN_ROOT;
    Object.assign(env, { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, overrides);
    const invocation = shellInvocation(command);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(rawInput ?? `${bom ? "\uFEFF" : ""}${JSON.stringify(input)}`);
  });
}


function assertExactEventOutput(eventName, input, output) {
  if (["SessionStart", "PreCompact", "SessionEnd"].includes(eventName)) {
    assert.equal(output, null, `${eventName} must stay empty-stdout`);
    return;
  }
  if (eventName === "PreToolUse") {
    if (input.tool_name !== "Skill") assert.equal(output, null);
    else assert.deepEqual(output, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    return;
  }
  if (["UserPromptSubmit", "PostToolUse"].includes(eventName)) {
    if (output === null) return;
    assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
    assert.equal(output.hookSpecificOutput.hookEventName, eventName);
    assert.equal(typeof output.hookSpecificOutput.additionalContext, "string");
    return;
  }
  assert.equal(eventName, "Stop");
  if (output === null) return;
  if (output.decision === "block") {
    assert.deepEqual(Object.keys(output).sort(), ["decision", "reason"]);
    assert.equal(typeof output.reason, "string");
    return;
  }
  assert.deepEqual(Object.keys(output).sort(), ["continue", "systemMessage"]);
  assert.equal(output.continue, true);
  assert.equal(typeof output.systemMessage, "string");
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
        const declared = declaredNodeCommand(hook.command);
        assert.match(declared.bootstrap, /CLAUDE_PLUGIN_ROOT/u, `${eventName} Claude root`);
        assert.match(declared.bootstrap, /CODEAGENT3_PLUGIN_ROOT/u, `${eventName} CodeAgent3 root`);
        assert.match(declared.bootstrap, /realpathSync/u, `${eventName} canonical root`);
        assert.match(declared.bootstrap, /pathToFileURL/u, `${eventName} file URL import`);
        assert.doesNotMatch(hook.command, /\$\{|\$env:|%[A-Z0-9_]+%/u, `${eventName} shell root expansion`);
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


test("manifest, marketplace, contract, command and Skill declarations agree on the compatibility surface", async () => {
  const manifest = await readJson(".claude-plugin/plugin.json");
  const packageManifest = await readJson("package.json");
  const contract = await readCompatJson("contract.json");
  const marketplace = await readJson(".claude-plugin/marketplace.json");
  const marketplacePlugin = marketplace.plugins[0];
  assert.equal(marketplace.name, "runtime-corrector-local");
  assert.deepEqual(marketplace.metadata, {
    description: "Marketplace for the standalone Runtime Corrector Claude Code plugin.",
    version: "1.9.1",
  });
  assert.equal(Object.hasOwn(marketplace, "description"), false);
  assert.equal(Object.hasOwn(marketplace, "version"), false);
  assert.equal(marketplacePlugin.source, "./");
  for (const key of ["name", "version", "description"]) {
    assert.equal(marketplacePlugin[key], manifest[key], `marketplace plugin ${key}`);
    assert.equal(packageManifest[key], manifest[key], `package ${key}`);
  }
  assert.equal(packageManifest.scripts["benchmark:session-end"], "node ./scripts/benchmark-session-end.mjs");
  assert.deepEqual(await discoverCommandNames(), [...contract.commands].sort());
  assert.deepEqual(await discoverSkillNames(), [...contract.skills].sort());

  for (const commandName of contract.commands) {
    const relativePath = `commands/${commandName}.md`;
    const metadata = frontmatter(await fs.readFile(path.join(PLUGIN_ROOT, relativePath), "utf8"), relativePath);
    assert.equal(typeof metadata.description, "string", `${relativePath} description scalar`);
    assert.equal(typeof metadata["allowed-tools"], "string", `${relativePath} allowed-tools scalar`);
    if (Object.hasOwn(metadata, "argument-hint")) {
      assert.equal(typeof metadata["argument-hint"], "string", `${relativePath} argument-hint scalar`);
    }
  }
  for (const skillName of contract.skills) {
    const relativePath = `skills/${skillName}/SKILL.md`;
    const metadata = frontmatter(await fs.readFile(path.join(PLUGIN_ROOT, relativePath), "utf8"), relativePath);
    assert.equal(metadata.name, skillName, `${relativePath} name must match its directory`);
    assert.equal(typeof metadata.description, "string", `${relativePath} description scalar`);
    for (const optionalScalar of ["allowed-tools", "argument-hint"]) {
      if (Object.hasOwn(metadata, optionalScalar)) {
        assert.equal(typeof metadata[optionalScalar], "string", `${relativePath} ${optionalScalar} scalar`);
      }
    }
  }
});


test("canonical capability inputs drive all seven declared hook processes with exact event unions", async (t) => {
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
  const contract = await readCompatJson("contract.json");
  const hooks = await readJson("hooks/hooks.json");

  for (const event of contract.events) {
    const eventName = event.name;
    const canonical = await readCompatJson(event.input);
    const input = JSON.parse(JSON.stringify(canonical).replaceAll("/workspace", root));
    input.cwd = root;
    input.transcript_path = transcriptPath;
    input.session_id = `canonical-${eventName.toLowerCase()}`;
    assert.equal(Object.hasOwn(input, "hook_event_id"), false, eventName);
    const result = await runDeclaredCommand(primaryCommand(hooks, eventName), { cwd: root, input });
    assert.equal(result.code, 0, `${eventName}: ${result.stderr}`);
    const output = parseProtocolStdout(result.stdout, eventName);
    assertExactEventOutput(eventName, input, output);
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


test("every declared PostToolUse command obeys the protocol and invalid guard input stays silent", async (t) => {
  const root = await workspace(t, [
    "version: 2",
    "artifacts: []",
    "evidenceRoots:",
    "  - evidence",
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
  const evidenceRoot = path.join(root, "evidence");
  await fs.writeFile(transcriptPath, "", "utf8");
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(path.join(evidenceRoot, "before.txt"), "same capture", "utf8");
  await fs.writeFile(path.join(evidenceRoot, "after.txt"), "same capture", "utf8");

  const hooks = await readJson("hooks/hooks.json");
  const registrations = hooks.hooks.PostToolUse;
  const input = {
    session_id: "all-post-tool-registrations",
    transcript_path: transcriptPath,
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "capture evidence" },
    tool_response: { success: true },
    tool_use_id: "toolu-all-post-registrations",
  };

  for (const [registrationIndex, registration] of registrations.entries()) {
    assert.equal(registration.hooks.length, 1, `PostToolUse registration ${registrationIndex}`);
    const result = await runDeclaredCommand(registration.hooks[0].command, { cwd: root, input });
    assert.equal(result.code, 0, result.stderr);
    const output = parseProtocolStdout(result.stdout, `PostToolUse registration ${registrationIndex}`);
    if (registration.hooks[0].command.includes("evidence-distinctness-guard")) {
      assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
      assert.match(output.hookSpecificOutput.additionalContext, /evidence distinctness/u);
      assert.equal(output.decision, undefined);
      assert.equal(output.reason, undefined);
    }
  }

  const guard = registrations
    .flatMap((registration) => registration.hooks)
    .find((hook) => hook.command.includes("evidence-distinctness-guard"));
  assert.ok(guard, "evidence distinctness guard registration");

  const malformed = await runDeclaredCommand(guard.command, { cwd: root, rawInput: "{" });
  assert.equal(malformed.code, 0, malformed.stderr);
  assert.equal(malformed.stdout, "");

  const wrongEvent = await runDeclaredCommand(guard.command, {
    cwd: root,
    input: {
      ...input,
      hook_event_name: "PreToolUse",
      tool_response: undefined,
    },
  });
  assert.equal(wrongEvent.code, 0, wrongEvent.stderr);
  assert.equal(wrongEvent.stdout, "");
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
