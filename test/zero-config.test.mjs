import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntimePlan } from "../lib/runtime-plan.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zero-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function write(root, relative, contents) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}


test("a project with only a README and oh-package.json5 compiles a working v2 plan with no config file", async (t) => {
  const cwd = await workspace(t);
  await write(cwd, "README.md", "# Demo app\n\nBuild a TodoList.\n");
  await write(cwd, "oh-package.json5", "{ name: 'demo' }\n");

  const plan = await loadRuntimePlan({ cwd });

  assert.equal(plan.configSource, "plugin-default");
  const runtimeV2 = plan.runtimeV2;
  assert.equal(runtimeV2.enabled, true, "the v2 runtime is on without any configuration");
  assert.equal(runtimeV2.configVersion, 2);
  // Onboarding materials were discovered, not configured.
  assert.equal(runtimeV2.dynamicGroundTruth.enabled, true);
  assert.deepEqual(runtimeV2.dynamicGroundTruth.materialRoots, [path.join(cwd, "README.md")]);
  assert.equal(runtimeV2.dynamicGroundTruth.panel.size, 2);
  assert.equal(runtimeV2.dynamicGroundTruth.panel.adjudicator, true);
  // The platform came from the project fingerprint.
  assert.equal(runtimeV2.implementationCorrection.enabled, true);
  assert.equal(runtimeV2.implementationCorrection.platform, "harmonyos");
  // Terminal gate active; artifact/skill correction stay opt-in.
  assert.equal(runtimeV2.stopCorrection.enabled, true);
  assert.equal(runtimeV2.skillCorrection.enabled, false);
  assert.equal(runtimeV2.artifactCorrection.groundTruthReviewEnabled, false);
  // The derivation record drives the once-per-task DERIVED_CONFIG journal.
  assert.deepEqual(runtimeV2.derivation, {
    zeroConfig: true,
    materialRootsDerived: true,
    materialRoots: ["README.md"],
    platformDerived: true,
    platform: "harmonyos",
    platformMarker: "oh-package.json5",
  });
});


test("an explicit v2 config that leaves materials/platform unset gets them derived", async (t) => {
  const cwd = await workspace(t);
  await write(cwd, "README.md", "# App\n");
  await write(cwd, "oh-package.json5", "{}\n");
  await write(cwd, ".runtime-corrector/config.yaml", [
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "implementationCorrection:",
    "  enabled: true",
    "",
  ].join("\n"));

  const plan = await loadRuntimePlan({ cwd });
  assert.equal(plan.configSource, "project-simple");
  assert.deepEqual(plan.runtimeV2.dynamicGroundTruth.materialRoots, [path.join(cwd, "README.md")]);
  assert.equal(plan.runtimeV2.implementationCorrection.platform, "harmonyos");
  assert.equal(plan.runtimeV2.derivation.zeroConfig, false);
  assert.equal(plan.runtimeV2.derivation.materialRootsDerived, true);
  assert.equal(plan.runtimeV2.derivation.platformDerived, true);
});


test("explicit materials and platform suppress derivation entirely", async (t) => {
  const cwd = await workspace(t);
  await write(cwd, "README.md", "# App\n");
  await write(cwd, "oh-package.json5", "{}\n");
  await write(cwd, "docs/spec.md", "# Spec\n");
  await write(cwd, ".runtime-corrector/config.yaml", [
    "version: 2",
    "artifacts: []",
    "dynamicGroundTruth:",
    "  enabled: true",
    "  materialRoots:",
    "    - docs/spec.md",
    "implementationCorrection:",
    "  enabled: true",
    "  platform: null",
    "",
  ].join("\n"));

  const plan = await loadRuntimePlan({ cwd });
  assert.deepEqual(
    plan.runtimeV2.dynamicGroundTruth.materialRoots,
    [path.join(cwd, "docs", "spec.md")],
  );
  assert.equal(plan.runtimeV2.implementationCorrection.platform, null);
  assert.equal(plan.runtimeV2.derivation, null, "fully explicit config skips derivation");
});


test("a version 1 project config keeps the v2 runtime off", async (t) => {
  const cwd = await workspace(t);
  await write(cwd, "README.md", "# App\n");
  await write(cwd, ".runtime-corrector/config.yaml", [
    "version: 1",
    "enabledStages: []",
    "artifacts:",
    "  - name: example-document",
    "    patterns:",
    "      - docs/example.md",
    "",
  ].join("\n"));

  const plan = await loadRuntimePlan({ cwd });
  assert.equal(plan.runtimeV2.enabled, false);
  assert.equal(plan.runtimeV2.derivation, null);
});
