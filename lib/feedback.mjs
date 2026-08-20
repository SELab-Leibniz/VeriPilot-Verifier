import path from "node:path";

import { PUBLIC_COMMANDS_CONTEXT_MARKER } from "./artifact-pipeline.mjs";
import { DEFAULT_LOCALE, formatMessage } from "./messages.mjs";
import { EDGE_REVIEW_BASELINE } from "./review-graph.mjs";

// Delivery ration: full lists stay in diagnostic.md / patch.diff.
const MAX_INLINE_DIAGNOSTICS = 3;
const MAX_INLINE_DIFFS = 2;
const SEVERITY_RANK = { error: 0, warning: 1, info: 2, pending: 3 };


export function formatAgentFeedback(
  result,
  maxChars = 12000,
  stageSpecification = null,
  { includePublicCommandContext = true, locale = DEFAULT_LOCALE } = {},
) {
  const severityLabels = { error: "ERROR", warning: "WARN", info: "INFO", pending: "PENDING" };
  const semanticReviewCompleted = result.agentReview?.status === "completed";
  const lines = [
    formatMessage(locale, "feedback.header", {
      artifactType: result.metadata.artifactType,
      status: result.status,
    }),
    formatMessage(locale, "feedback.triggerFile", { file: result.metadata.triggerFile }),
    formatMessage(locale, "feedback.knowledge", {
      ruleSets: result.metadata.ruleSetIds.join(", ") || formatMessage(locale, "feedback.none"),
    }),
    formatMessage(locale, "feedback.configSource", {
      source: result.metadata.configSource ?? "unknown",
    }),
  ];

  if (result.metadata.configSource === "plugin-default") {
    lines.push("当前项目尚未初始化专属规则，正在使用插件内置默认规则。新用户可在 Claude Code 输入 `/runtime-corrector:init` 一键创建可修改的项目规则。");
  }

  if (result.roundOutputFiles?.length > 0) {
    lines.push(`历史 Round 产物（${result.metadata.roundId}，不会被后续轮次覆盖）：`);
    for (const outputFile of result.roundOutputFiles) {
      lines.push(`- ${outputFile}`);
    }
  }
  if (result.latestOutputFiles?.length > 0) {
    lines.push("Latest 指针（始终指向当前最新一轮）：");
    for (const outputFile of result.latestOutputFiles) {
      lines.push(`- ${outputFile}`);
    }
  }
  if (result.outputFiles?.length > 0) {
    lines.push("历史 Round 和 Latest 指针中的诊断、完整规范包与候选 Git Patch 仅供主 Agent 决策，不会自动应用到目标产物。");
  }
  const diagnosticOutput = result.roundOutputFiles?.find(
    (file) => path.posix.basename(file) === "diagnostic.md",
  );
  const diffOutput = result.roundOutputFiles?.find(
    (file) => path.posix.basename(file) === "patch.diff",
  );
  if (diagnosticOutput) {
    lines.push(`本轮诊断结果路径：${diagnosticOutput}`);
  }
  if (diffOutput) {
    lines.push(
      result.diffs.length > 0
        ? `本轮 Diff 文件路径：${diffOutput}`
        : `本轮 Diff 文件路径：${diffOutput}（本轮没有安全候选补丁，因此为 0 字节空文件。）`,
    );
  }

  if (result.diagnostics.length === 0) {
    lines.push(formatMessage(locale, "feedback.noDeviations"));
  } else {
    const ranked = [...result.diagnostics].sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
    );
    const shown = ranked.slice(0, MAX_INLINE_DIAGNOSTICS);
    lines.push(
      ranked.length > shown.length
        ? formatMessage(locale, "feedback.diagnosticsHeadingTruncated", {
            total: ranked.length,
            shown: shown.length,
          })
        : formatMessage(locale, "feedback.diagnosticsHeading"),
    );
    for (const item of shown) {
      const location = `${item.path}${item.line ? `:${item.line}` : ""}`;
      lines.push(`- [${severityLabels[item.severity] ?? item.severity}] ${item.ruleId} ${location} — ${item.message}`);
      if (item.suggestion) {
        lines.push(`  建议：${item.suggestion}`);
      }
    }
    if (ranked.length > shown.length) {
      lines.push(`其余 ${ranked.length - shown.length} 条完整记录于本轮 diagnostic.md。`);
    }
  }

  lines.push(formatMessage(locale, "feedback.candidatePatchCount", { count: result.diffs.length }));
  if (result.diffs.length === 0 && result.status === "failed") {
    lines.push("本次没有可安全生成的 Patch：当前偏差需要补充语义值或不存在可确定的机械改写；插件不会编造内容。");
  }

  const inlineDiffs = result.diffs.slice(0, MAX_INLINE_DIFFS);
  for (const diff of inlineDiffs) {
    lines.push(`候选 Git Patch（${diff.path}，基线 ${diff.baseHash}）：`);
    lines.push("```diff");
    lines.push(diff.unifiedDiff);
    lines.push("```");
    lines.push("应用前必须确认目标文件仍匹配基线，并先执行 `git apply --check <patch-file>`；校验通过后仍由主 Agent 决定是否应用。");
  }
  if (result.diffs.length > inlineDiffs.length) {
    lines.push(`其余 ${result.diffs.length - inlineDiffs.length} 个候选 Patch 已完整写入本轮 patch.diff，未在正文展开。`);
  }

  if (result.status === "failed") {
    lines.push(formatMessage(locale, "feedback.errorStatus"));
  } else if (result.status === "warning") {
    lines.push(formatMessage(locale, "feedback.warningStatus"));
  } else if (result.status === "pending") {
    lines.push(
      semanticReviewCompleted
        ? "⏳ Bundle 尚未齐备。现有快照已经完成隔离语义审阅并生成本轮诊断与候选 Diff；依赖缺失成员的检查保持 pending，继续生成其余文件即可。"
        : "⏳ Bundle 尚未齐备。现有快照已经完成确定性检查并生成本轮诊断与候选 Diff；依赖缺失成员的检查保持 pending。当前入口未执行隔离语义审阅，请按下方 reviewer 完成审阅，或继续生成其余文件并以 PostToolUse 自动检查结果为准。",
    );
  }

  if (result.agentReview?.status === "completed") {
    lines.push(`隔离语义审阅已完成${result.agentReview.sessionId ? `（session ${result.agentReview.sessionId}，已释放）` : ""}：${result.agentReview.summary || "无补充说明"}`);
    lines.push("上述诊断与候选 Git Patch 已包含当前快照的语义审阅结果；主 Agent 只需决定是否使用，不需要再次加载 reviewer 或 bundle 快照。");
  } else if (result.agentReview?.status === "failed") {
    lines.push(`隔离语义审阅失败：${result.agentReview.error}`);
  } else if (result.agentReview?.status === "requested" && result.status !== "failed") {
    lines.push("请主 Agent 在处理确定性诊断和候选 Git Patch 的同时，按照下面的 Agent 审阅标准评估当前产物：");
    if (result.agentReview.criteria) lines.push(result.agentReview.criteria);
    if (result.agentReview.edges?.length > 0) {
      lines.push(`Workflow 入边内置一致性基线：${EDGE_REVIEW_BASELINE}`);
      for (const edge of result.agentReview.edges) {
        lines.push(`- ${edge.from} -> ${edge.to}（${edge.status}）`);
        if (edge.reviewer) {
          lines.push(`  扩展标准 ${edge.reviewer.path}：`);
          lines.push(edge.reviewer.criteria);
        }
      }
    }
    lines.push("审阅时必须引用当前产物中的具体证据；是否修改、应用 Patch 或转人工由主 Agent 决定。");
  }

  if (result.status === "failed" && includePublicCommandContext) {
    const stage = result.metadata.stage;
    lines.push(
      PUBLIC_COMMANDS_CONTEXT_MARKER,
      "需要更多信息时按需使用 Runtime Corrector 的公开命令：",
      `- \`/runtime-corrector:spec ${stage}\`：读取当前 ${stage} stage 的完整规范、规则、Schema 与 reviewer。`,
      "- `/runtime-corrector:help`：查看项目感知的帮助和其他公开命令。",
      "先依据本次诊断做最小修正；只有需要精确格式或更多规则时再渐进式查询。",
    );
  }

  lines.push(formatMessage(locale, "feedback.noAutoApply"));

  const feedback = lines.join("\n");
  if (result.status === "failed") {
    return feedback;
  }
  if (feedback.length <= maxChars) {
    return feedback;
  }
  return `${feedback.slice(0, maxChars - 40)}\n${formatMessage(locale, "feedback.truncated")}`;
}
