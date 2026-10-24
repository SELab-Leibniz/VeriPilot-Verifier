import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectArtifactCandidates } from "../lib/runtime-v2/artifact-candidates.mjs";
import { runStopTaskReview } from "../lib/runtime-v2/stop-task-review.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t, metric = "M11", target = "PROCESS") {
  const scratch = fileURLToPath(new URL("../.runtime-correction/stop-preparation-scope-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "scope", directory = path.join(root, ".runtime-correction/tasks", taskId);
  const groundTruthPath = path.join(directory, "ground-truth/current.json");
  const text = "Run the unchanged verifier against this implementation; preserve every original condition.";
  const truth = { version: 1, digest: "frozen-truth", claims: [
    { claimId: "R1", category: "workflowSteps", text, authority: "USER_EXPLICIT", severity: "HARD", status: "ACTIVE", verificationTarget: target },
    { claimId: "C1", category: "constraints", text: "If input is absent, use the declared default; never weaken the verifier.", authority: "USER_EXPLICIT", severity: "HARD", status: "ACTIVE" },
  ] };
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  await fs.writeFile(path.join(directory, "task.json"), JSON.stringify({
    groundTruth: { version: 1, digest: truth.digest }, correctionEpoch: { id: "epoch" }, control: { generation: 1 },
  }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/unrelated.py"), "# unrelated application module\n");
  await fs.writeFile(path.join(root, "verify.py"), "assert current_implementation_is_valid\n");
  const object = { objectId: `${metric}:R1`, sourceId: "R1", metricId: metric, description: text,
    applicabilityKind: "CURRENT_TASK", authority: "USER_EXPLICIT", verificationTarget: target };
  const population = { metrics: { [metric]: [object] } };
  const snapshot = { entries: [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "verify-call", name: "exec", input: { command: "python verify.py" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "verify-call", content: "exit=0" }] } },
  ] };
  const input = { projectRoot: root, taskId, role: "stop-reviewer", reviewer: { timeoutMs: 5000 },
    request: { groundTruthPath, population, reviewScope: { objectIds: [object.objectId], sourceIds: ["R1"] },
      fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: null } },
    evidence: { groundTruth: truth, population, snapshot } };
  return { root, input, truth, snapshot };
}

const unknown = () => ({ completed: true, verdict: "UNVERIFIED", reason: "The offline worker has no conclusive witness.", refs: [] });

test("process proof skips unrelated project copies while preserving full original conditions and events", async t => {
  const f = await fixture(t);
  const h = await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(options.task.scope, "PROCESS_COMPLIANCE");
    assert.deepEqual(options.task.targetPrefixes, ["process/"]);
    assert.equal(await fs.stat(path.join(options.root, "project")).catch(error => error.code === "ENOENT" ? null : Promise.reject(error)), null);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.root, "original-ground-truth.json"), "utf8")), f.truth);
    for (const [index, entry] of f.snapshot.entries.entries())
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.root, "process", `${String(index).padStart(6, "0")}.json`), "utf8")), entry);
    const basis = (await Promise.all(options.task.basisFiles.map(file => fs.readFile(path.join(options.root, file), "utf8")))).join("");
    assert.match(basis, /never weaken the verifier/);
    assert.match(basis, /preserve every original condition/);
    return unknown();
  } });
  assert.deepEqual(h.reviewEvidence.files, []);
});

test("explicit process source declarations retain required files without walking unrelated application modules", async t => {
  const f = await fixture(t);
  f.input.request.sourceManifest = [{ path: "verify.py", sha256: sha256(await fs.readFile(path.join(f.root, "verify.py"))) }];
  const h = await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(await fs.readFile(path.join(options.root, "project/verify.py"), "utf8"), "assert current_implementation_is_valid\n");
    assert.deepEqual(await fs.readdir(path.join(options.root, "project")), ["verify.py"]);
    return unknown();
  } });
  assert.deepEqual(h.reviewEvidence.files, [path.join(f.root, "verify.py")]);
});

test("runtime acceptance retains verifier, implementation and original invocation/result for binding", async t => {
  const f = await fixture(t, "M12", "IMPLEMENTATION");
  await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(options.task.scope, "RUNTIME_ACCEPTANCE");
    assert.deepEqual(options.task.targetPrefixes, ["process/"]);
    assert.equal(await fs.readFile(path.join(options.root, "project/verify.py"), "utf8"), "assert current_implementation_is_valid\n");
    assert.equal(await fs.readFile(path.join(options.root, "project/src/unrelated.py"), "utf8"), "# unrelated application module\n");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.root, "original-ground-truth.json"), "utf8")), f.truth);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.root, "process/000001.json"), "utf8")), f.snapshot.entries[1]);
    return unknown();
  } });
});

for (const mode of ["cancelled", "expired"]) test(`candidate ${mode} preparation exits before filesystem discovery`, async () => {
  const controller = new AbortController();
  if (mode === "cancelled") controller.abort();
  await assert.rejects(collectArtifactCandidates({ projectRoot: "unavailable-audit-root", abortSignal: controller.signal,
    deadlineAt: mode === "expired" ? Date.now() - 1 : Infinity }), error => error.code === (mode === "cancelled" ? "REVIEW_COLLECTION_CANCELLED" : "REVIEW_COLLECTION_STALE"));
});

