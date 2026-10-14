import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileTransactionJournal, stateDelta, applyDelta } from "../lib/runtime-v2/transaction-journal.mjs";
import { ensureTask, findTask, withTaskState, withTaskDecision, taskDirectory, appendTaskJournal, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson, readJson } from "../lib/runtime-v2/utils.mjs";
import { persistResult } from "../lib/result-store.mjs";

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-file-journal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function journalFixture(t, options = {}) {
  const root = await directory(t);
  const journal = new FileTransactionJournal(root, options);
  await journal.initialize({ current: {}, assessments: { seed: { result: "R".repeat(500_000) } }, history: [] });
  return { root, journal, loaded: await journal.load() };
}
async function taskFixture(t) {
  const root = await directory(t);
  const state = await ensureTask({ projectRoot: root, sessionId: "s", explicitTaskId: "task" });
  const target = { projectRoot: root, taskId: state.taskId };
  const current = () => findTask({ ...target, explicitTaskId: state.taskId });
  return { root, target, current, directory: taskDirectory(root, state.taskId) };
}

test("dictionary changes and array append/edit/truncate never replace growing history", () => {
  const before = JSON.parse('{"assessments":{"seed":{"result":"large"}},"history":[1,2],"__proto__":{"x":1}}');
  const after = JSON.parse('{"assessments":{"seed":{"result":"large"},"a/b":{"result":"new"}},"history":[1,3,4],"__proto__":{"x":2}}');
  const delta = stateDelta(before, after);
  assert(!delta.some(item => item.op === "set" && ["assessments", "history"].includes(item.path.join("/"))));
  assert.deepEqual(applyDelta(structuredClone(before), delta), after);
  assert.deepEqual(applyDelta(after, stateDelta(after, { ...after, history: [1] })), { ...after, history: [1] });
  assert.equal({}.x, undefined);
});

test("ordinary commits stay bounded; one large body shared across results, files and outputs", async t => {
  const { journal } = await journalFixture(t, { checkpointEvery: 10 });
  let loaded = await journal.load(), sizes = [];
  for (let i = 1; i <= 40; i++) {
    const state = structuredClone(loaded.state);
    state.assessments[`operation-${i}`] = { sequence: i, metadata: "M".repeat(300) };
    state.history.push({ sequence: i });
    loaded = await journal.publish(loaded, state, { events: [{ sequence: i }] }, { operationId: `operation-${i}` });
    sizes.push(Buffer.byteLength(JSON.stringify(loaded.commit)));
    await journal.compact(loaded);
  }
  assert(Math.max(...sizes) - Math.min(...sizes) < 150);
  const result = { body: "R".repeat(500_000) };
  const state = structuredClone(loaded.state); state.assessments.report = { result };
  loaded = await journal.publish(loaded, state, { result, files: { "evaluation.json": JSON.stringify({ result }) }, outputs: [{ result }] });
  const largeBlobs = [];
  for (const name of await fs.readdir(journal.file("blobs"))) if ((await fs.stat(journal.file("blobs", name))).size > 400_000) largeBlobs.push(name);
  assert.equal(largeBlobs.length, 1);
  assert.deepEqual((await journal.effects(loaded.head.sequence)).result, result);
  assert.deepEqual(JSON.parse((await journal.effects(loaded.head.sequence)).files["evaluation.json"]), { result });
  assert((await fs.readdir(journal.file("checkpoints"))).length <= 2);
  assert.equal((await journal.load()).state.assessments.report.result.body.length, 500_000);
});

for (const phase of ["commit-written", "published", "projected"]) test(`interruption at ${phase} observes only published commits`, async t => {
  const { journal, loaded, root } = await journalFixture(t);
  const state = structuredClone(loaded.state); state.current.version = 1;
  journal.fault = async point => { if (point === phase) throw new Error("crash"); };
  await assert.rejects(journal.publish(loaded, state, { events: [{ id: "event" }], outputs: [{ id: "output" }] }, { operationId: "one" }), /crash/);
  const restarted = new FileTransactionJournal(root);
  const recovered = await restarted.load();
  assert.equal(recovered.head.sequence, phase === "commit-written" ? 0 : 1);
  assert.equal(recovered.state.current.version, phase === "commit-written" ? undefined : 1);
  await restarted.cleanup();
  if (phase === "commit-written") assert.equal((await fs.readdir(restarted.file("log"))).length, 0);
  else assert.deepEqual((await restarted.effects(1)).outputs, [{ id: "output" }]);
});

