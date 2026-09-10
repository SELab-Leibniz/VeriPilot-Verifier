import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { compileRuntimePolicy } from "../lib/policy/compiler.mjs";
import { loadRuntimePlan } from "../lib/runtime-plan.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-runtime-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


test("v1 and v2 project schemas validate reviewerRuntime without requiring v2 roles", () => {
  for (const version of [1, 2]) {
    const config = { version, artifacts: [{ name: "document", patterns: ["item.md"] }] };
    assert.doesNotThrow(() => validateProjectConfig({
      ...config,
      reviewerRuntime: { executable: "codeagent" },
    }, "config.yaml"));
    for (const reviewerRuntime of [null, {}, { executable: " " }, { executable: "agent", argsPrefix: [1] },
      { executable: "agent", argsPrefix: null }, { executable: "agent", argsPrefix: ["bad\u0000argument"] },
      { executable: "agent", sessionDialect: "future" }, { executable: "agent", shell: true }]) {
      assert.throws(() => validateProjectConfig({ ...config, reviewerRuntime }, "config.yaml"), /reviewerRuntime/);
    }
  }
});


test("YAML preserves and normalizes the owning project's runtime in v1 and v2", async (t) => {
  const cwd = await workspace(t);
  const policyRoot = path.join(cwd, ".runtime-corrector");
  await fs.mkdir(policyRoot);
  for (const version of [1, 2]) {
    await fs.writeFile(path.join(policyRoot, "config.yaml"), `version: ${version}\nreviewerRuntime:\n  executable: ./tools/codeagent\n  argsPrefix:\n    - /opt/agent/entry.mjs\nartifacts:\n  - name: document\n    patterns: [item.md]\n`);
    const plan = await loadRuntimePlan({ cwd });
    assert.deepEqual(plan.reviewerRuntime, {
      executable: path.join(cwd, "tools", "codeagent"),
      argsPrefix: ["/opt/agent/entry.mjs"],
    });
    assert.ok(Object.isFrozen(plan.reviewerRuntime));
  }
});


test("provided and legacy configurations apply the same new-field validation and owner root", async (t) => {
  const cwd = await workspace(t);
  const base = { version: 1, artifacts: [], legacyUnrelatedExtension: { enabled: true } };
  for (const source of ["provided", "legacy"]) {
    const load = async (reviewerRuntime) => {
      const config = { ...base, reviewerRuntime };
      if (source === "provided") return loadRuntimePlan({ cwd, config });
      await fs.writeFile(path.join(cwd, ".runtime-corrector.json"), JSON.stringify(config));
      return loadRuntimePlan({ cwd });
    };
    const plan = await load({ executable: "./tools/codeagent" });
    assert.deepEqual(plan.reviewerRuntime, {
      executable: path.join(cwd, "tools", "codeagent"),
      argsPrefix: [],
    });
    assert.deepEqual(plan.legacyUnrelatedExtension, { enabled: true });
    for (const invalid of [null, {}, { executable: "agent", argsPrefix: "entry.js" },
      { executable: "agent", sessionDialect: "future" }, { executable: "agent", extra: true }]) {
      await assert.rejects(load(invalid), /reviewerRuntime/);
    }
  }
});


test("direct compilation requires an explicit owner for relative executable paths", () => {
  const config = { version: 1, artifacts: [], reviewerRuntime: { executable: "./tools/agent" } };
  assert.throws(() => compileRuntimePolicy(config), /projectRoot/);
  assert.throws(() => compileRuntimePolicy({ ...config, policyRoot: ".runtime-corrector" }), /projectRoot/);
  const projectRoot = path.resolve(os.tmpdir(), "reviewer-owner");
  const compiled = compileRuntimePolicy(config, { projectRoot });
  assert.equal(compiled.reviewerRuntime.executable, path.join(projectRoot, "tools", "agent"));
  const relativePolicy = compileRuntimePolicy({ ...config, policyRoot: ".runtime-corrector" }, { projectRoot });
  assert.equal(relativePolicy.reviewerRuntime.executable, path.join(projectRoot, "tools", "agent"));
});
