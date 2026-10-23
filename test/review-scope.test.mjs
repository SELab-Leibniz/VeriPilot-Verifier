import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeReviewScopeRequest, prepareReviewScope, REVIEW_SCOPE_PAGE_BYTES, REVIEW_SCOPE_REQUEST_BYTES } from "../lib/runtime-v2/review-scope.mjs";
import { prepareReviewerRequest, scopedSourceCitations } from "../lib/runtime-v2/reviewer-evidence.mjs";
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

test("bounded Stop navigation omits validation hashes while preserving all semantic metadata and an exact audit manifest", async t => {
  const f = await fixture(t);
  const manifest = Array.from({ length: 80 }, (_, index) => ({ path: `src/module-${index}.ets`, size: 19000,
    sha256: "f".repeat(64), applicability: "Preserve this source condition.", custom: { owner: "R1" } }));
  const before = structuredClone(manifest);
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request({ sourceManifest: manifest, reviewScope: { boundedBasis: true, sourceIds: ["R1"], objectIds: ["M12:R1"] } }),
    evidence: { groundTruth: truth([claim("R1")]) } });
  assert.deepEqual(manifest, before);
  assert.deepEqual(await original(out.request.reviewSources.originalSourceManifest), manifest);
  const navigation = await records(out.request.reviewSources.sourceManifest);
  assert.deepEqual(navigation, manifest.map(({ sha256: _hash, ...entry }) => entry));
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) - Buffer.byteLength(JSON.stringify(navigation)) > 6000);
  assert.match(out.request.instructions.join("\n"), /do not reread the audit manifest/);
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

test("bounded Stop scopes preserve oversized obligations, common constraints and explicit dependencies in a mandatory exact basis", async t => {
  for (const large of ["obligation", "common constraints", "dependency"]) await t.test(large, async t => {
    const f = await fixture(t), ending = "末页条件：仅在原始例外成立时允许执行🌻";
    const selected = { ...claim("R1", "requirements", large === "obligation" ? "完整需求🌻".repeat(5000) + ending : "Preserve the condition in R2."), dependsOn: ["R2"] };
    const dependency = { ...claim("R2", "requirements", large === "dependency" ? "原始依赖🌻".repeat(5000) + ending : "R2 condition."), exceptionClaimIds: ["R3"] };
    const common = claim("G", "constraints", large === "common constraints" ? "共同强制条件🌻".repeat(5000) + ending : "Preserve protected files.");
    const canonical = truth([selected, dependency, claim("R3"), common, claim("unrelated")]);
    const input = request({ reviewScope: { boundedBasis: true, objectIds: ["M12:R1"], sourceIds: ["R1"] } });
    const before = structuredClone({ input, canonical });
    const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory, request: input, evidence: { groundTruth: canonical } });
    const basis = out.request.reviewSources.requiredGroundTruthBasis;
    assert.equal(basis.required, true); assert.equal(basis.read, "ALL_PARTS_IN_OFFSET_ORDER");
    const complete = await original(basis);
    assert.deepEqual(complete.claims.map(item => item.claimId), ["R1", "G", "R2", "R3"]);
    for (const item of complete.claims) assert.deepEqual(item, canonical.claims.find(original => original.claimId === item.claimId));
    assert.ok(complete.claims.some(item => item.text.endsWith(ending)));
    assert.deepEqual(out.evidence.groundTruth.claims, []);
    assert.equal(out.evidence.groundTruth.reviewScope.claimCount, 4);
    assert.equal(out.evidence.groundTruth.reviewScope.deferredRequiredBasis, true);
    assert.deepEqual(out.evidence.groundTruth.reviewScope.requiredBasis, basis);
    assert.match(out.evidence.groundTruth.reviewScope.instructions, /not an empty requirement set/u);
    assert.deepEqual(await original(out.request.reviewSources.originalGroundTruth), canonical);
    assert.deepEqual({ input, canonical }, before);
    assert.ok(Buffer.byteLength(JSON.stringify(out.request, null, 2)) + 1 <= REVIEW_SCOPE_REQUEST_BYTES);
    await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
  });
});