test("cancellation during wildcard discovery stops nested traversal before candidate bodies are read", async t => {
  const f = await fixture(t), controller = new AbortController();
  const docs = path.join(f.root, "docs");
  await fs.mkdir(path.join(docs, "nested"), { recursive: true });
  await fs.writeFile(path.join(docs, "a.md"), "A\n");
  await fs.writeFile(path.join(docs, "nested/b.md"), "B\n");
  const readdir = fs.readdir, readFile = fs.readFile;
  let nestedVisits = 0, bodyReads = 0;
  fs.readdir = async function(file, ...args) {
    if (path.resolve(String(file)) === path.join(docs, "nested")) nestedVisits++;
    const value = await readdir.call(this, file, ...args);
    if (path.resolve(String(file)) === docs) controller.abort();
    return value;
  };
  fs.readFile = async function(file, ...args) {
    if (path.resolve(String(file)).startsWith(docs + path.sep)) bodyReads++;
    return readFile.call(this, file, ...args);
  };
  try {
    await assert.rejects(collectArtifactCandidates({ projectRoot: f.root, abortSignal: controller.signal,
      plan: { configuredArtifacts: [{ nodeId: "docs", metrics: ["M01"], patterns: ["docs/**/*.md"] }] } }),
    error => error.code === "REVIEW_COLLECTION_CANCELLED");
    assert.equal(nestedVisits, 0);
    assert.equal(bodyReads, 0);
  } finally { fs.readdir = readdir; fs.readFile = readFile; }
});

test("candidate body reads inherit cancellation and stop before reading the next file", async t => {
  const f = await fixture(t), controller = new AbortController();
  const a = path.join(f.root, "a.md"), b = path.join(f.root, "b.md");
  await fs.writeFile(a, "A\n"); await fs.writeFile(b, "B\n");
  const readFile = fs.readFile; let bodies = 0;
  fs.readFile = async function(file, options) {
    if ([a, b].includes(path.resolve(String(file)))) {
      bodies++; assert(options?.signal);
      const value = await readFile.call(this, file, options);
      controller.abort(); return value;
    }
    return readFile.call(this, file, options);
  };
  try {
    await assert.rejects(collectArtifactCandidates({ projectRoot: f.root, abortSignal: controller.signal,
      plan: { configuredArtifacts: [{ nodeId: "docs", metrics: ["M01"], patterns: ["a.md", "b.md"] }] } }),
    error => error.code === "REVIEW_COLLECTION_CANCELLED");
    assert.equal(bodies, 1);
  } finally { fs.readFile = readFile; }
});

for (const proof of ["complete", "missing-basis", "wrong-basis-hash", "missing-cite-id"]) test(`SDK ${proof} input emits only justified program read proof`, async t => {
  const f = await fixture(t);
  const h = await runStopTaskReview(f.input, { runTask: async options => {
    const file = "process/000001.json", bytes = await fs.readFile(path.join(options.root, file));
    const citeId = "audit-cite-id";
    const basis = await Promise.all(options.task.basisFiles.map(async file => {
      const bytes = await fs.readFile(path.join(options.root, file));
      return { path: file, start: 1, end: bytes.toString("utf8").split("\n").length, sha256: sha256(bytes) };
    }));
    if (proof === "missing-basis") basis.pop();
    if (proof === "wrong-basis-hash") basis[0].sha256 = "0".repeat(64);
    return { completed: true, verdict: "PASS", reason: "The original invocation has its result.",
      basis, citeIds: proof === "missing-cite-id" ? [] : [citeId],
      refs: [{ path: file, start: 1, end: 1, sha256: sha256(bytes), citeId }] };
  } });
  const citation = h.sourceCitations[0];
  if (proof === "complete") assert.deepEqual(citation.readProof, { version: 1, observed: true, basisComplete: true, owner: "PROCESS" });
  else assert.equal(citation.readProof, undefined, "completed alone cannot manufacture a read/basis proof");
});

test("stop-owned M09 source proof is marked SOURCE rather than artifact or process evidence", async t => {
  const f = await fixture(t, "M09", "IMPLEMENTATION");
  const h = await runStopTaskReview(f.input, { runTask: async options => {
    assert.equal(options.task.scope, "SOURCE_IMPLEMENTATION");
    const file = "project/verify.py", bytes = await fs.readFile(path.join(options.root, file));
    const basis = await Promise.all(options.task.basisFiles.map(async file => {
      const bytes = await fs.readFile(path.join(options.root, file));
      return { path: file, start: 1, end: bytes.toString("utf8").split("\n").length, sha256: sha256(bytes) };
    }));
    return { completed: true, verdict: "PASS", reason: "Source is established in this isolated protocol fixture.", basis,
      citeIds: ["source-cite"], refs: [{ path: file, start: 1, end: 1, sha256: sha256(bytes), citeId: "source-cite" }] };
  } });
  assert.equal(h.sourceCitations[0].readProof.owner, "SOURCE");
});
