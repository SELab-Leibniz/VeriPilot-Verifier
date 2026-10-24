// Read the archived kitchen snapshot; write only to a new isolated replay root.
// This checks routing/coverage, not model accuracy or full end-to-end behavior.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMetricPopulation, isSourceOnlyDelivery } from "../../lib/runtime-v2/metrics.mjs";
import { loadConfig } from "../../lib/runtime-corrector.mjs";
import { sha256 } from "../../lib/runtime-v2/utils.mjs";
import { rejectedGroundTruthSource } from "../../lib/runtime-v2/ground-truth-provenance.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const archived = path.resolve(repo, process.argv[2] ?? "experiments/live-kitchen-disabled-20261024-01/host/host-state/worktrees/6ceb54f63ac9b33d/wt-81bdce14");
const taskId = "oc-scope-6af302e6-e620-4530-87d9-2194158f8af1";
const state = path.join(archived, ".runtime-correction/tasks", taskId);
const inputs = [path.join(state, "ground-truth/current.json"), path.join(state, "metrics/population.json"),
  path.join(archived, ".runtime-corrector/config.yaml"), path.join(archived, "kitchen.py")];
const before = await Promise.all(inputs.map(file => fs.readFile(file)));
const truth = JSON.parse(before[0]), previous = JSON.parse(before[1]);
const plan = await loadConfig({ cwd: archived, pluginRoot: repo });
const declarations = plan.configuredArtifacts ?? plan.artifacts;
await fs.mkdir(path.join(repo, ".runtime-correction"), { recursive: true });
const output = await fs.mkdtemp(path.join(repo, ".runtime-correction/kitchen-stop-replay-"));
const population = await buildMetricPopulation({ projectRoot: output, taskId, groundTruth: truth,
  artifactMetricIds: [...new Set(declarations.flatMap(artifact => artifact.metrics ?? []))],
  sourceOnlyDelivery: isSourceOnlyDelivery(declarations) });
const objects = Object.values(population.metrics).flat();
const mandatory = truth.claims.filter(c => c.status === "ACTIVE" && c.severity === "HARD"
  && ["USER_EXPLICIT", "MATERIAL_DERIVED", "PROJECT_CONSTRAINT"].includes(c.authority) && !rejectedGroundTruthSource(c));
const covered = new Set(objects.map(o => o.sourceId));
assert.deepEqual(mandatory.filter(c => !covered.has(c.claimId)), [], "No original HARD obligation may be lost.");
const processConstraints = truth.claims.filter(c => c.status === "ACTIVE" && c.category === "constraints" && c.verificationTarget === "PROCESS");
assert(processConstraints.length > 0);
assert(processConstraints.every(c => population.metrics.M11.some(o => o.sourceId === c.claimId)));
assert.equal(Object.entries(population.metrics).filter(([id]) => /^M0[1-7]$/u.test(id)).flatMap(([, rows]) => rows).length, 0);
const after = await Promise.all(inputs.map(file => fs.readFile(file)));
assert.deepEqual(after.map(sha256), before.map(sha256), "Archived evidence must remain byte-identical.");
const counts = value => Object.fromEntries(Object.entries(value.metrics).map(([id, rows]) => [id, rows.length]));
const report = { kind: "OFFLINE_ROUTING_REPLAY", modelCalls: 0, originalInputsUnchanged: true,
  originalHashes: before.map(sha256), previousCounts: counts(previous), currentCounts: counts(population),
  oldObjects: Object.values(previous.metrics).flat().length, currentObjects: objects.length,
  mandatoryClaims: mandatory.length, uncoveredMandatoryClaims: 0,
  processConstraints: processConstraints.map(c => ({ sourceId: c.claimId, assigned: `M11:${c.claimId}` })),
  scope: "Frozen kitchen Ground Truth and policy only; no new model verdicts or end-to-end run." };
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output, ...report }, null, 2) + "\n");