test("large population descriptions remain exact and the materializer cannot re-inline captured originals", async t => {
  const f = await fixture(t), body = "完整对象描述🌻\\引号\"".repeat(6000) + "FINAL_OBJECT_CONDITION";
  const population = { version: 7, groundTruthVersion: 3, digest: "frozen-population", metricCatalog: { M12: { name: "Requirement execution" } },
    metrics: { M12: [{ objectId: "M12:R1", metricId: "M12", sourceId: "R1", sourceRevisionId: "R1@3", description: body,
      applicability: "Only after the original prerequisite.", verificationTarget: "IMPLEMENTATION", hard: true, evidenceRequired: true }] } };
  const input = request({ population, reviewScope: { boundedBasis: true, objectIds: ["M12:R1"], sourceIds: ["R1"] } });
  const evidence = { groundTruth: truth([claim("R1")]), population }, before = structuredClone({ input, evidence });
  const prepared = await prepareReviewerRequest({ requestDirectory: f.requestDirectory, request: input, evidence });
  assert.ok(Buffer.byteLength(JSON.stringify(prepared, null, 2)) + 1 <= REVIEW_SCOPE_REQUEST_BYTES);
  const object = prepared.population.metrics.M12[0];
  assert.equal(object.objectId, "M12:R1"); assert.equal(object.sourceRevisionId, "R1@3"); assert.equal(object.hard, true);
  assert.equal(object.requiredBasis.jsonPointer, "/metrics/M12/0"); assert.equal(object.requiredBasis.required, true);
  assert.deepEqual(await original(prepared.reviewSources.requiredPopulationBasis), population);
  assert.ok(!JSON.stringify(prepared).includes("FINAL_OBJECT_CONDITION"));
  const part = (await records(object.requiredBasis)).at(-1), lines = (await fs.readFile(part.path, "utf8")).split("\n");
  const start = lines.findIndex(line => line.includes("FINAL_OBJECT_CONDITION")) + 1;
  assert.ok(start > 0);
  const report = { metricObjectJudgements: [{ objectId: object.objectId, evidence: [`${part.path}#L${start}-L${start}`] }] };
  const citations = await scopedSourceCitations({ projectRoot: f.root, requestDirectory: f.requestDirectory, prepared, report });
  assert.equal(citations.length, 1); assert.equal(citations[0].frozen, true);
  assert.deepEqual(citations[0].usedBy, [object.objectId]); assert.match(citations[0].exactQuote, /FINAL_OBJECT_CONDITION/u);
  assert.deepEqual({ input, evidence }, before);
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("four metrics share one exact long Ground Truth description without repeated mandatory bodies", async t => {
  const f = await fixture(t), canonical = truth([claim("R1", "requirements", "Complete original with conditions and exceptions. ".repeat(1600))]);
  const population = { version: 2, metrics: Object.fromEntries(["M01", "M02", "M05", "M12"].map(metric => [metric, [{
    objectId: `${metric}:R1`, sourceId: "R1", sourceRevisionId: "R1@3", description: canonical.claims[0].text,
    applicability: "Only for the requested current stage.", customCondition: { exception: "Keep this exact object field." },
  }]])) };
  const input = request({ population, reviewScope: { boundedBasis: true, sourceIds: ["R1"], objectIds: Object.values(population.metrics).flat().map(row => row.objectId) } });
  const prepared = await prepareReviewerRequest({ requestDirectory: f.requestDirectory, request: input, evidence: { groundTruth: canonical, population } });
  assert.equal(prepared.reviewSources.requiredPopulationBasis, undefined);
  assert.deepEqual(await original(prepared.reviewSources.originalPopulation), population);
  assert.equal((await original(prepared.reviewSources.requiredGroundTruthBasis)).claims[0].text, canonical.claims[0].text);
  assert(Buffer.byteLength(JSON.stringify(prepared.population)) < 8192);
  for (const [metric, [object]] of Object.entries(prepared.population.metrics)) {
    assert.equal(object.descriptionBasis.kind, "EXACT_GROUND_TRUTH_TEXT");
    assert.equal(object.descriptionBasis.claimId, "R1"); assert.equal(object.descriptionBasis.revisionId, "R1@3");
    const restored = { ...object, description: canonical.claims[0].text }; delete restored.descriptionBasis;
    assert.deepEqual(restored, population.metrics[metric][0]);
  }
  assert.equal(input.population.metrics.M01[0].description, canonical.claims[0].text);
});

for (const mismatch of ["text", "revision"]) test(`description deduplication refuses a ${mismatch} mismatch`, async t => {
  const f = await fixture(t), canonical = truth([claim("R1", "requirements", "Original condition. ".repeat(1200))]);
  const population = { metrics: { M12: [{ objectId: "M12:R1", sourceId: "R1", sourceRevisionId: mismatch === "revision" ? "R1@2" : "R1@3",
    description: canonical.claims[0].text + (mismatch === "text" ? "Additional mandatory exception." : "") }] } };
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: request({ population, reviewScope: { boundedBasis: true, sourceIds: ["R1"], objectIds: ["M12:R1"] } }), evidence: { groundTruth: canonical, population } });
  assert(out.request.reviewSources.requiredPopulationBasis);
  assert.deepEqual(await original(out.request.reviewSources.requiredPopulationBasis), population);
});

