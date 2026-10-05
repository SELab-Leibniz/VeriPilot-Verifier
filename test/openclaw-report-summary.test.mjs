import test from "node:test";
import assert from "node:assert/strict";
import { renderSummary } from "../lib/openclaw/report.mjs";

function report(overrides = {}) {
  return { status: "COMPLETED", phase: "DELIVERED", verification: "PASS", files: [], findings: [],
    budget: { correctionsUsed: 1, maximum: 3 }, ...overrides };
}

function file(name, status, overrides = {}) {
  return { file: name, status, retained: true, findings: [], artifactProblems: [], verifiedFixes: [], ...overrides };
}

test("a successful summary names verified files and confirms fixes only with recheck evidence", () => {
  const text = renderSummary(report({ files: [
    file("proposal.md", "PASS", { verifiedFixes: [{ verifiedBy: "recheck" }] }),
    file("design.md", "PASS", { modifications: [{}, {}], feedbackDelivered: [{}] }),
    file("tasks.md", "PASS"),
  ] }));
  assert.match(text, /^\*\*验收通过/u);
  assert.match(text, /proposal\.md \| 已通过 \| 此前问题已修正，并经复验确认/u);
  assert.match(text, /design\.md \| 已通过 \| 当前内容已通过验收/u);
  assert.match(text, /纠偏额度使用：1\/3/u);
  assert.match(text, /“查看反馈”/u);
  assert.doesNotMatch(text, /反馈送达|修改 2 次|连续评审故障|三份文档|PASS|OPEN/u);
});

test("budget exhaustion keeps failure, missing verification and a verified fix distinct", () => {
  const text = renderSummary(report({ status: "COMPLETED_WITH_ISSUES", phase: "STOPPED", verification: "DEVIATION",
    correctionBudgetExhausted: true, budget: { correctionsUsed: 3, maximum: 3 }, files: [
      file("proposal.md", "PASS", { verifiedFixes: [{}] }),
      file("design.md", "DEVIATION", { finalAssessment: { reason: "内存存储不满足重启后保留数据的要求" } }),
      file("tasks.md", "UNVERIFIED"),
    ] }));
  assert.match(text, /尚未全部通过验收/u);
  assert.match(text, /纠偏额度已用尽：3\/3/u);
  assert.match(text, /design\.md \| 未通过 \| 内存存储/u);
  assert.match(text, /tasks\.md \| 未验证/u);
  assert.match(text, /请修正剩余问题，再重新验收/u);
  assert.doesNotMatch(text, /^\*\*验收通过/u);
});

test("a timed-out review exposes a short reason and does not claim completion or file retention", () => {
  const text = renderSummary(report({ status: "STOPPED_UNVERIFIED", phase: "UNVERIFIED", verification: "UNVERIFIED",
    failureCode: "RUN_BUDGET_EXHAUSTED", pauseReason: "总时限由 agents.defaults.timeoutSeconds 控制",
    budget: { correctionsUsed: 0, maximum: 3 } }));
  assert.match(text, /最终验收未完成，成果尚未验证/u);
  assert.match(text, /达到总运行时限/u);
  assert.match(text, /纠偏额度使用：0\/3/u);
  assert.match(text, /尚无完整文件证据/u);
  assert.doesNotMatch(text, /agents\.defaults|文件已保留|验收通过|已完成/u);
});

test("expired evidence never makes a historic fix a current pass", () => {
  const text = renderSummary(report({ verification: "STALE", files: [file("design.md", "UNVERIFIED", {
    verifiedFixes: [{ fixedAt: "previous-run" }], feedbackDelivered: [{ feedback: "old diagnosis" }],
  })] }));
  assert.match(text, /验收结论已失效/u);
  assert.match(text, /design\.md \| 未验证/u);
  assert.doesNotMatch(text, /此前问题已修正|old diagnosis|验收通过/u);
});

test("global PASS cannot hide a current file-specific deviation", () => {
  const text = renderSummary(report({ files: [file("design.md", "DEVIATION", {
    finalAssessment: { reason: "必须持久化，当前仅有内存存储" },
  })] }));
  assert.match(text, /^\*\*成果尚未全部通过验收/u);
  assert.match(text, /任务要求已通过核心验收，但逐文件质量/u);
  assert.match(text, /必须持久化，当前仅有内存存储/u);
  assert.doesNotMatch(text, /本次成果符合当前任务要求/u);
});

test("large reports prioritize problems and bound rows and diagnostic prose", () => {
  const files = Array.from({ length: 20 }, (_, i) => file(`reference-${i}.md`, "PASS"));
  files.push(file("bad.md", "DEVIATION", { artifactProblems: [{ message: `存储 | 错误\n${"问题".repeat(500)}` }] }),
    file("missing.md", "UNVERIFIED", { retained: false }), file("pending.md", "UNVERIFIED"));
  const text = renderSummary(report({ verification: "DEVIATION", files }));
  assert.equal(text.split("\n").filter(line => line.startsWith("| ")).length, 5);
  assert.match(text, /bad\.md \| 未通过 \| 存储 \\\| 错误/u);
  assert.match(text, /missing\.md \| 文件缺失/u);
  assert.match(text, /pending\.md \| 未验证/u);
  assert.match(text, /另有 20 份文件/u);
  assert.doesNotMatch(text, /reference-0\.md/u);
  assert.ok(text.length < 700);
});

test("task-wide findings use the latest observation without repeating file diagnostics or closed history", () => {
  const family = { familyId: "file-family", status: "OPEN", observations: [{ finding: { reason: "缺少持久化" } }] };
  const text = renderSummary(report({ verification: "DEVIATION", files: [file("design.md", "DEVIATION", { findings: [family] })],
    findings: [family,
      { familyId: "global-1", status: "OPEN", observations: [{ finding: { reason: "旧原因" } }, { finding: { reason: "缺少验收契约" } }] },
      { familyId: "global-2", status: "OPEN", observations: [{ finding: { reason: "缺少验收契约" } }] },
      { familyId: "closed", status: "FIXED", observations: [{ finding: { reason: "已关闭的历史问题" } }] },
    ] }));
  assert.equal(text.split("缺少持久化").length - 1, 1);
  assert.equal(text.split("缺少验收契约").length - 1, 1);
  assert.doesNotMatch(text, /旧原因|已关闭的历史问题|file-family|global-1/u);
});

test("a waiting question and unknown delivery remain actionable without suggesting automatic correction", () => {
  const text = renderSummary(report({ status: "ACTIVE", phase: "WAITING_FOR_USER", verification: "UNVERIFIED",
    waitingQuestion: "请选择保存位置？", delivery: { status: "UNKNOWN" } }));
  assert.match(text, /自动执行已暂停/u);
  assert.match(text, /待确认：请选择保存位置/u);
  assert.match(text, /先核对交付回执，不自动重发/u);
  assert.doesNotMatch(text, /验收通过|请修正剩余问题/u);
});

test("stopping with unsettled calls cannot claim that all execution has ended", () => {
  const text = renderSummary(report({ status: "STOPPING", phase: "STOPPING", verification: "STALE", unsettledRuns: [{}, {}] }));
  assert.match(text, /^\*\*正在停止自动执行/u);
  assert.match(text, /2 个评审运行尚未确认结束/u);
  assert.doesNotMatch(text, /自动执行已停止/u);
});
