import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanSkillDirectory } from "../lib/runtime-v2/skill-source.mjs";
import { createSkillCare } from "../lib/runtime-v2/skill-care.mjs";
import { prepareReviewerRequest } from "../lib/runtime-v2/reviewer-evidence.mjs";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { registerReviewerProgress } from "../lib/openclaw/reviewer-progress.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";
import { SKILL_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-skill-care-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skill = path.join(root, "skills", "demo");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "# Verify\nRun validation before completion.\n");
  const source = await scanSkillDirectory(skill);
  const task = await ensureTask({ projectRoot: root, sessionId: "host" });
  const request = { watcher: { skillId: "demo" } };
  const evidence = { skillSource: source, skillGroundTruth: { constraints: [
    { constraintId: "verify", kind: "STEP", modality: "MUST", statement: "Run validation before completion.", sourceRef: "SKILL.md:2" },
  ] }, groundTruth: { digest: "truth-1" }, snapshot: { digest: "transcript-1", entries: [
    { type: "assistant", uuid: "original-message", message: { content: "I am still implementing. " + "x".repeat(20000) } },
  ] } };
  return { root, skill, taskId: task.taskId, request, evidence, projectRoot: root };
}

test("source cache avoids unchanged reads, invalidates edits/deletes/adds, and reports incomplete scans accurately", async t => {
  const f = await fixture(t);
  const warm = await scanSkillDirectory(f.skill);
  assert.equal(warm.stats.filesRead, 0);
  assert.equal(warm.stats.cacheHits, 1);
  await fs.writeFile(path.join(f.skill, "SKILL.md"), "# Verify\nRun validation after completion.\n");
  const edited = await scanSkillDirectory(f.skill);
  assert.notEqual(edited.digest, warm.digest);
  assert.equal(edited.stats.filesRead, 1);
  await fs.writeFile(path.join(f.skill, "helper.txt"), "helper");
  assert.equal((await scanSkillDirectory(f.skill)).files.length, 2);
  await fs.rm(path.join(f.skill, "helper.txt"));
  assert.equal((await scanSkillDirectory(f.skill)).files.length, 1);
  assert.equal((await scanSkillDirectory(f.skill, { maxFiles: 1 })).truncated, false);
  await fs.writeFile(path.join(f.skill, "large.txt"), "x".repeat(100));
  const bounded = await scanSkillDirectory(f.skill, { maxBytes: 80 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.files[0].path, "SKILL.md");
  assert.equal((await scanSkillDirectory(f.skill, { cache: false })).stats.cacheHits, 0);
  await fs.mkdir(path.join(f.skill, ".runtime-correction"));
  await fs.writeFile(path.join(f.skill, ".runtime-correction", "hidden.txt"), "not original Skill evidence");
  assert.equal((await scanSkillDirectory(f.skill)).files.length, 2);
});

test("bounded search/read recovers exact original bodies without traversing or copying business files", async t => {
  const f = await fixture(t), care = await createSkillCare(f);
  // An irrelevant business tree is intentionally inaccessible to the tool.
  await fs.mkdir(path.join(f.root, "business"));
  await fs.writeFile(path.join(f.root, "business", "irrelevant.txt"), "validation secret business input");
  const matches = await care.execute({ action: "search", query: "validation", limit: 1 });
  assert.equal(matches.items.length, 1);
  assert.equal(matches.items[0].id, "skill/SKILL.md");
  assert.equal(matches.nextOffset, 1);
  const next = await care.execute({ action: "search", query: "validation", offset: 1, limit: 1 });
  assert.equal(next.items[0].id, "constraint/verify");
  assert.equal(next.nextOffset, null);
  let content = "", offset = 0;
  do {
    const page = await care.execute({ action: "read", id: "execution/0", offset, limit: 1000 });
    assert.ok(page.content.length <= 1000);
    content += page.content; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(content, JSON.stringify(f.evidence.snapshot.entries[0]));
  await assert.rejects(care.execute({ action: "read", id: "../business/irrelevant.txt" }), /SOURCE_NOT_FOUND/);
  await assert.rejects(care.execute({ action: "search", query: "x", limit: 1000 }), /INVALID_PAGE/);
  await assert.rejects(care.execute({ action: "search", query: "validation", prefix: "../" }), /INVALID_PREFIX/);
  assert.equal((await fs.readdir(f.root)).includes("source"), false);
  f.evidence.skillSource.files[0].content = "mutated caller";
  assert.match((await care.execute({ action: "read", id: "skill/SKILL.md" })).content, /Run validation/);
});

test("notes survive session recreation, reject stale authority, isolate tasks, and serialize concurrent saves", async t => {
  const f = await fixture(t), care = await createSkillCare(f);
  await Promise.all(["a", "b"].map(key => care.execute({ action: "note", key, text: "Pending original proof", refs: ["constraint/verify"] })));
  await care.checkpoint("before_compaction");
  const restored = await createSkillCare(f);
  const state = await restored.execute({ action: "resume" });
  assert.equal(state.notes.length, 2);
  assert.ok(state.notes.every(note => note.current));
  assert.ok(state.notes.every(note => note.text === undefined));
  const saved = await restored.execute({ action: "notes" });
  assert.equal(saved.items[0].sources[0].origin, "SKILL.md:2");
  assert.equal(saved.items[0].sources[0].sha256.length, 64);
  f.evidence.groundTruth.digest = "truth-2";
  const changed = await createSkillCare(f);
  assert.ok((await changed.execute({ action: "notes" })).items.every(note => !note.current));
  const other = await createSkillCare({ ...f, taskId: "other-task" });
  assert.equal((await other.execute({ action: "notes" })).total, 0);
  await assert.rejects(care.execute({ action: "note", key: "bad", text: "invented", refs: ["missing"] }), /INVALID_NOTE/);
  let open = true;
  const closed = await createSkillCare({ ...f, active: () => open });
  open = false;
  await assert.rejects(closed.execute({ action: "resume" }), /CLOSED/);
});

test("extraction request discloses manifests and preserves all original Skill bodies on demand", async t => {
  const f = await fixture(t), requestDirectory = path.join(f.root, "request");
  const prepared = await prepareReviewerRequest({ requestDirectory,
    request: { skill: { files: f.evidence.skillSource.files } }, evidence: f.evidence });
  assert.equal(prepared.skill.files[0].content, undefined);
  assert.equal(prepared.skillCare.sourceComplete, true);
  const captured = JSON.parse(await fs.readFile(prepared.skillSourcePath));
  assert.equal(captured.files[0].content, f.evidence.skillSource.files[0].content);
});

test("native Skill reviewer receives its private tool, lightweight protocol and revocable ownership", async t => {
  const f = await fixture(t), registrations = new Map();
  let savedTool, runParams;
  const api = { config: { agents: { defaults: { model: "controlled/controlled" } } },
    registerTool(factory, { names }) { for (const name of names) registrations.set(name, factory); },
    runtime: { agent: { async runEmbeddedAgent(params) {
      runParams = params;
      assert.match(params.extraSystemPrompt, /rc_skill_care/);
      assert.deepEqual(params.skillsSnapshot, { prompt: "", skills: [] });
      const get = registrations.get("rc_skill_care");
      assert.equal(get({ sessionId: "unrelated" }), null);
      savedTool = get({ sessionId: params.sessionId });
      assert.ok(savedTool);
      assert.ok(params.config.agents.list.find(agent => agent.id === "main").tools.alsoAllow.includes("rc_skill_care"));
      const result = await savedTool.execute("resume", { action: "resume" });
      assert.equal(JSON.parse(result.content[0].text).skillId, "demo");
      return { payloads: [{ text: JSON.stringify({ summary: "Still working", completionStatus: "NOT_COMPLETED", findings: [] }) }], meta: {} };
    } } } };
  registerReviewerProgress(api);
  assert.equal(registrations.get("rc_skill_care")({}), null);
  const factory = createOpenClawReviewerFactory(api);
  const handle = await factory({ ...f, role: "skill-reviewer", reviewer: { timeoutMs: 5000 }, schema: SKILL_REVIEW_SCHEMA });
  assert.equal(handle.result.completionStatus, "NOT_COMPLETED");
  assert.equal(runParams.workspaceDir, f.root);
  await assert.rejects(savedTool.execute("late", { action: "resume" }), /NOT_OWNED/);
  await handle.close();
  const extraction = await factory({ ...f, request: { skill: { skillId: "demo", files: f.evidence.skillSource.files } },
    role: "ground-truth-extractor", reviewer: { timeoutMs: 5000 }, schema: SKILL_REVIEW_SCHEMA });
  assert.deepEqual(runParams.toolsAllow, ["read", "rc_skill_care"]);
  await extraction.close();
});