for (const phase of ["audit-written", "checkpoint-written", "checkpoint-published", "logs-reclaimed"]) test(`checkpoint interruption at ${phase} preserves recovery and audit`, async t => {
  const { journal, root } = await journalFixture(t, { checkpointEvery: 2 });
  let loaded = await journal.load();
  for (let i = 1; i <= 2; i++) loaded = await journal.publish(loaded, { ...loaded.state, current: { i } }, { events: [{ i }] });
  journal.fault = async point => { if (point === phase) throw new Error("crash"); };
  await assert.rejects(journal.compact(loaded), /crash/);
  const restarted = new FileTransactionJournal(root, { checkpointEvery: 2 });
  const recovered = await restarted.load();
  assert.equal(recovered.state.current.i, 2);
  await restarted.compact(recovered); await restarted.cleanup();
  assert((await fs.readdir(restarted.file("checkpoints"))).length <= 2);
  assert.equal((await fs.readdir(restarted.file("log"))).length, 0);
  assert.deepEqual((await restarted.effects(1)).events, [{ i: 1 }]);
  assert.deepEqual((await restarted.effects(2)).events, [{ i: 2 }]);
});

test("torn unpublished tail is ignored; a damaged published delta fails closed", async t => {
  const { journal, loaded } = await journalFixture(t);
  await journal.publish(loaded, { ...loaded.state, current: { version: 1 } });
  await fs.writeFile(journal.file("log", "000000000002.json"), '{"changes":');
  await fs.writeFile(journal.file("log", "000000000002.json.tmp"), '{');
  assert.equal((await journal.load()).state.current.version, 1);
  await journal.cleanup();
  await assert.rejects(fs.access(journal.file("log", "000000000002.json")), /ENOENT/);
  const recordPath = journal.file("log", "000000000001.json");
  const original = await fs.readFile(recordPath, "utf8");
  const corrupt = JSON.parse(original); corrupt.changes[0].value = 999;
  await fs.writeFile(recordPath, JSON.stringify(corrupt));
  await assert.rejects(journal.load(), /checksum/);
  await fs.writeFile(recordPath, original.slice(0, -20));
  await assert.rejects(journal.load(), SyntaxError);
});

test("invalid newest checkpoint falls back to previous checkpoint plus retained audit", async t => {
  const { journal } = await journalFixture(t, { checkpointEvery: 1 });
  let loaded = await journal.load();
  for (let i = 1; i <= 3; i++) {
    loaded = await journal.publish(loaded, { ...loaded.state, current: { i } }); await journal.compact(loaded);
  }
  await fs.writeFile(journal.file("checkpoints", "000000000003.json"), '{');
  assert.equal((await journal.load()).state.current.i, 3);
  const segment = journal.file("audit", "3-3.jsonl");
  await fs.appendFile(segment, '{"sequence":4');
  assert.equal((await journal.load()).state.current.i, 3, "uncommitted audit suffix is ignored");
});

