import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareReviewerRequest } from "../lib/runtime-v2/reviewer-evidence.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}


test("request preparation without evidence returns an isolated request and leaves request.json to its caller", async (t) => {
  const root = await workspace(t);
  const request = { schemaVersion: "review.v2", instructions: ["Assess this task."] };
  const prepared = await prepareReviewerRequest({ requestDirectory: root, request });
  request.instructions.push("Later mutation.");
  assert.deepEqual(prepared, { schemaVersion: "review.v2", instructions: ["Assess this task."] });
  assert.deepEqual(await fs.readdir(root), []);
});


test("preparation captures every supplied object before asynchronous writes can observe caller mutations", async (t) => {
  const root = await workspace(t);
  const request = { instructions: ["Original instructions."], currentGroundTruth: { path: "/old/current.json", version: 4 } };
  const evidence = {
    snapshot: {
      entries: [{ type: "user", uuid: "u1", message: { content: "Original user evidence." } }],
      digest: "source-digest",
      lastEntryKey: "u1",
    },
    groundTruth: { version: 4, claims: [{ text: "Original claim." }] },
    population: { metrics: { M01: [{ objectId: "object-1" }] } },
    skillGroundTruth: { constraints: [{ statement: "Original constraint." }] },
    semanticRequest: { version: 1, specification: { criteria: "Original criteria." }, runtimeV2: {} },
  };
  const pending = prepareReviewerRequest({ requestDirectory: root, request, evidence });
  request.instructions[0] = "Mutated instructions.";
  request.currentGroundTruth.version = 5;
  evidence.snapshot.entries[0].message.content = "Mutated user evidence.";
  evidence.snapshot.digest = "mutated-digest";
  evidence.snapshot.lastEntryKey = "u2";
  evidence.groundTruth.claims[0].text = "Mutated claim.";
  evidence.population.metrics.M01[0].objectId = "object-2";
  evidence.skillGroundTruth.constraints[0].statement = "Mutated constraint.";
  evidence.semanticRequest.specification.criteria = "Mutated criteria.";
  const prepared = await pending;

  assert.deepEqual(prepared.instructions, ["Original instructions."]);
  assert.equal(prepared.currentGroundTruth.version, 4);
  assert.equal((await readJson(prepared.transcript.path)).entries[0].message.content, "Original user evidence.");
  assert.deepEqual(prepared.transcript, { path: path.join(root, "transcript.json"), digest: "source-digest", cursor: "u1" });
  assert.equal((await readJson(prepared.groundTruthPath)).claims[0].text, "Original claim.");
  assert.equal(prepared.population.metrics.M01[0].objectId, "object-1");
  assert.equal((await readJson(prepared.skillGroundTruthPath)).constraints[0].statement, "Original constraint.");
  assert.equal((await readJson(prepared.semanticReviewRequestPath)).specification.criteria, "Original criteria.");
});


