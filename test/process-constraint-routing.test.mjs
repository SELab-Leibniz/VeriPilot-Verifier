import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildMetricPopulation, isSourceOnlyDelivery } from "../lib/runtime-v2/metrics.mjs";

test("kitchen write-scope constraints are assigned to process review without inventing duplicate execution checks", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-process-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claim = (claimId, category, verificationTarget) => ({ claimId, category, verificationTarget,
    status: "ACTIVE", authority: "USER_EXPLICIT", severity: "HARD", revisionId: `${claimId}@1`,
    text: "Only create kitchen.py and application data; keep original conditions." });
  const population = await buildMetricPopulation({ projectRoot: root, taskId: "routing", groundTruth: {
    version: 1, claims: [claim("write-scope", "constraints", "PROCESS"), claim("run-verifier", "requirements", "PROCESS"),
      claim("file-content", "constraints", "ARTIFACT"), claim("legacy-unknown", "constraints", undefined)] } });
  assert.deepEqual(population.metrics.M11.map(o => o.sourceId), ["write-scope"]);
  assert.equal(population.metrics.M11[0].description, "Only create kitchen.py and application data; keep original conditions.");
  assert.equal(population.metrics.M11[0].hard, true);
  assert.deepEqual(population.metrics.M12.map(o => o.sourceId), ["run-verifier"]);
  assert(population.metrics.M01.some(o => o.sourceId === "write-scope"), "representation coverage remains separate");
});

test("an explicitly source-only task has fulfillment checks for every HARD obligation instead of unbound document views", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-source-only-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claims = [
    { claimId: "goal", category: "goals", verificationTarget: "IMPLEMENTATION" },
    { claimId: "stdlib", category: "constraints", verificationTarget: "IMPLEMENTATION" },
    { claimId: "scope", category: "constraints", verificationTarget: "PROCESS" },
    { claimId: "runtime", category: "requirements", verificationTarget: "IMPLEMENTATION" },
  ].map(c => ({ ...c, status: "ACTIVE", authority: "USER_EXPLICIT", severity: "HARD", text: c.claimId, revisionId: `${c.claimId}@1` }));
  const run = artifactMetricIds => buildMetricPopulation({ projectRoot: root, taskId: "typed", groundTruth: { version: 1, claims }, artifactMetricIds,
    sourceOnlyDelivery: isSourceOnlyDelivery([{ stage: "implementation", patterns: ["kitchen.py"] }]) });
  const scoped = await run([]);
  assert.equal(scoped.metrics.M01.length, 0); assert.equal(scoped.metrics.M02.length, 0);
  assert.equal(scoped.metricCatalog.M01.reasonCode, "NO_ARTIFACT_OBLIGATIONS");
  assert.deepEqual(new Set(Object.values(scoped.metrics).flat().map(o => o.sourceId)), new Set(claims.map(c => c.claimId)));
  assert.equal(scoped.metrics.M11[0].sourceId, "scope");
  assert.deepEqual(new Set(scoped.metrics.M12.map(o => o.sourceId)), new Set(["goal", "stdlib", "runtime"]));
  assert((await run(["M01"])).metrics.M01.length > 0, "explicitly declared document comparison is retained");
  assert.equal(isSourceOnlyDelivery([{ stage: "requirements", patterns: ["delivery.md"] }]), false);
  assert.equal(isSourceOnlyDelivery([{ stage: "implementation", patterns: ["kitchen.py", "README.md"] }]), false);
  delete claims[0].verificationTarget;
  assert((await run([])).metrics.M01.length > 0, "unknown ownership must not be silently excluded");
});