test("oversized Stop instructions and other request fields are recoverable from a required request basis", async t => {
  const f = await fixture(t), instructions = ["Mandatory original instruction. ".repeat(1500) + "FINAL_INSTRUCTION_CONDITION"];
  const sourceCatalog = [{ sourceId: "user:1", text: "Original source declaration🌻".repeat(4000) + "FINAL_SOURCE_CONDITION" }];
  const input = request({ instructions, sourceCatalog, fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: null },
    reviewScope: { boundedBasis: true, objectIds: ["M12:R1"], sourceIds: ["R1"] } });
  const before = structuredClone(input);
  const prepared = await prepareReviewerRequest({ requestDirectory: f.requestDirectory, request: input, evidence: { groundTruth: truth([claim("R1")]) } });
  assert.ok(Buffer.byteLength(JSON.stringify(prepared, null, 2)) + 1 <= REVIEW_SCOPE_REQUEST_BYTES);
  assert.deepEqual(prepared.fixedStopClassification, input.fixedStopClassification);
  const basis = prepared.reviewSources.requiredRequestBasis; assert.equal(basis.required, true);
  const complete = await original(basis);
  assert.deepEqual(complete.sourceCatalog, sourceCatalog); assert.equal(complete.instructions[0], instructions[0]);
  assert.match(prepared.instructions.join(" "), /read reviewSources.requiredRequestBasis in full/u);
  assert.deepEqual(input, before);
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("the final materializer bounds references added after scope preparation", async t => {
  const f = await fixture(t), evidence = { groundTruth: truth([claim("R1")]), skillGroundTruth: { constraints: [] } };
  const base = request({ instructions: [], reviewScope: { boundedBasis: true, objectIds: ["M12:R1"], sourceIds: ["R1"] } });
  const empty = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory, request: base, evidence });
  const gap = REVIEW_SCOPE_REQUEST_BYTES - (Buffer.byteLength(JSON.stringify(empty.request, null, 2)) + 1) - 20;
  const input = { ...base, instructions: ["x".repeat(gap - 10)] };
  const scoped = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory, request: input, evidence });
  assert.equal(scoped.request.reviewSources.requiredRequestBasis, undefined);
  const prepared = await prepareReviewerRequest({ requestDirectory: f.requestDirectory, request: input, evidence });
  assert.ok(Buffer.byteLength(JSON.stringify(prepared, null, 2)) + 1 <= REVIEW_SCOPE_REQUEST_BYTES);
  assert.ok(prepared.reviewSources.requiredRequestBasis.path.includes(`${path.sep}materialized${path.sep}`));
  const complete = await original(prepared.reviewSources.requiredRequestBasis);
  assert.equal(complete.instructions[0], input.instructions[0]); assert.equal(complete.skillGroundTruthPath, prepared.skillGroundTruthPath);
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("Stop baseline alignment preserves every current claim and full task sources behind bounded navigation", async t => {
  const f = await fixture(t), canonical = { ...truth([claim("R1", "requirements", "原始需求🌻".repeat(5000)), claim("A1", "acceptanceCriteria"),
    claim("T1", "testContracts"), claim("G", "constraints")]), conflicts: [{ reason: "Unresolved original condition." }] };
  const canonicalPath = path.join(f.root, "canonical.json"); await fs.writeFile(canonicalPath, JSON.stringify(canonical));
  const snapshot = { digest: "baseline-original", lastEntryKey: "result", entries: [
    { type: "user", uuid: "user", message: { content: "Original user source🌻".repeat(3000) } },
    { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id: "tool", name: "read", input: { path: "source.txt" } }] } },
    { type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "Original material🌻".repeat(6000) + "FINAL_MATERIAL_CONDITION" }] } },
  ] };
  const input = { schemaVersion: "baseline.request", instructions: ["Align every original task source."],
    reviewScope: { kind: "baseline", boundedBasis: true, sourceIds: [], objectIds: [] }, currentGroundTruth: { path: canonicalPath, version: 3, digest: canonical.digest },
    sourceCatalog: [{ ref: "user", text: "Source authority declaration🌻".repeat(4000) }],
    userSources: [{ ref: "user", text: snapshot.entries[0].message.content }], userMessages: [snapshot.entries[0]] };
  const evidence = { groundTruth: canonical, snapshot }, before = structuredClone({ input, evidence });
  const prepared = await prepareReviewerRequest({ requestDirectory: f.requestDirectory, request: input, evidence });
  assert.equal(prepared.currentGroundTruth.path, prepared.groundTruthPath);
  assert.equal(prepared.reviewScope.originalGroundTruthPath, canonicalPath);
  assert.equal(prepared.groundTruthPath, path.join(f.requestDirectory, "ground-truth.json"));
  const basis = await original(prepared.reviewSources.requiredGroundTruthBasis);
  assert.deepEqual(basis.claims, canonical.claims); assert.deepEqual(basis.conflicts, canonical.conflicts);
  assert.deepEqual(await original(prepared.reviewSources.originalGroundTruth), canonical);
  const completeRequest = await original(prepared.reviewSources.requiredRequestBasis);
  for (const key of ["sourceCatalog", "userSources", "userMessages"]) assert.deepEqual(completeRequest[key], input[key]);
  assert.ok(!prepared.instructions.join(" ").includes("owns ONLY"));
  assert.match(prepared.instructions.join(" "), /aligns the current Ground Truth/u);
  const transcript = JSON.parse(await fs.readFile(prepared.transcript.path, "utf8"));
  assert.deepEqual(await Promise.all((await records(transcript.entryIndex)).map(row => original(row.source))), snapshot.entries);
  const pairs = await records(transcript.toolIndex), pair = await original(pairs[0].source);
  assert.equal((await original(pair.results[0].source)).message.content[0].content, snapshot.entries[2].message.content[0].content);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared, null, 2)) + 1 <= REVIEW_SCOPE_REQUEST_BYTES);
  assert.deepEqual({ input, evidence }, before); assert.equal(await fs.readFile(canonicalPath, "utf8"), JSON.stringify(canonical));
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});

