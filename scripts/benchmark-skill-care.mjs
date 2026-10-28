// Reproducible deterministic evidence-delivery experiment. No model calls and
// no repository copies. Bytes are a proxy, never reported as billed tokens.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { scanSkillDirectory } from "../lib/runtime-v2/skill-source.mjs";
import { createSkillCare } from "../lib/runtime-v2/skill-care.mjs";
import { prepareReviewerRequest } from "../lib/runtime-v2/reviewer-evidence.mjs";
import { atomicWriteJson } from "../lib/runtime-v2/utils.mjs";

const output = path.resolve(process.argv[2] ?? ".runtime-correction/skill-care-experiment.json");
const parent = path.join(path.dirname(output), "skill-care-fixtures");
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "run-"));
try {
  const skill = path.join(root, "skills", "demo");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "# Delivery\nRun verify-result before claiming completion.\n");
  for (let i = 0; i < 80; i++) await fs.writeFile(path.join(skill, `helper-${i}.md`), `# Optional helper ${i}\n` + "Ordinary reference details.\n".repeat(300));
  const start = performance.now();
  const source = await scanSkillDirectory(skill, { cache: false });
  const coldMs = performance.now() - start;
  await scanSkillDirectory(skill);
  const times = [], reads = [];
  for (let i = 0; i < 7; i++) {
    const tick = performance.now(), warm = await scanSkillDirectory(skill);
    times.push(performance.now() - tick); reads.push(warm.stats.bytesRead);
    assert.equal(warm.digest, source.digest);
  }
  const request = { skill: { skillId: "demo", files: source.files }, watcher: { skillId: "demo" } };
  const evidence = { skillSource: source, groundTruth: { digest: "v1" }, skillGroundTruth: { constraints: [] },
    snapshot: { digest: "original-execution", entries: [{ type: "assistant", message: { content: "Still implementing" } }] } };
  const prepared = await prepareReviewerRequest({ requestDirectory: path.join(root, "request"), request, evidence });
  const care = await createSkillCare({ projectRoot: root, taskId: "experiment", request, evidence });
  const search = await care.execute({ action: "search", query: "verify-result", prefix: "skill/" });
  const read = await care.execute({ action: "read", id: search.items[0].id });
  assert.match(read.content, /before claiming completion/);
  await care.execute({ action: "note", key: "verification", text: "Need original verification result before completion", refs: ["skill/SKILL.md"] });
  await care.checkpoint("before_compaction");
  const restored = await createSkillCare({ projectRoot: root, taskId: "experiment", request, evidence });
  const notes = await restored.execute({ action: "notes" });
  assert.equal(notes.items[0].current, true);
  times.sort((a, b) => a - b);
  const baselineBytes = Buffer.byteLength(JSON.stringify(request));
  const optimizedBytes = Buffer.byteLength(JSON.stringify(prepared)) + Buffer.byteLength(JSON.stringify(search)) + Buffer.byteLength(JSON.stringify(read));
  assert.ok(optimizedBytes < baselineBytes / 5);
  const report = { schemaVersion: 1, kind: "deterministic-delivery-benchmark", fixture: { helperFiles: 80, sourceBytes: source.totalBytes },
    cold: { ms: coldMs, bytesRead: source.stats.bytesRead }, warm: { medianMs: times[3], samplesMs: times, bytesRead: reads },
    disclosure: { baselineBytes, optimizedBytes, reductionPercent: 100 * (1 - optimizedBytes / baselineBytes),
      unit: "UTF-8 bytes delivered for one entrypoint lookup, not model token usage" },
    assertions: { originalEvidenceRecovered: true, notesRestoredAfterRecreation: true, businessRepositoryCopies: 0 },
    limits: "Synthetic deterministic workload; model quality, billed tokens and real host wall time require a live model experiment." };
  await atomicWriteJson(output, report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Only the exact mkdtemp child created above is removed.
  if (path.dirname(root) !== parent) throw new Error("Unexpected experiment fixture path");
  await fs.rm(root, { recursive: true, force: true });
}
