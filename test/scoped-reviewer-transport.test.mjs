import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { registerReviewerProgress } from "../lib/openclaw/reviewer-progress.mjs";
import { IMPL_REVIEW_SCHEMA, runImplementationReview } from "../lib/runtime-v2/impl-review.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { REVIEW_SCOPE_REQUEST_BYTES } from "../lib/runtime-v2/review-scope.mjs";
import { ensureTask, taskDirectory, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson, sha256 } from "../lib/runtime-v2/utils.mjs";

const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
const output = value => ({ payloads: [{ text: typeof value === "string" ? value : JSON.stringify(value) }], meta: {} });
const rowsOf = request => Object.values(request.population.metrics).flat();
async function records(descriptor) {
  const page = await json(descriptor.path);
  return page.kind === "records" ? page.records : (await Promise.all(page.pages.map(records))).flat();
}
async function sourceSelection(descriptor, needle) {
  for (const part of await records(descriptor)) {
    const lines = (await fs.readFile(part.path, "utf8")).split("\n");
    const line = lines.findIndex(value => value.includes(needle));
    if (line >= 0) return { path: part.path, start: line + 1, end: line + 1 };
  }
  throw new Error(`Missing controlled original marker ${needle}`);
}

async function fixture(t, { hugeSecond = false, withSpaces = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), withSpaces ? "rc scoped native 空 格-" : "rc-scoped-native-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "scoped-business-host" });
  const source = path.join(root, "src", "service.mjs");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "export const currentValue = 1;\n// controlled production evidence\n");
  const unlisted = path.join(root, "unlisted.txt"); await fs.writeFile(unlisted, "This is outside the production manifest.\n");
  const claims = ["R1", "R2", "R3"].map(id => ({ claimId: id, revisionId: `${id}@3`, category: "requirements",
    status: "ACTIVE", severity: "HARD", authority: "USER_EXPLICIT", verificationTarget: "IMPLEMENTATION",
    text: id === "R2" && hugeSecond ? "UNRELATED_LARGE_ORIGINAL 原始业务要求🌻 ".repeat(9000) : `Inspect the current production behavior for ${id}.` }));
  claims.push({ claimId: "G", revisionId: "G@3", category: "constraints", status: "ACTIVE", severity: "HARD",
    authority: "USER_EXPLICIT", text: "Preserve every protected file and report actual evidence." });
  const groundTruth = { schemaVersion: "runtime-corrector.ground-truth.v2", taskId: task.taskId, version: 3,
    frozenAtVersion: 3, digest: sha256(claims), claims };
  const groundTruthPath = path.join(taskDirectory(root, task.taskId), "ground-truth", "current.json");
  await atomicWriteJson(groundTruthPath, groundTruth);
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => {
    state.groundTruth.version = 3; state.groundTruth.digest = groundTruth.digest; state.groundTruth.frozenAtVersion = 3;
  });
  const object = (id, metric = "M12") => ({ objectId: `${metric}:${id}`, metricId: metric, sourceId: id,
    sourceRevisionId: `${id}@3`, description: groundTruth.claims.find(claim => claim.claimId === id).text,
    hard: true, evidenceRequired: true, verificationTarget: "IMPLEMENTATION" });
  const population = (ids, metric = "M12") => ({ taskId: task.taskId, version: 1, groundTruthVersion: 3,
    digest: sha256(ids), metrics: { [metric]: ids.map(id => object(id, metric)) } });
  const snapshot = { digest: "captured-original-transcript", lastEntryKey: "result-1", entries: [
    { type: "user", uuid: "user-1", message: { content: "Inspect the requested current output." } },
    { type: "assistant", uuid: "call-1", message: { content: [{ type: "tool_use", id: "exec-1", name: "exec", input: { command: "node controlled-check.mjs" } }] } },
    { type: "user", uuid: "result-1", message: { content: [{ type: "tool_result", tool_use_id: "exec-1",
      content: "Original returned data🌻\n".repeat(3000) + "CONTROLLED_EVIDENCE_END" }] } },
  ] };
  return { root, taskId: task.taskId, source, unlisted, groundTruth, groundTruthPath, population, snapshot };
}

function native(f, runner, options = {}) {
  let toolFactory;
  const calls = [];
  const api = { rootDir: path.resolve("."), config: { agents: { defaults: { model: { primary: "fixture/scoped-checker" } } } },
    registerTool: factory => { toolFactory = factory; }, runtime: { agent: { runEmbeddedAgent: async params => {
      const requestPath = path.join(path.dirname(params.sessionFile), "request.json");
      const request = await json(requestPath); calls.push({ params, request, requestPath });
      const tool = toolFactory({ sessionId: params.sessionId, workspaceDir: f.root });
      return runner({ params, request, requestPath, tool });
    } } } };
  registerReviewerProgress(api);
  return { factory: createOpenClawReviewerFactory(api, options), calls };
}

