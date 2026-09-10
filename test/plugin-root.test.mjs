import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import * as claudeHost from "../lib/hosts/claude.mjs";
import * as codeAgentHost from "../lib/hosts/codeagent.mjs";
import { resolvePluginEntry, resolvePluginRoot } from "../lib/plugin-root.mjs";

function posixDrivePath(nativePath) {
  const match = nativePath.match(/^([a-zA-Z]):[\\/](.*)$/u);
  assert.ok(match);
  return "/" + match[1].toLowerCase() + "/" + match[2].replaceAll("\\", "/");
}

async function makePlugin(t, hostAdapter, name = "runtime-corrector") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-plugin-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, hostAdapter.manifestDirectory), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(root, hostAdapter.manifestDirectory, "plugin.json"),
    JSON.stringify({ name, version: "1.9.1" }) + "\n",
  );
  await fs.writeFile(path.join(root, "scripts", "runtime-event.mjs"), "export {};\n");
  return root;
}

function moduleUrl(root) {
  return pathToFileURL(path.join(root, "scripts", "runtime-event.mjs"));
}

async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

for (const [label, hostAdapter] of [["Claude", claudeHost], ["CodeAgent", codeAgentHost]]) {
  test("resolves the selected " + label + " declaration and manifest", async (t) => {
    const root = await makePlugin(t, hostAdapter);
    const resolved = await resolvePluginRoot({
      env: { [hostAdapter.pluginRootEnv]: root },
      executingModuleUrl: moduleUrl(root),
      hostAdapter,
    });
    assert.equal(resolved.root, await fs.realpath(root));
    assert.equal(resolved.source, "module");
  });
}

test("win32 normalizes a CodeAgent POSIX drive declaration", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await makePlugin(t, codeAgentHost);
  const declared = posixDrivePath(root);
  const resolved = await resolvePluginRoot({
    env: { CODEAGENT3_PLUGIN_ROOT: declared },
    executingModuleUrl: moduleUrl(root),
    hostAdapter: codeAgentHost,
  });
  assert.equal(resolved.root, await fs.realpath(root));
  assert.equal(resolved.declarations.CODEAGENT3_PLUGIN_ROOT, declared);
});

test("foreign root is ignored when the selected host root is valid", async (t) => {
  const selected = await makePlugin(t, claudeHost);
  const foreign = await makePlugin(t, codeAgentHost);
  const resolved = await resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: selected, CODEAGENT3_PLUGIN_ROOT: foreign },
    executingModuleUrl: moduleUrl(selected),
    hostAdapter: claudeHost,
  });
  assert.equal(resolved.root, await fs.realpath(selected));
});

test("foreign-only declaration reports a host mismatch", async (t) => {
  const root = await makePlugin(t, claudeHost);
  await rejectsWithCode(() => resolvePluginRoot({
    env: { CODEAGENT3_PLUGIN_ROOT: root },
    executingModuleUrl: moduleUrl(root),
    hostAdapter: claudeHost,
  }), "PLUGIN_HOST_MISMATCH");
});

test("explicit and selected roots must agree", async (t) => {
  const selected = await makePlugin(t, claudeHost);
  const explicit = await makePlugin(t, claudeHost);
  await rejectsWithCode(() => resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: selected },
    explicitRoot: explicit,
    executingModuleUrl: moduleUrl(selected),
    hostAdapter: claudeHost,
  }), "PLUGIN_ROOT_CONFLICT");
});

test("requires a selected declaration unless an explicit root is injected", async (t) => {
  const root = await makePlugin(t, claudeHost);
  await rejectsWithCode(() => resolvePluginRoot({
    env: {}, executingModuleUrl: moduleUrl(root), hostAdapter: claudeHost,
  }), "PLUGIN_ROOT_MISSING");
  const resolved = await resolvePluginRoot({
    env: {}, explicitRoot: root, executingModuleUrl: moduleUrl(root), hostAdapter: claudeHost,
  });
  assert.equal(resolved.source, "explicit");
});

test("rejects relative, missing, non-directory, wrong identity, and execution mismatch", async (t) => {
  const root = await makePlugin(t, claudeHost);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-root-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "file");
  await fs.writeFile(file, "x");
  for (const [value, code] of [
    ["relative/plugin", "PLUGIN_ROOT_NOT_ABSOLUTE"],
    [path.join(directory, "missing"), "PLUGIN_ROOT_NOT_DIRECTORY"],
    [file, "PLUGIN_ROOT_NOT_DIRECTORY"],
  ]) {
    await rejectsWithCode(() => resolvePluginRoot({
      env: { CLAUDE_PLUGIN_ROOT: value },
      executingModuleUrl: moduleUrl(root),
      hostAdapter: claudeHost,
    }), code);
  }
  const wrong = await makePlugin(t, claudeHost, "other");
  await rejectsWithCode(() => resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: wrong },
    executingModuleUrl: moduleUrl(wrong),
    hostAdapter: claudeHost,
  }), "PLUGIN_ROOT_IDENTITY_MISMATCH");
  const other = await makePlugin(t, claudeHost);
  await rejectsWithCode(() => resolvePluginRoot({
    env: { CLAUDE_PLUGIN_ROOT: other },
    executingModuleUrl: moduleUrl(root),
    hostAdapter: claudeHost,
  }), "PLUGIN_ROOT_EXECUTION_MISMATCH");
});

test("resolves an in-root entry and rejects lexical and symlink escapes", async (t) => {
  const root = await makePlugin(t, claudeHost);
  const entry = path.join(root, "scripts", "runtime-event.mjs");
  assert.equal(await resolvePluginEntry({ root, entry: "scripts/runtime-event.mjs" }), await fs.realpath(entry));
  await rejectsWithCode(() => resolvePluginEntry({ root, entry: "../escape.mjs" }), "PLUGIN_ROOT_ENTRY_ESCAPE");
  const outside = path.join(path.dirname(root), path.basename(root) + "-outside.mjs");
  await fs.writeFile(outside, "export {};\n");
  t.after(() => fs.rm(outside, { force: true }));
  const link = path.join(root, "scripts", "link.mjs");
  await fs.symlink(outside, link, "file");
  await rejectsWithCode(() => resolvePluginEntry({ root, entry: "scripts/link.mjs" }), "PLUGIN_ROOT_ENTRY_ESCAPE");
});

test("entry containment accepts an in-root name beginning with two dots", async (t) => {
  const root = await makePlugin(t, claudeHost);
  const directory = path.join(root, "..metadata");
  const entry = path.join(directory, "entry.mjs");
  await fs.mkdir(directory);
  await fs.writeFile(entry, "export {};\n");
  assert.equal(await resolvePluginEntry({ root, entry: "..metadata/entry.mjs" }), await fs.realpath(entry));
});
