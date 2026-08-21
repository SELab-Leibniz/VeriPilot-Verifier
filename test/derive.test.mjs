import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import {
  deriveConfigDefaults,
  detectPlatform,
  discoverMaterialRoots,
  renderMaterializedConfig,
  ZERO_CONFIG_DEFAULTS,
} from "../lib/runtime-v2/derive.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { parseSimpleYaml } from "../lib/simple-yaml.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "derive-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function write(root, relative, contents = "content\n") {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}


test("material discovery is prioritized, deduplicated, capped and deterministic", async (t) => {
  const root = await workspace(t);
  await write(root, "README.md");
  await write(root, "readme.zh-CN.md");
  await write(root, "app_requirements.md");
  await write(root, "prompts/task-spec.md");
  await write(root, "docs/overview.md");
  await write(root, "docs/nested/detail.md");
  // Noise that must never be discovered.
  await write(root, "node_modules/pkg/README.md");
  await write(root, ".runtime-correction/tasks/x/notes.md");
  await write(root, "docs/diagram.png");
  await write(root, "source.js");

  const discovered = await discoverMaterialRoots(root);
  assert.deepEqual(discovered, [
    "README.md",
    "readme.zh-CN.md",
    "app_requirements.md",
    "prompts/task-spec.md",
    "docs/nested/detail.md",
    "docs/overview.md",
  ]);
  // Deterministic across runs.
  assert.deepEqual(await discoverMaterialRoots(root), discovered);
  // The cap keeps the highest-priority group: README* survives a small cap.
  assert.deepEqual(await discoverMaterialRoots(root, { maxEntries: 2 }), [
    "README.md",
    "readme.zh-CN.md",
  ]);
});


test("platform fingerprinting maps markers to adapters and defaults to null", async (t) => {
  const harmony = await workspace(t);
  await write(harmony, "oh-package.json5", "{}\n");
  assert.deepEqual(await detectPlatform(harmony), {
    platform: "harmonyos",
    marker: "oh-package.json5",
  });

  // A plain Node project has no platform adapter yet: null keeps the kit
  // check off while recording which marker was seen.
  const node = await workspace(t);
  await write(node, "package.json", "{}\n");
  assert.deepEqual(await detectPlatform(node), { platform: null, marker: "package.json" });

  const bare = await workspace(t);
  assert.deepEqual(await detectPlatform(bare), { platform: null, marker: null });
});


test("compile precedence: plugin defaults < derived < explicit config", async (t) => {
  const root = await workspace(t);
  await write(root, "README.md");
  await write(root, "oh-package.json5", "{}\n");
  const derived = await deriveConfigDefaults(root, { env: { LANG: "en_US.UTF-8" } });

  // Derived fills unset keys.
  const derivedCompile = compileRuntimeV2Config({
    version: 2,
    dynamicGroundTruth: { enabled: true },
    implementationCorrection: { enabled: true },
  }, { derived });
  assert.deepEqual(derivedCompile.dynamicGroundTruth.materialRoots, [path.join(root, "README.md")]);
  assert.equal(derivedCompile.implementationCorrection.platform, "harmonyos");
  assert.deepEqual(derivedCompile.derivation, {
    zeroConfig: false,
    materialRootsDerived: true,
    materialRoots: ["README.md"],
    platformDerived: true,
    platform: "harmonyos",
    platformMarker: "oh-package.json5",
    localeDerived: true,
    locale: "en",
  });
  assert.equal(derivedCompile.locale, "en");

  // Explicit config wins over derived.
  const explicitCompile = compileRuntimeV2Config({
    version: 2,
    dynamicGroundTruth: { enabled: true, materialRoots: [path.join(root, "docs")] },
    implementationCorrection: { enabled: true, platform: null },
  }, { derived });
  assert.deepEqual(explicitCompile.dynamicGroundTruth.materialRoots, [path.join(root, "docs")]);
  assert.equal(explicitCompile.implementationCorrection.platform, null);
  assert.equal(explicitCompile.derivation.materialRootsDerived, false);
  assert.equal(explicitCompile.derivation.platformDerived, false);

  // Without a derivation pass the plugin default platform stands unchanged.
  const defaultCompile = compileRuntimeV2Config({
    version: 2,
    implementationCorrection: { enabled: true },
  });
  assert.equal(defaultCompile.implementationCorrection.platform, "harmonyos");
  assert.equal(defaultCompile.derivation, null);
});