test("migration retains full legacy audit as deltas and recovers legacy pending output first", async t => {
  const root = await directory(t), dir = taskDirectory(root, "legacy");
  await fs.mkdir(path.join(dir, "transactions"), { recursive: true });
  const old = { taskId: "legacy", sessionIds: ["s"], groundTruth: { version: 0 }, correctionEpoch: { id: 1 }, assessments: {} };
  const giant = { result: { text: "R".repeat(100_000) } };
  const a = { ...old, assessments: { a: giant } };
  const b = { ...old, assessments: { a: giant, b: { result: { ok: true } } }, decisionCommitId: "b", projectionPending: true };
  await atomicWriteJson(path.join(dir, "task.json"), b);
  for (const [id, state] of [["a", a], ["b", b]]) await atomicWriteJson(path.join(dir, "transactions", `${id}.json`), {
    commitId: id, assessmentId: id, result: state.assessments[id].result,
    files: { "task.json": JSON.stringify(state), "evaluations/legacy.json": JSON.stringify({ ok: true }) },
    events: [{ file: "journal/events.jsonl", value: { eventId: `${id}:0`, type: "LEGACY" } }], outputs: [],
  });
  await withTaskState({ projectRoot: root, taskId: "legacy" }, () => {});
  const journal = new FileTransactionJournal(dir);
  const recovered = await journal.load();
  assert.deepEqual(recovered.state.assessments, b.assessments);
  assert.equal(recovered.state.projectionPending, false);
  assert.deepEqual(await readJson(path.join(dir, "evaluations/legacy.json")), { ok: true });
  const lines = (await fs.readFile(journal.file("audit", "legacy-000000000000.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert(lines.every(record => record.publication === "confirmed"));
  let state = {}; for (const line of lines) state = applyDelta(state, line.changes);
  assert.deepEqual((await journal.decode(state)).assessments, b.assessments);
  assert.deepEqual((await journal.decode(lines[0].effects)).result, giant.result);
  assert((await fs.stat(journal.file("audit", "legacy-000000000000.jsonl"))).size < 4000);
  await assert.rejects(fs.access(journal.file("a.json")), /ENOENT/);
  await assert.rejects(fs.access(journal.file("b.json")), /ENOENT/);
});

test("published decision recovers torn event, failed output and deleted task projection; duplicate returns original result", async t => {
  const f = await taskFixture(t);
  const result = { status: "passed", metadata: { stage: "test", artifactType: "text", triggerFile: "artifact.txt", artifactFiles: ["artifact.txt"], ruleSetIds: [],
    generatedAt: "2026-10-14T00:00:00Z", roundId: "20261014T000000Z-12345678" }, diagnostics: [], diffs: [] };
  const context = { kind: "hook", assessmentId: "one", guard: decisionGuard(await f.current()) };
  let calculations = 0, blocked;
  await assert.rejects(withTaskDecision({ ...f.target, context }, async () => {
    calculations++;
    await appendTaskJournal(f.root, "task", { type: "OPERATION_OBSERVED" });
    await atomicWriteJson(path.join(f.directory, "evaluations", "one.json"), { result });
    const outputs = await persistResult({ result, output: { persist: true, mode: "centralized" }, cwd: f.root, triggerFile: path.join(f.root, "artifact.txt") });
    blocked = outputs.roundFiles.find(file => file.endsWith("result.json"));
    await fs.mkdir(blocked, { recursive: true });
    return result;
  }), /EISDIR/);
  assert.equal((await f.current()).projectionPending, true);
  assert.deepEqual(await readJson(path.join(f.directory, "evaluations", "one.json")), { result });
  const journalFile = path.join(f.directory, "journal", "events.jsonl");
  await fs.writeFile(journalFile, '{"eventId":');
  await fs.rm(path.join(f.directory, "task.json"));
  await fs.rm(blocked, { recursive: true });
  const duplicate = await withTaskDecision({ ...f.target, context }, () => { calculations++; return { wrong: true }; });
  assert.deepEqual(duplicate, result); assert.equal(calculations, 1);
  assert.equal((await f.current()).projectionPending, false);
  assert.equal((await fs.readFile(journalFile, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(blocked, "utf8")), result);
  const journal = new FileTransactionJournal(f.directory), loaded = await journal.load();
  const operations = [];
  for (let seq = 1; seq <= loaded.head.sequence; seq++) { const record = await journal.readRecord(seq); if (record.operationId === "one") operations.push(record); }
  assert.equal(operations.length, 1);
  assert.equal(operations[0].effects.outputs.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, "task.json"), "utf8")), loaded.state);
});

test("concurrent duplicate operations and stale/cancelled decisions preserve guards", async t => {
  const f = await taskFixture(t);
  const context = { assessmentId: "same", kind: "hook", guard: decisionGuard(await f.current()) };
  const calculate = async () => { await appendTaskJournal(f.root, "task", { type: "ONCE" }); return { ok: true }; };
  const results = await Promise.all([withTaskDecision({ ...f.target, context }, calculate), withTaskDecision({ ...f.target, context }, calculate)]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal((await fs.readFile(path.join(f.directory, "journal", "events.jsonl"), "utf8")).trim().split("\n").length, 1);
  const guard = decisionGuard(await f.current());
  await withTaskState(f.target, state => { state.control = { cancelEpoch: 1 }; });
  const stale = await withTaskDecision({ ...f.target, context: { assessmentId: "stale", guard } }, () => assert.fail("must not calculate"));
  assert.equal(stale.reason, "cancelEpoch");
  assert.equal((await f.current()).assessments.stale, undefined);
});

test("task readers recover publication interrupted before any current-state/file projection", async t => {
  const f = await taskFixture(t);
  const project = FileTransactionJournal.prototype.project;
  FileTransactionJournal.prototype.project = async function () { throw new Error("projection crash"); };
  t.after(() => { FileTransactionJournal.prototype.project = project; });
  const context = { assessmentId: "published", kind: "hook" }, result = { status: "committed" };
  let calculations = 0;
  await assert.rejects(withTaskDecision({ ...f.target, context }, async () => {
    calculations++;
    await atomicWriteJson(path.join(f.directory, "evaluations", "published.json"), result);
    return result;
  }), /projection crash/);
  const committed = await f.current();
  const projection = JSON.parse(await fs.readFile(path.join(f.directory, "task.json"), "utf8"));
  assert(committed.journalSequence > projection.journalSequence);
  assert.deepEqual(await readJson(path.join(f.directory, "evaluations", "published.json")), result);
  FileTransactionJournal.prototype.project = project;
  assert.deepEqual(await withTaskDecision({ ...f.target, context }, () => { calculations++; }), result);
  assert.equal(calculations, 1);
  assert.equal((await f.current()).projectionPending, false);
});

test("migration interruption after publication safely resumes legacy-file reclamation", async t => {
  const root = await directory(t), journal = new FileTransactionJournal(root, { fault: async phase => { if (phase === "migration-published") throw new Error("crash"); } });
  const state = { assessments: { one: { result: { body: "R".repeat(10000) } } } };
  await fs.mkdir(journal.root, { recursive: true });
  await fs.writeFile(journal.file("one.json"), JSON.stringify({ commitId: "one", assessmentId: "one", files: { "task.json": JSON.stringify(state) }, events: [], outputs: [] }));
  await assert.rejects(journal.initialize(state), /crash/);
  assert.deepEqual((await new FileTransactionJournal(root).load()).state, state);
  await fs.access(journal.file("one.json"));
  await new FileTransactionJournal(root).cleanup();
  await assert.rejects(fs.access(journal.file("one.json")), /ENOENT/);
  const audit = JSON.parse((await fs.readFile(journal.file("audit", "legacy-000000000000.jsonl"), "utf8")).trim());
  assert.equal(audit.operationId, "one");
});

test("valid JSON projection corruption is ignored, and dictionary reordering is harmless", async t => {
  const f = await taskFixture(t), file = path.join(f.directory, "task.json");
  const projected = JSON.parse(await fs.readFile(file, "utf8"));
  projected.status = "WRONG";
  await fs.writeFile(file, JSON.stringify(projected));
  assert.equal((await f.current()).status, "ACTIVE");
  await withTaskState(f.target, () => {});
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).status, "ACTIVE");
  const journal = new FileTransactionJournal(await directory(t));
  await journal.initialize({ current: { a: 1, b: 2 }, assessments: {} });
  const loaded = await journal.load();
  await journal.publish(loaded, { assessments: {}, current: { b: 2, a: 1 } });
  assert.deepEqual((await journal.load()).state, { current: { a: 1, b: 2 }, assessments: {} });
});

