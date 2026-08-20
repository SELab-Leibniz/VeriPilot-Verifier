import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateProjectPolicy } from "../lib/policy/validator.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-validate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


test("policy validation reports shadowed artifacts and missing required Ground Truth", async (t) => {
  const cwd = await workspace(t);
  const policyRoot = path.join(cwd, ".runtime-corrector");
  await fs.mkdir(policyRoot, { recursive: true });
  await fs.writeFile(path.join(policyRoot, "config.yaml"), `version: 1
groundTruth:
  - id: baseline
    required: true
    patterns: [baseline.md]
artifacts:
  - name: first
    patterns: [docs/item.md]
    groundTruth: [baseline]
    rules:
      enabled: false
    review:
      enabled: false
  - name: second
    patterns: [docs/item.md]
    rules:
      enabled: false
    review:
      enabled: false
`, "utf8");

  const validation = await validateProjectPolicy({ cwd, pluginRoot: PLUGIN_ROOT });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "ARTIFACT-MATCHER-SHADOWED"));
  assert.ok(validation.issues.some(
    (issue) => issue.code === "GROUND-TRUTH-REQUIRED-FILE-MISSING",
  ));
  assert.ok(validation.issues.some(
    (issue) => issue.code === "ARTIFACT-HAS-NO-PROJECT-CHECKS",
  ));

  const cli = spawnSync(process.execPath, [
    CLI,
    "validate",
    "--cwd",
    cwd,
    "--format",
    "json",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, "invalid");
});


test("validate command accepts the shipped TodoList Prompt Contract example", () => {
  const example = path.join(
    PLUGIN_ROOT,
    "examples",
    "harmonyos-todolist-prompt-contract",
  );
  const cli = spawnSync(process.execPath, [
    CLI,
    "validate",
    "--cwd",
    example,
    "--format",
    "json",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.status, "valid");
  assert.equal(result.policyFiles.some((file) => file.path.endsWith("checkpoint.schema.json")), true);
});


test("Ground Truth paths cannot escape the project", async (t) => {
  const cwd = await workspace(t);
  const policyRoot = path.join(cwd, ".runtime-corrector");
  await fs.mkdir(policyRoot, { recursive: true });
  await fs.writeFile(path.join(policyRoot, "config.yaml"), `version: 1
groundTruth:
  - id: escaped
    patterns: [../outside.md]
artifacts:
  - name: document
    patterns: [document.md]
    groundTruth: [escaped]
`, "utf8");
  const validation = await validateProjectPolicy({ cwd, pluginRoot: PLUGIN_ROOT });
  assert.equal(validation.valid, false);
  assert.equal(validation.issues[0].code, "POLICY-COMPILE-FAILED");
  assert.match(validation.issues[0].message, /项目内相对路径/);
});


test("validate does not report an uninitialized project as valid", async (t) => {
  const cwd = await workspace(t);
  const validation = await validateProjectPolicy({ cwd, pluginRoot: PLUGIN_ROOT });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some(
    (issue) => issue.code === "PROJECT-POLICY-NOT-INITIALIZED",
  ));
});
