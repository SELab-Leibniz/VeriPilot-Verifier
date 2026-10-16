import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { compileRuntimePolicy } from "../lib/policy/compiler.mjs";
import { loadRuntimePlan } from "../lib/runtime-plan.mjs";

const base = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: true } };
const roles = ["groundTruthExtractor", "onboardingAdjudicator", "skillReviewer",
  "artifactReviewer", "stopReviewer", "implementationReviewer"];

test("schema and compiler accept the thirty-minute regression and sixty-minute boundary", () => {
  for (const timeoutMs of [1000, 1200000, 1800000, 3600000]) {
    const config = { ...base, limits: { semanticReviewTimeoutMs: timeoutMs },
      reviewers: { defaults: { timeoutMs } } };
    validateProjectConfig(config, "config.yaml");
    const plan = compileRuntimePolicy(config);
    assert.equal(plan.limits.semanticReviewTimeoutMs, timeoutMs);
    for (const role of roles) assert.equal(plan.runtimeV2.reviewers[role].timeoutMs, timeoutMs);
  }
});

test("schema and direct compilation reject invalid limits and every reviewer timeout", () => {
  for (const timeoutMs of [999, 3600001, 7200000, 1200000.5, "1800000", null]) {
    const candidates = [{ ...base, limits: { semanticReviewTimeoutMs: timeoutMs } },
      ...["defaults", ...roles].map(role => ({ ...base, reviewers: { [role]: { timeoutMs } } }))];
    for (const config of candidates) {
      assert.throws(() => validateProjectConfig(config, "config.yaml"), /TimeoutMs|timeoutMs/);
      assert.throws(() => compileRuntimePolicy(config), /TimeoutMs|timeoutMs/);
    }
  }
});

test("loaded YAML defaults to twenty minutes and preserves explicit role/default/limit precedence", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-review-timeout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".runtime-corrector");
  await fs.mkdir(directory);
  const header = "version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n";
  for (const [suffix, common, stop] of [
    ["", 1200000, 1200000],
    ["limits:\n  semanticReviewTimeoutMs: 1800000\n", 1800000, 1800000],
    ["limits:\n  semanticReviewTimeoutMs: 1800000\nreviewers:\n  defaults:\n    timeoutMs: 2400000\n  stopReviewer:\n    timeoutMs: 3600000\n", 2400000, 3600000],
  ]) {
    await fs.writeFile(path.join(directory, "config.yaml"), header + suffix);
    const plan = await loadRuntimePlan({ cwd: root });
    for (const role of roles) assert.equal(plan.runtimeV2.reviewers[role].timeoutMs, role === "stopReviewer" ? stop : common);
  }
});

test("schema defaults and maximum agree with every packaged host adapter", async () => {
  const schema = JSON.parse(await fs.readFile(new URL("../config/schemas/project-config.schema.json", import.meta.url)));
  for (const definition of [schema.properties.limits.properties.semanticReviewTimeoutMs, schema.$defs.reviewer.properties.timeoutMs]) {
    assert.equal(definition.default, 1200000);
    assert.equal(definition.maximum, 3600000);
  }
  for (const name of ["claude", "codeagent", "openclaw"]) {
    const adapter = await import(`../lib/hosts/${name}.mjs`);
    assert.equal(adapter.defaultSemanticReviewTimeoutMs, 1200000);
    assert.equal(adapter.defaultReviewerTimeoutMs, 1200000);
  }
});
