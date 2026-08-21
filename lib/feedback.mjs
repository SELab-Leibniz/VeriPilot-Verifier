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
    lines.push(formatMessage(locale, "feedback.pluginDefaultHint"));
  }

  if (result.roundOutputFiles?.length > 0) {
    lines.push(formatMessage(locale, "feedback.roundOutputsHeading", { roundId: result.metadata.roundId }));
    for (const outputFile of result.roundOutputFiles) {
      lines.push(`- ${outputFile}`);
    }
  }
  if (result.latestOutputFiles?.length > 0) {
    lines.push(formatMessage(locale, "feedback.latestOutputsHeading"));
    for (const outputFile of result.latestOutputFiles) {
      lines.push(`- ${outputFile}`);
    }
  }
  if (result.outputFiles?.length > 0) {
    lines.push(formatMessage(locale, "feedback.outputsAdvisory"));
  }
  const diagnosticOutput = result.roundOutputFiles?.find(
    (file) => path.posix.basename(file) === "diagnostic.md",
  );
  const diffOutput = result.roundOutputFiles?.find(
    (file) => path.posix.basename(file) === "patch.diff",
  );
  if (diagnosticOutput) {
    lines.push(formatMessage(locale, "feedback.diagnosticPath", { path: diagnosticOutput }));
  }
  if (diffOutput) {
    lines.push(
      result.diffs.length > 0
        ? formatMessage(locale, "feedback.diffPath", { path: diffOutput })
        : formatMessage(locale, "feedback.diffPathEmpty", { path: diffOutput }),
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
        lines.push(formatMessage(locale, "feedback.suggestion", { suggestion: item.suggestion }));
      }
    }
    if (ranked.length > shown.length) {
      lines.push(formatMessage(locale, "feedback.diagnosticsRest", { count: ranked.length - shown.length }));
    }
  }

  lines.push(formatMessage(locale, "feedback.candidatePatchCount", { count: result.diffs.length }));
  if (result.diffs.length === 0 && result.status === "failed") {
    lines.push(formatMessage(locale, "feedback.noSafePatch"));
  }

  const inlineDiffs = result.diffs.slice(0, MAX_INLINE_DIFFS);
  for (const diff of inlineDiffs) {
    lines.push(formatMessage(locale, "feedback.patchHeading", { path: diff.path, baseHash: diff.baseHash }));
    lines.push("```diff");
    lines.push(diff.unifiedDiff);
    lines.push("```");
    lines.push(formatMessage(locale, "feedback.patchApplyGuard"));
  }
  if (result.diffs.length > inlineDiffs.length) {
    lines.push(formatMessage(locale, "feedback.patchesRest", { count: result.diffs.length - inlineDiffs.length }));
  }

  if (result.status === "failed") {
    lines.push(formatMessage(locale, "feedback.errorStatus"));
  } else if (result.status === "warning") {
    lines.push(formatMessage(locale, "feedback.warningStatus"));
  } else if (result.status === "pending") {
    lines.push(
      semanticReviewCompleted
        ? formatMessage(locale, "feedback.pendingSemanticDone")
        : formatMessage(locale, "feedback.pendingSemanticTodo"),
    );
  }

  if (result.agentReview?.status === "completed") {
    const semanticSummary = result.agentReview.summary || formatMessage(locale, "feedback.semanticNoSummary");
    lines.push(result.agentReview.sessionId
      ? formatMessage(locale, "feedback.semanticDoneWithSession", { sessionId: result.agentReview.sessionId, summary: semanticSummary })
      : formatMessage(locale, "feedback.semanticDone", { summary: semanticSummary }));
    lines.push(formatMessage(locale, "feedback.semanticIncluded"));
  } else if (result.agentReview?.status === "failed") {
    lines.push(formatMessage(locale, "feedback.semanticFailed", { error: result.agentReview.error }));
  } else if (result.agentReview?.status === "requested" && result.status !== "failed") {
    lines.push(formatMessage(locale, "feedback.semanticRequested"));
    if (result.agentReview.criteria) lines.push(result.agentReview.criteria);
    if (result.agentReview.edges?.length > 0) {
      lines.push(formatMessage(locale, "feedback.edgeBaseline", { baseline: EDGE_REVIEW_BASELINE }));
      for (const edge of result.agentReview.edges) {
        lines.push(`- ${edge.from} -> ${edge.to}（${edge.status}）`);
        if (edge.reviewer) {
          lines.push(formatMessage(locale, "feedback.edgeExtension", { path: edge.reviewer.path }));
          lines.push(edge.reviewer.criteria);
        }
      }
    }
    lines.push(formatMessage(locale, "feedback.reviewEvidence"));
  }

  if (result.status === "failed" && includePublicCommandContext) {
    const stage = result.metadata.stage;
    lines.push(
      PUBLIC_COMMANDS_CONTEXT_MARKER,
      formatMessage(locale, "feedback.publicCommandsIntro"),
      formatMessage(locale, "feedback.publicCommandsSpec", { stage }),
      formatMessage(locale, "feedback.publicCommandsHelp"),
      formatMessage(locale, "feedback.publicCommandsGuidance"),
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
