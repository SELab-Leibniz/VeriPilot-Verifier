// Promote the previously validated mechanism checks without replaying business tasks.
import "./.review-task/checks.mjs";
import "./.review-task/native-checks.mjs";
import "./.review-task/memory-checks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPromptProfile } from "../lib/review-task/prompt-profile.mjs";
import { captureFiles, registerCitation, runReviewTask, taskVerdicts, validateDecision } from "../lib/review-task/review-task.mjs";
import { nativeTools } from "./helpers/native-task.mjs";

test('group submission schema exposes only original member IDs and hides the group ID as a task choice', async t=>{
  const f=await discoveryFixture(t),outputDir=`${f.root}-group`;
  t.after(()=>fs.rm(outputDir,{recursive:true,force:true}));
  const members=[{...f.task,id:'M01:original-A'},{...f.task,id:'M01:original-B'}];
  const result=await runReviewTask({task:{...f.task,id:'group-opaque-uuid'},tasks:members,root:f.root,outputDir,maxAttempts:1,
    nativeRun:async worker=>{
      assert.equal(worker.maxTokens, 32768);
      const submit=worker.tools.find(tool=>tool.name==='submit_review');
      const choices=submit.parameters.properties.taskId;
      assert.deepEqual(choices.anyOf.map(value=>value.const),members.map(member=>member.id));
      const prompt=JSON.parse(worker.prompt);assert.equal(prompt.group.groupId,'group-opaque-uuid');assert.equal(prompt.group.id,undefined);
      const tools=nativeTools(worker);
      await assert.rejects(tools.submit('group-opaque-uuid','UNVERIFIED',[]),/Remaining original task IDs: M01:original-A, M01:original-B/u);
      for(const member of members)await tools.submit(member.id,'UNVERIFIED',[]);
    }});
  assert.equal(result.completed,true);
});

test("review profiles preserve task ownership and keep untuned routes unchanged", () => {
  assert.match(reviewPromptProfile("M01", "REQUIREMENT_DECOMPOSITION_COVERAGE").promptAppend, /Metric M01/);
  assert.equal(reviewPromptProfile("M03", "TEST_CONTRACT_COVERAGE").promptAppend, "");
  assert.match(reviewPromptProfile("M12", "SOURCE_IMPLEMENTATION").promptAppend, /proof before PASS/);
  const runtime = reviewPromptProfile("M12", "RUNTIME_ACCEPTANCE");
  assert.equal(runtime.reviewType, "runtime-evidence-reviewer");
  assert.match(runtime.promptAppend, /attributable original tool invocation and its returned result/);
  assert.match(runtime.promptAppend, /cannot manufacture execution proof/);
  assert.match(runtime.promptAppend, /missing or unresolved execution, version or coverage evidence is UNVERIFIED/);
  assert.equal(reviewPromptProfile("M12", "UNRECOGNIZED_SCOPE").promptAppend, "");
  assert.match(reviewPromptProfile("M15", "EXECUTION_CLOSURE").promptAppend, /Missing\/stale results.*UNVERIFIED/);
  assert.equal(reviewPromptProfile("M09", "SOURCE_IMPLEMENTATION").reviewType, "development-standard-reviewer");
  assert.equal(reviewPromptProfile("M99", "OTHER").promptAppend, "");
});

async function discoveryFixture(t) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/review-task-prefix-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "project"));
  await fs.writeFile(path.join(root, "project/basis.md"), "Required condition\nApplicable exception");
  await fs.writeFile(path.join(root, "project/candidate.md"), "Actual candidate witness\nSecond line");
  await fs.writeFile(path.join(root, "other.md"), "Outside the permitted target scope");
  const snapshot = await captureFiles(root), registry = new Map();
  const cite = async file => registerCitation({ registry, file, bytes: await fs.readFile(path.join(root, file)),
    sha256: snapshot.get(file).sha256, range: { start: 1, end: 1 } });
  const basis = await cite("project/basis.md"), candidate = await cite("project/candidate.md"), outside = await cite("other.md");
  return { root, snapshot, registry, basis, candidate, outside,
    task: { id: "discover", requirement: "Review the actual candidate.", basisFiles: ["project/basis.md"], targetFiles: [], targetPrefixes: ["project/"] },
    reads: [{ path: "project/basis.md", start: 1, end: 2 }, { path: "project/candidate.md", start: 1, end: 1 }, { path: "other.md", start: 1, end: 1 }] };
}
const discoveryDecision = (verdict, citeIds) => ({ taskId: "discover", verdict, reason: "The inspected candidate supports this scoped judgement.", citeIds });

