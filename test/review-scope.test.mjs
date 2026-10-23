import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareReviewScope, REVIEW_SCOPE_PAGE_BYTES, REVIEW_SCOPE_REQUEST_BYTES } from "../lib/runtime-v2/review-scope.mjs";
import { prepareReviewerRequest } from "../lib/runtime-v2/reviewer-evidence.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-review-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requestDirectory = path.join(root, ".runtime-correction", "requests", "scope");
  return { root, requestDirectory };
}
const claim = (claimId, category = "requirements", text = `${claimId} original requirement`) => ({ claimId,
  revisionId: `${claimId}@3`, category, text, authority: "USER_EXPLICIT", status: "ACTIVE", severity: "HARD" });
const truth = claims => ({ schemaVersion: "runtime-corrector.ground-truth.v2", taskId: "scope-task", version: 3,
  digest: sha256(claims), frozenAtVersion: 3, claims });
const request = (extra = {}) => ({ taskId: "scope-task", instructions: ["Inspect only assigned objects."],
  reviewScope: { sourceIds: ["R1"], objectIds: ["M12:R1"] }, population: { version: 2, groundTruthVersion: 3,
    metrics: { M12: [{ objectId: "M12:R1", sourceId: "R1", sourceRevisionId: "R1@3", description: "R1 original requirement" }] } }, ...extra });
async function records(descriptor) {
  const index = JSON.parse(await fs.readFile(descriptor.path, "utf8"));
  return index.kind === "records" ? index.records : (await Promise.all(index.pages.map(records))).flat();
}
async function original(descriptor) {
  const index = JSON.parse(await fs.readFile(descriptor.path, "utf8"));
  const segments = (await records(descriptor)).sort((a, b) => a.offset - b.offset);
  const body = (await Promise.all(segments.map(async segment => {
    const bytes = await fs.readFile(segment.path); assert.equal(bytes.length, segment.bytes);
    assert.equal(sha256(bytes), segment.sha256); return bytes;
  })));
  const source = Buffer.concat(body); assert.equal(source.length, index.sourceBytes);
  assert.equal(sha256(source), index.sourceSha256); return JSON.parse(source.toString("utf8"));
}
async function assertBoundedPages(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await assertBoundedPages(target);
    else assert.ok((await fs.stat(target)).size <= REVIEW_SCOPE_PAGE_BYTES, `Oversized page: ${target}`);
  }
}

test("unscoped requests retain isolated originals and write no new files", async t => {
  const f = await fixture(t), input = { instructions: ["Original"] }, evidence = { snapshot: { entries: [] } };
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory, request: input, evidence });
  input.instructions[0] = "Changed"; evidence.snapshot.entries.push({ later: true });
  assert.deepEqual(out.request, { instructions: ["Original"] }); assert.deepEqual(out.evidence, { snapshot: { entries: [] } });
  await assert.rejects(fs.access(f.requestDirectory), { code: "ENOENT" });
});

