import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  resolvePluginEntry,
  resolvePluginRoot,
} from "../lib/plugin-root.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_ENTRY_URL = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "runtime-event.mjs"));


async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-plugin-root-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}


async function makePluginCopy(t, name = "runtime-corrector") {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name, version: "1.9.1" })}\n`,
  );
  await fs.writeFile(path.join(root, "scripts", "runtime-event.mjs"), "export {};\n");
  return root;
}


async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}


test("resolves a Claude-only declaration to the executing plugin realpath", async () => {
  const resolved = await resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  });

  assert.equal(resolved.root, await fs.realpath(PLUGIN_ROOT));
  assert.equal(resolved.source, "module");
  assert.deepEqual(resolved.declarations, {
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    CODEAGENT3_PLUGIN_ROOT: null,
  });
});


test("resolves a CodeAgent3-only declaration without synthesizing a Claude alias", async () => {
  const resolved = await resolvePluginRoot({
    env: { CODEAGENT3_PLUGIN_ROOT: `  ${PLUGIN_ROOT}  ` },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  });

  assert.equal(resolved.root, await fs.realpath(PLUGIN_ROOT));
  assert.deepEqual(resolved.declarations, {
    CLAUDE_PLUGIN_ROOT: null,
    CODEAGENT3_PLUGIN_ROOT: PLUGIN_ROOT,
  });
});


test("accepts two declarations that canonicalize to the same directory", async (t) => {
  const parent = await temporaryDirectory(t);
  const linkedRoot = path.join(parent, "plugin link");
  await fs.symlink(PLUGIN_ROOT, linkedRoot, process.platform === "win32" ? "junction" : "dir");

  const resolved = await resolvePluginRoot({
    env: {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CODEAGENT3_PLUGIN_ROOT: linkedRoot,
    },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  });

  assert.equal(resolved.root, await fs.realpath(PLUGIN_ROOT));
});


test("rejects two declarations that canonicalize to different plugin copies", async (t) => {
  const otherRoot = await makePluginCopy(t);

  await rejectsWithCode(() => resolvePluginRoot({
    env: {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CODEAGENT3_PLUGIN_ROOT: otherRoot,
    },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  }), "PLUGIN_ROOT_CONFLICT");
});


test("requires a host declaration unless an explicit root is injected", async () => {
  await rejectsWithCode(() => resolvePluginRoot({
    env: {},
    executingModuleUrl: RUNTIME_ENTRY_URL,
  }), "PLUGIN_ROOT_MISSING");

  const resolved = await resolvePluginRoot({
    env: {},
    explicitRoot: PLUGIN_ROOT,
    executingModuleUrl: RUNTIME_ENTRY_URL,
  });
  assert.equal(resolved.root, await fs.realpath(PLUGIN_ROOT));
  assert.equal(resolved.source, "explicit");
});


test("rejects relative, missing, and non-directory declarations", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "not-a-directory");
  await fs.writeFile(file, "x");

  await rejectsWithCode(() => resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: "relative/plugin" },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  }), "PLUGIN_ROOT_NOT_ABSOLUTE");
  await rejectsWithCode(() => resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: path.join(directory, "missing") },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  }), "PLUGIN_ROOT_NOT_DIRECTORY");
  await rejectsWithCode(() => resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: file },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  }), "PLUGIN_ROOT_NOT_DIRECTORY");
});


test("rejects a declared plugin with the wrong artifact identity", async (t) => {
  const wrongRoot = await makePluginCopy(t, "another-plugin");

  await rejectsWithCode(() => resolvePluginRoot({
    env: { CODEAGENT3_PLUGIN_ROOT: wrongRoot },
    executingModuleUrl: pathToFileURL(path.join(wrongRoot, "scripts", "runtime-event.mjs")),
  }), "PLUGIN_ROOT_IDENTITY_MISMATCH");
});


test("rejects a valid declaration that differs from the executing plugin", async (t) => {
  const otherRoot = await makePluginCopy(t);

  await rejectsWithCode(() => resolvePluginRoot({
    env: { CODEAGENT3_PLUGIN_ROOT: otherRoot },
    executingModuleUrl: RUNTIME_ENTRY_URL,
  }), "PLUGIN_ROOT_EXECUTION_MISMATCH");
});


test("resolves an entry inside the root and rejects path escape", async () => {
  const root = await fs.realpath(PLUGIN_ROOT);
  assert.equal(
    await resolvePluginEntry({ root, entry: "scripts/runtime-event.mjs" }),
    await fs.realpath(path.join(root, "scripts", "runtime-event.mjs")),
  );

  await rejectsWithCode(() => resolvePluginEntry({
    root,
    entry: "../outside.mjs",
  }), "PLUGIN_ROOT_ENTRY_ESCAPE");
});