test("DERIVED_CONFIG is journaled exactly once per task", async (t) => {
  const root = await workspace(t);
  await write(root, "README.md");
  await write(root, "oh-package.json5", "{}\n");
  const derived = { ...(await deriveConfigDefaults(root)), zeroConfig: true };
  const plan = {
    runtimeV2: compileRuntimeV2Config({
      ...ZERO_CONFIG_DEFAULTS,
      // panel size 0 keeps this test free of reviewer subprocesses.
      dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
    }, { derived }),
  };
  const event = (id, name) => handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-derived",
      transcript_path: path.join(root, "transcript.jsonl"),
      hook_event_name: name,
      hook_event_id: id,
    },
    projectRoot: root,
    plan,
  });

  await event("event-1", "SessionStart");
  await event("event-2", "UserPromptSubmit");

  const tasksRoot = path.join(root, ".runtime-correction", "tasks");
  const [taskId] = await fs.readdir(tasksRoot);
  const journal = await fs.readFile(path.join(tasksRoot, taskId, "journal", "events.jsonl"), "utf8");
  const events = journal.trim().split("\n").map((line) => JSON.parse(line));
  const derivedEvents = events.filter((entry) => entry.type === "DERIVED_CONFIG");
  assert.equal(derivedEvents.length, 1, "one DERIVED_CONFIG per task");
  assert.equal(derivedEvents[0].zeroConfig, true);
  assert.deepEqual(derivedEvents[0].materialRoots, ["README.md"]);
  assert.equal(derivedEvents[0].platform, "harmonyos");
  assert.equal(derivedEvents[0].platformMarker, "oh-package.json5");
});


test("materialized config renders valid, loadable version 2 YAML", async (t) => {
  const root = await workspace(t);
  await write(root, "README.md");
  await write(root, "oh-package.json5", "{}\n");
  const derived = await deriveConfigDefaults(root);
  const rendered = renderMaterializedConfig(derived);
  const document = parseSimpleYaml(rendered, { source: "config.yaml" });
  assert.equal(validateProjectConfig(document, "config.yaml"), document);
  assert.equal(document.version, 2);
  assert.deepEqual(document.artifacts, []);
  assert.equal(document.dynamicGroundTruth.enabled, true);
  assert.deepEqual(document.dynamicGroundTruth.materialRoots, ["README.md"]);
  assert.equal(document.implementationCorrection.platform, "harmonyos");
  assert.equal(document.stopCorrection.enabled, true);
  // No secrets, endpoints or key literals in the active configuration.
  assert.ok(!/apiKey(?!Env)/.test(rendered), "no raw apiKey key anywhere");

  // A bare project materializes with platform null and no materialRoots key.
  const bare = await workspace(t);
  const bareDocument = parseSimpleYaml(
    renderMaterializedConfig(await deriveConfigDefaults(bare)),
    { source: "config.yaml" },
  );
  assert.equal(validateProjectConfig(bareDocument, "config.yaml"), bareDocument);
  assert.equal(bareDocument.implementationCorrection.platform, null);
  assert.equal(bareDocument.dynamicGroundTruth.materialRoots, undefined);
});

test("locale derives from the environment with POSIX precedence and explicit config wins", async (t) => {
  const { deriveLocale } = await import("../lib/runtime-v2/derive.mjs");
  assert.equal(deriveLocale({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(deriveLocale({ LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(deriveLocale({ LANG: "de_DE.UTF-8" }), "en", "non-Chinese locales get the English catalog");
  assert.equal(deriveLocale({ LC_ALL: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }), "zh", "LC_ALL outranks LANG");
  assert.equal(deriveLocale({}), null, "nothing set derives nothing");
  assert.equal(deriveLocale({ LANG: "C" }), null, "C/POSIX locales derive nothing");

  const { compileRuntimeV2Config } = await import("../lib/runtime-v2/config.mjs");
  const derivedOnly = compileRuntimeV2Config({ version: 2 }, { derived: { locale: "en" } });
  assert.equal(derivedOnly.locale, "en");
  assert.equal(derivedOnly.derivation.localeDerived, true);
  const explicitWins = compileRuntimeV2Config({ version: 2, locale: "zh" }, { derived: { locale: "en" } });
  assert.equal(explicitWins.locale, "zh");
  assert.equal(explicitWins.derivation.localeDerived, false);
});
