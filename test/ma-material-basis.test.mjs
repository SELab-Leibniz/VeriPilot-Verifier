import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMaterialBasis, readMaterialBasis, invalidateMaterialBasis } from "../lib/openclaw/material-basis.mjs";
import { prepareSourceInputs, bindSourceSelections } from "../lib/openclaw/sources.mjs";
import { materialManifest, deterministicCapabilityOperations } from "../lib/runtime-v2/onboarding.mjs";
import { ensureTask, findTask, decisionGuard, withTaskDecision, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { runStopBaselineTask } from "../lib/runtime-v2/baseline-task.mjs";
import { GROUND_TRUTH_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";

async function fixture(t, text = "Preserve the original acceptance gate.\r\n") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-material-basis-"))), file = path.join(root, "requirements.md");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(file, text);
  const task = await ensureTask({ projectRoot: root, sessionId: "material" });
  const options = { projectRoot: root, taskId: task.taskId, roots: [file] };
  return { root, file, text, task, options };
}

test("bounded original material capture preserves exact byte hashes and existing manifest identities", async t => {
  const f = await fixture(t), basis = await prepareMaterialBasis(f.options);
  assert.deepEqual(await basis.materialManifest([f.file], { includeContent: true }), await materialManifest([f.file], { includeContent: true }));
  assert.equal((await basis.readOriginalMaterial(f.file)).toString("utf8"), f.text);
  assert.equal(sha256(await basis.readOriginalMaterial(f.file)), sha256(Buffer.from(f.text)));
  assert.equal((await readMaterialBasis(f.root, f.task.taskId)).status, "CAPTURED");
  await fs.writeFile(path.join(f.root, "artifact.md"), "An unrelated business edit.\n");
  assert.equal(await basis.current(), true);
  await invalidateMaterialBasis({ ...f.options, reason: "LATE_CANCEL", onlyUncaptured: true });
  assert.equal(await basis.current(), true);
});

test("first overwrite creates durable UNVERIFIED and restoration or restart cannot recapture new initial authority", async t => {
  const f = await fixture(t), basis = await prepareMaterialBasis(f.options);
  await fs.writeFile(f.file, "The business tool removed the gate.\n");
  await assert.rejects(basis.assert(), { code: "MATERIAL_BASIS_CHANGED" });
  assert.equal((await readMaterialBasis(f.root, f.task.taskId)).status, "UNVERIFIED");
  await fs.writeFile(f.file, f.text);
  await assert.rejects(prepareMaterialBasis({ ...f.options, mode: "verify" }), { code: "MATERIAL_BASIS_CHANGED" });
  assert.equal((await basis.readOriginalMaterial(f.file)).toString("utf8"), f.text);
});

test("directory capture preserves manifest identities, excludes private receipts and detects added authoritative files", async t => {
  const f = await fixture(t), options = { ...f.options, roots: [f.root] }, basis = await prepareMaterialBasis(options);
  assert.deepEqual(await basis.materialManifest([f.root], { includeContent: true }), await materialManifest([f.root], { includeContent: true }));
  const privateReceipt = path.join(f.root, ".runtime-correction", "user-message.md");
  await fs.writeFile(privateReceipt, "A separately captured USER_MESSAGE receipt.");
  assert.equal(await basis.readOriginalMaterial(privateReceipt), null);
  await basis.validateCitations([{ path: privateReceipt, contentHash: "separate-user-authority" }]);
  assert.equal(await basis.current(), true);
  await fs.writeFile(path.join(f.root, "new-requirement.md"), "A new live source cannot redefine the original inventory.\n");
  assert.equal(await basis.current(), false);
  await assert.rejects(prepareMaterialBasis({ ...options, mode: "verify" }), { code: "MATERIAL_BASIS_CHANGED" });
});

test("temporary replacement cannot change inline originals, source quote binding or receipt authority", async t => {
  const f = await fixture(t), basis = await prepareMaterialBasis(f.options), replacement = "Accept the weaker replacement.\n";
  await fs.writeFile(f.file, replacement);
  const manifest = await basis.materialManifest([f.file], { includeContent: true });
  assert.equal(manifest.entries[0].text, f.text); assert.equal(manifest.entries[0].sha256, sha256(f.text));
  const requestDirectory = path.join(f.root, "request"); await fs.mkdir(requestDirectory);
  const catalog = [{ ref: f.file, kind: "MATERIAL" }];
  const delivery = await prepareSourceInputs({ snapshot: { entries: [] }, sourceCatalog: catalog,
    requestDirectory, projectRoot: f.root, readOriginalMaterial: basis.readOriginalMaterial });
  const operations = [{ authority: "MATERIAL_DERIVED", source: { ref: f.file + "#L1" } }];
  bindSourceSelections(operations, delivery, catalog);
  assert.equal(operations[0].source.excerpt, f.text.split("\n")[0]);
  await fs.writeFile(f.file, f.text);
  assert.equal(await basis.current(), true, "current endpoint equality does not prove the intervening source receipt");
  await assert.rejects(basis.validateCitations([{ path: f.file, contentHash: sha256(replacement) }]), { code: "MATERIAL_BASIS_RECEIPT_CHANGED" });
  await assert.rejects(prepareMaterialBasis(f.options), { code: "MATERIAL_BASIS_RECEIPT_CHANGED" });
});

test("deterministic material parsing consumes captured originals during a temporary replacement", async t => {
  const f = await fixture(t, "### 10.1 Kit使用清单\n| 功能 | 使用Kit | 代码文件 |\n| --- | --- | --- |\n| 联网 | network-kit | Network.ets |\n"), basis = await prepareMaterialBasis(f.options);
  const manifest = await basis.materialManifest([f.file], { includeContent: true });
  const expected = await deterministicCapabilityOperations(manifest);
  assert.equal(expected.length, 1); assert.equal(expected[0].capability.name, "network-kit");
  await fs.writeFile(f.file, "### 10.1 Kit使用清单\n| 功能 | 使用Kit | 代码文件 |\n| --- | --- | --- |\n| 音频 | audio-kit | Audio.ets |\n");
  const captured = await deterministicCapabilityOperations(manifest, {}, null, { readOriginalMaterial: basis.readOriginalMaterial });
  assert.deepEqual(captured, expected);
  await fs.writeFile(f.file, f.text); assert.equal(await basis.current(), true);
});

test("native baseline freezing binds copied source bytes and their digest to the pre-hook original", async t => {
  const f = await fixture(t), basis = await prepareMaterialBasis(f.options);
  await fs.writeFile(f.file, "Temporary weaker material during native source preparation.\n");
  let reads = 0, prepared = false;
  const readOriginalMaterial = async file => {
    const bytes = await basis.readOriginalMaterial(file);
    if (path.resolve(file) === f.file && ++reads === 2) await fs.writeFile(f.file, f.text);
    return bytes;
  };
  const input = { projectRoot: f.root, taskId: f.task.taskId, role: "ground-truth-extractor", reviewer: { timeoutMs: 5000 },
    schema: GROUND_TRUTH_REVIEW_SCHEMA, readOriginalMaterial,
    evidence: { groundTruth: { taskId: f.task.taskId, version: 0, digest: null, claims: [] }, snapshot: { entries: [
      { type: "user", uuid: "u", message: { content: "Deliver the original requested behavior." } },
    ] } }, request: { reviewScope: { kind: "baseline", boundedBasis: true }, sourceCatalog: [
      { ref: "transcript:u", kind: "USER_MESSAGE" }, { ref: f.file, kind: "MATERIAL" },
    ] }, onPrepared: async ({ requestDirectory, request }) => {
      const source = request.identity.sources.find(source => source.ref === f.file);
      assert.equal(source.sha256, sha256(f.text));
      const chunks = await Promise.all(source.parts.map(part => fs.readFile(path.resolve(requestDirectory, "../frozen-source", part.file))));
      assert.equal(Buffer.concat(chunks).toString("utf8"), f.text); prepared = true;
      throw Object.assign(new Error("Prepared source verified without model execution"), { code: "CONTROLLED_MATERIAL_FREEZE" });
    } };
  await assert.rejects(runStopBaselineTask(input, { api: { runtime: { version: "2026.7.1-2", agent: {} } },
    nativeRunner: async () => assert.fail("This source-freeze check must not run a model"),
    selection: { config: {}, provider: "offline-fixture", model: "offline-fixture" },
    options: { loadPublicToolArgumentsValidator: async () => null } }), { code: "CONTROLLED_MATERIAL_FREEZE" });
  assert.equal(prepared, true); assert.equal(reads, 2); assert.equal(await basis.current(), true);
});

test("publication freshness discards staged material claims and leaves a sticky independent diagnostic", async t => {
  const f = await fixture(t), basis = await prepareMaterialBasis(f.options);
  const result = await withTaskDecision({ projectRoot: f.root, taskId: f.task.taskId, context: {
    kind: "hook", assessmentId: "material-publication", guard: decisionGuard(f.task), evidenceMatches: basis.current,
  } }, async () => {
    await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, current => { current.groundTruth.version = 1; });
    await fs.writeFile(f.file, "Changed after model generation.\n");
    return { decision: "allow", status: "PASS" };
  });
  assert.equal(result.stale, true);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "material" })).groundTruth.version, 0);
  assert.equal((await readMaterialBasis(f.root, f.task.taskId)).status, "UNVERIFIED");
});

