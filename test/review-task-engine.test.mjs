// Promote the previously validated mechanism checks without replaying business tasks.
import "./.review-task/checks.mjs";
import "./.review-task/sdk-checks.mjs";
import "./.review-task/memory-checks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPromptProfile } from "../lib/review-task/prompt-profile.mjs";
import { captureFiles, registerCitation, validateDecision } from "../lib/review-task/review-task.mjs";

test("review profiles preserve task ownership and keep untuned routes unchanged", () => {
  assert.match(reviewPromptProfile("M01", "REQUIREMENT_DECOMPOSITION_COVERAGE").promptAppend, /Metric M01/);
  assert.equal(reviewPromptProfile("M03", "TEST_CONTRACT_COVERAGE").promptAppend, "");
  assert.match(reviewPromptProfile("M12", "SOURCE_IMPLEMENTATION").promptAppend, /proof before PASS/);
  assert.equal(reviewPromptProfile("M12", "RUNTIME_ACCEPTANCE").promptAppend, "");
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