test("Stop source preparation observes its deadline and cancellation before writing pages", async t => {
  const f = await fixture(t), controller = new AbortController();
  const input = { projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: { reviewScope: { boundedBasis: true, objectIds: [], sourceIds: [] } },
    evidence: { groundTruth: truth([claim("r", "requirements", "Large original. ".repeat(10000))]) } };
  await assert.rejects(prepareReviewScope({ ...input, deadlineAt: Date.now() - 1 }), { code: "REVIEWER_DEADLINE" });
  controller.abort();
  await assert.rejects(prepareReviewScope({ ...input, abortSignal: controller.signal }), { code: "REVIEWER_CANCELLED" });
  await assert.rejects(fs.access(path.join(f.requestDirectory, "review-scope")), { code: "ENOENT" });
});

test("every request finalization phase stops at the first page when cancelled during a write", async t => {
  for (const phase of ["scoped", "materialized", "native"]) await t.test(phase, async t => {
    const f = await fixture(t), controller = new AbortController(), rename = fs.rename;
    let writes = 0;
    fs.rename = async (from, to) => {
      const result = await rename(from, to);
      if (String(to).includes(`${path.sep}request-basis${path.sep}`)) { writes++; controller.abort(); }
      return result;
    };
    t.after(() => { fs.rename = rename; });
    const input = { requestDirectory: f.requestDirectory, request: { reviewScope: { boundedBasis: true, objectIds: [], sourceIds: [] },
      instructions: ["Original requirement. ".repeat(50000)] }, abortSignal: controller.signal };
    await assert.rejects(phase === "scoped"
      ? prepareReviewScope({ ...input, projectRoot: f.root })
      : finalizeReviewScopeRequest({ ...input, phase }), { code: "REVIEWER_CANCELLED" });
    assert.equal(writes, 1, "no remaining original or navigation pages may be written after cancellation");
  });
});