test("prefix discovery admits disclosed current candidate evidence without declaring an arbitrary file", async t => {
  const input = await discoveryFixture(t);
  for (const verdict of ["PASS", "DEVIATION"]) {
    const result = await validateDecision({ ...input, decision: discoveryDecision(verdict, [input.candidate.citeId]) });
    assert.equal(result.refs[0].path, "project/candidate.md");
  }
  const unverified = await validateDecision({ ...input, reads: [], decision: discoveryDecision("UNVERIFIED", []) });
  assert.equal(unverified.verdict, "UNVERIFIED");
});

test("discovery still requires a targetFiles array, nonempty basis and a valid nonempty target scope", async t => {
  const input = await discoveryFixture(t), decision = discoveryDecision("UNVERIFIED", []);
  for (const targetPrefixes of [undefined, [], ["../"], ["project/../"], ["/project/"], ["C:/project/"], ["project\\"], ["project"], ["./project/"], ["project//"], [null]])
    await assert.rejects(validateDecision({ ...input, task: { ...input.task, targetPrefixes }, decision }), /Task requires/u);
  for (const override of [{ targetFiles: undefined }, { targetFiles: "project/candidate.md" }, { basisFiles: [] }])
    await assert.rejects(validateDecision({ ...input, task: { ...input.task, ...override }, decision }), /Task requires/u);
});

test("discovery cannot promote basis-only or outside-prefix citations, or skip mandatory basis reads", async t => {
  const input = await discoveryFixture(t);
  for (const verdict of ["PASS", "DEVIATION"]) {
    for (const citation of [input.basis, input.outside])
      await assert.rejects(validateDecision({ ...input, decision: discoveryDecision(verdict, [citation.citeId]) }), /current target source/u);
    await assert.rejects(validateDecision({ ...input, reads: input.reads.filter(read => read.path !== "project/basis.md"),
      decision: discoveryDecision(verdict, [input.candidate.citeId]) }), /basis not fully read/u);
  }
  await fs.appendFile(path.join(input.root, "project/candidate.md"), "\nChanged after capture");
  await assert.rejects(validateDecision({ ...input, decision: discoveryDecision("PASS", [input.candidate.citeId]) }), /STALE/u);
});

test("only the exact caller-owned conditional kind can authorize applicability verdicts", async t => {
  const f = await discoveryFixture(t);
  for (const applicabilityKind of [undefined, null, "CURRENT_TASK", "FUTURE", "UNKNOWN", "conditional", "CONDITIONAL ", true, 1, {}, []]) {
    const task = { ...f.task, applicabilityKind };
    assert.deepEqual(taskVerdicts(task), ["PASS", "DEVIATION", "UNVERIFIED"]);
    for (const verdict of ["NOT_APPLICABLE", "NOT_YET_APPLICABLE"])
      await assert.rejects(validateDecision({ ...f, task, decision: discoveryDecision(verdict, [f.candidate.citeId]) }), /Wrong task or verdict/u);
  }
  const task = { ...f.task, applicabilityKind: "CONDITIONAL" };
  for (const verdict of taskVerdicts(task)) {
    const result = await validateDecision({ ...f, task, decision: discoveryDecision(verdict, verdict === "UNVERIFIED" ? [] : [f.candidate.citeId]) });
    assert.equal(result.verdict, verdict, "Applicability decisions must never be rewritten into PASS.");
  }
  const unknown = await validateDecision({ ...f, task, reads: [],
    decision: { ...discoveryDecision("UNVERIFIED", []), reason: "The original trigger cannot be established from the available evidence." } });
  assert.equal(unknown.verdict, "UNVERIFIED");
});

