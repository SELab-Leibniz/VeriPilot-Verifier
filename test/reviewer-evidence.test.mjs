import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareReviewerRequest } from "../lib/runtime-v2/reviewer-evidence.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";


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
    skillSource: { files: [{ path: "SKILL.md", content: "Read the guide if provided." }] },
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
  evidence.skillSource.files[0].content = "Read before every edit.";
  evidence.semanticRequest.specification.criteria = "Mutated criteria.";
  const prepared = await pending;

  assert.deepEqual(prepared.instructions, ["Original instructions."]);
  assert.equal(prepared.currentGroundTruth.version, 4);
  assert.equal((await readJson(prepared.transcript.path)).entries[0].message.content, "Original user evidence.");
  assert.deepEqual(prepared.transcript, { path: path.join(root, "transcript.json"), digest: "source-digest", cursor: "u1" });
  assert.equal((await readJson(prepared.groundTruthPath)).claims[0].text, "Original claim.");
  assert.equal(prepared.population.metrics.M01[0].objectId, "object-1");
  assert.equal((await readJson(prepared.skillGroundTruthPath)).constraints[0].statement, "Original constraint.");
  assert.equal((await readJson(prepared.skillSourcePath)).files[0].content, "Read the guide if provided.");
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

test('recent whole-entry navigation exposes later edits and real checks beyond a long planning prefix', async t => {
  const root = await workspace(t);
  const entries = [
    { type: 'user', uuid: 'planning', sourceMessageId: 'proposal:user', message: { content: 'Complete planning only. ' + 'Long historical planning context. '.repeat(12000) } },
    { type: 'user', uuid: 'apply', sourceMessageId: 'apply:user', message: { content: 'The plan is approved. Implement it and run the required checks.' } },
    { type: 'assistant', uuid: 'edit-call', message: { content: [{ type: 'tool_use', id: 'edit-1', name: 'edit', input: { path: 'app.py', oldText: 'return 0', newText: 'return 1' } }] } },
    { type: 'user', uuid: 'edit-result', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated app.py.' }] } },
    { type: 'assistant', uuid: 'check-call', message: { content: [{ type: 'tool_use', id: 'check-1', name: 'project_check', input: { action: 'test' } }] } },
    { type: 'user', uuid: 'check-result', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'check-1', content: { exitCode: 0, outputComplete: true, counts: { PASS: 3 }, snapshotSha256: 'a'.repeat(64) } }] } },
  ];
  await fs.writeFile(path.join(root, 'auth-store.json'), 'UNRELATED_AUTH_STORE_SENTINEL');
  const prepared = await prepareReviewerRequest({ requestDirectory: path.join(root, 'review'), request: {},
    evidence: { snapshot: { entries, digest: 'frozen-digest', lastEntryKey: 'check-result',
      invocation: { runId: 'apply', sessionId: 'session', auth: 'DO_NOT_COPY_INVOCATION_FIELDS' } },
      semanticRequest: { artifactFiles: ['plan.md'], runtimeV2: {} } } });
  const full = await fs.readFile(prepared.transcript.path), recent = await fs.readFile(prepared.transcriptNavigation.path);
  const navigation = JSON.parse(recent), fullLines = full.toString().split('\n');
  assert(full.length > 318 * 1024, 'the full history exceeds a normal prefix-only read');
  assert(recent.length <= 24 * 1024);
  assert.equal(sha256(recent), prepared.transcriptNavigation.sha256);
  assert.equal(navigation.source.sha256, sha256(full));
  assert.equal(navigation.source.digest, 'frozen-digest');
  assert.equal(navigation.source.cursor, 'check-result');
  assert.equal(navigation.source.entryCount, entries.length);
  assert.deepEqual(navigation.invocation, { runId: 'apply', sessionId: 'session' });
  assert.equal(navigation.latestExternalUser.sourceMessageId, 'apply:user');
  assert.equal(navigation.complete, false);
  assert.equal(navigation.omittedEntryCount, 1);
  assert.deepEqual(navigation.entries.map(row => row.sourceIndex), [1, 2, 3, 4, 5]);
  for (const row of navigation.entries) assert.deepEqual(row.entry, entries[row.sourceIndex], 'selected entries are whole original values');
  for (const ref of [navigation.latestExternalUser, ...navigation.recentToolResults, ...navigation.recentToolResults.map(row => row.call)]) {
    const exactEntry = fullLines.slice(ref.startLine - 1, ref.startLine - 1 + ref.lineCount).join('\n').replace(/,\s*$/u, '');
    assert.deepEqual(JSON.parse(exactEntry), entries[ref.index], 'full-transcript offsets retrieve the exact original entry');
    assert.equal(ref.sha256, sha256(entries[ref.index]));
  }
  assert.match(navigation.instructions, /Missing or unread evidence is UNVERIFIED, never proof that an action did not occur/);
  assert.doesNotMatch(recent.toString(), /UNRELATED_AUTH_STORE_SENTINEL|DO_NOT_COPY_INVOCATION_FIELDS|Complete planning only/);
  assert.deepEqual(await readJson(prepared.transcript.path), { entries }, 'earlier authority remains in the full snapshot');
  assert.deepEqual((await readJson(prepared.semanticReviewRequestPath)).runtimeV2.transcriptNavigation, prepared.transcriptNavigation);
});

test('oversized latest entries stay explicitly omitted with exact full-source navigation', async t => {
  const root = await workspace(t);
  const entries = [
    { type: 'user', uuid: 'u', sourceMessageId: 'run:user', message: { content: 'Current task.' } },
    { type: 'user', uuid: 'result', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'check', content: 'Uncut output. '.repeat(10000) }] } },
  ];
  const prepared = await prepareReviewerRequest({ requestDirectory: root, request: {}, evidence: { snapshot: { entries } } });
  const navigation = await readJson(prepared.transcriptNavigation.path);
  assert.equal(navigation.complete, false);
  assert.equal(navigation.omittedEntryCount, 1);
  assert.deepEqual(navigation.entries.map(row => row.entry), [entries[0]]);
  assert.equal(navigation.recentToolResults[0].index, 1);
  assert.equal(navigation.recentToolResults[0].toolUseId, 'check');
  assert.equal(navigation.recentToolResults[0].call, undefined, 'an unavailable call must not be invented');
  assert.deepEqual((await readJson(prepared.transcript.path)).entries[1], entries[1]);
  assert((await fs.stat(prepared.transcriptNavigation.path)).size <= 24 * 1024);
});

test('empty history does not invent a run, phase, user or execution result', async t => {
  const root = await workspace(t);
  const prepared = await prepareReviewerRequest({ requestDirectory: root, request: {}, evidence: { snapshot: { entries: [] } } });
  const navigation = await readJson(prepared.transcriptNavigation.path);
  assert.deepEqual(navigation.entries, []);
  assert.deepEqual(navigation.recentToolResults, []);
  assert.equal(navigation.latestExternalUser, null);
  assert.equal(navigation.invocation, undefined);
  assert.equal(navigation.complete, true);
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