test("request finalization checks an expired deadline even when no paging is needed", async t => {
  const f = await fixture(t);
  await assert.rejects(finalizeReviewScopeRequest({ requestDirectory: f.requestDirectory,
    request: { reviewScope: { boundedBasis: true } }, deadlineAt: Date.now() - 1 }), { code: "REVIEWER_DEADLINE" });
  await assert.rejects(fs.access(f.requestDirectory), { code: "ENOENT" });
  const ordinary = { reviewScope: { boundedBasis: false } };
  assert.equal(await finalizeReviewScopeRequest({ requestDirectory: f.requestDirectory, request: ordinary, deadlineAt: 0 }), ordinary);
});

test("materialized request paging receives cancellation after scope preparation", async t => {
  const f = await fixture(t), evidence = { groundTruth: truth([claim("R1")]), skillGroundTruth: { constraints: [] } };
  const base = request({ instructions: [], reviewScope: { boundedBasis: true, objectIds: ["M12:R1"], sourceIds: ["R1"] } });
  const empty = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory, request: base, evidence });
  const gap = REVIEW_SCOPE_REQUEST_BYTES - (Buffer.byteLength(JSON.stringify(empty.request, null, 2)) + 1) - 20;
  const input = { ...base, instructions: ["x".repeat(gap - 10)] }, controller = new AbortController(), rename = fs.rename;
  let writes = 0;
  fs.rename = async (from, to) => {
    const result = await rename(from, to);
    if (String(to).includes(`${path.sep}request-basis${path.sep}materialized${path.sep}`)) { writes++; controller.abort(); }
    return result;
  };
  t.after(() => { fs.rename = rename; });
  await assert.rejects(prepareReviewerRequest({ requestDirectory: f.requestDirectory, request: input, evidence,
    abortSignal: controller.signal }), { code: "REVIEWER_CANCELLED" });
  assert.equal(writes, 1);
});

test("bounded Stop classification materializes only genuine users and the latest assistant text", async t => {
  const f = await fixture(t), snapshot = { digest: "full-source", lastEntryKey: "internal", entries: [
    { type: "user", uuid: "u", message: { content: "Original request." } },
    { type: "assistant", uuid: "old", message: { content: "Earlier status." } },
    { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id: "t", name: "exec", input: { command: "check" } }] } },
    { type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "TOOL_HISTORY_MUST_NOT_BE_COPIED".repeat(2000) }] } },
    { type: "assistant", uuid: "final", message: { content: "Current completion statement." } },
    { type: "user", uuid: "internal", isMeta: true, message: { content: "[runtime-corrector:internal] Private role state." } },
  ] };
  const out = await prepareReviewScope({ projectRoot: f.root, requestDirectory: f.requestDirectory,
    request: { reviewScope: { kind: "classification", boundedBasis: true, objectIds: [], sourceIds: [] } }, evidence: {
      snapshot, groundTruth: truth([claim("goal", "goals", "Old detailed goals. ".repeat(2000))]) } });
  const transcript = JSON.parse(await fs.readFile(out.request.transcript.path, "utf8"));
  assert.equal(transcript.classificationOnly, true); assert.equal(transcript.sourceEntryCount, 6);
  assert.deepEqual((await records(transcript.entryIndex)).map(row => row.key), ["u", "final"]);
  assert.deepEqual((await records(transcript.classificationIndex)).map(row => row.key), ["u", "final"]);
  assert.deepEqual(await records(transcript.toolIndex), []);
  assert.equal(transcript.latestUser.key, "u");
  assert.equal(transcript.latestAssistant.key, "final");
  assert(out.request.reviewSources.classificationBasis);
  assert.equal(out.request.reviewSources.requiredGroundTruthBasis, undefined,
    "scope selection must not require reading all old goals before any item can start");
  assert.match(out.request.instructions.join(" "), /ONLY classifies the current Stop/u);
  for (const file of await fs.readdir(path.join(f.requestDirectory, "review-scope")))
    assert.ok(!(await fs.readFile(path.join(f.requestDirectory, "review-scope", file), "utf8")).includes("TOOL_HISTORY_MUST_NOT_BE_COPIED"));
  await assertBoundedPages(path.join(f.requestDirectory, "review-scope"));
});