test("both conditional applicability verdicts retain full basis, target ownership, citation and stale guards", async t => {
  const f = await discoveryFixture(t), task = { ...f.task, applicabilityKind: "CONDITIONAL" };
  for (const verdict of ["NOT_APPLICABLE", "NOT_YET_APPLICABLE"]) {
    const decision = discoveryDecision(verdict, [f.candidate.citeId]);
    await assert.rejects(validateDecision({ ...f, task, reads: f.reads.filter(r => r.path !== "project/basis.md"), decision }), /basis not fully read/u);
    await assert.rejects(validateDecision({ ...f, task, decision: { ...decision, citeIds: [] } }), /requires source evidence/u);
    for (const citation of [f.basis, f.outside])
      await assert.rejects(validateDecision({ ...f, task, decision: { ...decision, citeIds: [citation.citeId] } }), /current target source/u);
    await assert.rejects(validateDecision({ ...f, task, decision: { ...decision, citeIds: ["made-up-cite"] } }), /Unknown citation/u);
    const registry = new Map(f.registry);
    registry.set(f.candidate.citeId, { ...f.candidate, sha256: "0".repeat(64) });
    await assert.rejects(validateDecision({ ...f, task, registry, decision }), /Tampered citation/u);
    await assert.rejects(validateDecision({ ...f, task, reads: f.reads.filter(r => r.path !== "project/candidate.md"), decision }), /Unread or invalid citation/u);
  }
  await fs.appendFile(path.join(f.root, "project/candidate.md"), "\nCondition evidence changed after capture.");
  for (const verdict of ["NOT_APPLICABLE", "NOT_YET_APPLICABLE"])
    await assert.rejects(validateDecision({ ...f, task, decision: discoveryDecision(verdict, [f.candidate.citeId]) }), /STALE/u);
});

// Exercise the native tool schema/save contract with a scripted host.
// This checks protocol enforcement, not a model's semantic trigger reasoning.
test("conditional native tool submissions keep both applicability verdicts durable while the default schema rejects them", async t => {
  for (const [kind, verdict] of [["CONDITIONAL", "NOT_APPLICABLE"], ["CONDITIONAL", "NOT_YET_APPLICABLE"], [undefined, "NOT_APPLICABLE"]]) {
    const f = await discoveryFixture(t), task = { ...f.task, ...(kind ? { applicabilityKind: kind } : {}) };
    await fs.writeFile(path.join(f.root, "project/basis.md"), "If the release phase is in scope and reached, obtain approval before release.\nMissing approval evidence alone does not establish an applicability exception.");
    await fs.writeFile(path.join(f.root, "project/candidate.md"), !kind ? "The current release scope and stage cannot be established."
      : verdict === "NOT_APPLICABLE" ? "Current task scope is an explicitly documentation-only preview; release is outside this task."
        : "Current task stage is draft review; the in-scope release phase has not yet been reached.");
    const outputDir = `${f.root}-review`; t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
    let turns = 0;
    const result = await runReviewTask({ task, root: f.root, outputDir, maxAttempts: 1, maxTurns: 5,
      nativeRun: async worker => {
        const tools = nativeTools(worker);
        await tools.read('project/basis.md'); const citeId = await tools.read('project/candidate.md'); turns = 2;
        if (!kind) { await assert.rejects(tools.submit(task.id, verdict, [citeId]), /Wrong task or verdict/); turns++; }
        await tools.submit(task.id, kind ? verdict : 'UNVERIFIED', kind ? [citeId] : []); turns++;
      } });
    assert.equal(result.completed, true);
    assert.equal(result.verdict, kind ? verdict : "UNVERIFIED");
    const saved = JSON.parse(await fs.readFile(path.join(outputDir, "decision.json"), "utf8"));
    assert.equal(saved.verdict, result.verdict);
    assert.equal(turns, kind ? 3 : 4);
    const prompt = await fs.readFile(path.join(outputDir, "prompt.txt"), "utf8");
    if (kind) {
      assert.match(prompt, /Missing or incomplete trigger evidence is UNVERIFIED/u);
      assert.match(prompt, /neither means the business obligation passed/u);
      assert.equal(saved.refs[0].path, "project/candidate.md");
    } else assert.doesNotMatch(prompt, /For this conditional task/u);
  }
});