test("serialization reproduces quadratic legacy growth and linear deltas even with a large seed", async () => {
  const { serializedComparison } = await import("../scripts/benchmark-file-transactions.mjs");
  const rows = [100, 200, 400].map(N => serializedComparison(N, 0));
  assert(rows[1].oldTransactionBytes / rows[0].oldTransactionBytes > 3.8);
  assert(rows[2].oldTransactionBytes / rows[1].oldTransactionBytes > 3.8);
  assert(rows[2].newDeltaBytes / rows[0].newDeltaBytes < 4.1);
  const large = serializedComparison(200, 100_000);
  assert.equal(large.oldTransactionBytes - rows[1].oldTransactionBytes, 200 * 100_000);
  assert.equal(large.newDeltaBytes, rows[1].newDeltaBytes);
});

test("growing JSON history in other projected files is incremental and historical versions survive compaction", async t => {
  const root = await directory(t), journal = new FileTransactionJournal(root, { checkpointEvery: 5 });
  await journal.initialize({ current: 0 });
  let loaded = await journal.load(), mirror = { observations: [], assessments: {} }, sizes = [];
  for (let i = 1; i <= 30; i++) {
    mirror.observations.push({ i, metadata: "M".repeat(300) }); mirror.assessments[`op-${i}`] = { i };
    loaded = await journal.publish(loaded, { current: i }, { files: { "mirror.json": JSON.stringify(mirror) } });
    sizes.push(Buffer.byteLength(JSON.stringify(loaded.commit)));
    await journal.compact(loaded);
  }
  // The first commit initializes this previously unknown projection.
  assert(Math.max(...sizes.slice(1)) - Math.min(...sizes.slice(1)) < 80, JSON.stringify(sizes));
  const first = JSON.parse((await journal.effects(1)).files["mirror.json"]);
  const last = JSON.parse((await journal.effects(30)).files["mirror.json"]);
  assert.equal(first.observations.length, 1); assert.deepEqual(last, mirror);
  assert((await fs.readdir(journal.file("checkpoints"))).length <= 2);
});