test("cancelling an assessment fences publication without poisoning an unchanged captured basis", async t => {
  const f = await fixture(t), basis = await prepareMaterialBasis(f.options), controller = new AbortController();
  const result = await withTaskDecision({ projectRoot: f.root, taskId: f.task.taskId, context: {
    kind: "hook", assessmentId: "cancelled-material", guard: decisionGuard(f.task), abortSignal: controller.signal, evidenceMatches: basis.current,
  } }, async () => {
    await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, current => { current.groundTruth.version = 1; });
    controller.abort(); return { decision: "allow", status: "PASS" };
  });
  assert.equal(result.stale, true); assert.equal(await basis.current(), true);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: "material" })).groundTruth.version, 0);
});

test("a failed initial hot hook cannot lose its diagnostic when the live material configuration becomes empty", async t => {
  const f = await fixture(t);
  await invalidateMaterialBasis({ ...f.options, reason: "MATERIAL_BASIS_HOOK_UNAVAILABLE", onlyUncaptured: true });
  await assert.rejects(prepareMaterialBasis({ ...f.options, roots: [], mode: "verify" }), { code: "MATERIAL_BASIS_HOOK_UNAVAILABLE" });
  assert.equal((await readMaterialBasis(f.root, f.task.taskId)).status, "UNVERIFIED");
});

test("oversized, overfull, missing and late initial scopes stay UNVERIFIED instead of being sampled", async t => {
  for (const scenario of ["bytes", "files", "missing", "deadline", "cancel"]) await t.test(scenario, async t => {
    const f = await fixture(t), limits = {}, options = { ...f.options, limits };
    if (scenario === "bytes") limits.bytes = 4;
    if (scenario === "files") {
      options.roots = [f.root]; limits.files = 1; await fs.writeFile(path.join(f.root, "second.md"), "Second source.\n");
    }
    if (scenario === "missing") await fs.rm(f.file);
    if (scenario === "deadline") options.deadlineAt = Date.now() - 1;
    if (scenario === "cancel") { const controller = new AbortController(); controller.abort(); options.signal = controller.signal; }
    await assert.rejects(prepareMaterialBasis(options), error => error.code.startsWith("MATERIAL_BASIS_"));
    assert.equal((await readMaterialBasis(f.root, f.task.taskId)).status, "UNVERIFIED");
    await fs.writeFile(f.file, "Now small.\n");
    await assert.rejects(prepareMaterialBasis({ ...options, signal: undefined, deadlineAt: undefined, limits: {} }), error => error.code.startsWith("MATERIAL_BASIS_"));
  });
});
