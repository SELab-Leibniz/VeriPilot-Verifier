import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { startRoleReviewer, STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask, taskDirectory, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson, sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc scoped cli 空 格-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "business-host" });
  const claims = [{ claimId: "R1", revisionId: "R1@1", category: "requirements", text: "Check the exact original execution result.",
    status: "ACTIVE", severity: "HARD", authority: "USER_EXPLICIT" }];
  const groundTruth = { version: 1, digest: sha256(claims), claims };
  const groundTruthPath = path.join(taskDirectory(root, task.taskId), "ground-truth/current.json");
  await atomicWriteJson(groundTruthPath, groundTruth);
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => {
    state.groundTruth.version = 1; state.groundTruth.digest = groundTruth.digest;
  });
  const population = { version: 1, groundTruthVersion: 1, metrics: { M01: [{ objectId: "M01:R1", metricId: "M01",
    sourceId: "R1", sourceRevisionId: "R1@1", description: claims[0].text }] } };
  const entry = path.join(root, "fake reviewer.cjs"), capture = path.join(root, "capture.jsonl");
  const foreign = path.join(root, ".runtime-correction/.internal-requests/foreign/review-scope/foreign.txt");
  await fs.mkdir(path.dirname(foreign), { recursive: true });
  await fs.writeFile(foreign, "Another review's private evidence, never owned by this session.\n");
  await fs.writeFile(entry, String.raw`
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const requestPath = args[0].match(/Read the request at (.*)\.\n/)[1];
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const records = descriptor => {
  const index = read(descriptor.path);
  return index.kind === "records" ? index.records : index.pages.flatMap(records);
};
let ref;
if (process.env.REF_MODE === "request") ref = requestPath + "#L1-L1";
else if (process.env.REF_MODE === "foreign") ref = process.env.FOREIGN_REF + "#L1-L1";
else if (process.env.REF_MODE === "truth") ref = request.groundTruthPath + "#L1-L1";
else {
  const transcript = read(request.transcript.path);
  const result = records(transcript.entryIndex).find(entry => entry.key === "result-1");
  for (const part of records(result.source)) {
    const lines = fs.readFileSync(part.path, "utf8").split("\n"), line = lines.findIndex(text => text.includes("CONTROLLED_END"));
    if (line >= 0) { ref = part.path + "#L" + (line + 1) + "-L" + (line + 1); break; }
  }
  if (!ref) throw new Error("Original execution evidence is unavailable.");
}
fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ args, requestPath, ref, request }) + "\n");
process.stdout.write(JSON.stringify({session_id:process.env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID,structured_output:{
  summary:"Compared the assigned original evidence.",stopClassification:"TASK_COMPLETE",stage:null,findings:[],
  metricObjectJudgements:Object.values(request.population.metrics).flat().map(object => ({objectId:object.objectId,
    judgement:"PASS",reason:"Observed the selected original source.",evidence:[ref]}))
}}));
`);
  const snapshot = { digest: "captured-evidence", lastEntryKey: "result-1", entries: [
    { type: "user", uuid: "user-1", message: { content: "Check the current original result." } },
    { type: "assistant", uuid: "call-1", message: { content: [{ type: "tool_use", id: "exec-1", name: "exec", input: { command: "controlled-check" } }] } },
    { type: "user", uuid: "result-1", message: { content: [{ type: "tool_result", tool_use_id: "exec-1", content: "Original bytes 中文🌻\n".repeat(3000) + "CONTROLLED_END" }] } },
  ] };
  const factory = options => startRoleReviewer({ ...options, reviewerRuntime: { executable: process.execPath, argsPrefix: [entry] },
    env: { ...process.env, RUNTIME_CORRECTOR_AGENT_EXECUTABLE: undefined, CAPTURE: capture, REF_MODE: mode, FOREIGN_REF: foreign } });
  const run = () => collectReviewItems({ projectRoot: root, taskId: task.taskId, parentSessionId: "business-host", sessionCwd: root,
    role: "stop-reviewer", reviewerFactory: factory, reviewer: { effort: "low", timeoutMs: 5000, formatRepairAttempts: 0 }, schema: STOP_REVIEW_SCHEMA,
    classification: { stopClassification: "TASK_COMPLETE", stage: null }, deadlineAt: Date.now() + 20000,
    request: { groundTruthPath, population }, evidence: { groundTruth, population, snapshot } });
  return { root, run, groundTruthPath, groundTruth, capture };
}

for (const mode of ["page", "truth"]) test(`scoped CLI collector durably binds its own ${mode} citation before native process cleanup`, async t => {
  const f = await fixture(t, mode), result = await f.run();
  assert.equal(result.collection.complete, true, JSON.stringify(result.collection.failures));
  assert.equal(result.result.metricObjectJudgements[0].judgement, "PASS");
  const [citation] = result.sourceCitations;
  assert.equal(citation.frozen, true);
  assert.deepEqual(citation.usedBy, ["M01:R1"]);
  const source = await fs.readFile(citation.snapshotPath);
  assert.equal(sha256(source), citation.contentHash);
  assert.equal(source.toString("utf8").split("\n").slice(citation.start - 1, citation.end).join("\n"), citation.exactQuote);
  if (mode === "page") assert.match(citation.exactQuote, /CONTROLLED_END/u);
  const call = JSON.parse((await fs.readFile(f.capture, "utf8")).trim());
  assert(!call.args.includes("--resume")); assert(!call.args.includes("--fork-session"));
  assert.equal(call.request.transcript.paged, true);
  await assert.rejects(fs.access(path.dirname(call.requestPath)), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await fs.readFile(f.groundTruthPath, "utf8")), f.groundTruth);
});

for (const mode of ["request", "foreign"]) test(`scoped CLI collector rejects ${mode} private citations without program evidence ownership`, async t => {
  const f = await fixture(t, mode), result = await f.run();
  assert.equal(result.collection.complete, false);
  assert.equal(result.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  assert.equal(result.collection.failures[0].code, "REVIEW_ITEM_EVIDENCE_INVALID", JSON.stringify(result.collection.failures));
  assert.deepEqual(result.sourceCitations, []);
});