function stopInput(f) {
  const population = f.population(["R1"], "M01");
  return { projectRoot: f.root, taskId: f.taskId, role: "stop-reviewer", schema: STOP_REVIEW_SCHEMA,
    reviewer: { timeoutMs: 5000, formatRepairAttempts: 0 }, request: { groundTruthPath: f.groundTruthPath, population,
      instructions: ["Assess the supplied original obligation."], reviewScope: { objectIds: ["M01:R1"], sourceIds: ["R1"] } },
    evidence: { groundTruth: f.groundTruth, population, snapshot: f.snapshot } };
}

test("same-task cached private request and evidence pages remain owned by their original native session", async t => {
  for (const closeOrigin of [false, true]) await t.test(closeOrigin ? "origin closed" : "origin live", async t => {
    const f = await fixture(t);
    let foreignReferences = [], calls = 0;
    const n = native(f, async ({ request, requestPath, tool }) => {
      calls++;
      if (calls === 1) {
        const navigation = await json(request.transcript.path);
        const entry = (await records(navigation.entryIndex)).find(entry => entry.key === "result-1");
        const page = await sourceSelection(entry.source, "CONTROLLED_EVIDENCE_END");
        foreignReferences = [`${requestPath}#L1-L1`, `${page.path}#L${page.start}-L${page.end}`];
      } else {
        for (const ref of foreignReferences) {
          const [file, range] = ref.split("#L"), start = Number(range.split("-")[0]);
          await assert.rejects(tool.execute("foreign-source", { action: "save", item: {
            objectId: "M01:R1", state: "COMPLETED", judgement: "PASS", reason: "A different role produced this private file.",
            refs: [{ path: file, start, end: start }], unresolved: [],
          } }));
        }
      }
      return output({ summary: "Controlled source selection.", stopClassification: "TASK_COMPLETE", stage: null, findings: [],
        metricObjectJudgements: [{ objectId: "M01:R1", judgement: "PASS", reason: "Controlled source reference.", evidence: foreignReferences }] });
    });
    const origin = await n.factory(stopInput(f));
    assert.equal(origin.sourceCitations.length, 2);
    foreignReferences.push(...origin.sourceCitations.map(citation => citation.selection));
    if (closeOrigin) await origin.close();
    const current = await n.factory(stopInput(f));
    assert.deepEqual(current.sourceCitations, [], "A task cache hit cannot import foreign private evidence or its durable alias.");
    assert.deepEqual(await current.getSourceCitations(current.result), []);
    await current.close();
    if (!closeOrigin) await origin.close();
    assert.equal(calls, 2);
  });
});

test("implementation citation lookup enforces its manifest even for business files cached by another native role", async t => {
  const f = await fixture(t);
  let calls = 0;
  const n = native(f, async () => {
    calls++;
    return output({ summary: "Controlled business source selection.", ...(calls === 1 ? { stopClassification: "TASK_COMPLETE", stage: null } : {}),
      findings: [], metricObjectJudgements: [{ objectId: "M01:R1", judgement: "PASS", reason: "Controlled source reference.",
        evidence: [`${f.unlisted}#L1-L1`] }] });
  });
  const origin = await n.factory(stopInput(f));
  assert.equal(origin.sourceCitations.length, 1);
  await origin.close();
  const input = stopInput(f);
  const implementation = await n.factory({ ...input, role: "implementation-reviewer", schema: IMPL_REVIEW_SCHEMA,
    request: { ...input.request, sourceManifest: [{ path: f.source, sha256: sha256(await fs.readFile(f.source)) }] } });
  assert.deepEqual(implementation.sourceCitations, []);
  assert.deepEqual(await implementation.getSourceCitations({ metricObjectJudgements: [{ objectId: "M01:R1",
    evidence: [origin.sourceCitations[0].selection] }] }), []);
  await implementation.close();
});

