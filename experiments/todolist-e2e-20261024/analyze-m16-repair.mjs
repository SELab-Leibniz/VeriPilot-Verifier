// Read-only verification of the seven authorized model cases; no model calls.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { sha256 } from "../../lib/runtime-v2/utils.mjs";
import { validateProductionTrace } from "../../lib/review-task/production-trace.mjs";

const root = path.resolve(process.argv[2]);
assert.equal(path.dirname(root), path.resolve("experiments"));
assert(/^live-m16-repair-validation-/u.test(path.basename(root)));
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const report = await read(path.join(root, "report.json"));
assert.equal(report.cases.length, 7); assert.equal(report.passed, true);
const prepared = path.resolve("experiments/live-m16-repair-validation-prepared-20261025");
const approved = await read(path.join(prepared, "report.json"));
const taskRoot = async (directory, name) => {
  const tasks = path.join(directory, name, ".runtime-correction/tasks");
  const ids = await fs.readdir(tasks); assert.equal(ids.length, 1);
  return path.join(tasks, ids[0]);
};
const result = { kind: report.kind, model: report.model, catalogVersion: report.catalogVersion, promptDigest: report.promptDigest,
  startedAt: report.startedAt, finishedAt: report.finishedAt, wallElapsedMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt), cases: [],
  totals: { turns: 0, toolCalls: 0, readBytes: 0, inputTokens: 0, outputTokens: 0, compactions: 0, compactionFailures: 0, unsafeRequestsPrevented: 0, protocolErrors: 0, providerErrors: 0, postSaveCancellations: 0 } };
for (const item of report.cases) {
  const original = approved.cases.find(c => c.name === item.name);
  assert(original); assert.equal(item.matched, true);
  for (const source of original.sourceManifest)
    assert.equal(sha256(await fs.readFile(path.join(root, item.name, source.path))), source.sha256);
  const currentTask = await taskRoot(root, item.name), approvedTask = await taskRoot(prepared, item.name);
  assert.deepEqual((await read(path.join(currentTask, "ground-truth/current.json"))).claims,
    (await read(path.join(approvedTask, "ground-truth/current.json"))).claims);
  const runs = path.join(currentTask, "review-task-runs"), ids = await fs.readdir(runs);
  assert.equal(ids.length, 1);
  const artifacts = path.join(runs, ids[0], "review"), worker = await read(path.join(artifacts, "result.json"));
  assert.equal(worker.completed, true); assert.equal(worker.verdict, item.judgement);
  assert(item.sourceCitations.some(c => c.readProof?.version === 1 && c.readProof.observed === true
    && c.readProof.basisComplete === true && c.readProof.owner === "SOURCE"));
  for (const citation of item.sourceCitations.filter(c => c.readProof?.owner === "SOURCE"))
    assert.equal(sha256(await fs.readFile(citation.path)), citation.contentHash);
  const sourceIds = worker.refs.filter(ref => ref.path.startsWith("project/") && worker.citeIds.includes(ref.citeId)).map(ref => ref.citeId);
  if (worker.verdict === "PASS") validateProductionTrace(worker.productionTrace, sourceIds);
  else assert.equal(worker.productionTrace, undefined, "Non-PASS traces must not be published as validated proof.");
  const sessionDir = path.join(artifacts, "sessions");
  let protocolErrors = 0, providerErrors = 0, submissions = 0, postSaveCancellations = 0;
  for (const file of await fs.readdir(sessionDir)) {
    let saved = false;
    const records = (await fs.readFile(path.join(sessionDir, file), "utf8")).trim().split("\n").map(JSON.parse);
    for (const record of records) {
      const message = record.message;
      if (!message) continue;
      if (message.role === "toolResult" && message.toolName === "submit_review" && !message.isError && Array.isArray(message.content)) {
        for (const block of message.content) if (block.type === "text") {
          try { if (JSON.parse(block.text).saved === true) saved = true; } catch { /* Other tool text does not acknowledge a saved decision. */ }
        }
      }
      if (message.role === "assistant" && message.stopReason === "error") {
        if (saved && /abort/iu.test(message.errorMessage ?? "")) postSaveCancellations++;
        else providerErrors++;
      }
      if (message.role === "toolResult" && message.isError) protocolErrors++;
      if (Array.isArray(message.content)) submissions += message.content.filter(c => c.type === "toolCall" && c.name === "submit_review").length;
    }
  }
  for (const key of Object.keys(result.totals)) result.totals[key] += key === "protocolErrors" ? protocolErrors
    : key === "providerErrors" ? providerErrors : key === "postSaveCancellations" ? postSaveCancellations : worker.metrics[key] ?? 0;
  result.cases.push({ name: item.name, expected: item.expected, judgement: item.judgement, reason: item.reason,
    elapsedMs: item.elapsedMs, sourceInputsAndRequirementsMatchAuthorization: true, currentSourceProofChecked: true,
    sourceCitationCount: item.sourceCitations.filter(c => c.readProof?.owner === "SOURCE").length,
    productionTraceChecked: worker.verdict === "PASS", targets: worker.productionTrace?.stateTargets.length ?? null,
    relations: worker.productionTrace?.targetRelations.length ?? null, submissions, protocolErrors, providerErrors, postSaveCancellations,
    metrics: worker.metrics, artifacts,
    ...(item.acceptance ? { acceptance: item.acceptance } : {}), ...(item.probe ? { probe: item.probe } : {}) });
}
assert.equal(sha256(await fs.readFile(report.originalFile)), report.originalHash);
const identity = await read(path.join(root, "code-identity.json"));
for (const [file, hash] of Object.entries(identity.sourceHashes)) assert.equal(sha256(await fs.readFile(file)), hash);
result.originalExperimentSourceUnchanged = true;
result.currentCodeMatchesReviewedVersion = true;
result.inputTokenMeaning = "SDK cumulative input + cacheRead + cacheWrite; not an exact billing total.";
result.passed = true;
await fs.writeFile(path.join(root, "analysis.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, cases: result.cases.map(c => ({ name: c.name, judgement: c.judgement, protocolErrors: c.protocolErrors })), wallElapsedMs: result.wallElapsedMs, totals: result.totals }, null, 2));
