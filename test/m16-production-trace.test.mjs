import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { validateProductionTrace } from "../lib/review-task/production-trace.mjs";
import { captureFiles, registerCitation, runReviewTask, validateDecision } from "../lib/review-task/review-task.mjs";
import { nativeTools } from "./helpers/native-task.mjs";

const stateless = () => ({ version: 1, entryPoint: "preview(input)", actualInput: "Caller input is returned",
  producerToConsumer: "The caller's argument flows directly through preview to its return value.", stateful: false,
  statelessReason: "The function returns its argument and accesses no shared or persisted state.", stateTargets: [], targetRelations: [] });
const stateful = () => ({ ...stateless(), stateful: true, statelessReason: "",
  stateTargets: [
    { id: "business", expression: "resolve(input.path)", readers: ["load(resource)"], writers: ["save(resource, items)"], producerValue: "items array", citeIds: ["source"] },
    { id: "auxiliary", expression: "resolve(input.auxiliaryPath)", readers: [], writers: ["save(auxiliary, metadata)"], producerValue: "metadata object", citeIds: ["source"] },
  ], targetRelations: [{ left: "business", right: "auxiliary", identity: "MAY_ALIAS",
    overlapAttempt: "The allowed inputs can select the same resource.", effect: "BREAKS_REQUIRED_FLOW",
    explanation: "The final auxiliary write replaces the value consumed by load.", citeIds: ["source"] }] });

test("production trace preserves identity uncertainty and does not turn a known broken flow into PASS", () => {
  assert.throws(() => validateProductionTrace(undefined, []), /M16_PRODUCTION_TRACE/u);
  assert.deepEqual(validateProductionTrace(stateless(), []), stateless());
  const trace = stateful();
  assert.throws(() => validateProductionTrace(trace, ["source"]), /broken required flow/u);
  assert.deepEqual(validateProductionTrace(trace, ["source"], { requireSafe: false }), trace);
  trace.targetRelations[0].effect = "SAFE";
  assert.deepEqual(validateProductionTrace(trace, ["source"]), trace, "Aliasing itself can be safe if the necessary data flow is preserved.");
  trace.targetRelations[0].identity = "UNKNOWN";
  assert.throws(() => validateProductionTrace(trace, ["source"]), /unknown identity/u);
  trace.targetRelations[0].left = "business data file";
  assert.throws(() => validateProductionTrace(trace, ["source"]), /targetRelations\[0\]\.left must copy an exact stateTargets\[\]\.id/u);
});

test("production trace rejects omitted or duplicate target comparisons and foreign source citations", () => {
  for (const change of [trace => { trace.targetRelations = []; },
    trace => { trace.targetRelations.push({ ...trace.targetRelations[0], left: "auxiliary", right: "business" }); },
    trace => { trace.stateTargets[1].citeIds = ["unread"]; },
    trace => { trace.stateTargets[1].id = "business"; },
    trace => { trace.stateTargets[1].writers = []; },
    trace => { trace.targetRelations[0].overlapAttempt = " "; }]) {
    const trace = stateful(); trace.targetRelations[0].effect = "SAFE"; change(trace);
    assert.throws(() => validateProductionTrace(trace, ["source"]), /M16_PRODUCTION_TRACE/u);
  }
  const hidden = stateless(); hidden.stateTargets = stateful().stateTargets;
  assert.throws(() => validateProductionTrace(hidden, ["source"]), /stateless flow/u);
});

async function fixture(t) {
  const scratch = path.resolve(".runtime-correction/m16-trace-tests");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  const outputDir = `${root}-review`, authPath = `${root}-auth.json`;
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outputDir, { recursive: true, force: true }); await fs.rm(authPath, { force: true }); });
  await fs.mkdir(path.join(root, "project"));
  await fs.writeFile(path.join(root, "basis.txt"), "Preview returns the supplied input.\n");
  await fs.writeFile(path.join(root, "project/main.js"), "export const preview = input => input;\n");
  const snapshot = await captureFiles(root), registry = new Map(), reads = [];
  const cite = async file => {
    const bytes = await fs.readFile(path.join(root, file)), end = bytes.toString("utf8").split("\n").length;
    reads.push({ path: file, start: 1, end });
    return registerCitation({ registry, bytes, file, sha256: snapshot.get(file).sha256, range: { start: 1, end } });
  };
  const basis = await cite("basis.txt"), source = await cite("project/main.js");
  const task = { id: "M16:preview", scope: "SOURCE_IMPLEMENTATION", reviewType: "production-implementation-coverage-reviewer",
    requirement: "Preview returns its actual supplied input.", basisFiles: ["basis.txt"], targetFiles: ["project/main.js"] };
  return { root, outputDir, authPath, snapshot, registry, reads, task, basis, source };
}

test("M16 decision gate requires trace on PASS while preserving early D/U and other metrics", async t => {
  const f = await fixture(t);
  const decision = { taskId: f.task.id, verdict: "PASS", reason: "Caller input flows through preview to its return value.", citeIds: [f.source.citeId] };
  await assert.rejects(validateDecision({ ...f, decision }), /M16_PRODUCTION_TRACE/u);
  const proven = await validateDecision({ ...f, decision: { ...decision, productionTrace: stateless() } });
  assert.deepEqual(proven.productionTrace, stateless());
  for (const verdict of ["DEVIATION", "UNVERIFIED"]) assert.equal((await validateDecision({ ...f, decision: { ...decision, verdict } })).verdict, verdict);
  const earlyDeviation = await validateDecision({ ...f, decision: { ...decision, verdict: "DEVIATION", productionTrace: { incomplete: true } } });
  assert.equal(earlyDeviation.verdict, "DEVIATION"); assert.equal(earlyDeviation.productionTrace, undefined);
  assert.equal((await validateDecision({ ...f, task: { ...f.task, reviewType: "obligation-reviewer" }, decision })).verdict, "PASS");
  const foreign = stateful(); foreign.targetRelations[0].effect = "SAFE";
  for (const target of foreign.stateTargets) target.citeIds = [f.basis.citeId];
  foreign.targetRelations[0].citeIds = [f.basis.citeId];
  await assert.rejects(validateDecision({ ...f, decision: { ...decision, citeIds: [f.source.citeId, f.basis.citeId], productionTrace: foreign } }), /M16_PRODUCTION_TRACE/u);
});

test("native submission rejects an untraced M16 PASS and preserves the corrected trace through final currentness validation", async t => {
  const f = await fixture(t);
  let turns = 0;
  const result = await runReviewTask({ task: f.task, root: f.root, outputDir: f.outputDir, maxAttempts: 1, maxTurns: 5,
    nativeRun: async worker => {
      const tools = nativeTools(worker);
      await tools.read('basis.txt'); const citeId = await tools.read('project/main.js');
      await assert.rejects(tools.submit(f.task.id, 'PASS', [citeId]), /M16_PRODUCTION_TRACE/);
      await tools.submit(f.task.id, 'PASS', [citeId], { productionTrace: stateless() }); turns = 4;
    } });
  assert.equal(turns, 4); assert.equal(result.completed, true); assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.productionTrace, stateless());
  const saved = JSON.parse(await fs.readFile(path.join(f.outputDir, "decision.json"), "utf8"));
  assert.deepEqual(saved.productionTrace, result.productionTrace);
});