test("scoped native transport uses a local claim schema and saves paged original citations beyond session cleanup", async t => {
  const f = await fixture(t, { hugeSecond: true }), before = await fs.readFile(f.groundTruthPath, "utf8");
  let originalPage, requestDirectory;
  const n = native(f, async ({ params, request, requestPath, tool }) => {
    requestDirectory = path.dirname(requestPath);
    assert.ok(Buffer.byteLength(await fs.readFile(requestPath, "utf8")) <= REVIEW_SCOPE_REQUEST_BYTES);
    assert.ok(!JSON.stringify(request).includes("UNRELATED_LARGE_ORIGINAL"));
    assert.ok(!params.extraSystemPrompt.includes('"R2"'), "The findings schema must not repeat unassigned canonical claim IDs.");
    assert.ok(params.extraSystemPrompt.includes('"R1"'));
    assert.deepEqual((await json(request.groundTruthPath)).claims.map(claim => claim.claimId), ["R1", "G"]);
    const navigation = await json(request.transcript.path);
    const entry = (await records(navigation.entryIndex)).find(entry => entry.key === "result-1");
    originalPage = await sourceSelection(entry.source, "CONTROLLED_EVIDENCE_END");
    await assert.rejects(tool.execute("foreign", { action: "save", item: { objectId: "M01:R2", state: "COMPLETED",
      judgement: "PASS", reason: "Unassigned item.", refs: [originalPage], unresolved: [] } }), /OBJECT_NOT_AUTHORIZED/u);
    const refs = [originalPage, { path: request.groundTruthPath, start: 1, end: 1 }];
    await tool.execute("save", { action: "save", item: { objectId: "M01:R1", state: "COMPLETED", judgement: "DEVIATION",
      reason: "The returned original evidence contradicts the assigned output claim.", refs, unresolved: [] } });
    return output({ summary: "Compared current original evidence.", stopClassification: "TASK_COMPLETE", stage: null, findings: [],
      metricObjectJudgements: [{ objectId: "M01:R1", judgement: "DEVIATION", reason: "The original result contradicts the assigned claim.",
        evidence: refs.map(ref => `${ref.path}#L${ref.start}-L${ref.end}`) }] });
  });
  const handle = await n.factory(stopInput(f));
  assert.equal(handle.sourceCitations.length, 2);
  assert.ok(handle.sourceCitations.every(citation => citation.frozen));
  await handle.close();
  await assert.rejects(fs.access(requestDirectory), { code: "ENOENT" });
  await assert.rejects(fs.access(originalPage.path), { code: "ENOENT" });
  for (const citation of handle.sourceCitations) {
    const lines = (await fs.readFile(citation.snapshotPath, "utf8")).split("\n");
    assert.equal(lines.slice(citation.start - 1, citation.end).join("\n"), citation.exactQuote);
  }
  assert.equal(await fs.readFile(f.groundTruthPath, "utf8"), before);
});

test("scoped native transport binds full original citations in project paths containing spaces", async t => {
  const f = await fixture(t, { withSpaces: true });
  const n = native(f, async ({ request, tool }) => {
    const navigation = await json(request.transcript.path);
    const entry = (await records(navigation.entryIndex)).find(entry => entry.key === "result-1");
    const page = await sourceSelection(entry.source, "CONTROLLED_EVIDENCE_END");
    const refs = [page, { path: request.groundTruthPath, start: 1, end: 1 }];
    await tool.execute("save", { action: "save", item: { objectId: "M01:R1", state: "COMPLETED", judgement: "PASS",
      reason: "Checked the original evidence at full paths containing spaces.", refs, unresolved: [] } });
    return output({ summary: "Checked the assigned original source.", stopClassification: "TASK_COMPLETE", stage: null,
      findings: [], metricObjectJudgements: [{ objectId: "M01:R1", judgement: "PASS", reason: "The selected original matches.",
        evidence: refs.map(ref => `${ref.path}#L${ref.start}-L${ref.end}`) }] });
  });
  const handle = await n.factory(stopInput(f));
  assert.equal(handle.sourceCitations.length, 2);
  assert(handle.sourceCitations.every(citation => citation.frozen));
  assert(handle.sourceCitations.some(citation => citation.exactQuote.includes("CONTROLLED_EVIDENCE_END")));
  await handle.close();
  for (const citation of handle.sourceCitations) await fs.access(citation.snapshotPath);
});

test("changing an unassigned canonical claim invalidates scoped native partial recovery", async t => {
  const f = await fixture(t, { hugeSecond: true });
  const n = native(f, async ({ tool }) => {
    await tool.execute("save", { action: "save", item: { objectId: "M01:R1", state: "COMPLETED", judgement: "PASS",
      reason: "The selected current file establishes this item.", refs: [{ path: f.source, start: 1, end: 2 }], unresolved: [] } });
    const changed = structuredClone(f.groundTruth);
    changed.claims.find(claim => claim.claimId === "R2").text = "A genuine later change outside this local disclosure.";
    changed.version = 4; changed.digest = sha256(changed.claims);
    await atomicWriteJson(f.groundTruthPath, changed);
    return output("{ malformed terminal result");
  });
  await assert.rejects(n.factory(stopInput(f)), error => {
    assert.equal(error.partialReview, undefined, "A frozen local view must not bypass changes to the canonical baseline."); return true;
  });
  assert.equal(n.calls.length, 1);
});

