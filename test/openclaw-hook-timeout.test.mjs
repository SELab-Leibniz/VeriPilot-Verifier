import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveHookTimeoutMs, hookReviewBudgetMs, hotHookTimeoutMs, isHotHook } from "../lib/openclaw/hook-timeout.mjs";

test("ordinary Hook timeout defaults to twenty minutes and is capped at twenty-four hours; manifest also permits explicit baseline windows", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packaging/hosts/openclaw/openclaw.plugin.json", import.meta.url)));
  assert.equal(manifest.configSchema.properties.hookTimeoutMs.default, 1200000);
  assert.equal(manifest.configSchema.properties.hookTimeoutMs.maximum, 2147483647);
  assert(manifest.configSchema.properties.baselineLimits.properties.timeoutMs.maximum + 60000 <= 2147483647);
  for (const [configured, timeout, reviewBudget] of [
    [undefined, 1200000, 1199000], [null, 1200000, 1199000], [2000, 2000, 1000],
    [600000, 600000, 599000], [1800000, 1800000, 1799000],
    [3600000, 3600000, 3599000], [7200000, 7200000, 7199000], [86400000, 86400000, 86399000], [172800000, 86400000, 86399000],
  ]) {
    assert.equal(resolveHookTimeoutMs(configured), timeout, `configured: ${configured}`);
    assert.equal(hookReviewBudgetMs(configured), reviewBudget, `configured: ${configured}`);
  }
});

test("Hook review retains the cleanup margin and honors a shorter host policy", () => {
  assert.equal(hookReviewBudgetMs(undefined, 300000), 299000);
  assert.equal(hookReviewBudgetMs(3600000, 600000), 599000);
  assert.equal(hookReviewBudgetMs(1800000, 3600000), 1799000);
  assert.equal(hookReviewBudgetMs(7200000, 7200000), 7199000);
  assert.equal(hookReviewBudgetMs(2000, 500), 1);
});

test("hot hooks stay in seconds while independent review budgets retain explicit long windows", () => {
  for (const configured of [undefined, 600000, 86400000, 86460000])
    assert.equal(hotHookTimeoutMs(configured), 10000);
  assert.equal(hotHookTimeoutMs(2000), 2000);
  assert.equal(hookReviewBudgetMs(86400000), 86399000);
  for (const name of ["before_tool_call", "before_prompt_build", "reply_payload_sending", "agent_end"])
    assert.equal(isHotHook(name), true);
  assert.equal(isHotHook("reply_dispatch"), false);
});
