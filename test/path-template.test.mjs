import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePathTemplate,
  compilePathTemplates,
  compileWorkflowCorrelation,
  extractWorkflowInstance,
  matchPathTemplates,
  normalizeWorkflowInstance,
  workflowInstancesEqual,
} from "../lib/path-template.mjs";


test("path templates capture Unicode values and keep non-correlation fields out of the instance", () => {
  const templates = compilePathTemplates([
    "spec/{YYYY-MM-DD}-需求分析报告-{changeName}.md",
  ]);
  const matched = matchPathTemplates(
    "spec/2026-07-28-需求分析报告-登录优化.md",
    templates,
  );
  const correlation = compileWorkflowCorrelation({ keys: ["changeName"] });

  assert.deepEqual(matched.captures, {
    "YYYY-MM-DD": "2026-07-28",
    changeName: "登录优化",
  });
  assert.deepEqual(
    extractWorkflowInstance(matched.captures, correlation),
    { changeName: "登录优化" },
  );
  assert.equal(templates[0].scanPattern, "spec/*-需求分析报告-*.md");
});


test("workflow instance equality is case-insensitive and independent of date captures", () => {
  const correlation = compileWorkflowCorrelation({
    keys: ["changeName", "tenant-id"],
  });
  const first = normalizeWorkflowInstance({
    changeName: "Dry-Run",
    "tenant-id": "CN",
    date: "2026-07-28",
  }, correlation);
  const second = normalizeWorkflowInstance({
    changeName: "dry-run",
    "tenant-id": "cn",
    date: "2026-07-29",
  }, correlation);

  assert.deepEqual(first, { changeName: "Dry-Run", "tenant-id": "CN" });
  assert.equal(workflowInstancesEqual(first, second, correlation), true);
  assert.equal(
    workflowInstancesEqual(first, { ...second, changeName: "other" }, correlation),
    false,
  );
});


test("path templates reject ambiguous or malformed placeholder syntax", () => {
  for (const [template, error] of [
    ["spec/*-{changeName}.md", /不能混用 glob/],
    ["spec/{changeName.md", /未闭合/],
    ["spec/changeName}.md", /未配对/],
    ["spec/{1change}.md", /必须以字母开头/],
    ["spec/{change name}.md", /必须以字母开头/],
    ["spec/{changeName}-{changeName}.md", /不能重复声明/],
  ]) {
    assert.throws(() => compilePathTemplate(template), error);
  }
});


test("correlation keys must be valid, unique, and fully present in an instance", () => {
  assert.throws(
    () => compileWorkflowCorrelation({ keys: [] }),
    /必须是非空列表/,
  );
  assert.throws(
    () => compileWorkflowCorrelation({ keys: ["changeName", "changeName"] }),
    /不能包含重复 key/,
  );
  assert.throws(
    () => compileWorkflowCorrelation({ keys: ["change.name"] }),
    /必须以字母开头/,
  );
  const correlation = compileWorkflowCorrelation({ keys: ["changeName"] });
  assert.throws(
    () => normalizeWorkflowInstance({}, correlation),
    /必须包含.*changeName/,
  );
});

