import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { FileTransactionJournal, stateDelta } from "../lib/runtime-v2/transaction-journal.mjs";
import { ensureTask, withTaskState, withTaskDecision, appendTaskJournal, taskDirectory, findTask } from "../lib/runtime-v2/task-store.mjs";

const bytes = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const seed = baseBytes => ({ current: {}, assessments: { seed: { result: "R".repeat(baseBytes) } } });
const observation = sequence => ({ sequence, metadata: "M".repeat(300) });
const event = sequence => ({ type: "OPERATION_OBSERVED", sequence });
const legacyCommit = (state, i) => ({ commitId: `commit-${i}`, operationId: `operation-${i}`, files: { "state.json": JSON.stringify(state) }, events: [event(i)], outputs: [] });

// No model, no external system, and no growing full-history files in this run.
export function serializedComparison(N, baseBytes) {
  const state = seed(baseBytes);
  let oldBytes = 0, newBytes = 0, previous = structuredClone(state), sizes = [];
  previous.assessments.seed.result = { $journalBlob: digest(state.assessments.seed.result) };
  for (let i = 1; i <= N; i++) {
    state.assessments[`operation-${i}`] = observation(i);
    oldBytes += bytes(JSON.stringify(legacyCommit(state, i), null, 2));
    const encoded = { ...state, assessments: { ...state.assessments, seed: previous.assessments.seed } };
    const record = { format: "runtime-corrector.file-journal.v3", sequence: i, commitId: `commit-${i}`, operationId: `operation-${i}`,
      baseVersion: i - 1, newVersion: i, previousHash: i === 1 ? null : "h".repeat(64),
      changes: stateDelta(previous, encoded), projectionChanges: [], effects: { events: [event(i)], outputs: [], outputIds: [], fileNames: [] }, checksum: "h".repeat(64) };
    const size = bytes(record) + 1; newBytes += size; sizes.push(size); previous = encoded;
  }
  return { N, baseBytes, oldTransactionBytes: oldBytes, newDeltaBytes: newBytes, newOrdinaryMin: Math.min(...sizes), newOrdinaryMax: Math.max(...sizes),
    excluded: "one-time initialization/blob and periodic checkpoints; this row counts serialization only" };
}
async function inventory(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push({ name: path.relative(root, file).replaceAll(path.sep, "/"), bytes: (await fs.stat(file)).size });
    }
  }
  await visit(root);
  return { fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}