test("local Ground Truth retains selected clauses, common constraints and explicit dependency closure without rewriting the canonical baseline", async t => {
  const f = await fixture(t), selected = claim("R1", "requirements", "R1 must preserve the condition and exception from R2.");
  selected.dependsOn = ["R2"];
  const second = { ...claim("R2"), exceptionClaimIds: ["R3"] };
  const canonical = truth([selected, second, claim("R3"), claim("R4", "requirements", "UNRELATED BODY ".repeat(5000)),
    claim("G", "constraints", "Preserve every protected file.")]);
  const before = structuredClone(canonical);
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request(), evidence: { groundTruth: canonical } });
  assert.deepEqual(canonical, before);
  assert.deepEqual(new Set(out.evidence.groundTruth.claims.map(item => item.claimId)), new Set(["R1", "R2", "R3", "G"]));
  assert.equal(out.evidence.groundTruth.claims[0].text, selected.text);
  assert.equal(out.evidence.groundTruth.version, canonical.version); assert.equal(out.evidence.groundTruth.digest, canonical.digest);
  assert.equal(out.evidence.groundTruth.reviewScope.dependencyCompleteness, "NOT_PROVEN");
  assert.deepEqual(await original(out.request.reviewSources.originalGroundTruth), canonical);
  assert.ok(Buffer.byteLength(JSON.stringify(out.request, null, 2)) < REVIEW_SCOPE_REQUEST_BYTES);
  assert.ok(!JSON.stringify(out.request).includes("UNRELATED BODY"));
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("long Unicode tool results remain exact and pairing remains discoverable without inlining the transcript", async t => {
  const f = await fixture(t), body = "长行🌻\"原文\"\\反斜线\n".repeat(14000) + "最后的证据-END";
  const entries = [
    { type: "user", uuid: "u", message: { content: "Original user requirement" } },
    { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id: "tool-1", name: "exec", input: { command: "python test.py" } }] } },
    { type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: body }] } },
    { type: "assistant", uuid: "final", message: { content: "Task complete." } },
  ];
  const snapshot = { digest: "transcript-original", lastEntryKey: "final", entries };
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request({ processToolEvidence: [{ toolUseId: "tool-1", invocationIndex: 1, resultIndex: 2, status: "RETURNED" }] }),
    evidence: { snapshot, groundTruth: truth([claim("R1")]) } });
  assert.equal(out.evidence.snapshot, null); assert.equal(out.request.transcript.digest, snapshot.digest);
  const navigation = JSON.parse(await fs.readFile(out.request.transcript.path, "utf8"));
  const storedEntries = await records(navigation.entryIndex);
  assert.deepEqual(await Promise.all(storedEntries.map(entry => original(entry.source))), entries);
  const tools = await records(navigation.toolIndex); assert.equal(tools.length, 1);
  const pair = await original(tools[0].source); assert.equal(pair.inputs[0].index, 1); assert.equal(pair.results[0].index, 2);
  assert.equal((await original(pair.results[0].source)).message.content[0].content, body);
  assert.deepEqual(await original(out.request.reviewSources.processToolEvidence), [{ toolUseId: "tool-1", invocationIndex: 1, resultIndex: 2, status: "RETURNED" }]);
  assert.ok(!JSON.stringify(out.request).includes("最后的证据-END"));
  assert.equal(out.request.processToolEvidence, undefined);
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("classification defers large goals and hook text and does not inherit unrelated large common constraints", async t => {
  const f = await fixture(t), hook = { hookEventName: "Stop", lastAssistantMessage: "Completed with details. ".repeat(7000) };
  const canonical = truth([claim("goal", "goals", "原始目标🌻".repeat(9000)), claim("global", "constraints", "巨大约束".repeat(15000))]);
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request({ reviewScope: { kind: "classification", sourceIds: [], objectIds: [] }, population: { metrics: {} }, hook }),
    evidence: { groundTruth: canonical, snapshot: { entries: [{ type: "user", uuid: "u", message: { content: "Create the app." } },
      { type: "user", uuid: "internal-user", message: { content: "[runtime-corrector:internal] Private role instruction." } },
      { type: "assistant", uuid: "a", message: { content: "Done." } },
      { type: "assistant", uuid: "internal-assistant", isMeta: true, message: { content: "Private review state." } }], digest: "d", lastEntryKey: "internal-assistant" } } });
  assert.equal(out.evidence.groundTruth.claims.length, 0);
  const basis = await original(out.request.reviewSources.classificationBasis);
  assert.deepEqual(basis.claims.map(item => item.claimId), ["goal"]);
  assert.deepEqual(await original(out.request.reviewSources.hook), hook);
  const navigation = JSON.parse(await fs.readFile(out.request.transcript.path, "utf8"));
  assert.deepEqual((await records(navigation.classificationIndex)).map(item => item.key), ["u", "a"]);
  assert.ok(Buffer.byteLength(JSON.stringify(out.request, null, 2)) < REVIEW_SCOPE_REQUEST_BYTES);
  assert.ok(!JSON.stringify(out.request).includes("Completed with details."));
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("implementation requests read canonical Ground Truth when evidence is absent and page a large manifest", async t => {
  const f = await fixture(t), canonical = truth([claim("R1"), claim("R2"), claim("scope", "outOfScope")]);
  const canonicalPath = path.join(f.root, "canonical.json"); await fs.writeFile(canonicalPath, JSON.stringify(canonical));
  const manifest = Array.from({ length: 300 }, (_, index) => ({ path: `src/${"nested/".repeat(8)}module-${index}.py`, sha256: "f".repeat(64) }));
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request({ groundTruthPath: canonicalPath, sourceManifest: manifest }) });
  assert.equal(out.request.sourceManifest, undefined);
  assert.deepEqual(await records(out.request.reviewSources.sourceManifest), manifest);
  assert.deepEqual(out.evidence.groundTruth.claims.map(item => item.claimId), ["R1", "scope"]);
  assert.equal(out.request.reviewScope.originalGroundTruthPath, canonicalPath);
  assert.equal(await fs.readFile(canonicalPath, "utf8"), JSON.stringify(canonical));
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("oversized local obligations and requests fail explicitly without truncating or weakening requirements", async t => {
  const f = await fixture(t), canonical = truth([claim("R1", "requirements", "必须完整核查的原始需求".repeat(4000))]);
  const before = structuredClone(canonical);
  await assert.rejects(prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request(), evidence: { groundTruth: canonical } }), { code: "REVIEW_SCOPE_TOO_LARGE" });
  assert.deepEqual(canonical, before);
  await assert.rejects(prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request({ instructions: ["x".repeat(REVIEW_SCOPE_REQUEST_BYTES)] }), evidence: { groundTruth: truth([claim("R1")]) } }),
  { code: "REVIEW_SCOPE_TOO_LARGE" });
});

test("scope originals remain discoverable after the standard request materializer, without recreating a full transcript file", async t => {
  const f = await fixture(t);
  const prepared = await prepareReviewerRequest({ requestDirectory: f.requestDirectory,
    request: request(), evidence: { groundTruth: truth([claim("R1"), claim("R2")]), snapshot: { digest: "d", lastEntryKey: "u",
      entries: [{ type: "user", uuid: "u", message: { content: "Need complete originals." } }] } } });
  assert.equal(prepared.transcript.path, path.join(f.requestDirectory, "review-scope", "transcript-index.json"));
  assert.equal(prepared.transcript.paged, true);
  await assert.rejects(fs.access(path.join(f.requestDirectory, "transcript.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await fs.readFile(prepared.groundTruthPath, "utf8")).claims.map(item => item.claimId), ["R1"]);
});