test("scoped implementation transport retains exact production ownership for relative and absolute manifests", async t => {
  for (const absolute of [false, true]) await t.test(absolute ? "absolute manifest" : "relative manifest", async t => {
    const f = await fixture(t, { hugeSecond: true });
    const population = f.population(["R1"]);
    const n = native(f, async ({ request, tool }) => {
      assert.equal(request.sourceManifest, undefined);
      const manifest = await records(request.reviewSources.sourceManifest);
      assert.equal(manifest.length, 1);
      for (const forbidden of [request.groundTruthPath, f.unlisted]) await assert.rejects(tool.execute("wrong-owner", {
        action: "save", item: { objectId: "M12:R1", state: "COMPLETED", judgement: "PASS", reason: "Wrong evidence owner.",
          refs: [{ path: forbidden, start: 1, end: 1 }], unresolved: [] } }), /NOT_OWNED_BY_IMPLEMENTATION/u);
      await tool.execute("owned", { action: "save", item: { objectId: "M12:R1", state: "COMPLETED", judgement: "PASS",
        reason: "The production source establishes this obligation.", refs: [{ path: f.source, start: 1, end: 2 }], unresolved: [] } });
      return output({ summary: "Reviewed production code.", findings: [], metricObjectJudgements: [{ objectId: "M12:R1", judgement: "PASS",
        reason: "The production code establishes this obligation.", evidence: [`${f.source}#L1-L2`] }] });
    });
    const handle = await n.factory({ projectRoot: f.root, taskId: f.taskId, role: "implementation-reviewer", schema: IMPL_REVIEW_SCHEMA,
      reviewer: { timeoutMs: 5000, formatRepairAttempts: 0 }, request: { groundTruthPath: f.groundTruthPath, population,
        sourceManifest: [{ path: absolute ? f.source : "src/service.mjs", sha256: sha256(await fs.readFile(f.source)) }],
        reviewScope: { objectIds: ["M12:R1"], sourceIds: ["R1"] } } });
    assert.equal(handle.result.metricObjectJudgements[0].judgement, "PASS");
    assert.equal(handle.sourceCitations.length, 1); assert.equal(handle.sourceCitations[0].frozen, false);
    await handle.close(); await fs.access(handle.sourceCitations[0].snapshotPath);
  });
});

test("implementation review dispatches short native tasks and preserves siblings when a single obligation exceeds the input budget", async t => {
  for (const hugeSecond of [false, true]) await t.test(hugeSecond ? "oversized middle obligation" : "all obligations fit", async t => {
    const f = await fixture(t, { hugeSecond }), before = await fs.readFile(f.groundTruthPath, "utf8");
    const n = native(f, async ({ request }) => {
      const rows = rowsOf(request); assert.equal(rows.length, 1);
      assert.equal(request.sourceManifest, undefined);
      assert.ok(request.reviewSources.sourceManifest.path);
      return output({ summary: "Compared production code for the assigned obligation.", findings: [], metricObjectJudgements: rows.map(row => ({
        objectId: row.objectId, judgement: "PASS", reason: "The current production source establishes this obligation.", evidence: [`${f.source}#L1-L2`] })) });
    });
    let deviceCalls = 0;
    const result = await runImplementationReview({ projectRoot: f.root, sessionCwd: f.root, taskId: f.taskId,
      parentSessionId: "business-host", runtimeV2: { locale: "en", reviewers: { implementationReviewer: { timeoutMs: 10000, formatRepairAttempts: 0 } },
        implementationCorrection: { platform: null }, dynamicGroundTruth: { materialRoots: [] } }, reviewerFactory: n.factory,
      population: f.population(["R1", "R2", "R3"]), groundTruth: f.groundTruth, groundTruthPath: f.groundTruthPath,
      rootCauseIds: ["IMPLEMENTATION_BEHAVIOR_MISMATCH"], deviceVerifier: async () => {
        deviceCalls++;
        return { assurance: { level: "static", reason: "No device runtime in this controlled fixture." },
          build: { status: "NOT_EXECUTED" }, smoke: { status: "NOT_EXECUTED" }, findings: [] };
      } });
    assert.equal(deviceCalls, 1, "Deterministic device work must not repeat per obligation.");
    assert.equal(result.sourceManifestCount, 1);
    assert.equal(result.status, hugeSecond ? "FAILED" : "COMPLETED");
    assert.equal(result.collection.complete, !hugeSecond);
    assert.deepEqual(result.metricObjectJudgements.map(row => row.judgement), ["PASS", hugeSecond ? "UNVERIFIED" : "PASS", "PASS"]);
    assert.equal(n.calls.length, hugeSecond ? 2 : 3);
    assert.equal(new Set(n.calls.map(call => call.params.sessionId)).size, n.calls.length);
    if (hugeSecond) assert.equal(result.collection.failures[0].code, "REVIEW_SCOPE_TOO_LARGE");
    for (const item of result.collection.items) await fs.access(item.path);
    for (const citation of result.sourceCitations) await fs.access(citation.snapshotPath);
    assert.equal(await fs.readFile(f.groundTruthPath, "utf8"), before);
  });
});