async function timed(load) {
  const times = []; let recovered;
  for (let i = 0; i < 5; i++) { const start = performance.now(); recovered = await load(); times.push(performance.now() - start); }
  return { state: recovered, medianMs: times.sort((a, b) => a - b)[2] };
}
export async function diskComparison(root, N = 120, baseBytes = 128 * 1024) {
  const old = path.join(root, "before"), next = path.join(root, "after");
  await fs.mkdir(path.join(old, "transactions"), { recursive: true });
  const journal = new FileTransactionJournal(next, { checkpointEvery: 32 });
  await journal.initialize(seed(baseBytes));
  let state = seed(baseBytes), loaded = await journal.load(), oldProjectionBytes = 0, oldSizes = [], newSizes = [];
  for (let i = 1; i <= N; i++) {
    state.assessments[`operation-${i}`] = observation(i);
    const transaction = JSON.stringify(legacyCommit(state, i), null, 2);
    oldSizes.push(bytes(transaction));
    await fs.writeFile(path.join(old, "transactions", `${i}.json`), transaction);
    const current = `${JSON.stringify(state, null, 2)}\n`; oldProjectionBytes += bytes(current);
    await fs.writeFile(path.join(old, "state.json"), current);
    loaded = await journal.publish(loaded, structuredClone(state), { events: [event(i)], outputs: [] }, { operationId: `operation-${i}`, commitId: `commit-${i}` });
    newSizes.push(bytes(loaded.commit) + 1); await journal.compact(loaded);
  }
  const workloadProjectionBytes = journal.metrics.stateProjectionBytes;
  const beforeRecovery = await timed(async () => {
    let recovered = seed(baseBytes);
    // Validate/replay the old authoritative full manifests, not the current projection.
    for (let i = 1; i <= N; i++) recovered = JSON.parse(JSON.parse(await fs.readFile(path.join(old, "transactions", `${i}.json`), "utf8")).files["state.json"]);
    return recovered;
  });
  await fs.rm(path.join(next, "task.json"));
  const afterRecovery = await timed(async () => (await new FileTransactionJournal(next).load()).state);
  assert.deepEqual(beforeRecovery.state, afterRecovery.state);
  await journal.project(afterRecovery.state);
  const oldInventory = await inventory(old), newInventory = await inventory(next);
  const deltaFiles = newInventory.files.filter(file => /^transactions\/(log\/|audit\/\d+-\d+\.jsonl)/.test(file.name));
  return { N, baseBytes, stateEqual: true, assessmentCount: Object.keys(afterRecovery.state.assessments).length,
    before: { fileCount: oldInventory.fileCount, totalBytes: oldInventory.totalBytes, transactionBytes: oldSizes.reduce((a, b) => a + b), ordinaryFirst: oldSizes[0], ordinaryLast: oldSizes.at(-1),
      recoveryMedianMs: beforeRecovery.medianMs, fullStateProjectionWriteBytes: oldProjectionBytes },
    after: { fileCount: newInventory.fileCount, totalBytes: newInventory.totalBytes, retainedDeltaBytes: deltaFiles.reduce((a, b) => a + b.bytes, 0),
      ordinaryFirst: newSizes[0], ordinaryLast: newSizes.at(-1), recoveryMedianMs: afterRecovery.medianMs,
      fullStateProjectionWriteBytes: workloadProjectionBytes, recoveryProjectionWriteBytes: journal.metrics.stateProjectionBytes - workloadProjectionBytes, checkpointWriteBytes: journal.metrics.checkpointBytes,
      checkpointCount: newInventory.files.filter(file => file.name.startsWith("transactions/checkpoints/")).length,
      auditPolicy: "retain compact incremental audit segments and referenced blobs indefinitely; reclaim checkpointed recovery files; keep two recovery checkpoints" } };
}
async function runtimeHooks(root, N = 80, baseBytes = 128 * 1024) {
  const projectRoot = path.join(root, "actual-runtime");
  const task = await ensureTask({ projectRoot, sessionId: "pure-file-test", explicitTaskId: "experiment" });
  const target = { projectRoot, taskId: task.taskId }, directory = taskDirectory(projectRoot, task.taskId);
  await withTaskState(target, state => { state.assessments = { seed: { result: { body: "R".repeat(baseBytes) } } }; });
  const journal = new FileTransactionJournal(directory);
  let oldBytes = 0, oldSizes = [], newSizes = [], projectionBytes = 0;
  const originalProject = FileTransactionJournal.prototype.project;
  FileTransactionJournal.prototype.project = async function (state) {
    projectionBytes += bytes(`${JSON.stringify(state, null, 2)}\n`);
    return originalProject.call(this, state);
  };
  try {
    for (let i = 1; i <= N; i++) {
      const run = () => withTaskDecision({ ...target, context: { assessmentId: `operation-${i}`, kind: "hook" } }, async () => {
        await appendTaskJournal(projectRoot, task.taskId, event(i)); return observation(i);
      });
      const result = await run(); assert.deepEqual(await run(), result);
      const state = await findTask({ projectRoot, explicitTaskId: task.taskId });
      const record = await journal.readRecord(state.decisionSequence);
      newSizes.push(bytes(record) + 1);
      const reconstructed = { commitId: record.commitId, assessmentId: record.operationId, result, files: { "task.json": JSON.stringify(state) },
        events: [{ file: "journal/events.jsonl", value: { ...event(i), eventId: `${record.commitId}:0` } }], outputs: [] };
      const size = bytes(JSON.stringify(reconstructed, null, 2)); oldBytes += size; oldSizes.push(size);
    }
    const restored = await journal.load();
    const stats = await inventory(directory);
    const deltas = stats.files.filter(file => /^transactions\/(log\/|audit\/\d+-\d+\.jsonl)/.test(file.name));
    const events = (await fs.readFile(path.join(directory, "journal", "events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(events.length, N); assert.equal(Object.keys(restored.state.assessments).length, N + 1);
    return { N, baseBytes, oldReconstructedTransactionBytes: oldBytes, oldOrdinaryFirst: oldSizes[0], oldOrdinaryLast: oldSizes.at(-1),
      actualNewOrdinaryFirst: newSizes[0], actualNewOrdinaryLast: newSizes.at(-1), actualNewRetainedDeltaBytes: deltas.reduce((a, b) => a + b.bytes, 0),
      actualNewFiles: stats.fileCount, actualNewTotalBytes: stats.totalBytes, logicalDecisions: N, eventCount: events.length,
      duplicateRequests: N, duplicateCalculations: 0, journalVersionsIncludingProjectionAcks: restored.head.sequence,
      fullStateProjectionWriteBytes: projectionBytes, projectionWritesPerDecision: 2 };
  } finally { FileTransactionJournal.prototype.project = originalProject; }
}
export async function runBenchmark({ output = null, keep = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-transaction-experiment-"));
  try {
    const report = { generatedAt: new Date().toISOString(), note: "Pure file experiment; isolated new temporary directory; no model or business service. Byte counts are UTF-8. Recovery timing is five-run warm filesystem-cache median, not a cold-start guarantee.",
      serialized: [0, 500_000].flatMap(baseBytes => [100, 200, 400].map(N => serializedComparison(N, baseBytes))),
      disk: await diskComparison(root), actualRuntimeHooks: await runtimeHooks(root) };
    if (keep) report.testDirectory = root;
    if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
    return report;
  } finally { if (!keep) await fs.rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf("--output");
  console.log(JSON.stringify(await runBenchmark({ output: index >= 0 ? path.resolve(process.argv[index + 1]) : null, keep: process.argv.includes("--keep") }), null, 2));
}