test("transcript evidence retains complete entries and source cursor identity without truncation", async (t) => {
  const root = await workspace(t);
  const entries = Array.from({ length: 250 }, (_, index) => ({
    uuid: `entry-${index}`,
    type: index % 2 ? "assistant" : "user",
    message: { content: [{ type: "text", text: `Entry ${index}: ${"x".repeat(5000)}` }] },
  }));
  entries.push({ type: "user", uuid: "tool-result", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Verified." }] } });
  const prepared = await prepareReviewerRequest({
    requestDirectory: root,
    request: { transcript: { path: "/old/transcript.jsonl", digest: "obsolete", cursor: "obsolete" } },
    evidence: { snapshot: { entries, digest: "raw-source-transcript-digest", lastEntryKey: "tool-result" } },
  });
  assert.deepEqual(await readJson(prepared.transcript.path), { entries });
  assert.equal(prepared.transcript.digest, "raw-source-transcript-digest");
  assert.equal(prepared.transcript.cursor, "tool-result");
  await assert.rejects(fs.access(path.join(root, "request.json")), { code: "ENOENT" });
});


test("semantic and role evidence paths remain readable after their source directory is deleted", async (t) => {
  const root = await workspace(t);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "current.json"), JSON.stringify({ version: 99 }), "utf8");
  const oldGroundTruthPath = path.join(source, "current.json");
  const oldTranscriptPath = path.join(source, "transcript.jsonl");
  const oldSkillPath = path.join(source, "skill.json");
  const request = {
    schemaVersion: "artifact-role-request.v2",
    groundTruthPath: oldGroundTruthPath,
    currentGroundTruth: { path: oldGroundTruthPath, version: 4 },
    skillGroundTruthPath: oldSkillPath,
    semanticReviewRequestPath: path.join(source, "semantic.json"),
  };
  const evidence = {
    snapshot: { entries: [{ uuid: "fixed-cursor", type: "user", message: { content: "Fixed task." } }], digest: "fixed-digest", lastEntryKey: "fixed-cursor" },
    groundTruth: { version: 4, claims: [] },
    population: { metrics: { M01: [{ objectId: "frozen-object" }] } },
    skillGroundTruth: { constraints: [{ statement: "Verify first." }] },
    semanticRequest: {
      version: 1,
      artifactFiles: ["result.md"],
      runtimeV2: {
        groundTruthPath: oldGroundTruthPath,
        skillGroundTruthPath: oldSkillPath,
        transcript: { path: oldTranscriptPath, digest: "old-digest", cursor: "old-cursor" },
        transcriptDigest: "old-digest",
        transcriptCursor: "old-cursor",
        population: { metrics: {} },
      },
    },
  };
  await fs.rm(source, { recursive: true });
  const prepared = await prepareReviewerRequest({ requestDirectory: target, request, evidence });
  const semantic = await readJson(prepared.semanticReviewRequestPath);

  assert.equal(prepared.schemaVersion, "artifact-role-request.v2");
  assert.equal(prepared.currentGroundTruth.path, prepared.groundTruthPath);
  assert.equal(prepared.groundTruthPath, path.join(target, "ground-truth.json"));
  assert.deepEqual(await readJson(prepared.groundTruthPath), { version: 4, claims: [] });
  assert.deepEqual(await readJson(prepared.skillGroundTruthPath), { constraints: [{ statement: "Verify first." }] });
  assert.equal(semantic.version, 1);
  assert.deepEqual(semantic.artifactFiles, ["result.md"]);
  assert.equal(semantic.runtimeV2.groundTruthPath, prepared.groundTruthPath);
  assert.equal(semantic.runtimeV2.skillGroundTruthPath, prepared.skillGroundTruthPath);
  assert.deepEqual(semantic.runtimeV2.transcript, prepared.transcript);
  assert.equal(semantic.runtimeV2.transcriptDigest, "fixed-digest");
  assert.equal(semantic.runtimeV2.transcriptCursor, "fixed-cursor");
  assert.deepEqual(semantic.runtimeV2.population, { metrics: { M01: [{ objectId: "frozen-object" }] } });
  assert.ok(!JSON.stringify({ prepared, semantic }).includes(source), "prepared requests must not retain deleted source paths");
  for (const filePath of [prepared.transcript.path, prepared.groundTruthPath, prepared.skillGroundTruthPath, prepared.semanticReviewRequestPath]) {
    assert.equal(path.dirname(filePath), target);
    await fs.access(filePath);
  }
});


test("unserializable evidence fails before any files are written", async (t) => {
  const root = await workspace(t);
  const circular = {};
  circular.self = circular;
  for (const groundTruth of [circular, { revision: 1n }]) {
    await assert.rejects(prepareReviewerRequest({
      requestDirectory: root,
      request: {},
      evidence: { snapshot: { entries: [], digest: "empty", lastEntryKey: null }, groundTruth },
    }), TypeError);
    assert.deepEqual(await fs.readdir(root), []);
  }
});
