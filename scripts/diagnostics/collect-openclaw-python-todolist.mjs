// Export synthetic acceptance evidence only. Never reads provider configuration,
// credentials, model reasoning, or unrelated host sessions.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileTransactionJournal, applyDelta } from "../../lib/runtime-v2/transaction-journal.mjs";
import { readReport } from "../../lib/openclaw/report.mjs";

const [directory, output] = process.argv.slice(2);
assert.ok(directory && output, "Usage: collect-openclaw-python-todolist.mjs <isolated-test-root> <output.json>");
const root = path.resolve(directory), report = JSON.parse(await fs.readFile(path.join(root, "report.json")));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(report.root, root); assert.equal(report.workspace, path.join(root, "workspace"));
assert.equal(report.originalProfileTouched, false); assert.equal(report.replacementReviewer, false);
assert.ok(path.basename(root).startsWith("rc-openclaw-todo-live-"));
async function files(dir) {
  const out = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...await files(file)); else if (item.isFile()) out.push(file);
  }
  return out;
}
const taskDir = path.join(report.workspace, ".runtime-correction/tasks", report.taskId);
const journal = new FileTransactionJournal(taskDir);
const recoveries = [];
for (let attempt = 0; attempt < 5; attempt++) {
  const started = performance.now(); await journal.load(); recoveries.push(performance.now() - started);
}
const loaded = await journal.load(), base = JSON.parse(await fs.readFile(journal.file("audit/baseline.json")));
let encoded = base.state, allLogicalLegacyBytes = 0, logicalHookLegacyBytes = 0, logicalHookDeltaBytes = 0, logBytes = 0;
const ordinary = [], ids = [], events = [], records = [];
for (let sequence = 1; sequence <= loaded.head.sequence; sequence++) {
  const record = await journal.readRecord(sequence); records.push(record);
  encoded = applyDelta(encoded, record.changes);
  const state = await journal.decode(encoded);
  const bytes = Buffer.byteLength(JSON.stringify(record)) + 1; logBytes += bytes;
  const oldBytes = Buffer.byteLength(JSON.stringify({ commitId: record.commitId, operationId: record.operationId,
    files: { "task.json": JSON.stringify(state) }, events: record.effects?.events ?? [], outputs: [] }, null, 2));
  if (record.operationId) { ids.push(record.operationId); allLogicalLegacyBytes += oldBytes; }
  for (const item of record.effects?.events ?? []) if (item.value?.eventId) events.push(item.value.eventId);
  if (/:(?:pre|post)$/u.test(record.operationId ?? "")) {
    assert.ok(!record.changes.some(change => change.path.length === 1 && change.path[0] === "assessments"
      && !(change.op === "set" && Object.keys(change.value).length === 1 && Object.hasOwn(change.value, record.operationId))),
      "A normal hook must never replace the historical dictionary");
    ordinary.push({ sequence, operationId: record.operationId, bytes, legacyFullStateBytes: oldBytes,
      fileProjections: record.effects.fileNames?.length ?? 0, outputReferences: record.effects.outputs?.length ?? 0 });
    logicalHookLegacyBytes += oldBytes; logicalHookDeltaBytes += bytes;
  }
}
assert.equal(new Set(ids).size, ids.length); assert.equal(new Set(events).size, events.length);
assert.deepEqual(await journal.decode(encoded), loaded.state);
const nativeFiles = (await files(path.join(root, "agents/main/sessions"))).filter(file => file.endsWith(".jsonl"));
const calls = [], modelRequests = [], commandResults = [];
for (const file of nativeFiles) {
  for (const line of (await fs.readFile(file, "utf8")).split("\n").filter(Boolean)) {
    const entry = JSON.parse(line), message = entry.message;
    if (message?.role === "assistant" && message.usage?.totalTokens > 0) modelRequests.push({
      id: entry.id, provider: message.provider, model: message.model, usage: message.usage,
      stopReason: message.stopReason });
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block.type === "toolCall") calls.push({ id: block.id, name: block.name,
        ...(block.name === "exec" ? { command: block.arguments?.command, workdir: block.arguments?.workdir } : {}) });
    }
    if (message?.role === "toolResult" && message.toolName === "exec") commandResults.push({
      toolCallId: message.toolCallId, isError: message.isError, exitCode: message.details?.exitCode,
      stdout: (message.content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n") });
  }
}
const nativeReviewRuns = [];
for (const file of (await files(path.join(report.workspace, ".runtime-correction/openclaw/native-runs"))).filter(file => file.endsWith(".json"))) {
  const item = JSON.parse(await fs.readFile(file));
  nativeReviewRuns.push({ role: item.role, phase: item.phase, runId: item.runId, sessionId: item.sessionId, status: item.status,
    elapsedMs: item.settledAt ? item.settledAt - item.startedAt : null });
}
const journalEvents = (await fs.readFile(path.join(taskDir, "journal/events.jsonl"), "utf8"))
  .split("\n").filter(Boolean).map(JSON.parse);
const reviewerEnvelopes = journalEvents.filter(item => item.type === "REVIEWER_ENVELOPE")
  .map(item => ({ role: item.role, phase: item.phase, envelope: item.reviewerEnvelope }));
const reviewFailures = journalEvents.filter(item => ["REVIEWER_RUNTIME_FAILED", "STOP_ASSESSMENT_RETRY", "NATIVE_STOP_REVIEW_RETRY"].includes(item.type))
  .map(item => ({ type: item.type, role: item.role, failureCode: item.failureCode,
    reason: item.reason, attempt: item.attempt ?? item.failureAttempt }));
const stopDecisions = Object.entries(loaded.state.assessments ?? {}).filter(([id]) => id.includes(":stop"))
  .map(([operationId, entry]) => ({ operationId, status: entry.verification?.status,
    evaluationId: entry.verification?.evaluationId, decision: entry.result?.decision,
    requirementVersion: entry.verification?.requirementVersion }));
const publicReport = await readReport({ workspaceDir: report.workspace, sessionId: report.sessionId,
  sessionKey: "agent:main:file-transaction-todo-live" });
const observations = ordinary.filter(row => !row.fileProjections && !row.outputReferences);
const sortedBytes = observations.map(row => row.bytes).sort((a, b) => a - b);
const retained = await files(journal.root);
const retainedBytes = (await Promise.all(retained.map(file => fs.stat(file)))).reduce((sum, stat) => sum + stat.size, 0);
const blobs = retained.filter(file => file.includes("/blobs/")).map(file => path.basename(file, ".json"));
const blobBytes = await Promise.all(blobs.map(id => fs.stat(journal.file("blobs", `${id}.json`)).then(stat => stat.size)));
const references = new Map();
function countReferences(value) {
  if (!value || typeof value !== "object") return;
  if (value.$journalBlob) references.set(value.$journalBlob, (references.get(value.$journalBlob) ?? 0) + 1);
  for (const item of Object.values(value)) countReferences(item);
}
for (const record of records) countReferences(record);
for (const file of retained.filter(file => file.includes("/checkpoints/"))) countReferences(JSON.parse(await fs.readFile(file)));
assert.equal(blobs.length, new Set(blobs).size);
const sourceHashes = {};
for (const name of ["lib/openclaw/runtime.mjs", "lib/openclaw/report.mjs", "lib/runtime-v2/task-store.mjs", "lib/runtime-v2/utils.mjs"]) {
  const source = await fs.readFile(path.join(sourceRoot, name)), installed = await fs.readFile(path.join(root, "extensions/runtime-corrector", name));
  assert.deepEqual(installed, source, `The final test artifact must match production source: ${name}`);
  sourceHashes[name] = createHash("sha256").update(source).digest("hex");
}
const summary = { ...Object.fromEntries(["hostVersion", "pluginVersion", "branch", "root", "workspace", "sessionId", "taskId",
  "workModel", "reviewModel", "gatewayUsed", "replacementReviewer", "originalProfileTouched", "testInstrumentation", "harnessAdjustments", "checks", "passed", "error"].map(key => [key, report[key]])),
  phases: report.phases.map(phase => ({ name: phase.name, runId: phase.runId, completion: phase.completion,
    receipt: phase.receipt, boundary: phase.boundary, verification: phase.verification, note: phase.note, startedAt: phase.startedAt, finishedAt: phase.finishedAt })),
  sourceHashes,
  native: { modelRequests, tools: calls, execResults: commandResults, reviewRuns: nativeReviewRuns,
    reviewerEnvelopes, reviewFailures, stopDecisions },
  verification: { state: loaded.state.verification.status, userVisible: publicReport.verification,
    rulesBound: Boolean(loaded.state.verification.rulesDigest),
    sourceFingerprints: Object.keys(loaded.state.verification.evidence?.fingerprints ?? {}),
    taskStatus: loaded.state.status, projectionsPending: loaded.state.projectionPending },
  journal: { versions: loaded.head.sequence, ordinaryHooks: ordinary,
    observationOnly: { count: observations.length, min: sortedBytes[0], max: sortedBytes.at(-1),
      median: sortedBytes[Math.floor(sortedBytes.length / 2)], first: observations[0], last: observations.at(-1) },
    deltaLogBytes: logBytes,
    retainedFiles: retained.length, retainedBytes, checkpoints: retained.filter(file => file.includes("/checkpoints/")).length,
    logicalHookLegacyBytes, logicalHookDeltaBytes, allLogicalCommitsLegacyFullStateBytes: allLogicalLegacyBytes,
    legacyLogicalCommitFiles: ids.length,
    legacyEstimation: "Same recovered state serialized into each logical decision's immutable commit. Excludes additional legacy files and outputs; v3 metadata/ack versions are not treated as old immutable commits. No large old files are created.",
    duplicateOperationIds: ids.length - new Set(ids).size, duplicateCommittedEventIds: events.length - new Set(events).size,
    stateEqualsAuditReplay: true, journalRecoveryMs: recoveries,
    blobs: { uniqueFiles: blobs.length, bytes: blobBytes.reduce((sum, bytes) => sum + bytes, 0),
      largestBytes: Math.max(0, ...blobBytes), references: [...references.values()].reduce((sum, count) => sum + count, 0),
      mostReferencesToOneBlob: Math.max(0, ...references.values()) } },
  stateProjectionIo: report.stateProjectionIo };
assert.ok(modelRequests.length > 0 && nativeReviewRuns.some(item => item.role === "stop-reviewer"));
if (report.passed) assert.equal(summary.verification.userVisible, "PASS");
const sanitize = value => typeof value === "string" ? value.replaceAll(report.workspace, "$WORKSPACE").replaceAll(root, "$TEST_ROOT") : value;
const text = JSON.stringify(summary, (key, value) => sanitize(value), 2) + "\n";
assert.ok(!/\b(?:ark-|sk-)[a-z0-9_-]{25,}/iu.test(text), "Possible credential in synthetic evidence");
assert.ok(!/\b[a-f0-9]{32}\.[a-z0-9]{12,}\b/iu.test(text), "Possible provider credential in synthetic evidence");
await fs.writeFile(path.resolve(output), text);
console.log(JSON.stringify({ passed: report.passed, verification: summary.verification,
  modelRequests: modelRequests.length, reviewRuns: nativeReviewRuns.length, journal: {
    versions: loaded.head.sequence, hooks: ordinary.length, retainedFiles: retained.length, retainedBytes,
    logicalHookLegacyBytes, logicalHookDeltaBytes, recoveryMs: recoveries } }));
