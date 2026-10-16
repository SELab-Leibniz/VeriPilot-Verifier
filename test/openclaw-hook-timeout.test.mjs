import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveHookTimeoutMs, hookReviewBudgetMs } from "../lib/openclaw/hook-timeout.mjs";

test("Hook timeout defaults to twenty minutes and is capped at sixty, matching the manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packaging/hosts/openclaw/openclaw.plugin.json", import.meta.url)));
  assert.equal(manifest.configSchema.properties.hookTimeoutMs.default, 1200000);
  assert.equal(manifest.configSchema.properties.hookTimeoutMs.maximum, 3600000);
  for (const [configured, timeout, reviewBudget] of [
    [undefined, 1200000, 1199000], [null, 1200000, 1199000], [2000, 2000, 1000],
    [600000, 600000, 599000], [1800000, 1800000, 1799000],
    [3600000, 3600000, 3599000], [7200000, 3600000, 3599000],
  ]) {
    assert.equal(resolveHookTimeoutMs(configured), timeout, `configured: ${configured}`);
    assert.equal(hookReviewBudgetMs(configured), reviewBudget, `configured: ${configured}`);
  }
});

test("Hook review retains the cleanup margin and honors a shorter host policy", () => {
  assert.equal(hookReviewBudgetMs(undefined, 300000), 299000);
  assert.equal(hookReviewBudgetMs(3600000, 600000), 599000);
  assert.equal(hookReviewBudgetMs(1800000, 3600000), 1799000);
  assert.equal(hookReviewBudgetMs(7200000, 7200000), 3599000);
  assert.equal(hookReviewBudgetMs(2000, 500), 1);
});