test("byte threshold checkpoints before the count threshold", async t => {
  const root = await directory(t), journal = new FileTransactionJournal(root, { checkpointEvery: 10000, checkpointBytes: 1 });
  await journal.initialize({ current: 0 });
  const loaded = await journal.publish(await journal.load(), { current: 1 });
  await journal.compact(loaded);
  assert.equal((await journal.head()).checkpoint, 1);
  assert.equal((await fs.readdir(journal.file("log"))).length, 0);
  assert.equal((await journal.load()).state.current, 1);
});

test("metadata-only task refresh does not stale an in-flight decision; a session attachment is preserved", async t => {
  const f = await taskFixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const before = await f.current();
  const running = withTaskDecision({ ...f.target, context: { kind: "hook", assessmentId: "refresh" } }, async () => {
    entered(); await wait; return { ok: true };
  });
  await started;
  const touched = await ensureTask({ ...f.target, sessionId: "s", explicitTaskId: "task", now: "2026-10-14T01:00:00Z" });
  assert.equal(touched.revision, before.revision);
  release(); assert.deepEqual(await running, { ok: true });
  const committed = await f.current();
  assert.equal(committed.revision, (before.revision ?? 0) + 1);
  await ensureTask({ ...f.target, sessionId: "another-session", explicitTaskId: "task" });
  await fs.rm(path.join(f.directory, "task.json"));
  assert.deepEqual((await f.current()).sessionIds, ["s", "another-session"]);
});

