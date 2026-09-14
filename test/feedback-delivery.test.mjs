import test from "node:test";
import assert from "node:assert/strict";
import { formatAgentFeedback } from "../lib/feedback.mjs";

function result(roundOutputFiles = []) {
  return { status: "failed", metadata: { artifactType: "tasks", stage: "tasks",
    triggerFile: "tasks.md", ruleSetIds: [], configSource: "project-simple" }, roundOutputFiles,
  diagnostics: ["login", "sync", "persistence", "completion", "editing", "deletion"].map((name) => ({
    severity: "error", ruleId: name, path: "tasks.md", message: `Finding ${name}`,
  })), diffs: [1, 2, 3].map((n) => ({ path: "tasks.md", baseHash: "fixture", unifiedDiff: `Patch number ${n}` })) };
}

test("without persisted output all findings and patches remain available in tool feedback", () => {
  for (const locale of ["zh", "en"]) {
    const feedback = formatAgentFeedback(result(), 12000, null, { locale, includePublicCommandContext: false });
    for (const name of ["login", "sync", "persistence", "completion", "editing", "deletion"]) {
      assert.match(feedback, new RegExp(`Finding ${name}`));
    }
    assert.match(feedback, /Patch number 3/u);
    assert.doesNotMatch(feedback, /diagnostic\.md|patch\.diff/u, "never claim a nonexistent archive exists");
  }
});

test("persisted full diagnostics and patches keep the existing concise feedback", () => {
  const feedback = formatAgentFeedback(result(["round/diagnostic.md", "round/patch.diff"]));
  assert.match(feedback, /Finding persistence/u);
  assert.doesNotMatch(feedback, /Finding completion|Patch number 3/u);
  assert.match(feedback, /其余 3 条完整记录于本轮 diagnostic\.md/u);
  assert.match(feedback, /其余 1 个候选 Patch/u);
});
