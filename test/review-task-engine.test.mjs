// Promote the previously validated mechanism checks without replaying business tasks.
import "./.review-task/checks.mjs";
import "./.review-task/sdk-checks.mjs";
import "./.review-task/memory-checks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { reviewPromptProfile } from "../lib/review-task/prompt-profile.mjs";

test("review profiles preserve task ownership and keep untuned routes unchanged", () => {
  assert.match(reviewPromptProfile("M01", "REQUIREMENT_DECOMPOSITION_COVERAGE").promptAppend, /Metric M01/);
  assert.equal(reviewPromptProfile("M05", "ACCEPTANCE_COVERAGE").promptAppend, "");
  assert.match(reviewPromptProfile("M12", "SOURCE_IMPLEMENTATION").promptAppend, /proof before PASS/);
  assert.equal(reviewPromptProfile("M12", "RUNTIME_ACCEPTANCE").promptAppend, "");
  assert.equal(reviewPromptProfile("M12", "UNRECOGNIZED_SCOPE").promptAppend, "");
  assert.equal(reviewPromptProfile("M15", "OTHER").promptAppend, "");
});