test("new-format report reads committed evidence and torn event tails before projection recovery", async t => {
  const { readReport } = await import("../lib/openclaw/report.mjs");
  const f = await taskFixture(t), project = FileTransactionJournal.prototype.project;
  FileTransactionJournal.prototype.project = async function () { throw new Error("projection crash"); };
  t.after(() => { FileTransactionJournal.prototype.project = project; });
  await assert.rejects(withTaskDecision({ ...f.target, context: { kind: "hook", assessmentId: "report" } }, async () => {
    await withTaskState(f.target, state => { state.verification = { evaluationId: "report", status: "UNVERIFIED" }; });
    await atomicWriteJson(path.join(f.directory, "evaluations", "report.json"), { evaluationId: "report", status: "PASS" });
    await appendTaskJournal(f.root, "task", { type: "REPORT_READY" });
    return { ok: true };
  }), /projection crash/);
  FileTransactionJournal.prototype.project = project;
  await fs.mkdir(path.join(f.directory, "journal"), { recursive: true });
  await fs.writeFile(path.join(f.directory, "journal", "events.jsonl"), '{"eventId":');
  const report = await readReport({ workspaceDir: f.root, sessionId: "s" });
  assert.deepEqual(report.assessment, { evaluationId: "report", status: "PASS" });
  const revision = (await f.current()).revision;
  await withTaskState(f.target, () => {});
  assert.equal((await f.current()).revision, revision, "recovery acknowledgement is not a new business revision");
});

test("durable atomic writes preserve transient rename retries", async t => {
  const { durableWrite } = await import("../lib/runtime-v2/transaction-journal.mjs");
  const root = await directory(t), rename = fs.rename;
  let retries = 0;
  fs.rename = async (...args) => {
    if (retries++ === 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return rename(...args);
  };
  t.after(() => { fs.rename = rename; });
  const file = path.join(root, "atomic.json");
  try { await durableWrite(file, '{"ok":true}'); }
  finally { fs.rename = rename; }
  assert.equal(retries, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { ok: true });
  assert.deepEqual(await fs.readdir(root), ["atomic.json"]);
});

test("ensureTask inside a decision stays staged and is discarded when cancellation wins", async t => {
  const f = await taskFixture(t), journal = new FileTransactionJournal(f.directory);
  const initialVersion = (await journal.head()).sequence;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const guard = decisionGuard(await f.current());
  const running = withTaskDecision({ ...f.target, context: { kind: "hook", assessmentId: "cancel-staged-ensure", guard } }, async () => {
    await ensureTask({ ...f.target, sessionId: "candidate-session", explicitTaskId: "task" });
    entered(); await wait; return { ok: true };
  });
  await started;
  assert.equal((await journal.head()).sequence, initialVersion);
  assert.deepEqual((await f.current()).sessionIds, ["s"]);
  await withTaskState(f.target, state => { state.control = { cancelEpoch: 1 }; });
  release(); assert.equal((await running).reason, "cancelEpoch");
  assert.deepEqual((await f.current()).sessionIds, ["s"]);
  assert.equal((await f.current()).assessments?.["cancel-staged-ensure"], undefined);
});

test("JSON projection formatting and reserved user keys round-trip without full history replacement", async t => {
  const root = await directory(t), journal = new FileTransactionJournal(root);
  let state = { assessments: { $journalLiteral: { result: "user data" } } };
  await journal.initialize(state);
  let loaded = await journal.load();
  const pretty = JSON.stringify({ history: [1, 2], result: { text: "R".repeat(10000) } }, null, 2) + "\n";
  const tabbed = JSON.stringify({ nested: { value: "text" } }, null, "\t").replaceAll("\n", "\r\n") + "\r\n";
  const unusual = '{ "x" : 1, "x" : 2 }';
  state = structuredClone(state); state.assessments.next = { result: "new" };
  loaded = await journal.publish(loaded, state, { files: { "pretty.json": pretty, "tabbed.json": tabbed, "unusual.json": unusual } });
  assert(!loaded.commit.changes.some(change => change.op === "set" && change.path.length <= 1));
  assert.deepEqual((await journal.load()).state, state);
  const effects = await journal.effects(1);
  assert.equal(effects.files["pretty.json"], pretty);
  assert.equal(effects.files["tabbed.json"], tabbed);
  assert.equal(effects.files["unusual.json"], unusual);
});
