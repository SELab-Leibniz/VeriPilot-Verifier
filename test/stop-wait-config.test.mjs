import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { compileRuntimePolicy } from "../lib/policy/compiler.mjs";
import { loadRuntimePlan } from "../lib/runtime-plan.mjs";

const base = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: true } };

test("Stop wait defaults to correction and re-verification with an inherited total budget", () => {
  for (const document of [base, { ...base, stopCorrection: { enabled: true } }]) {
    validateProjectConfig(document, "config.yaml");
    const stop = compileRuntimePolicy(document).runtimeV2.stopCorrection;
    assert.equal(stop.waitMode, "until_pass");
    assert.equal(stop.waitTimeoutMs, null);
  }
});

test("Stop wait accepts both modes and retains a total budget independent of one assessment", () => {
  for (const waitMode of ["until_pass", "assessment"]) {
    const document = { ...base, stopCorrection: { enabled: true, waitMode,
      assessmentTimeoutMs: 60000, waitTimeoutMs: 180000 } };
    validateProjectConfig(document, "config.yaml");
    const stop = compileRuntimePolicy(document).runtimeV2.stopCorrection;
    assert.equal(stop.waitMode, waitMode);
    assert.equal(stop.waitTimeoutMs, 180000);
    assert.equal(stop.assessmentTimeoutMs, 60000);
  }
});

test("project validation rejects invalid Stop wait modes and total budgets", () => {
  for (const waitMode of ["pass", "", true, 1, null, [], {}]) {
    assert.throws(() => validateProjectConfig({ ...base,
      stopCorrection: { enabled: true, waitMode } }, "config.yaml"), /stopCorrection\.waitMode/);
  }
  for (const waitTimeoutMs of [999, 0, -1, 1000.5, "1000", true, null]) {
    assert.throws(() => validateProjectConfig({ ...base,
      stopCorrection: { enabled: true, waitTimeoutMs } }, "config.yaml"), /stopCorrection\.waitTimeoutMs/);
  }
});

test("loaded YAML preserves default and explicit Stop wait settings and rejects invalid values", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-wait-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".runtime-corrector");
  await fs.mkdir(directory);
  const file = path.join(directory, "config.yaml");
  const header = "version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\nstopCorrection:\n  enabled: true\n";
  for (const [suffix, waitMode, waitTimeoutMs] of [
    ["", "until_pass", null],
    ["  waitMode: until_pass\n  waitTimeoutMs: 1000\n", "until_pass", 1000],
    ["  waitMode: assessment\n  waitTimeoutMs: 180000\n", "assessment", 180000],
  ]) {
    await fs.writeFile(file, header + suffix);
    const stop = (await loadRuntimePlan({ cwd: root })).runtimeV2.stopCorrection;
    assert.equal(stop.waitMode, waitMode);
    assert.equal(stop.waitTimeoutMs, waitTimeoutMs);
  }
  for (const [suffix, error] of [
    ["  waitMode: wrong\n", /stopCorrection\.waitMode/],
    ["  waitTimeoutMs: false\n", /stopCorrection\.waitTimeoutMs/],
  ]) {
    await fs.writeFile(file, header + suffix);
    await assert.rejects(loadRuntimePlan({ cwd: root }), error);
  }
});
